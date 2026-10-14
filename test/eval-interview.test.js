// The interview regression set (scripts/eval-interview.js), offline: grading on its own,
// then a whole pass over the three fixtures with a scripted model, the real API on a
// spare port, and a stand-in for LangFuse that records every request it would have got.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import YAML from "yaml";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";

import {
  addCosts,
  allCorrect,
  costLines,
  evaluate,
  grade,
  largestAndTypical,
  loadCases,
  outcomeOf,
  readRunCost,
  sumGenerations,
  DATASET
} from "../scripts/eval-interview.js";
import { startTracing, useLangfuseTransport } from "../core/tracing.js";

const root = path.resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------------------------
// Grading.

const FIVE = ["continuous_service", "event_stream", "internal_only", "relational_database", "runtime_secrets"];
const need = kind => ({ kind, line: kind, evidence: [{ file: "index.js", shows: "x" }] });
const staticPlan = { modules: [{ id: "static_site_edge", enabled: true }, { id: "http_api_serverless", enabled: false }], needs: [] };

test("every sample app has a fixture, and every fixture an app", () => {
  const apps = fs.readdirSync(path.join(root, "apps"), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
  assert.deepEqual(loadCases().map(c => c.app), apps);
});

test("a submitted plan is ready or drafted by its needs; anything else keeps its status", () => {
  assert.equal(outcomeOf({ status: "submitted", plan: staticPlan }), "ready");
  assert.equal(outcomeOf({ status: "submitted", plan: { needs: [need("event_stream")] } }), "drafted");
  assert.equal(outcomeOf({ status: "stopped" }), "stopped");
  assert.equal(outcomeOf({ status: "invalid" }), "invalid");
});

test("the right building block and nothing it should not have is correct", () => {
  const expected = { status: "ready", modules: ["static_site_edge"], notModules: ["http_api_serverless"], needs: [] };
  const row = grade({ status: "submitted", plan: staticPlan, questions: 1 }, expected);
  assert.equal(row.modulesCorrect, true);
  assert.ok(allCorrect(row));

  const wrong = grade({ status: "submitted", plan: { modules: [{ id: "static_site_edge" }, { id: "http_api_serverless", enabled: true }] } }, expected);
  assert.equal(wrong.modulesCorrect, false);
  assert.ok(!allCorrect(wrong));
});

test("needs must match exactly, and the difference is named", () => {
  const expected = { status: "drafted", needs: FIVE };
  const short = grade({ status: "submitted", plan: { needs: FIVE.slice(1).map(need) } }, expected);
  assert.equal(short.needsCorrect, false);
  assert.deepEqual(short.missingNeeds, ["continuous_service"]);

  const extra = grade({ status: "submitted", plan: { needs: [...FIVE, "custom_domain"].map(need) } }, expected);
  assert.deepEqual(extra.extraNeeds, ["custom_domain"]);

  const exact = grade({ status: "submitted", plan: { needs: [...FIVE].reverse().map(need) } }, expected);
  assert.equal(exact.needsCorrect, true);
  assert.equal(exact.modulesCorrect, null, "a drafted plan is not graded on modules");
  assert.ok(allCorrect(exact));
});

test("a run that stopped instead of refusing is not correct", () => {
  const row = grade({ status: "stopped", questions: 4 }, { status: "drafted", needs: FIVE });
  assert.equal(row.outcomeCorrect, false);
  assert.ok(!allCorrect(row));
});

// ---------------------------------------------------------------------------------
// What each run spent, read back from LangFuse.

const gen = (input, output, cacheRead, cacheWrite, total, model = "claude-sonnet-5") => ({
  type: "GENERATION",
  model,
  usageDetails: { input, output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite },
  ...(total === undefined ? {} : { costDetails: { total }, totalCost: total })
});

test("a run's calls add up to its turns, tokens and cost", () => {
  const run = sumGenerations([gen(100, 20, 0, 4000, 0.02), gen(50, 30, 4000, 0, 0.005)]);
  assert.deepEqual(run, { turns: 2, input: 150, output: 50, cacheRead: 4000, cacheWrite: 4000, cost: 0.025, unpricedModels: [] });
});

test("a call LangFuse could not price leaves the run with no cost, never a cost of nothing", () => {
  const run = sumGenerations([gen(100, 20, 0, 0, 0.01), gen(100, 20, 0, 0, undefined, "claude-new")]);
  assert.equal(run.cost, null);
  assert.deepEqual(run.unpricedModels, ["claude-new"]);
});

test("the read waits until LangFuse has every call, and gives up in words", async () => {
  const seen = [[], [gen(1, 1, 0, 0, 0.1)], [gen(1, 1, 0, 0, 0.1), gen(1, 1, 0, 0, 0.1)], [gen(1, 1, 0, 0, 0.1), gen(1, 1, 0, 0, 0.1)]];
  const paths = [];
  let i = 0;
  const request = async (method, apiPath) => {
    paths.push(apiPath);
    return { data: seen[Math.min(i++, seen.length - 1)] };
  };
  const run = await readRunCost("abc", { request, pause: async () => {} });
  assert.equal(run.turns, 2);
  assert.equal(i, 4, "asked until the count held still");
  assert.match(paths[0], /^\/api\/public\/v2\/observations\?traceId=abc&type=GENERATION&/);

  const never = await readRunCost("abc", { request: async () => ({ data: [] }), pause: async () => {}, tries: 3, every: 1000 });
  assert.match(never.error, /had not recorded this run's model calls after 3 seconds/);
});

test("a row that could not be read says why, and the rest still print", async () => {
  const rows = [
    { app: "a", traceId: "t1" },
    { app: "b", error: "boom" },
    { app: "c", traceId: "t3" }
  ];
  const request = async (method, apiPath) => {
    if (apiPath.includes("t3")) throw new Error("LangFuse answered 500 to GET /api/public/v2/observations");
    return { data: [gen(1000, 200, 0, 5000, 0.05)] };
  };
  const out = await addCosts(rows, { request, pause: async () => {} });
  assert.equal(out[0].spend.turns, 1);
  assert.equal(out[1].spend.error, "the run did not finish");
  assert.match(out[2].spend.error, /answered 500/);

  const text = costLines(out, "claude-sonnet-5").join("\n");
  assert.match(text, /a\s+1\s+1,000\s+200\s+0\s+5,000\s+\$0\.0500/);
  assert.match(text, /b\s+could not read: the run did not finish/);
  assert.match(text, /Largest run: 1 turn, 6,200 tokens, \$0\.0500/);
});

test("the largest and typical runs are by cost, or by tokens when a run has no price", () => {
  const spend = (cost, tokens) => ({ spend: { turns: 1, input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, cost, unpricedModels: [] } });
  const priced = largestAndTypical([spend(0.3, 10), spend(0.1, 900), spend(0.2, 20)]);
  assert.equal(priced.by, "cost");
  assert.equal(priced.largest.cost, 0.3);
  assert.equal(priced.typical.cost, 0.2);

  const unpriced = largestAndTypical([spend(0.3, 10), spend(null, 900), spend(0.2, 20)]);
  assert.equal(unpriced.by, "tokens");
  assert.equal(unpriced.largest.input, 900);
});

test("with no price, the table says how to add one in LangFuse", () => {
  const rows = [{ app: "a", spend: sumGenerations([gen(10, 10, 0, 0, undefined)]) }];
  const text = costLines(rows, "claude-sonnet-5").join("\n");
  assert.match(text, /no price/);
  assert.match(text, /LangFuse has no price for claude-sonnet-5/);
  assert.match(text, /\^claude-sonnet-5\$/);
  assert.match(text, /run this again once it is added/);
});

// ---------------------------------------------------------------------------------
// A whole pass, offline.

const port = 3895 + Math.floor(Math.random() * 4);
// Tracing starts once per process, so both passes below share one exporter.
const exporter = new InMemorySpanExporter();
const api = `http://localhost:${port}`;
let server;

before(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-eval-api-"));
  server = spawn(process.execPath, ["api/server.js"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), SEALEYE_HOME: home, HOME: home, SEALEYE_AUTH: "off" },
    stdio: "ignore"
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${api}/health`)).ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("API did not start");
});

after(() => server?.kill());

function plans() {
  const read = f => YAML.parse(fs.readFileSync(path.join(root, "plans", f), "utf8"));
  const drafted = { ...read("static-plan.yaml"), planVersion: "0.4", app: { name: "payment-events-processor", type: "api" }, needs: FIVE.map(need) };
  return {
    "static-website": read("static-plan.yaml"),
    "beneficiary-lookup-api": read("api-plan.yaml"),
    "payment-events-processor": drafted
  };
}

// One confirmation question, then the plan.
function clientFor(plan) {
  const turns = [
    { content: [{ type: "text", text: "Is that right?" }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: "end_turn" },
    {
      content: [{ type: "tool_use", id: "t1", name: "submit_plan", input: { plan, summary: "s", assumptions: [] } }],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: "tool_use"
    }
  ];
  let i = 0;
  return { messages: { create: async () => turns[i++] } };
}

test("one pass grades all three apps and records a dataset run in LangFuse", async () => {
  process.env.LANGFUSE_PUBLIC_KEY ||= "pk-lf-test";
  process.env.LANGFUSE_SECRET_KEY ||= "sk-lf-test-only";
  assert.equal(startTracing({ exporter }), true);
  exporter.reset();

  // LangFuse answers with the ids the experiment marks need.
  const requests = [];
  useLangfuseTransport((method, apiPath, body) => {
    requests.push({ method, apiPath, body });
    if (apiPath === "/api/public/v2/datasets") return { id: "ds_1" };
    if (apiPath === "/api/public/dataset-run-items") return { datasetRunId: "run_1" };
    return {};
  });

  const byApp = plans();
  const rows = await evaluate({
    cases: loadCases(),

    runName: "test run",
    model: "claude-sonnet-5",
    clientFor: app => clientFor(byApp[app])
  });

  for (const row of rows) assert.ok(allCorrect(row), JSON.stringify(row));
  assert.deepEqual(rows.map(r => r.outcome), ["ready", "drafted", "ready"]);

  const posts = path => requests.filter(r => r.method === "POST" && r.apiPath === path).map(r => r.body);

  assert.deepEqual(posts("/api/public/v2/datasets").map(b => b.name), [DATASET]);

  const items = posts("/api/public/dataset-items");
  assert.deepEqual(items.map(b => b.id), rows.map(r => `${DATASET}-${r.app}`));
  assert.ok(items.every(b => Object.keys(b.input).join() === "app"), "an item's input is the app's name, never its files");

  const links = posts("/api/public/dataset-run-items");
  assert.deepEqual(links.map(b => b.traceId), rows.map(r => r.traceId));
  assert.ok(links.every(b => b.runName === "test run" && b.observationId), "linked to each item's root span");

  // What the Experiments view is built from, as LangFuse's own runner leaves it.
  const spans = exporter.getFinishedSpans();
  const roots = spans.filter(sp => sp.name === "experiment-item-run");
  assert.equal(roots.length, 3);
  for (const root of roots) {
    assert.equal(root.attributes["langfuse.environment"], "sdk-experiment");
    assert.ok(root.attributes["langfuse.experiment.item.expected_output"]);
  }
  const marked = spans.filter(sp => sp.name === "sealeye run");
  assert.equal(marked.length, 3);
  for (const sp of marked) {
    assert.equal(sp.attributes["langfuse.experiment.id"], "run_1");
    assert.equal(sp.attributes["langfuse.experiment.name"], "test run");
    assert.equal(sp.attributes["langfuse.experiment.dataset.id"], "ds_1");
    assert.match(sp.attributes["langfuse.experiment.item.id"], /^sealeye-interview-/);
    const root = roots.find(r => r.spanContext().traceId === sp.spanContext().traceId);
    assert.equal(sp.attributes["langfuse.experiment.item.root_observation_id"], root.spanContext().spanId);
  }

  const scores = posts("/api/public/scores");
  const named = name => scores.filter(s => s.name === name).map(s => s.value);
  assert.deepEqual(named("outcome_correct"), [1, 1, 1]);
  assert.deepEqual(named("needs_correct"), [1, 1, 1]);
  assert.deepEqual(named("modules_correct"), [1, 1], "the drafted app is not graded on modules");
});

test("with the older dataset-run link refused, a run still records as one experiment", async () => {
  assert.equal(startTracing({ exporter }), true);
  exporter.reset();
  const requests = [];
  useLangfuseTransport((method, apiPath, body) => {
    requests.push({ method, apiPath, body });
    if (apiPath === "/api/public/dataset-run-items") {
      const err = new Error("LangFuse answered 410 to POST /api/public/dataset-run-items");
      err.status = 410;
      throw err;
    }
    if (apiPath === "/api/public/v2/datasets") return { id: "ds_1" };
    return {};
  });

  const byApp = plans();
  const rows = await evaluate({
    cases: loadCases(),

    runName: "refused link run",
    model: "claude-sonnet-5",
    clientFor: app => clientFor(byApp[app])
  });
  for (const row of rows) assert.ok(allCorrect(row), JSON.stringify(row));

  // No run id came back, so the run's own id marks all three apps, the same one.
  const ids = new Set(exporter.getFinishedSpans().filter(sp => sp.name === "sealeye run").map(sp => sp.attributes["langfuse.experiment.id"]));
  assert.equal(ids.size, 1);
  assert.match([...ids][0], /^[0-9a-f]{16}$/);
});
