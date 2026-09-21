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

/** `module_id   what it does`, wrapped under a hanging indent. */
function moduleRows(entries, room) {
  if (!entries.length) return [];

  const idWidth = Math.max(...entries.map(e => e.id.length));
  const textRoom = Math.max(24, room - idWidth - 2);
  const hang = " ".repeat(idWidth + 2);

  return entries.flatMap(({ id, text }) =>
    wrapText(shortLine(text), textRoom).map((row, i) =>
      i === 0 ? `${c.fg(id.padEnd(idWidth))}  ${c.dim(row)}` : `${hang}${c.dim(row)}`
    )
  );
}

/** What a row takes up on the screen: colour codes have no width. */
const visibleLength = line => line.replace(/\x1b\[[0-9;]*m/g, "").length;

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

/**
 * The groups the card is made of: a heading, and the rows under it, already wrapped to
 * `room` and already coloured. Rows carry no left margin, so the same groups can be
 * printed bare or inside a frame.
 */
function cardGroups(plan, catalog, room) {
  const entryFor = id => catalog.modules.find(m => m.id === id) || {};
  const core = coreModule(plan);
  const isStatic = core?.id === "static_site_edge";

  const groups = [];
  const heading = text => groups.push({ heading: text, rows: [] });
  const row = text => groups[groups.length - 1].rows.push(text);

  // The app in one line, with the values the developer gave or confirmed in the
  // phosphor accent.
  heading("Your app:");
  const name = plan.app?.name || "your app";
  const typeLabel = appTypeLabel(plan);
  const entryPoint = core?.inputs?.entry_point;
  const opening =
    `${name}, a ${typeLabel}` +
    (entryPoint ? ` that ${isStatic ? "lands on" : "starts with"} ${entryPoint}` : "");

  for (const line of wrapText(opening, room)) row(paintValues(line, [name, typeLabel, entryPoint]));

  // The core module, and whatever else runs alongside it. What is switched off is not
  // listed: that list only grows as the platform supports more, and a developer
  // deciding whether to deploy does not need to read it. It stays in
  // DEPLOYMENT_PLAN.md, under Modules Not Required.
  heading("We will provision this infrastructure to run it:");
  const running = enabledModules(plan)
    .slice()
    .sort((a, b) => CARD_ORDER.indexOf(a.id) - CARD_ORDER.indexOf(b.id))
    .filter(m => m.id !== "domain_public")   // the executor ignores it, so never promise it
    .map(m => ({ id: m.id, text: entryFor(m.id).line }));
  groups[groups.length - 1].rows.push(...moduleRows(running, room));

  const variables = Object.keys(moduleById(plan, "config_basic")?.inputs?.variables || {});
  if (isEnabled(plan, "config_basic") && variables.length) {
    const settings = `the settings it passes through: ${variables.join(", ")}`;
    for (const line of wrapText(settings, room)) row(paintValues(line, variables));
  }

  // The plan's own outputs, in the developer's terms.
  heading("You will get back:");
  const outputs = plan.outputs || [];
  if (outputs.includes("public_url")) {
    for (const line of wrapText("A public HTTPS address, as soon as it is live", room)) row(c.fg(line));
  }

  const kept = moduleById(plan, "observability_basic")?.inputs?.retention_days;
  const collected = [
    outputs.includes("logs") ? "Your logs" : null,
    outputs.includes("metrics") ? "basic metrics" : null
  ].filter(Boolean);

  if (collected.length) {
    const back = `${collected.join(" and ")}${kept ? `, kept for ${kept} days` : ""}`;
    for (const line of wrapText(back, room)) row(c.fg(line));
  }

  // What the platform guessed is not listed here. Every guess that changes what gets
  // built is already a value on this card, and the rest is provenance, which belongs
  // in DEPLOYMENT_PLAN.md where the line under the card points.
  return groups;
}

const FRAMES_CHARS = {
  ascii: { h: "-", v: "|", tl: "+", tr: "+", bl: "+", br: "+", ml: "+", mr: "+" },
  line: { h: "\u2500", v: "\u2502", tl: "\u250c", tr: "\u2510", bl: "\u2514", br: "\u2518", ml: "\u251c", mr: "\u2524" }
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
 * @param {object} plan  a plan that has already passed POST /plans/validate
 */
export function decisionCard(plan, {
  catalog = loadCatalog(),
  width = process.stdout.columns || 80,
  frame = false,
  charset = "ascii"
} = {}) {
  const boxWidth = Math.min(width - 2, CARD_MAX_WIDTH);
  const room = frame ? boxWidth - 6 : Math.max(28, width - CARD_INDENT - 2);
  const groups = cardGroups(plan, catalog, room);

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
