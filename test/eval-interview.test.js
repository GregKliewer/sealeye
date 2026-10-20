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
  answerFor,
  summaryLines,
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
import { freePort } from "./helpers/free-port.js";

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

test("each question gets the answer written for it, whatever order the model asks in", () => {
  const answers = [
    { when: ["setting", "environment"], answer: "No, nothing else." },
    { when: ["is that right", "when it runs"], answer: "Yes, it answers requests." }
  ];
  const settings = "Does your app read any settings from the environment?";
  const confirm = "This looks like an API. Is that right?";
  for (const order of [[settings, confirm], [confirm, settings]]) {
    const state = {};
    const got = order.map(q => answerFor(q, answers, state).answer);
    assert.deepEqual(got, order.map(q => (q === settings ? "No, nothing else." : "Yes, it answers requests.")));
  }
  // The specific answer wins over the general one when a question holds both.
  assert.equal(answerFor("It reads settings from the environment, is that right?", answers).answer, "No, nothing else.");
  assert.deepEqual(answerFor("What is this for?", answers), { answer: "I'm not sure. Use your best judgement from the code.", by: "no answer fits" });

  // Plain strings still go in order, once each, as every fixture did before.
  const state = {};
  assert.deepEqual(["a?", "b?", "c?"].map(q => answerFor(q, ["one", "two"], state).answer), ["one", "two", "I'm not sure. Use your best judgement from the code."]);
});

test("every fixture's answers say which questions they answer", () => {
  for (const { app, answers } of loadCases()) {
    for (const a of answers) {
      assert.ok(a && typeof a === "object" && Array.isArray(a.when) && a.when.length && typeof a.answer === "string", `${app}: ${JSON.stringify(a)}`);
    }
  }
});

