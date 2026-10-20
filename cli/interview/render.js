// cli/interview/render.js
// What the terminal shows of a plan: the decision card. The two files the plan is
// written down as come from core/plan-files.js, which the API uses too.
import fs from "node:fs";
import path from "node:path";

import { c } from "../brand.js";
import { normalizeProfile, MODULE_IDS } from "../../core/schema.js";
import { loadCatalog, moduleEntry, patternsFor, planOffers, unsupportedNeeds } from "../../core/catalog.js";
import { CONFIG_FILE } from "../../core/names.js";
import { appTypeLabel, coreModule, enabledModules, isEnabled, moduleById, PLAN_FILE, renderPlanMarkdown, renderPlanYaml } from "../../core/plan-files.js";

export { loadTemplate, renderPlanMarkdown, renderPlanYaml } from "../../core/plan-files.js";

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
      // A module the app uses says where the app finds it (planVersion 0.6).
      text: `${shortLine(entryFor(m.id).line)}${m.connect && Object.keys(m.connect).length ? `, which your app finds through ${Object.values(m.connect).join(" and ")}` : ""}`,
      signature: stableJson({ inputs: m.inputs || {}, ...(m.connect ? { connect: m.connect } : {}) })
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
    outputs.includes("logs") && planOffers(plan, catalog, "logs") ? "Your logs" : null,
    outputs.includes("metrics") && planOffers(plan, catalog, "perf") ? "basic metrics" : null
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
