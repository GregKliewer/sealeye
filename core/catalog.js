// core/catalog.js
// What a catalog says, and the starter catalog every organization begins with.
//
// A catalog is one document: the modules the platform builds, the fixed list of need
// kinds, the profiles and their patterns. Every function here takes the catalog it reads
// from, so the API can hand each one the organization's live catalog (api/catalogs.js,
// PHASE4-PLAN Step 1). An organization with none has the starter catalog,
// prompts/module-catalog.yaml, word for word: seaLeye's own four modules.
//
// The starter is read fresh each time. Not cached: the file is small, the calls are
// rare, and an edit during a working day should take effect without restarting anything.
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { repoRoot, loadUserConfig } from "./config.js";
import { isPart } from "./terraform-modules.js";
import { environmentOperations } from "./operations.js";
import { EXECUTORS, LEGACY_MODULE_IDS, MODULE_IDS, STARTER_VERSION, contractSchema, moduleIdSource, normalizeProfile } from "./schema.js";

/**
 * The organization the developer belongs to, for the messages that name one. From
 * ~/.sealeye/config, because whose platform library this is belongs to the person
 * running the command and never to a line of code.
 */
export function orgName() {
  loadUserConfig();
  return process.env.ORG || "your organization";
}

/**
 * The fixed closing paragraph of the refusal, so the words can change without code.
 * It says what would make the plan buildable and never when, because seaLeye.run does
 * not know when and will not guess in front of a developer.
 */
export function refusalClosing(org = orgName()) {
  const file = path.join(repoRoot, "prompts", "refusal.md");

  return fs.readFileSync(file, "utf8").trim().split("{{org}}").join(org);
}

/** The version a plan names for the starter catalog (planVersion 0.5, Step 2). */
export { STARTER_VERSION };

/** The starter catalog: seaLeye's own modules, from prompts/module-catalog.yaml. */
export function starterCatalog() {
  return YAML.parse(fs.readFileSync(path.join(repoRoot, "prompts", "module-catalog.yaml"), "utf8"));
}

/**
 * The starter catalog, under the name every caller used before there could be more than
 * one. The command reads it for the card it draws; the API reads the organization's
 * live catalog instead (api/catalogs.js) and passes it to the functions below.
 */
export function loadCatalog() {
  return starterCatalog();
}

/** A {{name}} other than {{org}}, which only the prompt itself may hold. */
const otherPlaceholder = text => /\{\{(?!org\}\})[^}]*\}\}/.test(String(text));

/** A test for text naming any module a document could mean: its own, the four, an old plan's. */
function moduleNamer(doc) {
  const ids = [...new Set([
    ...MODULE_IDS, ...LEGACY_MODULE_IDS,
    ...(Array.isArray(doc?.modules) ? doc.modules.map(m => m?.id).filter(id => typeof id === "string" && /^[a-z][a-z0-9_]*$/.test(id)) : [])
  ])];
  return text => ids.find(id => new RegExp(moduleIdSource(id)).test(String(text ?? ""))) || null;
}

/**
 * What is wrong with a catalog document, in words; empty when nothing is. Only its shape:
 * the parts every function here reads. Whether its entries are right is the self-test's
 * to say (PHASE4-PLAN Step 7), and whether it may go live a platform engineer's.
 */
