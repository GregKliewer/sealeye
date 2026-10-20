#!/usr/bin/env node
// scripts/eval-interview.js
// The interview regression set (PHASE1-PLAN Step 6): run the interview against each
// sample app with pre-written answers, grade the plan against what that app is known to
// need, and record it all in LangFuse as one dataset run. Nothing is deployed.
//
//   npm run eval:interview
//
// Run it before any change to prompts/, and again after. Each run is a separate dataset
// run in LangFuse (Datasets, then sealeye-interview), so two runs side by side show both
// what a change did and how much the results vary on their own.
//
// At the end it reads each run's tokens and cost back from LangFuse and prints them as
// one table, with the largest run and the typical one (PHASE3-PLAN Step 1).
//
// Two sets (PHASE4-PLAN Step 8): the starter's, each app planned against seaLeye's own
// modules, and Juniper Mutual's, each app planned against the catalog discovery wrote
// for the made-up organization (a snapshot of its live catalog,
// test/fixtures/juniper-catalog-3.json). Juniper's modules are Terraform, and the snapshot
// was written before discovery recorded what the Terraform executor needs to build one,
// so for this eval only they are treated as built (`treatAsBuilt`): the plans are graded
// on being right, not on being buildable. `--set starter` or
// `--set juniper` runs one.
//
// It calls the model and LangFuse, so it is not part of `npm test`, which stays offline.
// The API it validates plans against is started here, on a spare port with an empty
// store of its own, so nothing is added to your deployment records.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";

import { DEFAULT_MODEL, loadSystemPrompt, resolveApiKey } from "../api/interview/model.js";
import { addCatalog, approveCatalog, liveCatalog, makeLive, openCatalogs } from "../api/catalogs.js";
import { EXECUTORS } from "../core/schema.js";
import { CONFIG_FILE, LEGACY_CONFIG_FILE } from "../core/names.js";
import { runInterview } from "../api/interview/service.js";
import { loadEnv, loadUserConfig, repoRoot, setting } from "../core/config.js";
import {
  flushScores,
  flushTracing,
  langfuseRequest,
  newExperimentId,
  promptVersionOf,
  scoreTrace,
  startTracing,
  traceExperimentItem,
  tracingConfigured,
  tracingSwitchedOff
} from "../core/tracing.js";

export const DATASET = "sealeye-interview";
const FIXTURES = path.join(repoRoot, "test", "fixtures", "eval");
const JUNIPER_FIXTURES = path.join(repoRoot, "test", "fixtures", "eval-juniper");
const JUNIPER_CATALOG = path.join(repoRoot, "test", "fixtures", "juniper-catalog-3.json");

/**
 * The sets the eval runs: each its cases, and the organization whose live catalog they
 * plan against (none: the starter, as `default` has it).
 */
export const SETS = {
  starter: { dir: FIXTURES, org: null },
  juniper: { dir: JUNIPER_FIXTURES, org: "eval-juniper", catalog: JUNIPER_CATALOG }
};
// When no scripted answer fits the question, the interview still gets an answer a
// developer might give, rather than an empty line.
const FALLBACK_ANSWER = "I'm not sure. Use your best judgement from the code.";

/**
 * The scripted answer to one question. A fixture's answer is either
 * - `{ when: [phrases], answer }`: given to any question holding one of the phrases
 *   (in any case), as often as such a question is asked. The first in the fixture whose
 *   phrase is in the question wins, so the specific ones (settings, who reaches it) go
 *   before a general "is that right?". Added Oct 15, 2026: a model that asks in another
 *   order than the last run still gets the answer meant for its question.
 * - a plain string: given to the next question no phrase matched, in the order written,
 *   once each, as every answer was before.
 * Nothing fits: FALLBACK_ANSWER.
 *
 * @param {string} question
 * @param {(string|{when: string[], answer: string})[]} answers
 * @param {{ next?: number }} state how many plain strings have been given; changed here
 * @returns {{ answer: string, by: string }} `by` says how it was chosen, for the terminal
 */