test("a run not as expected shows what was asked, how it was answered, and why it stopped", () => {
  const row = {
    app: "beneficiary-lookup-api",
    ...grade({ status: "stopped", questions: 1 }, { status: "ready", modules: ["http_api_serverless"], needs: [] }),
    asked: [{ question: "What does your app do when it runs?", by: "matched \"when it runs\"" }],
    stopped: "This version of the platform deploys sites and HTTP apps."
  };
  const lines = summaryLines([row]).join("\n");
  assert.match(lines, /asked: What does your app do when it runs\? \(matched "when it runs"\)/);
  assert.match(lines, /stopped: This version of the platform deploys sites and HTTP apps\./);
  const fine = { app: "static-website", ...grade({ status: "submitted", plan: staticPlan, questions: 1 }, { status: "ready", modules: ["static_site_edge"], needs: [] }), asked: [{ question: "x?", by: "next in order" }] };
  assert.doesNotMatch(summaryLines([fine]).join("\n"), /asked:/, "an app as expected is one line");
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

test("the read waits until LangFuse has every call the run made, and never reports part of one", async () => {
  const one = gen(1, 1, 0, 0, 0.1);
  // LangFuse makes part of a run readable, holds still, then has the rest.
  const seen = [[], [one], [one], [one], [one, one, one]];
  const paths = [];
  let i = 0;
  const request = async (method, apiPath) => {
    paths.push(apiPath);
    return { data: seen[Math.min(i++, seen.length - 1)] };
  };
  const run = await readRunCost("abc", { turns: 3, request, pause: async () => {} });
  assert.equal(run.turns, 3, "a count that held still at one was not taken as the run");
  assert.equal(i, 5);
  assert.match(paths[0], /^\/api\/public\/v2\/observations\?traceId=abc&type=GENERATION&/);

  const partial = await readRunCost("abc", { turns: 6, request: async () => ({ data: [one] }), pause: async () => {}, tries: 3, every: 1000 });
  assert.match(partial.error, /after 3 seconds LangFuse had 1 of this run's 6 model calls/);

  const unknown = await readRunCost("abc", { request, pause: async () => {} });
  assert.match(unknown.error, /did not say how many model calls it made/);
});

test("a row that could not be read says why, and the rest still print", async () => {
  const rows = [
    { app: "a", traceId: "t1", turns: 1 },
    { app: "b", error: "boom" },
    { app: "c", traceId: "t3", turns: 1 }
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

const port = await freePort();
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
  assert.deepEqual(rows.map(r => r.turns), [2, 2, 2], "each run says how many model calls it made");

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

test("a run whose own count differs from LangFuse's by more than five percent is flagged", async () => {
  const { costLines } = await import("../scripts/eval-interview.js");
  const spend = cost => ({ turns: 2, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost, unpricedModels: [] });
  const text = costLines([
    { app: "close", spent: 0.0102, spend: spend(0.01) },
    { app: "far", spent: 0.02, spend: spend(0.01) }
  ], "claude-sonnet-5").join("\n");
  assert.match(text, /far: seaLeye's own count, \$0\.0200, differs from LangFuse's, \$0\.0100, by more than 5%\./);
  assert.doesNotMatch(text, /close: seaLeye's own count/);
});

// ---------------------------------------------------------------------------------
// Juniper Mutual's set (PHASE4-PLAN Step 8): the same apps, planned against the catalog
// discovery wrote for the made-up organization, its Terraform modules treated as built
// for the eval only.

test("every Juniper case is a sample app, and names only modules its catalog has", async () => {
  const { SETS } = await import("../scripts/eval-interview.js");
  const apps = new Set(fs.readdirSync(path.join(root, "apps")));
  const doc = JSON.parse(fs.readFileSync(SETS.juniper.catalog, "utf8"));
  const ids = new Set(doc.modules.map(m => m.id));
  const kinds = new Set(doc.need_kinds.map(n => n.key));
  const cases = loadCases(SETS.juniper.dir, { set: "juniper", org: SETS.juniper.org });
  assert.ok(cases.length >= 3);
  for (const c of cases) {
    assert.ok(apps.has(c.app), c.app);
    for (const id of [...(c.expected.modules || []), ...(c.expected.notModules || [])]) assert.ok(ids.has(id), `${c.app}: ${id}`);
    for (const k of c.expected.needs) assert.ok(kinds.has(k), `${c.app}: ${k}`);
  }
  assert.ok(!JSON.stringify(doc).includes("@"), "the snapshot holds no one's address");
});

test("treated as built for the eval only: a Terraform module is planned, and the real executor comes back after", async () => {
  const { builtAsBefore, treatAsBuilt } = await import("../scripts/eval-interview.js");
  const { EXECUTORS } = await import("../core/schema.js");
  const { buildableModules } = await import("../core/catalog.js");
  const real = EXECUTORS.terraform;
  const doc = { modules: [
    { id: "web", availability: "available", builds_with: "terraform" },
    { id: "old", availability: "deprecated", builds_with: "terraform" },
    { id: "guess", availability: "available", builds_with: "terraform", open: ["q_1"] }
  ] };
  // The real executor builds none of it: nothing says how a module takes an app.
  assert.deepEqual(buildableModules(doc), []);
  try {
    assert.equal(treatAsBuilt(doc), true);
    assert.deepEqual(buildableModules(doc).map(m => m.id), ["web"], "still not what is deprecated or rests on a question");
    assert.deepEqual(EXECUTORS.terraform, ["web", "old", "guess"]);
  } finally {
    builtAsBefore();
  }
  assert.equal(EXECUTORS.terraform, real, "the real executor is back");
});

test("Juniper's set plans each app against its live catalog, graded on Juniper's modules", async () => {
  const { builtAsBefore, prepareSets, promptFor } = await import("../scripts/eval-interview.js");
  assert.equal(startTracing({ exporter }), true);
  const requests = [];
  useLangfuseTransport((method, apiPath, body) => {
    requests.push({ method, apiPath, body });
    if (apiPath === "/api/public/v2/datasets") return { id: "ds_1" };
    if (apiPath === "/api/public/dataset-run-items") return { datasetRunId: "run_1" };
    return {};
  });
  const before = process.env.SEALEYE_HOME;
  try {
    const cases = await prepareSets(["juniper"]);
    assert.ok(cases.every(c => c.set === "juniper" && c.org === "eval-juniper"));
    const juniperPrompt = promptFor("eval-juniper");
    assert.notEqual(juniperPrompt, promptFor(null), "Juniper's interview reads a prompt of its own");

    const plan = (app, type, modules, needs = []) => ({ planVersion: "0.4", app: { name: app, type }, profile: "dev", modules, outputs: ["logs"], ...(needs.length ? { needs } : {}) });
    const on = (id, inputs = {}) => ({ id, enabled: true, inputs });
    const byApp = {
      "static-website": plan("static-website", "static-site", [on("static_site", { index_document: "index.html" }), on("logs_and_alarms")]),
      "beneficiary-lookup-api": plan("beneficiary-lookup-api", "api", [on("http_api"), on("logs_and_alarms")]),
      "payment-events-processor": plan("payment-events-processor", "api", [on("container_service"), on("postgres"), on("secrets", { secret_names: ["SIGNING_KEY"] })],
        [need("event_stream")])
    };
    const systems = [];
    const clientWith = p => {
      const c = clientFor(p);
      return { messages: { create: async params => { systems.push(typeof params.system === "string" ? params.system : JSON.stringify(params.system)); return c.messages.create(params); } } };
    };
    const rows = await evaluate({ cases, runName: "juniper run", model: "claude-sonnet-5", clientFor: app => clientWith(byApp[app]) });

    for (const row of rows) assert.ok(allCorrect(row), JSON.stringify(row));
    assert.deepEqual(rows.map(r => r.app), ["juniper-beneficiary-lookup-api", "juniper-payment-events-processor", "juniper-static-website"]);
    assert.deepEqual(rows.map(r => r.outcome), ["ready", "drafted", "ready"]);
    assert.ok(systems.length && systems.every(s => s.includes("`container_service`")), "the model was told Juniper's modules");

    const items = requests.filter(r => r.method === "POST" && r.apiPath === "/api/public/dataset-items").map(r => r.body);
    assert.deepEqual(items.map(b => b.id), rows.map(r => `${DATASET}-${r.app}`));
    assert.ok(items.every(b => b.input.catalog === "juniper"));
  } finally {
    builtAsBefore();
    if (before === undefined) delete process.env.SEALEYE_HOME;
    else process.env.SEALEYE_HOME = before;
  }
});

test("what the plan connects is graded only when the fixture says what the app reads, and is named when wrong", () => {
  const expected = { status: "ready", modules: ["http_api", "document_table"], connect: { table_name: "ORDERS_TABLE" }, needs: [] };
  const wired = { modules: [{ id: "http_api", enabled: true }, { id: "document_table", enabled: true, connect: { table_name: "ORDERS_TABLE" } }], needs: [] };
  const row = grade({ status: "submitted", plan: wired, questions: 1 }, expected);
  assert.equal(row.connectCorrect, true);
  assert.deepEqual(row.connections, ["table_name=ORDERS_TABLE"]);
  assert.ok(allCorrect(row));

  // The modules are right, and the table reaches the app under the wrong name.
  const misnamed = { modules: [{ id: "http_api", enabled: true }, { id: "document_table", enabled: true, connect: { table_name: "TABLE" } }], needs: [] };
  const wrong = { app: "orders-api", ...grade({ status: "submitted", plan: misnamed, questions: 1 }, expected) };
  assert.equal(wrong.modulesCorrect, true);
  assert.equal(wrong.connectCorrect, false);
  assert.deepEqual(wrong.missingConnect, ["table_name=ORDERS_TABLE"]);
  assert.ok(!allCorrect(wrong));
  const lines = summaryLines([wrong]).join("\n");
  assert.match(lines, /connected: table_name=TABLE/);
  assert.match(lines, /not connected: table_name=ORDERS_TABLE/);

  // A module switched off connects nothing, and a value the app does not read is named.
  const off = { modules: [{ id: "http_api", enabled: true }, { id: "document_table", enabled: false, connect: { table_name: "ORDERS_TABLE" } }, { id: "file_bucket", enabled: true, connect: { bucket_name: "FILES" } }], needs: [] };
  const extra = grade({ status: "submitted", plan: off, questions: 1 }, { ...expected, notConnect: ["bucket_name"] });
  assert.deepEqual(extra.connections, ["bucket_name=FILES"]);
  assert.deepEqual(extra.missingConnect, ["table_name=ORDERS_TABLE"]);
  assert.deepEqual(extra.unwantedConnect, ["bucket_name"]);
  assert.match(summaryLines([{ app: "orders-api", ...extra }]).join("\n"), /should not connect: bucket_name/);

  // A fixture that says nothing about connections grades none.
  const ungraded = grade({ status: "submitted", plan: wired, questions: 1 }, { status: "ready", modules: ["http_api"], needs: [] });
  assert.equal(ungraded.connectCorrect, null);
  assert.ok(allCorrect(ungraded));
});

test("modules not as expected say what was planned, what was missing, and what should not be there", () => {
  const expected = { status: "drafted", modules: ["container_service", "postgres", "secrets"], notModules: ["postgres_cluster"], needs: ["event_stream"] };
  const plan = { modules: [{ id: "container_service" }, { id: "postgres_cluster" }, { id: "secrets", enabled: false }], needs: [need("event_stream")] };
  const row = { app: "juniper-payment-events-processor", ...grade({ status: "submitted", plan, questions: 0 }, expected) };
  assert.deepEqual(row.missingModules, ["postgres", "secrets"]);
  assert.deepEqual(row.unwantedModules, ["postgres_cluster"]);
  const lines = summaryLines([row]).join("\n");
  assert.match(lines, /planned: container_service, postgres_cluster/);
  assert.match(lines, /missing: postgres, secrets/);
  assert.match(lines, /should not have: postgres_cluster/);
});

test("each run's plan, summary and questions are kept as a file, and a run that could not finish says why", async () => {
  assert.equal(startTracing({ exporter }), true);
  useLangfuseTransport((method, apiPath) => (apiPath === "/api/public/v2/datasets" ? { id: "ds_1" } : {}));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-eval-out-"));
  const byApp = plans();
  const broken = { messages: { create: async () => { throw Object.assign(new Error("connection dropped"), { status: 400 }); } } };
  await evaluate({
    cases: loadCases(), runName: "kept run", model: "claude-sonnet-5", outDir,
    clientFor: app => (app === "static-website" ? broken : clientFor(byApp[app]))
  });
  const kept = YAML.parse(fs.readFileSync(path.join(outDir, "beneficiary-lookup-api.yaml"), "utf8"));
  assert.equal(kept.status, "submitted");
  assert.ok(kept.plan.modules.length, "the plan as submitted");
  assert.ok(Array.isArray(kept.asked));
  const failed = YAML.parse(fs.readFileSync(path.join(outDir, "static-website.yaml"), "utf8"));
  assert.ok(failed.status === "error" || failed.message, JSON.stringify(failed));
});

test("each app is interviewed from a clean copy: a plan left in its folder is never read (Greg's run, Oct 16)", async () => {
  const { cleanCopy } = await import("../scripts/eval-interview.js");
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-eval-app-"));
  fs.writeFileSync(path.join(app, "index.js"), "console.log(1)");
  for (const f of ["sealeye.yaml", "deployme.yaml", "DEPLOYMENT_PLAN.md", "DEPLOYMENT_REPORT.md", "DEPLOYMENT_EVIDENCE.md"]) fs.writeFileSync(path.join(app, f), "profile: prod");
  fs.mkdirSync(path.join(app, ".sealeye"));
  fs.mkdirSync(path.join(app, "node_modules"));
  const copy = cleanCopy(app, fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-eval-scratch-")));
  assert.deepEqual(fs.readdirSync(copy).sort(), ["index.js"]);
  assert.deepEqual(fs.readdirSync(app).length, 8, "the app's own folder is left as it was");
});
