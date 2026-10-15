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
import { EXECUTORS, STARTER_VERSION, contractSchema, normalizeProfile } from "./schema.js";

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

  if (doc.profiles !== undefined && !Array.isArray(doc.profiles)) problems.push("profiles is a list");
  if (doc.patterns !== undefined && (typeof doc.patterns !== "object" || doc.patterns === null || Array.isArray(doc.patterns))) {
    problems.push("patterns is a set of named profiles");
  }
  return problems;
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
  // The view the API sends a client (buildableView) has already asked, and says so.
  if (m.buildable === true) return true;
  const builds = typeof m.builds_with === "string" && Object.hasOwn(EXECUTORS, m.builds_with) ? EXECUTORS[m.builds_with] : [];
  return builds.includes(m.id);
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
  return contractSchema({
    moduleIds: buildableModules(catalog).map(m => m.id),
    needKinds: (catalog.need_kinds || []).map(n => n?.key).filter(Boolean)
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
    modules: modules.map(({ builds_with, ...m }) => ({ ...m, buildable: true })),
    need_kinds: catalog.need_kinds || [],
    profiles: catalog.profiles || [],
    patterns
  };
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

  for (const m of catalog.modules || []) {
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
      lines.push(`- ${moduleId}: ${String(text).replace(/\s+/g, " ").trim()}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
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