export function answerFor(question, answers = [], state = {}) {
  const asked = String(question || "").toLowerCase();
  for (const entry of answers) {
    if (!entry || typeof entry !== "object") continue;
    const phrase = (entry.when || []).find(p => asked.includes(String(p).toLowerCase()));
    if (phrase) return { answer: entry.answer, by: `matched "${phrase}"` };
  }
  const plain = answers.filter(a => typeof a === "string");
  state.next = state.next || 0;
  if (state.next < plain.length) return { answer: plain[state.next++], by: "next in order" };
  return { answer: FALLBACK_ANSWER, by: "no answer fits" };
}

/** Text on one line, cut to fit the terminal. */
const oneLine = text => {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 137)}...` : flat;
};

/** Every sample app with a fixture: its answers and what its plan should be. */
export function loadCases(dir = FIXTURES, { set = "starter", org = null } = {}) {
  return fs
    .readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .sort()
    .map(f => {
      const { answers = [], expected } = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      return { app: path.basename(f, ".json"), answers, expected, set, org };
    });
}

/**
 * For this eval only: the catalog's Terraform modules are built, so a catalog of them can
 * be planned against and its plans graded on their modules. The snapshot (catalog 3,
 * Oct 16, 2026) was written before discovery recorded how a module takes an app and
 * what it would run, and the eval's organization has no platform values, so the real
 * executor (PHASE4-PLAN Step 9) would build none of it. So in this process the executor
 * is the catalog's own list of Terraform modules; whether a module is offered and whether
 * it rests on a question are left to the catalog, as ever. `builtAsBefore` puts the real
 * executor back. Once a snapshot of a catalog discovery wrote since, with the eval's
 * platform values, is in the eval, this goes.
 */
const realExecutors = new Map();
export function treatAsBuilt(document, executor = "terraform") {
  if (!realExecutors.has(executor)) realExecutors.set(executor, EXECUTORS[executor]);
  EXECUTORS[executor] = (document.modules || []).filter(m => m?.builds_with === executor).map(m => m.id);
  return true;
}

/** The real executor again, after treatAsBuilt. */
export function builtAsBefore(executor = "terraform") {
  if (!realExecutors.has(executor)) return;
  const real = realExecutors.get(executor);
  if (real === undefined) delete EXECUTORS[executor];
  else EXECUTORS[executor] = real;
  realExecutors.delete(executor);
}

/**
 * Make a catalog an organization's live one, as a platform engineer would: kept as a
 * draft, approved, made live. Run in a scratch folder (SEALEYE_HOME), never the
 * machine's own. Returns its version.
 */
export async function seedCatalog({ org, document }) {
  await openCatalogs();
  const { version } = await addCatalog({ org, document, by: "eval@sealeye" });
  await approveCatalog({ org, version, by: "eval@sealeye" });
  await makeLive({ org, version, by: "eval@sealeye" });
  return version;
}

/** The prompt an organization's interview reads, by its fingerprint, for the run's name. */
export function promptFor(org) {
  const live = org ? liveCatalog(org) : null;
  return promptVersionOf(live && live.source === "organization" ? loadSystemPrompt(live.document, { starter: false }) : loadSystemPrompt());
}

/** What the run came to: a ready or drafted plan, or how the interview ended without one. */
export function outcomeOf(result) {
  if (result?.status !== "submitted") return result?.status || "error";
  return (result.plan?.needs || []).length > 0 ? "drafted" : "ready";
}

/**
 * What a plan connects: each value a module the app uses gives, and the setting the app
 * reads it from, across every enabled module (`connect` on a 0.6 plan's module). As
 * "value=SETTING" lines, so a fixture's expectation and a plan's wiring compare alike.
 */
function connectionsOf(plan) {
  return (plan?.modules || [])
    .filter(m => m && m.enabled !== false && m.connect && typeof m.connect === "object")
    .flatMap(m => Object.entries(m.connect).map(([value, name]) => `${value}=${name}`))
    .sort();
}

/**
 * Compare a run with what its app is known to need. Modules are graded only when the
 * fixture names them: a drafted plan is graded on its needs. What the plan connects is
 * graded only when the fixture says what the app reads (`connect`, value -> setting):
 * every connection it names must be in the plan, and none it says the app does not
 * read (`notConnect`, a list of values).
 */
export function grade(result, expected) {
  const outcome = outcomeOf(result);
  const modules = (result?.plan?.modules || []).filter(m => m.enabled !== false).map(m => m.id).sort();
  const needs = [...new Set((result?.plan?.needs || []).map(n => n.kind))].sort();
  const wantNeeds = [...(expected.needs || [])].sort();

  const modulesCorrect = expected.modules
    ? expected.modules.every(m => modules.includes(m)) && (expected.notModules || []).every(m => !modules.includes(m))
    : null;

  const connections = connectionsOf(result?.plan);
  const wantConnect = expected.connect ? Object.entries(expected.connect).map(([value, name]) => `${value}=${name}`) : null;
  const connectedValues = connections.map(c => c.split("=")[0]);
  const missingConnect = (wantConnect || []).filter(c => !connections.includes(c));
  const unwantedConnect = (expected.notConnect || []).filter(value => connectedValues.includes(value));
  const connectCorrect = wantConnect || expected.notConnect ? missingConnect.length === 0 && unwantedConnect.length === 0 : null;

  return {
    outcome,
    outcomeCorrect: outcome === expected.status,
    modules,
    modulesCorrect,
    needs,
    needsCorrect: needs.length === wantNeeds.length && needs.every((n, i) => n === wantNeeds[i]),
    missingNeeds: wantNeeds.filter(n => !needs.includes(n)),
    missingModules: (expected.modules || []).filter(m => !modules.includes(m)),
    unwantedModules: (expected.notModules || []).filter(m => modules.includes(m)),
    extraNeeds: needs.filter(n => !wantNeeds.includes(n)),
    connections,
    connectCorrect,
    missingConnect,
    unwantedConnect,
    questions: result?.questions ?? 0
  };
}

/** Is the whole row right? Modules and connections count only where they were graded. */
export function allCorrect(row) {
  return !row.error && row.outcomeCorrect && row.needsCorrect && row.modulesCorrect !== false && row.connectCorrect !== false;
}

/** The dataset's id, creating the dataset if it is not there yet. */
async function ensureDataset() {
  try {
    const created = await langfuseRequest("POST", "/api/public/v2/datasets", {
      name: DATASET,
      description: "The sample apps in apps/, with the plan each one should get. Written by scripts/eval-interview.js."
    }, 10_000);
    if (created?.id) return created.id;
  } catch (err) {
    // Already there is fine; anything else (bad keys, no network) is not.
    const existing = await langfuseRequest("GET", `/api/public/v2/datasets/${encodeURIComponent(DATASET)}`, undefined, 10_000).catch(() => {
      throw err;
    });
    return existing?.id;
  }
  const existing = await langfuseRequest("GET", `/api/public/v2/datasets/${encodeURIComponent(DATASET)}`, undefined, 10_000);
  return existing?.id;
}

/**
 * Run every case and record it. `clientFor(app)` supplies a model client per app, for
 * tests; left out, the interview makes its own.
 *
 * @returns {Promise<object[]>} one graded row per app
 */
export async function evaluate({ cases, runName, model, clientFor, outDir = null, log = () => {} }) {
  const datasetId = await ensureDataset();
  const scratch = fs.mkdtempSync(path.join((await import("node:os")).tmpdir(), "sealeye-eval-apps-"));
  const experimentId = newExperimentId();

  const rows = [];
  for (const { app, answers, expected, set = "starter", org = null } of cases) {
    const description = `Interview prompt ${promptFor(org)}, model ${model}${org ? `, ${set}'s catalog` : ""}`;
    // The starter's items keep the ids they always had; another set's are its own.
    const name = set === "starter" ? app : `${set}-${app}`;
    const itemId = `${DATASET}-${name}`;
    // The input is the app's name, never its files: the dataset is a list of what to
    // run and what should come of it.
    await langfuseRequest("POST", "/api/public/dataset-items", {
      datasetName: DATASET,
      id: itemId,
      input: { app, ...(set === "starter" ? {} : { catalog: set }) },
      expectedOutput: expected
    }, 10_000);

    log(`${name}: interviewing`);
    const state = {};
    // What was asked and how each was answered, shown when the app is not as expected.
    const asked = [];
    let row;

    try {
      // Recorded the way LangFuse's own experiment runner records an item, so the run
      // shows under the dataset's Experiments with each app's trace, cost and scores.
      row = await traceExperimentItem(
        { experimentId, runName, description, datasetId, itemId, input: { app, ...(set === "starter" ? {} : { catalog: set }) }, expectedOutput: expected },
        async () => {
          const result = await runInterview({
            // A clean copy each time: the app as written, never a plan left in it.
            appPath: cleanCopy(path.join(repoRoot, "apps", app), fs.mkdtempSync(path.join(scratch, `${name}-`))),
            model,
            user: "eval",
            ...(org ? { caller: { email: "eval@sealeye", org, team: "eval" } } : {}),
            ask: async question => {
              const { answer, by } = answerFor(question, answers, state);
              asked.push({ question: oneLine(question), by });
              return answer;
            },
            ...(clientFor ? { client: clientFor(app) } : {})
          });
          // What it planned and why, kept on this machine for reading a run that went
          // wrong (eval-results/ is never committed). The sample apps are seaLeye's own.
          if (outDir) keepResult(outDir, name, result, asked);
          return {
            app: name, traceId: result.traceId, turns: result.turns, spent: result.spent, asked,
            ...(result.status === "stopped" && result.message ? { stopped: oneLine(result.message) } : {}),
            ...grade(result, expected)
          };
        }
      );
      await flushTracing();

      if (row.traceId) {
        scoreTrace(row.traceId, "outcome_correct", row.outcomeCorrect);
        scoreTrace(row.traceId, "needs_correct", row.needsCorrect);
        if (row.modulesCorrect !== null) scoreTrace(row.traceId, "modules_correct", row.modulesCorrect);
        if (row.connectCorrect !== null) scoreTrace(row.traceId, "connect_correct", row.connectCorrect);
      }
    } catch (err) {
      row = { app: name, error: err.message };
      if (outDir) keepResult(outDir, name, { status: "error", error: err.message }, asked);
    }

    rows.push(row);
    log(`${name}: ${row.error ? `could not finish (${row.error})` : allCorrect(row) ? "as expected" : "not as expected"}`);
  }

  await flushScores(10_000);
  return rows;
}

/** One run's plan, summary, assumptions and questions, as a YAML file in `outDir`. */
function keepResult(outDir, name, result, asked) {
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const kept = {
      app: name,
      status: result.status,
      ...(result.error ? { error: result.error } : {}),
      ...(result.message ? { message: result.message } : {}),
      asked,
      ...(result.plan ? { plan: result.plan } : {}),
      ...(result.summary ? { summary: result.summary } : {}),
      ...(result.assumptions ? { assumptions: result.assumptions } : {})
    };
    fs.writeFileSync(path.join(outDir, `${name}.yaml`), YAML.stringify(kept));
  } catch {
    // Keeping it is a convenience; the run's grade does not depend on it.
  }
}

/**
 * The files seaLeye itself writes into an app's folder (principle 5), and the folder it
 * keeps there. A plan left by an earlier `sealeye run` is read by the interview and
 * carried forward, so a sample app holding one is graded on that plan, not on the app
 * (Greg's run, Oct 16, 2026: a leftover plan's prod profile chose production's
 * database).
 */
export const SEALEYE_WRITES = [CONFIG_FILE, LEGACY_CONFIG_FILE, "DEPLOYMENT_PLAN.md", "DEPLOYMENT_REPORT.md", "DEPLOYMENT_EVIDENCE.md", ".sealeye"];

/** A copy of a sample app, without anything seaLeye wrote into it, in a scratch folder. */
export function cleanCopy(appDir, scratch) {
  const to = path.join(scratch, path.basename(appDir));
  fs.cpSync(appDir, to, {
    recursive: true,
    filter: src => !SEALEYE_WRITES.includes(path.basename(src)) && path.basename(src) !== "node_modules"
  });
  return to;
}

/** One line per app, for the terminal. */
export function summaryLines(rows) {
  const mark = ok => (ok === null ? "  " : ok ? "ok" : "NO");
  const lines = [];
  for (const r of rows) {
    if (r.error) {
      lines.push(`  ${r.app.padEnd(34)} could not finish: ${r.error}`);
      continue;
    }
    lines.push(
      `  ${r.app.padEnd(34)} ${mark(r.outcomeCorrect)} ${r.outcome.padEnd(8)}` +
        ` ${mark(r.modulesCorrect)} modules  ${mark(r.needsCorrect)} needs  ${r.questions} question${r.questions === 1 ? "" : "s"}`
    );
    if (r.missingNeeds.length) lines.push(`  ${"".padEnd(34)}    missing: ${r.missingNeeds.join(", ")}`);
    if (r.extraNeeds.length) lines.push(`  ${"".padEnd(34)}    not expected: ${r.extraNeeds.join(", ")}`);
    // Modules wrong: what it planned, and which were missing or should not be there.
    if (r.modulesCorrect === false) {
      lines.push(`  ${"".padEnd(34)}    planned: ${r.modules.join(", ") || "no modules"}`);
      if (r.missingModules?.length) lines.push(`  ${"".padEnd(34)}    missing: ${r.missingModules.join(", ")}`);
      if (r.unwantedModules?.length) lines.push(`  ${"".padEnd(34)}    should not have: ${r.unwantedModules.join(", ")}`);
    }
    // Connections wrong: what the plan wired to which setting, and what was missing or
    // should not be there.
    if (r.connectCorrect === false) {
      lines.push(`  ${"".padEnd(34)}    connected: ${r.connections.join(", ") || "nothing"}`);
      if (r.missingConnect?.length) lines.push(`  ${"".padEnd(34)}    not connected: ${r.missingConnect.join(", ")}`);
      if (r.unwantedConnect?.length) lines.push(`  ${"".padEnd(34)}    should not connect: ${r.unwantedConnect.join(", ")}`);
    }
    // Not as expected: what the model asked, how each was answered, and why it stopped,
    // so a run that went wrong can be read without opening its trace.
    if (!allCorrect(r)) {
      for (const a of r.asked || []) lines.push(`  ${"".padEnd(34)}    asked: ${a.question} (${a.by})`);
      if (r.stopped) lines.push(`  ${"".padEnd(34)}    stopped: ${r.stopped}`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------------
// What each run spent (PHASE3-PLAN Step 1), read back from LangFuse.
//
// LangFuse prices each model call from the usage the interview records
// (`usageDetails` in core/tracing.js), so the eval reads its numbers rather than
// pricing them again here. This is measurement only: the cap on a run never reads
// LangFuse (DESIGN.md, "A run's cap is close, not exact").

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A number from LangFuse, or 0 when it sent none. */
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Add up one run's model calls. A call with tokens but no cost means LangFuse had no
 * price for its model when the call arrived.
 */
export function sumGenerations(generations) {
  const run = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpricedModels: [] };
  for (const g of generations) {
    const u = g.usageDetails || {};
    const tokens = num(u.input) + num(u.output) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
    run.turns += 1;
    run.input += num(u.input);
    run.output += num(u.output);
    run.cacheRead += num(u.cache_read_input_tokens);
    run.cacheWrite += num(u.cache_creation_input_tokens);
    const cost = g.costDetails?.total ?? g.totalCost ?? g.calculatedTotalCost;
    if (Number.isFinite(Number(cost)) && Number(cost) > 0) run.cost += Number(cost);
    else if (tokens > 0 && !run.unpricedModels.includes(g.model || "unnamed")) run.unpricedModels.push(g.model || "unnamed");
  }
  if (run.unpricedModels.length) run.cost = null;
  return run;
}

/**
 * One run's model calls as LangFuse holds them. LangFuse can take a minute or more to
 * make everything it was sent readable, and can make part of a run readable before the
 * rest, so a count that holds still is not enough: this asks until LangFuse has as
 * many calls as the run made (`turns`, from the interview's result), and otherwise
 * says how many it had. A partial run is never reported as a whole one.
 *
 * @returns {Promise<object>} sumGenerations' totals, or { error }
 */
export async function readRunCost(traceId, { turns, request = langfuseRequest, pause = sleep, tries = 40, every = 5000 } = {}) {
  if (!Number.isFinite(turns) || turns < 1) return { error: "the run did not say how many model calls it made" };
  let generations = [];
  for (let i = 0; i < tries; i++) {
    const page = await request(
      "GET",
      `/api/public/v2/observations?traceId=${encodeURIComponent(traceId)}&type=GENERATION&fields=core,basic,model,usage&limit=100`,
      undefined,
      10_000
    );
    generations = page?.data || [];
    if (generations.length >= turns) return sumGenerations(generations);
    if (i < tries - 1) await pause(every);
  }
  const waited = Math.round((tries * every) / 1000);
  return {
    error:
      `after ${waited} seconds LangFuse had ${generations.length} of this run's ${turns} model calls. ` +
      "Look at its trace in LangFuse; if the rest are there, run this again"
  };
}