export function catalogProblems(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return ["a catalog is a document of named parts"];
  const problems = [];
  const text = v => typeof v === "string" && v.trim() !== "";

  if (!Array.isArray(doc.modules)) problems.push("modules is a list");
  else {
    const seen = new Set();
    doc.modules.forEach((m, i) => {
      if (!m || !text(m.id)) return problems.push(`module ${i + 1} has no id`);
      if (!/^[a-z][a-z0-9_]*$/.test(m.id)) problems.push(`module ${m.id}: an id is lowercase letters, digits and underscores`);
      if (seen.has(m.id)) problems.push(`module ${m.id} is listed twice`);
      seen.add(m.id);
      if (!text(m.line)) problems.push(`module ${m.id} has no line`);
    });
  }

  if (!Array.isArray(doc.need_kinds)) problems.push("need_kinds is a list");
  else {
    const seen = new Set();
    doc.need_kinds.forEach((n, i) => {
      if (!n || !text(n.key)) return problems.push(`need kind ${i + 1} has no key`);
      if (seen.has(n.key)) problems.push(`need kind ${n.key} is listed twice`);
      seen.add(n.key);
      if (!text(n.line)) problems.push(`need kind ${n.key} has no line`);
    });
  }

  if (Array.isArray(doc.modules)) {
    for (const m of doc.modules) {
      if (m && text(m.id) && m.builds_with !== undefined && !text(m.builds_with)) problems.push(`module ${m.id}: builds_with names what builds it`);
      if (m && text(m.id) && m.buildable !== undefined) problems.push(`module ${m.id}: whether it is buildable is the platform's to say, not the catalog's`);
      // An executor the platform may not have yet (Terraform, until PHASE4-PLAN Step 9)
      // is fine: the module is simply not buildable. Only a name that could never be
      // one is a mistake in the document.
      else if (m && text(m.id) && typeof m.builds_with === "string" && !/^[a-z][a-z0-9_-]*$/.test(m.builds_with)) problems.push(`module ${m.id}: builds_with is a lowercase name`);
    }
  }

  // Which needs a module meets (the gap report's, DESIGN.md, "Discovery records which
  // needs each module meets"): the catalog's own need kinds, by key.
  if (Array.isArray(doc.modules) && Array.isArray(doc.need_kinds)) {
    const keys = new Set(doc.need_kinds.map(n => n?.key).filter(Boolean));
    for (const m of doc.modules) {
      if (!m || !text(m.id) || m.meets === undefined) continue;
      if (!Array.isArray(m.meets)) problems.push(`module ${m.id}: meets is a list of need kinds`);
      else for (const k of m.meets) if (!keys.has(k)) problems.push(`module ${m.id}: meets ${k}, which is not one of the catalog's need kinds`);
    }
  }

  if (Array.isArray(doc.modules)) {
    for (const m of doc.modules) {
      if (m && text(m.id) && m.guidance !== undefined && !text(m.guidance)) problems.push(`module ${m.id}: guidance is text`);
      else if (m && text(m.id) && text(m.guidance) && otherPlaceholder(m.guidance)) problems.push(`module ${m.id}: guidance may hold {{org}} and no other {{name}}`);
    }
  }
  if (doc.interview !== undefined) {
    if (!doc.interview || typeof doc.interview !== "object" || Array.isArray(doc.interview)) problems.push("interview is a set of named passages");
    else {
      for (const [key, value] of Object.entries(doc.interview)) {
        if (!INTERVIEW_PASSAGES.includes(key)) problems.push(`interview.${key} is not a passage the interview has`);
        else if (typeof value !== "string") problems.push(`interview.${key} is text`);
        else if (otherPlaceholder(value)) problems.push(`interview.${key} may hold {{org}} and no other {{name}}`);
      }
    }
  }

  // What a need and a pattern say is about the app and the environment, never a module:
  // a module named there would reach the interview and the developer whether it is
  // built or not.
  const anyModule = moduleNamer(doc);
  if (Array.isArray(doc.need_kinds)) {
    for (const n of doc.need_kinds) {
      if (!n || !text(n.key)) continue;
      const said = [n.line, ...Object.values(n.profile_expects || {})].map(String).find(anyModule);
      if (said) problems.push(`need kind ${n.key} names a module (${anyModule(said)}); a need says what the app needs`);
    }
  }
  if (doc.patterns && typeof doc.patterns === "object" && !Array.isArray(doc.patterns)) {
    for (const [profile, block] of Object.entries(doc.patterns)) {
      if (block && anyModule(block.line)) problems.push(`patterns.${profile} names a module (${anyModule(block.line)}) in its line`);
    }
  }

  if (doc.profiles !== undefined && !Array.isArray(doc.profiles)) problems.push("profiles is a list");
  if (doc.patterns !== undefined && (typeof doc.patterns !== "object" || doc.patterns === null || Array.isArray(doc.patterns))) {
    problems.push("patterns is a set of named profiles");
  }
  return problems;
}

/**
 * A test for text that names a module this catalog does not build: one of the starter's
 * four, an id from a plan before 0.4, or one of the catalog's own, that it does not
 * build. Returns the id named, or null. Ids are lowercase letters, digits and
 * underscores (catalogProblems), so a word boundary is exact: `http_api` is not found
 * inside `http_api_serverless`. An id that is an ordinary word is found only in
 * backticks (moduleIdSource in core/schema.js). An id no catalog has ever had cannot be
 * known, and is not caught here.
 */
