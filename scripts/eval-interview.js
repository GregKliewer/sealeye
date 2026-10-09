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
// It calls the model and LangFuse, so it is not part of `npm test`, which stays offline.
// The API it validates plans against is started here, on a spare port with an empty
// store of its own, so nothing is added to your deployment records.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { runInterview, resolveApiKey, DEFAULT_MODEL } from "../cli/interview/loop.js";
import { loadEnv, loadUserConfig, repoRoot, setting } from "../core/config.js";
import {
  flushScores,
  flushTracing,
  langfuseRequest,
  newExperimentId,
  promptVersion,
  scoreTrace,
  startTracing,
  traceExperimentItem,
  tracingConfigured
} from "../core/tracing.js";

export const DATASET = "sealeye-interview";
const FIXTURES = path.join(repoRoot, "test", "fixtures", "eval");
// When the scripted answers run out, the interview still gets an answer a developer
// might give, rather than an empty line.
const FALLBACK_ANSWER = "I'm not sure. Use your best judgement from the code.";

/** Every sample app with a fixture: its answers and what its plan should be. */
export function loadCases(dir = FIXTURES) {
  return fs
    .readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .sort()
    .map(f => {
      const { answers = [], expected } = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      return { app: path.basename(f, ".json"), answers, expected };
    });
}

/** What the run came to: a ready or drafted plan, or how the interview ended without one. */
export function outcomeOf(result) {
  if (result?.status !== "submitted") return result?.status || "error";
  return (result.plan?.needs || []).length > 0 ? "drafted" : "ready";
}

/**
 * Compare a run with what its app is known to need. Modules are graded only when the
 * fixture names them: a drafted plan is graded on its needs.
 */
export function grade(result, expected) {
  const outcome = outcomeOf(result);
  const modules = (result?.plan?.modules || []).filter(m => m.enabled !== false).map(m => m.id).sort();
  const needs = [...new Set((result?.plan?.needs || []).map(n => n.kind))].sort();
  const wantNeeds = [...(expected.needs || [])].sort();

  const modulesCorrect = expected.modules
    ? expected.modules.every(m => modules.includes(m)) && (expected.notModules || []).every(m => !modules.includes(m))
    : null;

  return {
    outcome,
    outcomeCorrect: outcome === expected.status,
    modules,
    modulesCorrect,
    needs,
    needsCorrect: needs.length === wantNeeds.length && needs.every((n, i) => n === wantNeeds[i]),
    missingNeeds: wantNeeds.filter(n => !needs.includes(n)),
    extraNeeds: needs.filter(n => !wantNeeds.includes(n)),
    questions: result?.questions ?? 0
  };
}

/** Is the whole row right? Modules count only where they were graded. */
export function allCorrect(row) {
  return !row.error && row.outcomeCorrect && row.needsCorrect && row.modulesCorrect !== false;
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
export async function evaluate({ cases, apiBaseUrl, runName, model, clientFor, log = () => {} }) {
  const datasetId = await ensureDataset();
  const description = `Interview prompt ${promptVersion()}, model ${model}`;
  const experimentId = newExperimentId();

  const rows = [];
  for (const { app, answers, expected } of cases) {
    const itemId = `${DATASET}-${app}`;
    // The input is the app's name, never its files: the dataset is a list of what to
    // run and what should come of it.
    await langfuseRequest("POST", "/api/public/dataset-items", {
      datasetName: DATASET,
      id: itemId,
      input: { app },
      expectedOutput: expected
    }, 10_000);

    log(`${app}: interviewing`);
    const queue = [...answers];
    let row;

    try {
      // Recorded the way LangFuse's own experiment runner records an item, so the run
      // shows under the dataset's Experiments with each app's trace, cost and scores.
      row = await traceExperimentItem(
        { experimentId, runName, description, datasetId, itemId, input: { app }, expectedOutput: expected },
        async () => {
          const result = await runInterview({
            appPath: path.join(repoRoot, "apps", app),
            apiBaseUrl,
            model,
            user: "eval",
            ask: async () => (queue.length ? queue.shift() : FALLBACK_ANSWER),
            ...(clientFor ? { client: clientFor(app) } : {})
          });
          return { app, traceId: result.traceId, ...grade(result, expected) };
        }
      );
      await flushTracing();

      if (row.traceId) {
        scoreTrace(row.traceId, "outcome_correct", row.outcomeCorrect);
        scoreTrace(row.traceId, "needs_correct", row.needsCorrect);
        if (row.modulesCorrect !== null) scoreTrace(row.traceId, "modules_correct", row.modulesCorrect);
      }
    } catch (err) {
      row = { app, error: err.message };
    }

    rows.push(row);
    log(`${app}: ${row.error ? `could not finish (${row.error})` : allCorrect(row) ? "as expected" : "not as expected"}`);
  }

  await flushScores(10_000);
  return rows;
}

/** One line per app, for the terminal. */
export function summaryLines(rows) {
  const mark = ok => (ok === null ? "  " : ok ? "ok" : "NO");
  const lines = [];
  for (const r of rows) {
    if (r.error) {
      lines.push(`  ${r.app.padEnd(26)} could not finish: ${r.error}`);
      continue;
    }
    lines.push(
      `  ${r.app.padEnd(26)} ${mark(r.outcomeCorrect)} ${r.outcome.padEnd(8)}` +
        ` ${mark(r.modulesCorrect)} modules  ${mark(r.needsCorrect)} needs  ${r.questions} question${r.questions === 1 ? "" : "s"}`
    );
    if (r.missingNeeds.length) lines.push(`  ${"".padEnd(26)}    missing: ${r.missingNeeds.join(", ")}`);
    if (r.extraNeeds.length) lines.push(`  ${"".padEnd(26)}    not expected: ${r.extraNeeds.join(", ")}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------------

async function startApi() {
  const port = 3800 + Math.floor(Math.random() * 90);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-eval-"));
  const server = spawn(process.execPath, ["api/server.js"], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port), SEALEYE_HOME: home },
    stdio: "ignore"
  });
  const apiBaseUrl = `http://localhost:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${apiBaseUrl}/health`)).ok) return { server, apiBaseUrl };
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  server.kill();
  throw new Error("the API did not start");
}

async function main() {
  loadEnv();
  loadUserConfig();

  if (!resolveApiKey()) {
    console.error("ANTHROPIC_API_KEY is not set. Put it in ~/.sealeye/config and run this again.");
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
  const runName = `${stamp} prompt ${promptVersion()}`;
  const cases = loadCases();

  console.log(`Interview regression set: ${cases.length} apps, model ${model}`);
  console.log(`Dataset run: ${runName}`);
  console.log("");

  const { server, apiBaseUrl } = await startApi();
  let rows;
  try {
    rows = await evaluate({ cases, apiBaseUrl, runName, model, log: line => console.log(`  ${line}`) });
  } finally {
    server.kill();
  }

  console.log("");
  for (const line of summaryLines(rows)) console.log(line);
  console.log("");
  console.log(`In LangFuse: Datasets, ${DATASET}, Experiments, then this run.`);

  process.exitCode = rows.every(allCorrect) ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch(err => {
    console.error(`The regression set could not run: ${err.message}`);
    process.exit(1);
  });
}