/** Each graded row with what its run spent added, read after every app has run. */
export async function addCosts(rows, options) {
  const out = [];
  for (const row of rows) {
    if (!row.traceId) {
      out.push({ ...row, spend: { error: row.error ? "the run did not finish" : "the run has no trace" } });
      continue;
    }
    try {
      out.push({ ...row, spend: await readRunCost(row.traceId, { ...options, turns: row.turns }) });
    } catch (err) {
      out.push({ ...row, spend: { error: err.message } });
    }
  }
  return out;
}

const dollars = v => (v === null ? "no price" : `$${v.toFixed(4)}`);
const count = v => v.toLocaleString("en-CA");

/** The largest run and the median one, by cost when every run has one, else by tokens. */
export function largestAndTypical(rows) {
  const spent = rows.map(r => r.spend).filter(s => s && !s.error);
  if (!spent.length) return null;
  const priced = spent.every(s => s.cost !== null);
  const size = s => (priced ? s.cost : s.input + s.output + s.cacheRead + s.cacheWrite);
  const sorted = [...spent].sort((a, b) => size(a) - size(b));
  return { by: priced ? "cost" : "tokens", largest: sorted[sorted.length - 1], typical: sorted[Math.floor((sorted.length - 1) / 2)] };
}

/** What each run spent, as a table for the terminal. */
export function costLines(rows, model) {
  const head = ["app", "turns", "input", "output", "cache read", "cache write", "cost"];
  const body = rows.map(r =>
    r.spend?.error
      ? [r.app, "", "", "", "", "", ""]
      : [r.app, String(r.spend.turns), count(r.spend.input), count(r.spend.output), count(r.spend.cacheRead), count(r.spend.cacheWrite), dollars(r.spend.cost)]
  );
  const widths = head.map((h, i) => Math.max(h.length, ...body.map(b => b[i].length)));
  const line = cells => "  " + cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");

  const lines = ["What each run spent, from LangFuse (tokens; cost in US dollars):", line(head)];
  rows.forEach((r, i) => lines.push(r.spend?.error ? `  ${r.app.padEnd(widths[0])}  could not read: ${r.spend.error}` : line(body[i])));

  const sizes = largestAndTypical(rows);
  if (sizes) {
    const say = s => `${s.turns} turn${s.turns === 1 ? "" : "s"}, ${count(s.input + s.output + s.cacheRead + s.cacheWrite)} tokens, ${dollars(s.cost)}`;
    lines.push("");
    lines.push(`  Largest run: ${say(sizes.largest)}`);
    lines.push(`  Typical run: ${say(sizes.typical)}`);
  }

  // The cap prices from core/model-prices.js, never from LangFuse; LangFuse is how that
  // table is checked. A run whose two counts differ by more than five percent says so.
  const drift = rows.filter(r => Number.isFinite(r.spent) && r.spend && !r.spend.error && r.spend.cost > 0 && Math.abs(r.spent - r.spend.cost) / r.spend.cost > 0.05);
  if (drift.length) {
    lines.push("");
    for (const r of drift) {
      lines.push(`  ${r.app}: seaLeye's own count, ${dollars(r.spent)}, differs from LangFuse's, ${dollars(r.spend.cost)}, by more than 5%.`);
    }
    lines.push("  The run cap prices from core/model-prices.js: check it against the provider's page (deploy/README.md, Model prices).");
  }

  const unpriced = [...new Set(rows.flatMap(r => r.spend?.unpricedModels || []))];
  if (unpriced.length) {
    lines.push("");
    lines.push(`  LangFuse has no price for ${unpriced.join(", ")}, so it recorded no cost.`);
    lines.push("  Add one in LangFuse: Project settings, Models, Add model definition, with a match");
    lines.push(`  pattern of ^${model}$ and prices for input, output, cache_read_input_tokens and`);
    lines.push("  cache_creation_input_tokens. LangFuse prices only calls that arrive after that, so");
    lines.push("  run this again once it is added.");
  }
  return lines;
}