export function namesUnbuilt(catalog = loadCatalog()) {
  const built = new Set(buildableModules(catalog).map(m => m.id));
  const unbuilt = [...new Set([...MODULE_IDS, ...LEGACY_MODULE_IDS, ...catalogModuleIds(catalog)])].filter(id => !built.has(id));
  const patterns = unbuilt.map(id => [id, new RegExp(moduleIdSource(id))]);
  return text => patterns.find(([, re]) => re.test(String(text)))?.[0] || null;
}

export function moduleEntry(id, catalog = loadCatalog()) {
  return (catalog.modules || []).find(m => m.id === id) || null;
}

/**
 * Whether the platform builds a catalog's module: the catalog marks it available, and
 * the platform has an executor for what it says builds it (`builds_with`, EXECUTORS in
 * core/schema.js) that builds this module. Anything else in a catalog is a module the
 * platform cannot build yet, and an app that needs it has a need: refuse, never shrink.
 */
export function isBuildable(id, catalog = loadCatalog()) {
  const m = moduleEntry(id, catalog);
  if (!m || m.availability !== "available") return false;
  // An entry resting on a question nobody has answered yet is never built: its guess
  // never goes live (Greg, Oct 16, 2026: the catalog may still be approved without it).
  if (Array.isArray(m.open) && m.open.length) return false;
  // The view the API sends a client (buildableView) has already asked, and says so.
  if (m.buildable === true) return true;
  const builds = typeof m.builds_with === "string" && Object.hasOwn(EXECUTORS, m.builds_with) ? EXECUTORS[m.builds_with] : [];
  // An executor says which modules it builds by id, or by looking at the entry and the
  // catalog it is in (Terraform's, which also reads the organization's platform values
  // the API puts beside the catalog: core/terraform-modules.js).
  return typeof builds === "function" ? builds(m, catalog) === true : builds.includes(m.id);
}

/** The modules a plan against this catalog may name, in the catalog's order. */
export function buildableModules(catalog = loadCatalog()) {
  return (catalog.modules || []).filter(m => m && isBuildable(m.id, catalog));
}

/**
 * The plan contract (0.5) for a plan written against this catalog: the modules it may
 * name and the need kinds it knows. A JSON schema; the API compiles it (api/validate.js).
 */
export function schemaFor(catalog = loadCatalog()) {
  const built = buildableModules(catalog);
  return contractSchema({
    moduleIds: built.map(m => m.id),
    needKinds: (catalog.need_kinds || []).map(n => n?.key).filter(Boolean),
    connects: built.some(isPart)
  });
}

/**
 * A catalog as the clients read it (GET /catalog): what the platform builds, the need
 * kinds, the profiles and their patterns. A module the platform cannot build is left
 * out, and so is anything a pattern says about one, because seaLeye never names a
 * module it cannot build (principle 2), not even in a document a command prints. What
 * builds a module (`builds_with`) is left out too: the platform's to know.
 */
export function buildableView(catalog = loadCatalog()) {
  const modules = buildableModules(catalog);
  const ids = new Set(modules.map(m => m.id));
  const patterns = Object.fromEntries(
    Object.entries(catalog.patterns || {}).map(([profile, block]) => [
      profile,
      { ...block, modules: Object.fromEntries(Object.entries(block?.modules || {}).filter(([id]) => ids.has(id))) }
    ])
  );
  return {
    ...(catalog.catalogVersion !== undefined ? { catalogVersion: catalog.catalogVersion } : {}),
    // What builds a module is the platform's to know, and its name is an AWS term; the
    // client is told only that the platform builds it.
    // Nor who edited an entry's words (catalog-edits.js): people are GET /team's to name.
    // Nor what code read of a Terraform module to build it (its outputs, how it takes an
    // app, what it would run, how it connects to another), nor which commit its release
    // is: the platform's to know too. Its version is the developer's to read.
    // What an environment built from it offers (core/operations.js), so a card promises
    // only what the developer can then do: readings come back only from what seaLeye's
    // own templates build; logs from those, and from a module that says where it keeps
    // them (delivers.logs).
    modules: modules.map(({ builds_with, guidance, edited, outputs, delivers, runs, offers, accepts, tag, commit, unreleased, meets, ...m }) => ({ ...m, buildable: true, operations: operationsOf({ builds_with, delivers }) })),
    need_kinds: catalog.need_kinds || [],
    profiles: catalog.profiles || [],
    patterns
  };
}

/** What an environment built from a catalog entry offers: its operations, by what builds it. */
function operationsOf(entry) {
  if (Array.isArray(entry?.operations)) return entry.operations;
  return environmentOperations(entry?.builds_with === "terraform" ? "terraform" : "cloudformation", { logs: Boolean(entry?.delivers?.logs) });
}

