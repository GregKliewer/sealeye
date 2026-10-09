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

import { allCorrect, evaluate, grade, loadCases, outcomeOf, DATASET } from "../scripts/eval-interview.js";
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
// A whole pass, offline.

const port = 3895 + Math.floor(Math.random() * 4);
const api = `http://localhost:${port}`;
let server;

before(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-eval-api-"));
  server = spawn(process.execPath, ["api/server.js"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), SEALEYE_HOME: home, HOME: home },
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
  const exporter = new InMemorySpanExporter();
  assert.equal(startTracing({ exporter }), true);

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
    apiBaseUrl: api,
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