// ---------------------------------------------------------------------------------

/** The sets `--set starter` or `--set juniper` asks for; both when it asks for none. */
export function setsAsked(argv) {
  const i = argv.indexOf("--set");
  const asked = i >= 0 ? argv[i + 1] : process.env.npm_config_set;
  if (!asked) return Object.keys(SETS);
  if (!SETS[asked]) throw new Error(`--set takes ${Object.keys(SETS).join(" or ")}, not ${asked}`);
  return [asked];
}

/**
 * The cases of each set asked for, with each set's catalog live in a scratch folder of
 * its own, so nothing on this machine's own seaLeye folder is read or changed.
 */
export async function prepareSets(names) {
  const os = await import("node:os");
  process.env.SEALEYE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-eval-interview-"));
  delete process.env.DATABASE_URL;
  const cases = [];
  for (const set of names) {
    const { dir, org, catalog } = SETS[set];
    if (catalog) {
      const document = JSON.parse(fs.readFileSync(catalog, "utf8"));
      treatAsBuilt(document);
      await seedCatalog({ org, document });
    }
    cases.push(...loadCases(dir, { set, org }));
  }
  return cases;
}

async function main() {
  loadEnv();
  loadUserConfig();

  if (!resolveApiKey()) {
    console.error("ANTHROPIC_API_KEY is not set. Put it in ~/.sealeye/config and run this again.");
    process.exit(1);
  }
  // The regression set exists to record a run in LangFuse, so with tracing switched
  // off it stops rather than grading apps nobody will see. --no-trace counts whether it
  // arrives after `--` or not: without `--`, npm keeps the flag for itself and leaves
  // npm_config_trace set to "" or "false" instead.
  const noTraceFlag =
    process.argv.includes("--no-trace") || ["", "false"].includes(process.env.npm_config_trace);
  if (noTraceFlag) {
    console.error("--no-trace turns tracing off, and the regression set only records with it on. Run it without --no-trace.");
    process.exit(1);
  }
  if (tracingSwitchedOff()) {
    console.error("SEALEYE_TRACING turns tracing off, and the regression set only records with it on. Unset it and run this again.");
    process.exit(1);
  }
  if (!tracingConfigured()) {
    console.error("LangFuse keys are not set. Put LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY in ~/.sealeye/config.");
    process.exit(1);
  }

  // Each app's trace is marked as an experiment (environment "sdk-experiment", the
  // one LangFuse's own runner uses), so it never mixes with real runs.
  startTracing();

  const model = setting("MODEL") || DEFAULT_MODEL;
  // Local time, so the run name matches the clock of whoever ran it.
  const now = new Date();
  const two = n => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ` +
    `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`;
  const runName = `${stamp} prompt ${promptVersionOf(loadSystemPrompt())}`;
  const cases = await prepareSets(setsAsked(process.argv));

  console.log(`Interview regression set: ${cases.length} runs (${[...new Set(cases.map(c => c.set))].join(" and ")}), model ${model}`);
  console.log(`Dataset run: ${runName}`);
  console.log("");

  // The interview runs in this process, the way the API runs it, with the plan checked
  // in-process too: there is no API to start.
  const outDir = path.resolve("eval-results", `interview-${stamp.replace(/[ :]/g, "-")}`);
  const rows = await evaluate({ cases, runName, model, outDir, log: line => console.log(`  ${line}`) });

  console.log("");
  for (const line of summaryLines(rows)) console.log(line);

  // Read once every app has run, so LangFuse has had the most time to take them in.
  // A cost that cannot be read is said, and does not change whether the set passed.
  console.log("");
  console.log("  Reading what each run spent from LangFuse");
  const spent = await addCosts(rows);
  console.log("");
  for (const line of costLines(spent, model)) console.log(line);

  console.log("");
  console.log(`Each run's plan, summary and questions: ${outDir}`);
  console.log(`In LangFuse: Datasets, ${DATASET}, Experiments, then this run.`);

  process.exitCode = rows.every(allCorrect) ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch(err => {
    console.error(`The regression set could not run: ${err.message}`);
    process.exit(1);
  });
}
