// src/interview/render.js
// The two files `sealeye run` writes into the developer's folder, and nothing else
// writes there: DEPLOYMENT_PLAN.md (the plan in their language) and sealeye.yaml
// (the plan exactly as the model submitted it).
//
// DEPLOYMENT_PLAN.md takes its sections, their order and their names from
// prompts/plan-template.md; every word of plain language about a module comes from
// prompts/module-catalog.yaml, so the interview prompt and this renderer cannot
// describe the same module two different ways. No em dash: the developer reads this.
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { c } from "../brand.js";
import { normalizeProfile, isBuildable, MODULE_IDS } from "../../core/schema.js";
import { loadCatalog, moduleEntry, profileEntry, patternsFor, unsupportedNeeds } from "../../core/catalog.js";
import { repoRoot } from "../../core/config.js";

const PLAN_FILE = "DEPLOYMENT_PLAN.md";
import { CONFIG_FILE } from "../../core/names.js";

export function loadTemplate() {
  return fs.readFileSync(path.join(repoRoot, "prompts", "plan-template.md"), "utf8");
}

export { loadCatalog };

/** Split the template on its horizontal rules: the preamble, then one block per section. */
function templateSections(template) {
  return template
    .split(/^---$/m)
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => {
      const heading = /^##\s+(.+)$/m.exec(block);
      return { heading: heading ? heading[1].trim() : null };
    });
}

/** "Notes (Optional)" is a note to whoever fills the template in, not a heading. */
function cleanHeading(heading) {
  return heading.replace(/\s*\(optional\)\s*$/i, "");
}

const enabledModules = plan => (plan.modules || []).filter(m => m.enabled !== false);
const disabledModules = plan => (plan.modules || []).filter(m => m.enabled === false);
const moduleById = (plan, id) => (plan.modules || []).find(m => m.id === id);
const isEnabled = (plan, id) => enabledModules(plan).some(m => m.id === id);

const CORE_MODULES = ["static_site_edge", "http_api_serverless"];

function coreModule(plan) {
  return enabledModules(plan).find(m => CORE_MODULES.includes(m.id));
}

/**
 * "Static Website" or "Node.js API", from the plan rather than from a guess.
 *
 * An app with neither core module is one that cannot start fresh for each request, so
 * it carries the continuous_service need instead. That is what it is called, and the
 * name comes from the need rather than from a module nobody can build.
 */
function appTypeLabel(plan) {
  const core = coreModule(plan);

  if (!core) {
    if ((plan.needs || []).some(n => n.kind === "continuous_service")) {
      return "service that runs continuously";
    }
    return plan.app?.type === "static-site" ? "Static Website" : "service";
  }

  if (core.id === "static_site_edge") return "Static Website";

  const runtime = core.inputs?.runtime;
  return runtime === "python" ? "Python API" : "Node.js API";
}