/**
 * Whether the environment a plan builds offers an operation (`logs`, `perf`): every
 * module it uses must. A plan the catalog does not describe offers what seaLeye's own
 * templates do.
 */
export function planOffers(plan, catalog, id) {
  const used = (plan?.modules || []).filter(m => m?.enabled !== false && m?.id);
  return used.every(m => {
    const entry = (catalog?.modules || []).find(e => e?.id === m.id);
    return !entry || operationsOf(entry).includes(id);
  });
}

/** Every module id a catalog names, built or not: what a plan file must not name unless it is built. */
export function catalogModuleIds(catalog = loadCatalog()) {
  return (catalog.modules || []).map(m => m?.id).filter(Boolean);
}

export function profileEntry(id, catalog = loadCatalog()) {
  return (catalog.profiles || []).find(p => p.id === id) || null;
}

/** A catalog line, on one line: the card and the refusal both want the first sentence. */
export function firstSentence(text) {
  const whole = String(text || "").replace(/\s+/g, " ").trim();
  return (whole.match(/^.*?\.(?=\s|$)/) || [whole])[0].trim();
}

/**
 * What the app needs that no module supports yet.
 *
 * A plan can be entirely valid and still carry these. That is the point: the plan is
 * the honest record of what the app needs, and the platform says which parts of it it
 * can build rather than deploying something smaller and reporting success.
 *
 * A profile is never in here. Whatever a plan is designed for, this run builds a dev
 * environment, and the patterns a dev or prod profile asks for are what the pipeline
 * applies to the environments it builds later.
 */
export function unsupportedNeeds(plan) {
  return (plan?.needs || []).map(need => ({
    kind: need.kind,
    line: need.line,
    evidence: need.evidence || [],
    profile_expects: need.profile_expects || null
  }));
}

/** The evidence for a need, as one phrase, for places that show it beside the line. */
export function evidencePhrase(need) {
  return (need?.evidence || [])
    .map(e => (e.file ? `${e.shows} (${e.file})` : e.shows))
    .join("; ");
}

/** The fixed need kinds, as the interview and the renderer read them. */
export function needKinds(catalog = loadCatalog()) {
  return catalog.need_kinds || [];
}

/** What a profile will expect of a need, in the catalog's own words. */
export function profileExpectsFor(kind, profile, catalog = loadCatalog()) {
  const entry = needKinds(catalog).find(n => n.key === kind);
  return entry?.profile_expects?.[normalizeProfile(profile)] || null;
}

/** The module's line in one sentence, for places that list many of them at once. */
const oneLine = text => firstSentence(String(text || "").replace(/\s+/g, " ").trim());

/**
 * The catalog as the interview reads it: every module with what it is, when it applies
 * and what in a folder points at it, then the profiles and their patterns.
 *
 * Generated rather than written out in the prompt, because a module that exists in two
 * places eventually says two different things, and the one the developer hears would be
 * the copy nobody updated.
 */
