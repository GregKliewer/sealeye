// src/interview/render.js
// The two files `sealeye init` writes into the developer's folder, and nothing else
// writes there: DEPLOYMENT_PLAN.md (the plan in their language) and deployme.yaml
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
import { repoRoot } from "../executor/env.js";

const PLAN_FILE = "DEPLOYMENT_PLAN.md";
const CONFIG_FILE = "deployme.yaml";

export function loadTemplate() {
  return fs.readFileSync(path.join(repoRoot, "prompts", "plan-template.md"), "utf8");
}

export function loadCatalog() {
  return YAML.parse(fs.readFileSync(path.join(repoRoot, "prompts", "module-catalog.yaml"), "utf8"));
}

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

function coreModule(plan) {
  return enabledModules(plan).find(
    m => m.id === "static_site_edge" || m.id === "http_api_serverless"
  );
}

/** "Static Website" or "Node.js API", from the plan rather than from a guess. */
function appTypeLabel(plan) {
  const core = coreModule(plan);
  if (!core) return plan.app?.type === "static-site" ? "Static Website" : "Application";
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
  return `# Deployment Plan\n\n${appTypeLabel(ctx.plan)} • Generated ${longDate(ctx.date)}`;
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
    `Backend: ${isStatic ? "none, it runs entirely in the browser" : "your own code, running on request"}`,
    `Build Step: ${isStatic ? "none required" : "none, your dependencies are installed for you"}`,
    `Profile: ${plan.profile || "poc"}`
  ]);
}

function selectedModules({ plan, catalog }) {
  const order = ["static_site_edge", "http_api_serverless", "observability_basic", "config_basic", "domain_public"];
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

  steps.push("You get the address back when it is live, and a report of what was created.");

  return steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
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
  const skipped = disabledModules(plan);
  if (!skipped.length) return "Every module in the catalog is in use for this app.";

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
  "Modules Not Required": modulesNotRequired,
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
const CARD_ORDER = ["static_site_edge", "http_api_serverless", "observability_basic", "config_basic", "domain_public"];

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
  const entryFor = id => catalog.modules.find(m => m.id === id) || {};
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
  const running = enabledModules(plan)
    .slice()
    .sort((a, b) => CARD_ORDER.indexOf(a.id) - CARD_ORDER.indexOf(b.id))
    .filter(m => m.id !== "domain_public")   // the executor ignores it, so never promise it
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
  if (outputs.includes("public_url")) {
    back.push({ key: "out:url", text: "A public HTTPS address, as soon as it is live" });
  }
  if (collected.length) {
    back.push({
      key: "out:collected",
      text: `${collected.join(" and ")}${kept ? `, kept for ${kept} days` : ""}`
    });
  }

  return { app, running, back };
}

/**
 * What is already deployed, as card rows. A record written before plans were stored
 * has only its module list, which is enough to diff at module level and not enough to
 * claim anything about inputs, so it is marked partial and the card says so.
 */
function previousContent(previous, catalog) {
  if (!previous) return null;
  if (previous.plan) return { ...cardContent(previous.plan, catalog), partial: false };

  const ids = (previous.modules || []).filter(id => id !== "domain_public");
  if (!ids.length) return null;

  const entryFor = id => catalog.modules.find(m => m.id === id) || {};

  return {
    running: ids
      .slice()
      .sort((a, b) => CARD_ORDER.indexOf(a) - CARD_ORDER.indexOf(b))
      .map(id => ({ key: `module:${id}`, id, text: shortLine(entryFor(id).line) })),
    partial: true
  };
}

// dim for what stays, phosphor for what arrives, amber for what moves or goes.
const MARKS = {
  unchanged: { word: "unchanged", paint: s => c.dim(s) },
  changed: { word: "changed", paint: s => c.prompt(s) },
  new: { word: "new", paint: s => c.accent(s) },
  removed: { word: "removed", paint: s => c.prompt(s) }
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

  if (row.id) {
    const textRoom = Math.max(24, room - markPad - idWidth - 2);
    const hang = " ".repeat(markPad + idWidth + 2);
    const id = row.mark === "removed" ? c.dim(row.id.padEnd(idWidth)) : c.fg(row.id.padEnd(idWidth));

    return wrapText(row.text, textRoom).map((line, i) =>
      i === 0 ? `${markCell}${id}  ${c.dim(line)}` : `${hang}${c.dim(line)}`
    );
  }

  const textRoom = Math.max(24, room - markPad);
  const hang = " ".repeat(markPad);
  const paint = line =>
    row.tone === "dim" || row.mark === "removed" ? c.dim(line) : paintValues(line, row.values || []);

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
    ...[...app, ...middle, ...back].map(row => (row.mark ? MARKS[row.mark].word.length : 0))
  );

  const groups = [
    { heading: "Your app:", rows: renderRows(app, room, markWidth) },
    {
      heading: before ? "We will change this environment:" : "We will provision this infrastructure to run it:",
      rows: renderRows(middle, room, markWidth)
    },
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

    blocks.push(`## ${name}\n\n${render(ctx)}`);
  }

  return `${blocks.join("\n\n---\n\n")}\n`;
}

/** deployme.yaml: the plan as submitted, nothing added. */
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