function longDate(date) {
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function bullets(lines) {
  return lines.map(l => `- ${l}`).join("\n");
}

function inputLines(module) {
  const inputs = module.inputs || {};
  const keys = Object.keys(inputs);
  if (!keys.length) return "";

  const value = v => {
    if (Array.isArray(v)) return v.length ? v.join(", ") : "none";
    if (v && typeof v === "object") {
      const names = Object.keys(v);
      return names.length ? names.join(", ") : "none";
    }
    return v === null || v === undefined || v === "" ? "none" : String(v);
  };

  return ["", "", "Inputs:", ...keys.map(k => `- ${k}: ${value(inputs[k])}`)].join("\n");
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function preamble(ctx) {
  const drafted = unsupportedNeeds(ctx.plan).length > 0;
  const title = drafted ? "# Deployment Plan (draft)" : "# Deployment Plan";
  const meta = `${appTypeLabel(ctx.plan)} • Generated ${longDate(ctx.date)}`;

  // A draft says so before anything else. A developer who reads one line of this file
  // should not come away thinking something was built.
  const status = drafted
    ? "\n\nDrafted: seaLeye.run can build part of this today. The sections below say what it cannot build yet, and why."
    : "";

  return `${title}\n\n${meta}${status}`;
}

/**
 * What the app needs that no module supports, with the code that shows it.
 *
 * The line is the developer's sentence, the evidence is what was read in their folder,
 * and profile_expects is what their profile will ask of it once something supports it.
 * Nothing here is a module id, because nobody has seen the module yet.
 */
function whatItNeeds({ plan }) {
  const needs = unsupportedNeeds(plan);
  if (!needs.length) return null;

  return needs
    .map(need => {
      const lines = [`### ${need.line}`, "", "Found in your code:"];
      for (const e of need.evidence) lines.push(`- ${e.shows} (${e.file})`);
      if (need.profile_expects) {
        lines.push("", `What your ${normalizeProfile(plan.profile)} profile will expect of it: ${need.profile_expects}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

/** What a developer does with a draft, which is the only question a draft raises. */
function whatHappensNext({ plan }) {
  if (!unsupportedNeeds(plan).length) return null;

  return (
    "When your Platform Library has modules that support the needs above, run " +
    "`sealeye run` in this folder. seaLeye.run will read this draft, match the needs " +
    "to modules, and finish the plan. Until then nothing is deployed."
  );
}

/** What runs the app, which is not "on request" when nothing runs it on request. */
function backendLine(plan, isStatic, core) {
  if (isStatic) return "none, it runs entirely in the browser";
  if (core) return "your own code, running on request";
  return "your own code, running continuously";
}

function applicationSummary({ plan }) {
  const core = coreModule(plan);
  const isStatic = core?.id === "static_site_edge";
  const inputs = core?.inputs || {};

  const structure = isStatic
    ? [inputs.entry_point, ...(inputs.additional_pages || [])].filter(Boolean).join(", ") ||
      "the files in your folder"
    : inputs.entry_point || "your entry point";

  return bullets([
    `Type: ${appTypeLabel(plan)}`,
    `Name: ${plan.app?.name || "your app"}`,
    `Structure: ${structure}`,
    `Runtime: ${isStatic ? "browser" : inputs.runtime === "python" ? "python" : "node"}`,
    `Backend: ${backendLine(plan, isStatic, core)}`,
    `Build Step: ${isStatic ? "none required" : "none, your dependencies are installed for you"}`,
    `Profile: ${normalizeProfile(plan.profile) || "poc"}`
  ]);
}

function selectedModules({ plan, catalog }) {
  const order = ["static_site_edge", "http_api_serverless", "observability_basic", "config_basic"];
  const modules = enabledModules(plan).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

  return modules
    .map(module => {
      const entry = catalog.modules.find(m => m.id === module.id);
      const role = entry?.role === "core" ? "Core" : entry?.role === "shared" ? "Observability" : "Optional";
      const line = entry?.line?.trim() || "";
      return `### ${module.id} - ${role}\n${line}${inputLines(module)}`;
    })
    .join("\n\n");
}

function whatWillBeCreated({ plan }) {
  const core = coreModule(plan);
  const steps = [];

  if (core?.id === "static_site_edge") {
    steps.push("Your files are uploaded exactly as they are, with nothing added to your folder.");
    steps.push("A public address is created for them, with HTTPS already on.");
  } else if (core?.id === "http_api_serverless") {
    steps.push(
      "Your app is packaged with its dependencies installed for you. Your own folder is not touched."
    );
    steps.push("A secure HTTPS address is created, and your app answers requests at it.");
    steps.push("Your app starts when a request arrives and costs nothing while nothing is calling it.");
  }

  if (isEnabled(plan, "observability_basic")) {
    const days = moduleById(plan, "observability_basic")?.inputs?.retention_days || 30;
    steps.push(
      `Everything your app prints, and every request, error and response time, is collected and kept for ${days} days.`
    );
  }

  if (isEnabled(plan, "config_basic")) {
    const names = Object.keys(moduleById(plan, "config_basic")?.inputs?.variables || {});
    steps.push(
      names.length
        ? `The settings your app reads from its environment are passed to it when it runs: ${names.join(", ")}.`
        : "The settings your app reads from its environment are passed to it when it runs."
    );
  }

  // A plan with no public URL in its outputs has no address to hand back, so it is not
  // promised one.
  steps.push(
    (plan.outputs || []).includes("public_url")
      ? "You get the address back when it is live, and a report of what was created."
      : "You get a report of what was created."
  );

  const numbered = steps.map((s, i) => `${i + 1}. ${s}`).join("\n");

  // A draft describes what would be built, not what will be. Saying otherwise is the
  // whole failure this file exists to avoid.
  if (unsupportedNeeds(plan).length) {
    return (
      "This plan is a draft, so nothing is created while it stays one. " +
      "What seaLeye.run would build today, once the needs above are met:\n\n" +
      numbered
    );
  }

  return numbered;
}

function expectedOutput({ plan }) {
  const outputs = plan.outputs || [];
  const lines = [];

  if (outputs.includes("public_url")) {
    lines.push("Public URL: generated when the deployment finishes, HTTPS included. Shareable immediately.");
  }
  if (outputs.includes("logs") || outputs.includes("log_stream")) {
    lines.push("Logs: everything your app prints, from the first request, with no setup.");
  }
  if (outputs.includes("metrics") || outputs.includes("metrics_dashboard")) {
    lines.push("Metrics: requests, errors and response times, tracked automatically.");
  }

  return bullets(lines.length ? lines : ["Public URL: generated when the deployment finishes."]);
}

function modulesNotRequired({ plan, catalog }) {
  // Only modules seaLeye.run builds are ever named here. What the app needs beyond
  // them has its own section and is not a module that was "not required".
  const skipped = disabledModules(plan).filter(m => isBuildable(m.id));
  if (!skipped.length) return "Every module seaLeye.run builds is in use for this app.";

  return bullets(
    skipped.map(module => {
      const entry = catalog.modules.find(m => m.id === module.id);
      return `${module.id}: ${entry?.skip_line?.trim() || "not needed for this app."}`;
    })
  );
}

function notes({ summary, assumptions }) {
  const lines = [];
  if (summary) lines.push(summary.trim(), "");

  if (assumptions?.length) {
    lines.push("Assumptions seaLeye.run made, and you can correct any of them:");
    lines.push(bullets(assumptions.map(a => a.trim())));
  } else {
    lines.push("No assumptions were needed: everything in this plan came from your folder or your answers.");
  }

  return lines.join("\n");
}

const SECTIONS = {
  "Application Summary": applicationSummary,
  "Selected Modules": selectedModules,
  "What Will Be Created": whatWillBeCreated,
  "Expected Output": expectedOutput,
  "What Your App Needs That No Module Supports Yet": whatItNeeds,
  "Modules Not Required": modulesNotRequired,
  "What Happens Next": whatHappensNext,
  Notes: notes
};


// ---------------------------------------------------------------------------
// The decision card
// ---------------------------------------------------------------------------
//
// What the developer reads before saying yes. It is rendered from the validated plan
// and from nothing else: prose from the model is the model's account of what it
// decided, and what the developer approves should be the thing that will actually
// run. The model's own words are good writing in the wrong place, so they go to the
// Notes section of DEPLOYMENT_PLAN.md.

const CARD_INDENT = 4;
const CARD_MAX_WIDTH = 96;   // a framed card stops widening past this, whatever the window
const CARD_ORDER = MODULE_IDS;

// What runs the app comes first. Every module in a plan is one the platform builds, so
// an id this order does not know about is a bug, and it sorts last rather than crashing.
const cardRank = id => (CARD_ORDER.indexOf(id) === -1 ? CARD_ORDER.length : CARD_ORDER.indexOf(id));

/** Rows that fit the room, broken on word boundaries. */
function wrapText(text, room) {
  const rows = [];
  let row = "";

  for (const word of String(text).split(" ")) {
    if (!row) row = word;
    else if (`${row} ${word}`.length <= room) row += ` ${word}`;
    else { rows.push(row); row = word; }
  }
  if (row) rows.push(row);

  return rows.length ? rows : [""];
}

// How much of a catalog line the card takes. A fixed budget, not one that depends on
// the terminal: the card has to read the same in a narrow window as in a wide one, and
// two runs over the same app have to produce the same words.
const CARD_SENTENCE_MAX = 90;

/**
 * A catalog line, short enough for a card: its first sentence, and that sentence's
 * first clause if the sentence is longer than the budget. Nothing is rewritten,
 * because then the card and DEPLOYMENT_PLAN.md would be describing the same module in
 * two different voices.
 */
function shortLine(text) {
  const whole = String(text || "").replace(/\s+/g, " ").trim();
  const sentence = (whole.match(/^.*?\.(?=\s|$)/) || [whole])[0].trim();
  if (sentence.length <= CARD_SENTENCE_MAX) return sentence;

  const clause = sentence.match(/^.*?(?=,\s(?:so|and|with)\s|:\s)/);
  return clause ? `${clause[0].replace(/[,:]\s*$/, "")}.` : sentence;
}

/** What a row takes up on the screen: colour codes have no width. */
const visibleLength = line => line.replace(/\x1b\[[0-9;]*m/g, "").length;

/** Key order must not make two identical sets of inputs look different. */
const stableJson = value =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]]))
      : v
  );