export function catalogForPrompt(catalog = loadCatalog()) {
  const lines = ["### Modules seaLeye.run builds", ""];
  // Only what the platform builds: the interview never hears of a module it cannot.
  const built = buildableModules(catalog);
  const builtIds = new Set(built.map(m => m.id));

  for (const m of built) {
    const inputs = Object.entries(m.inputs || {})
      .map(([name, spec]) => `${name} (${JSON.stringify(spec?.default ?? null)})`)
      .join(", ");

    lines.push(`- **${m.id}**  ${m.role}`);
    lines.push(`  ${oneLine(m.line)}`);
    if (m.when) lines.push(`  When: ${String(m.when).replace(/\s+/g, " ").trim()}`);
    if (m.signals?.length) lines.push(`  In the folder: ${m.signals.join("; ")}.`);
    if (inputs) lines.push(`  Inputs and defaults: ${inputs}.`);
    lines.push("");
  }

  // The known kinds, so the same need reads the same way every run. The key is yours;
  // the line is the developer's. A need none of them fits is `unlisted`.
  lines.push("### Need kinds, for what no module above supports", "");
  for (const n of catalog.need_kinds || []) {
    lines.push(`- **${n.key}**  "${String(n.line).trim()}"`);
    if (n.signals?.length) lines.push(`  In the folder: ${n.signals.join("; ")}.`);
    for (const [profile, text] of Object.entries(n.profile_expects || {})) {
      lines.push(`  ${profile} expects: ${String(text).replace(/\s+/g, " ").trim()}`);
    }
    lines.push("");
  }
  lines.push(
    "- **unlisted**  your own line, when the folder shows a need none of the kinds above fits",
    "  In the same form as the lines above: \"a ...\" or \"an ...\", the kind of thing the app needs, in a few words.",
    "  Never a product or a vendor (the technology goes in the evidence), never a module, never a promise.",
    ""
  );

  lines.push("### Profiles", "");
  for (const p of catalog.profiles || []) {
    lines.push(`- **${p.id}**  ${p.availability}  ${String(p.line).replace(/\s+/g, " ").trim()}`);
  }

  lines.push("", "### Patterns each profile applies", "");
  for (const [id, block] of Object.entries(catalog.patterns || {})) {
    lines.push(`**${id}**: ${String(block.line).replace(/\s+/g, " ").trim()}`);
    for (const [moduleId, text] of Object.entries(block.modules || {})) {
      if (!builtIds.has(moduleId)) continue;
      lines.push(`- ${moduleId}: ${String(text).replace(/\s+/g, " ").trim()}`);
    }
    lines.push("");
  }

  // The last guard of principle 2: a line naming a module the catalog does not build
  // (a pattern's line, a need's, a module's own words) is left out. Each line here
  // stands alone, so dropping one leaves the rest readable; catalogProblems refuses a
  // catalog whose need and pattern lines name a module at all.
  const names = namesUnbuilt(catalog);
  return lines.filter(line => !names(line)).join("\n").trim();
}

/** The patterns a profile applies to the modules a plan enables, for the card. */
export function patternsFor(plan, catalog = loadCatalog()) {
  const profile = normalizeProfile(plan?.profile);
  const block = (catalog.patterns || {})[profile];
  if (!block) return [];

  const enabled = new Set((plan?.modules || []).filter(m => m && m.enabled !== false).map(m => m.id));

  return Object.entries(block.modules || {})
    .filter(([id]) => enabled.has(id))
    .map(([id, text]) => ({ id, line: String(text).replace(/\s+/g, " ").trim() }));
}

// ---------------------------------------------------------------------------
// How the interview talks about a catalog's modules (PHASE4-PLAN Step 3)
// ---------------------------------------------------------------------------
//
// prompts/interview-system.md is the same for every catalog, except where it speaks of
// the modules themselves: how many there are, the one way of running an app, the
// sections on each module, a question that decides one of them. Those passages are the
// catalog's. The starter's are prompts/interview-starter.yaml, word for word as the
// interview was evaluated; an organization's catalog may carry its own (`interview:`);
// a catalog without one gets passages written from its own modules and rules, so the
// interview never hears of a module the catalog does not have.

/**
 * The starter catalog's passages, word for word as the interview was evaluated. Read by
 * the API only: the file is not in the command's package.
 */
export function starterPassages() {
  return YAML.parse(fs.readFileSync(path.join(repoRoot, "prompts", "interview-starter.yaml"), "utf8"));
}

/** The passages a catalog may carry, each a {{name}} in the prompt, and the tool's. */
export const INTERVIEW_PASSAGES = [
  "plan_description", "redeploy_example", "rule_one_way", "modules_intro",
  "catalog_source", "module_guidance", "settings_question"
];

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/** "four", or the digits past twelve. */
export const numberWord = n => NUMBER_WORDS[n] || String(n);