/**
 * Colour a row of plain text: the values the developer gave or confirmed in the
 * phosphor accent, the words around them in the default text colour. Wrapping happens
 * on the plain sentence first, so a value never loses its colour halfway down a line
 * and a coloured row never overflows the card.
 */
function paintValues(text, values) {
  const wanted = values.filter(Boolean);
  if (!wanted.length) return c.fg(text);

  const pattern = wanted.map(v => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

  return text
    .split(new RegExp(`(${pattern})`))
    .filter(part => part !== "")
    .map(part => (wanted.includes(part) ? c.accent(part) : c.fg(part)))
    .join("");
}

// ---------------------------------------------------------------------------
// The card as data
// ---------------------------------------------------------------------------
//
// Rows carry a key and their plain text, before any colour or wrapping. The key is
// what makes a diff possible: the same row in two plans keeps the same key whatever
// its words turn out to be.

function cardContent(plan, catalog) {
  const entryFor = id => moduleEntry(id, catalog) || {};
  const core = coreModule(plan);
  const isStatic = core?.id === "static_site_edge";

  const name = plan.app?.name || "your app";
  const typeLabel = appTypeLabel(plan);
  const entryPoint = core?.inputs?.entry_point;

  const app = [
    {
      key: "app",
      text:
        `${name}, a ${typeLabel}` +
        (entryPoint ? ` that ${isStatic ? "lands on" : "starts with"} ${entryPoint}` : ""),
      values: [name, typeLabel, entryPoint]
    }
  ];

  // A module's description never changes, so the row also carries its inputs: a
  // retention or an entry point that moved is a change to this environment even when
  // the sentence describing the module is the same.
  // A module the platform does not build yet stays in the list and says so, so the
  // developer meets it here, on the card, and not after they have said yes.
  const running = enabledModules(plan)
    .slice()
    .sort((a, b) => cardRank(a.id) - cardRank(b.id))
    .map(m => ({
      key: `module:${m.id}`,
      id: m.id,
      text: shortLine(entryFor(m.id).line),
      signature: stableJson(m.inputs || {})
    }));

  const variables = Object.keys(moduleById(plan, "config_basic")?.inputs?.variables || {});
  if (isEnabled(plan, "config_basic") && variables.length) {
    running.push({
      key: "module:config_basic:variables",
      text: `the settings it passes through: ${variables.join(", ")}`,
      values: variables
    });
  }

  const outputs = plan.outputs || [];
  const kept = moduleById(plan, "observability_basic")?.inputs?.retention_days;
  const collected = [
    outputs.includes("logs") ? "Your logs" : null,
    outputs.includes("metrics") ? "basic metrics" : null
  ].filter(Boolean);

  const back = [];
  // An app that asked not to be reachable from the public internet is never told it is
  // getting a public address, whatever the plan's outputs say. A plan can be wrong
  // about this; the card cannot be, because the card is what the developer approves.
  const internalOnly = unsupportedNeeds(plan).some(n => n.kind === "internal_only");
  if (internalOnly) {
    back.push({
      key: "out:url",
      text: "A private address inside your organization's network, as soon as it is live"
    });
  } else if (outputs.includes("public_url")) {
    back.push({ key: "out:url", text: "A public HTTPS address, as soon as it is live" });
  }
  if (collected.length) {
    back.push({
      key: "out:collected",
      text: `${collected.join(" and ")}${kept ? `, kept for ${kept} days` : ""}`
    });
  }

  // A proof of concept is not headed anywhere, so it is the one profile this is not
  // true of. Everything else is designed for the pipeline, and the plan is the design.
  const profile = normalizeProfile(plan.profile);
  if (profile === "dev" || profile === "prod") {
    back.push({ key: "out:design", text: "A plan your later environments are built from" });
  }

  // What the app needs that nothing here builds. Its own rows, its own heading, and
  // the evidence beside each one so the developer can check it against their code.
  const needs = unsupportedNeeds(plan).map(need => ({
    key: `need:${need.kind}`,
    id: need.line,
    tone: "need",
    text: (need.evidence || []).map(e => (e.file ? `${e.shows} (${e.file})` : e.shows)).join("; ")
  }));

  return { app, running, back, needs };
}

/**
 * What is already deployed, as card rows. A record written before plans were stored
 * has only its module list, which is enough to diff at module level and not enough to
 * claim anything about inputs, so it is marked partial and the card says so.
 */
function previousContent(previous, catalog) {
  if (!previous) return null;
  if (previous.plan) return { ...cardContent(previous.plan, catalog), partial: false };

  const ids = previous.modules || [];
  if (!ids.length) return null;

  const entryFor = id => moduleEntry(id, catalog) || {};

  return {
    running: ids
      .slice()
      .sort((a, b) => cardRank(a) - cardRank(b))
      .map(id => {
        const entry = entryFor(id);
        return { key: `module:${id}`, id, text: shortLine(entry.line) };
      }),
    partial: true
  };
}

// What moved gets a word; what stayed gets silence and the dim colour. Seven rows
// labelled "unchanged" is a column of noise that buries the one row that did change,
// and a reader who sees three labels in a card of ten knows what to look at.
const MARKS = {
  unchanged: { word: "", paint: s => c.dim(s) },
  changed: { word: "changed", paint: s => c.accent(s) },
  new: { word: "new", paint: s => c.accent(s) },
  removed: { word: "removed", paint: s => c.accent(s) }
};

const NOTHING_CHANGES = {
  key: "nothing",
  text: "Nothing changes. Your environment already matches this plan; deploying updates your code only.",
  values: ["Nothing changes."]
};

const PARTIAL_NOTE = {
  key: "partial",
  text: "That deploy did not record its plan, so this compares the modules and not their settings.",
  tone: "dim"
};

/**
 * Mark each row against what is deployed, and keep the rows that are going away.
 *
 * `settings: false` is the record that stored no plan: the modules can be compared and
 * their inputs cannot, so a module in both is unchanged as far as anyone can honestly
 * say, and the card carries a line admitting it.
 */
function markRows(rows, before, { settings = true } = {}) {
  if (!before) return rows.map(row => ({ ...row }));

  const was = new Map(before.map(row => [row.key, row]));

  const marked = rows.map(row => {
    const previous = was.get(row.key);
    if (!previous) return { ...row, mark: "new" };

    const same =
      previous.text === row.text &&
      (!settings || (previous.signature || "") === (row.signature || ""));

    return { ...row, mark: same ? "unchanged" : "changed" };
  });

  const keys = new Set(rows.map(row => row.key));
  for (const row of before) {
    if (!keys.has(row.key)) marked.push({ ...row, mark: "removed" });
  }

  return marked;
}

// ---------------------------------------------------------------------------
// The card on the screen
// ---------------------------------------------------------------------------

/** One row: its mark, its module id, and its text, wrapped under a hanging indent. */
function renderRow(row, { room, markWidth, idWidth }) {
  const mark = row.mark ? MARKS[row.mark] : null;
  const markPad = markWidth ? markWidth + 2 : 0;
  const markCell = markWidth
    ? `${mark ? mark.paint(mark.word.padEnd(markWidth)) : " ".repeat(markWidth)}  `
    : "";

  // A row that did not move recedes: no label, and the whole line dim, so the rows
  // that did move are the only thing with any colour in them.
  const quiet = row.mark === "unchanged" || row.mark === "removed";

  if (row.id) {
    const textRoom = Math.max(24, room - markPad - idWidth - 2);
    const hang = " ".repeat(markPad + idWidth + 2);
    // A need is the one row on the card that asks something of a person: amber, by the
    // same rule the prompts follow. Its evidence stays dim, like every other detail.
    const paintId = quiet ? c.dim : row.tone === "need" ? c.prompt : c.fg;
    const id = paintId(row.id.padEnd(idWidth));

    return wrapText(row.text, textRoom).map((line, i) =>
      i === 0 ? `${markCell}${id}  ${c.dim(line)}` : `${hang}${c.dim(line)}`
    );
  }

  const textRoom = Math.max(24, room - markPad);
  const hang = " ".repeat(markPad);
  const paint = line =>
    row.tone === "dim" || quiet ? c.dim(line) : paintValues(line, row.values || []);

  return wrapText(row.text, textRoom).map((line, i) => `${i === 0 ? markCell : hang}${paint(line)}`);
}

function renderRows(rows, room, markWidth) {
  const idWidth = Math.max(0, ...rows.filter(row => row.id).map(row => row.id.length));

  return rows.flatMap(row => renderRow(row, { room, markWidth, idWidth }));
}

const FRAMES_CHARS = {
  ascii: { h: "-", v: "|", tl: "+", tr: "+", bl: "+", br: "+", ml: "+", mr: "+" },
  line: { h: "─", v: "│", tl: "┌", tr: "┐", bl: "└", br: "┘", ml: "├", mr: "┤" }
};

/** The groups as plain indented lines. */
function bareCard(groups) {
  const indent = " ".repeat(CARD_INDENT);

  return groups
    .flatMap(({ heading, rows }) => [c.dim(`  ${heading}`), ...rows.map(r => `${indent}${r}`)])
    .join("\n");
}

/** The groups in a box, one rule per group, padded on visible width. */
function framedCard(groups, boxWidth, chars) {
  const inner = boxWidth - 4;
  const rule = (left, right) => c.dim(`  ${left}${chars.h.repeat(boxWidth - 2)}${right}`);
  const pad = line => " ".repeat(Math.max(0, inner - visibleLength(line)));
  const line = text => `  ${c.dim(chars.v)} ${text}${pad(text)} ${c.dim(chars.v)}`;

  const out = [rule(chars.tl, chars.tr)];

  groups.forEach(({ heading, rows }, i) => {
    if (i) out.push(rule(chars.ml, chars.mr));
    out.push(line(c.dim(heading)));
    for (const row of rows) out.push(line(`  ${row}`));
  });

  out.push(rule(chars.bl, chars.br));

  return out.join("\n");
}

/**
 * The card the developer decides on.
 *
 * @param {object} plan               a plan that has already passed POST /plans/validate
 * @param {object} [options.previous] what is already deployed: { plan } from a stored
 *                                    record, or { modules } for a record written before
 *                                    plans were stored. Absent means nothing is
 *                                    deployed and the card reads as it always has.
 */
export function decisionCard(plan, {
  catalog = loadCatalog(),
  width = process.stdout.columns || 80,
  frame = false,
  charset = "ascii",
  previous = null
} = {}) {
  const boxWidth = Math.min(width - 2, CARD_MAX_WIDTH);
  const room = frame ? boxWidth - 6 : Math.max(28, width - CARD_INDENT - 2);

  const next = cardContent(plan, catalog);
  const before = previousContent(previous, catalog);

  const settings = !before?.partial;
  const app = markRows(next.app, before?.app, { settings });
  const running = markRows(next.running, before?.running, { settings });
  const back = markRows(next.back, before?.back, { settings });
  const needs = markRows(next.needs || [], before?.needs, { settings });

  // A card that says nothing changes is the strongest thing a second run can say, so
  // it is only said when it is true of every line, not only of the modules.
  const nothingChanges =
    before && !before.partial && [...app, ...running, ...back].every(row => row.mark === "unchanged");

  const middle = nothingChanges
    ? [NOTHING_CHANGES]
    : before?.partial
      ? [...running, PARTIAL_NOTE]
      : running;

  // One mark column for the whole card: a row that changed and a row that did not have
  // to line up, or the eye reads the indent as meaning something.
  const markWidth = Math.max(
    0,
    ...[...app, ...middle, ...needs, ...back].map(row => (row.mark ? MARKS[row.mark].word.length : 0))
  );

  // Which environment these patterns describe. A dev plan gets its patterns now,
  // because the dev environment is the one being built; everything else is describing
  // an environment the pipeline builds later, so it says so.
  const PATTERN_HEADINGS = {
    dev: "Patterns your dev environment applies:",
    perf: "Patterns your perf environment will apply:",
    prod: "Patterns your production environment will apply:"
  };

  // A profile is a set of patterns, so a card that names one says what it chose. The
  // words are the catalog's, and there is not a number among them.
  const patterns = normalizeProfile(plan.profile) === "poc"
    ? []
    : patternsFor(plan, catalog).map(p => ({ key: `pattern:${p.id}`, id: p.id, text: p.line }));

  const groups = [
    { heading: "Your app:", rows: renderRows(app, room, markWidth) },
    {
      heading: before ? "We will change this environment:" : "We will build your dev environment with:",
      rows: renderRows(middle, room, markWidth)
    },
    // What no module supports comes straight after what will be built, because the
    // developer is being asked to approve both halves of the same answer.
    ...(needs.length
      ? [{
          heading: "Your app also needs, and no module in your catalog supports yet:",
          rows: renderRows(needs, room, markWidth)
        }]
      : []),
    ...(patterns.length
      ? [{
          heading: PATTERN_HEADINGS[normalizeProfile(plan.profile)] || PATTERN_HEADINGS.prod,
          rows: renderRows(patterns, room, markWidth)
        }]
      : []),
    { heading: "You will get back:", rows: renderRows(back, room, markWidth) }
  ];

  return frame ? framedCard(groups, boxWidth, FRAMES_CHARS[charset] || FRAMES_CHARS.ascii) : bareCard(groups);
}

/**
 * DEPLOYMENT_PLAN.md, in the developer's language.
 *
 * @param {{plan: object, summary: string, assumptions: string[]}} submission
 */
export function renderPlanMarkdown(submission, { template = loadTemplate(), catalog = loadCatalog(), date = new Date() } = {}) {
  const ctx = { ...submission, catalog, date };
  const blocks = [];

  const seen = new Set();

  for (const [index, { heading }] of templateSections(template).entries()) {
    // The template rules off its own sub-blocks too (one per example module), so only
    // the first headingless block is the preamble; the rest are skeleton, not sections.
    if (heading === null) {
      if (index === 0) blocks.push(preamble(ctx));
      continue;
    }

    const name = cleanHeading(heading);
    if (seen.has(name)) continue;
    seen.add(name);

    const render = SECTIONS[name];
    if (!render) continue;   // a section the template names and the plan has nothing to say about

    const body = render(ctx);
    if (body === null) continue;   // a section only a draft has, on a plan that is not one

    blocks.push(`## ${name}\n\n${body}`);
  }

  const markdown = `${blocks.join("\n\n---\n\n")}\n`;

  // The one rule this file exists to keep. A module id in here that seaLeye.run cannot
  // build is a promise to a developer that nobody can keep, so it fails here, loudly,
  // rather than reaching their folder.
  const stray = STRAY_MODULE_ID.exec(markdown);
  if (stray && !isBuildable(stray[0])) {
    throw new Error(
      `DEPLOYMENT_PLAN.md names ${stray[0]}, which seaLeye.run does not build. ` +
        "Only " + MODULE_IDS.join(", ") + " may appear in a plan file."
    );
  }

  return markdown;
}

// Module ids are the one lowercase_snake shape in this file. Anything matching that is
// checked against the four; prose never does, because prose is written in sentences.
const STRAY_MODULE_ID = /\b(?:static_site_edge|http_api_serverless|observability_basic|config_basic|domain_public|data_relational|data_cache|events_stream|queue_basic|secrets_basic|identity_service|network_private|compute_container|scheduled_job|storage_object)\b/;

/** sealeye.yaml: the plan as submitted, nothing added. */
export function renderPlanYaml(plan) {
  return YAML.stringify(plan);
}

/**
 * Write both files into the developer's folder. Called only after the interview has a
 * valid plan, and before the developer is asked whether to deploy.
 *
 * @returns {{planPath: string, configPath: string}}
 */
export function writeInterviewFiles(appPath, submission, options = {}) {
  const planPath = path.join(appPath, PLAN_FILE);
  const configPath = path.join(appPath, CONFIG_FILE);

  fs.writeFileSync(planPath, renderPlanMarkdown(submission, options));
  fs.writeFileSync(configPath, renderPlanYaml(submission.plan));

  return { planPath, configPath };
}