/** `a`, `b` and `c`. */
const idList = ids => {
  const quoted = ids.map(id => `\`${id}\``);
  return quoted.length < 2 ? quoted.join("") : `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
};

/** The catalog's core modules the platform builds, when it says exactly one runs the app. */
function oneWayOfRunning(catalog) {
  const rules = catalog.rules || {};
  const built = new Set(buildableModules(catalog).map(m => m.id));
  const core = (Array.isArray(rules.core_modules) ? rules.core_modules : []).filter(id => built.has(id));
  return rules.exactly_one_core === true && core.length >= 2 ? core : null;
}

/**
 * Every passage the interview's prompt and tool take from a catalog: the catalog's own
 * where it has them, and otherwise written from its modules and rules.
 *
 * @returns {Record<string, string>} keyed by INTERVIEW_PASSAGES, and module_count
 */
export function interviewPassages(catalog = loadCatalog(), { starter = false } = {}) {
  // The starter's passages live beside the prompt, on the server only
  // (prompts/interview-starter.yaml); an organization's catalog carries its own. Whether
  // this is the starter is the caller's to say, from the catalog it was given (its
  // version), never guessed from the document: a copy of the starter is not the starter.
  const own = catalog.interview && typeof catalog.interview === "object"
    ? catalog.interview
    : starter ? starterPassages() : {};
  const names = namesUnbuilt(catalog);
  const modules = buildableModules(catalog);
  const ids = modules.map(m => m.id);
  const core = oneWayOfRunning(catalog);

  const written = {
    plan_description:
      "The deployment plan. Modules are only ever the ones the catalog lists: never name a " +
      "module seaLeye.run cannot build." +
      (core ? ` Exactly one of ${core.join(" and ")} enabled.` : "") +
      " Anything else the app needs goes in needs, each with the code that shows it. status " +
      "is drafted when needs is not empty, ready when it is.",
    redeploy_example: "\"your app now reads DB_HOST and API_KEY from its environment, and the plan now says so\"",
    rule_one_way: core
      ? `One way of running the app, never two. Exactly one of ${idList(core)} is enabled. An app that none of them can run takes a need for what it is, and leaves them all disabled.`
      : "One way of running the app, never two.",
    modules_intro: ids.length
      ? `seaLeye.run builds ${numberWord(ids.length)} module${ids.length === 1 ? "" : "s"} here and no others: ${idList(ids)}. ` +
        "Those are the only module ids that exist. Never write any other id into a plan, a summary or an assumption, and never invent one."
      : "seaLeye.run builds no modules here yet. Never write a module id into a plan, a summary or an assumption, and never invent one: " +
        "everything the app needs is a need.",
    catalog_source: "The whole catalog, {{org}}'s own, which is the one place the modules and the need kinds are defined:",
    module_guidance: modules
      .filter(m => typeof m.guidance === "string" && m.guidance.trim() && !names(m.guidance))
      .map(m => `### ${m.id}\n${m.guidance.trim()}`)
      .join("\n\n"),
    settings_question: ""
  };

  // A passage of the catalog's own that names a module it does not build is set aside
  // for the written one: a catalog that began as a copy of the starter keeps the
  // starter's words about modules it may have dropped (principle 2).

  const passages = { module_count: numberWord(ids.length) };
  // Where the catalog comes from is the starter's to say only of itself: an
  // organization's catalog that began as its copy is not prompts/module-catalog.yaml.
  for (const key of INTERVIEW_PASSAGES) {
    const usable = typeof own[key] === "string" && !names(own[key]) && (key !== "catalog_source" || starter);
    passages[key] = usable ? own[key] : written[key];
  }
  // How the modules an app uses are connected to the one that runs it, for a catalog that
  // has any (core/terraform-modules.js, isPart): written from the catalog by code, after
  // whatever the catalog says itself. The starter has none, so its prompt is as it was.
  const connecting = connectingPassage(modules);
  if (connecting) {
    passages.module_guidance = [passages.module_guidance, connecting.guidance].filter(Boolean).join("\n\n");
    passages.plan_description = `${passages.plan_description} ${connecting.plan}`;
  }
  return passages;
}

/** What the interview is told about connecting modules, or null when nothing connects. */
function connectingPassage(modules) {
  const parts = modules.filter(m => isPart(m) && !m.delivers);
  const runs = modules.filter(m => m.delivers?.kind === "package" && m.accepts && (m.accepts.policies || m.accepts.secrets));
  if (!parts.length || !runs.length) return null;
  const offers = parts.map(m => `- ${m.id} gives the app ${idList(m.offers.values || [])}`).join("\n");
  return {
    guidance: [
      "### Connecting modules",
      `${idList(parts.map(m => m.id))} are modules an app uses, built beside the module that runs it (${idList(runs.map(m => m.id))}) and connected to it. ` +
        "Enable each one the app's code uses, with the file that shows it in the assumptions, and exactly one module that runs the app. " +
        "The platform gives the app what it needs to use each; never write a grant, a policy, a secret or a resource's name into inputs.",
      "For each module the app uses, `connect` says the setting the app reads each of its values from, by the name the code reads: " +
        "`connect: { table_name: \"ORDERS_TABLE\" }` for code that reads `process.env.ORDERS_TABLE`. Each value it gives:",
      offers,
      "A setting the code reads that no module gives is not connected: it is a need."
    ].join("\n"),
    plan: "A module the app uses (a table, a bucket, a queue) is enabled beside the one that runs it, with connect naming the setting the app reads each of its values from."
  };
}
