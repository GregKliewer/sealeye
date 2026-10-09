// The real interview loop, with tracing on, against a scripted model: what a run sends
// to LangFuse, read from LangFuse's own span processor through an in-memory exporter.
// The API runs on a spare port for plan validation. No AWS, no model calls, no network
// beyond localhost.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import YAML from "yaml";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";

const root = path.resolve(import.meta.dirname, "..");
const port = 3990 + Math.floor(Math.random() * 9);
const api = `http://localhost:${port}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-trace-api-"));
let server;

before(async () => {
  server = spawn(process.execPath, ["api/server.js"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), SEALEYE_HOME: home, HOME: home },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  server.stdout.on("data", d => (log += d));
  server.stderr.on("data", d => (log += d));
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${api}/health`)).ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`API did not start:\n${log}`);
});

after(() => server?.kill());

const ENV_SECRET = "sk-live-from-the-dotenv";
const ANSWER_SECRET = "sk-ant-api03-answeranswer";

function staticApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-trace-app-"));
  const app = path.join(dir, "static-website");
  fs.cpSync(path.join(root, "apps", "static-website"), app, { recursive: true });
  fs.writeFileSync(path.join(app, ".env"), `STRIPE_KEY=${ENV_SECRET}\n`);
  return app;
}

const usage = n => ({ input_tokens: 1000 + n, output_tokens: 50, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 });
const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });

// The model's side of a short, realistic run.
function scriptedClient(plan) {
  const turns = [
    () => { throw Object.assign(new Error("overloaded"), { status: 529, name: "APIError" }); },
    () => ({ content: [toolUse("t1", "list_files", { path: "." })], usage: usage(1), stop_reason: "tool_use" }),
    () => ({
      content: [toolUse("t2", "read_file", { path: ".env" }), toolUse("t3", "read_file", { path: "index.html" })],
      usage: usage(2),
      stop_reason: "tool_use"
    }),
    () => ({ content: [{ type: "text", text: "Who is this site for?" }], usage: usage(3), stop_reason: "end_turn" }),
    () => ({
      content: [toolUse("t4", "submit_plan", { plan, summary: "A static site.", assumptions: [] })],
      usage: usage(4),
      stop_reason: "tool_use"
    })
  ];
  let i = 0;
  return { messages: { create: async () => turns[i++]() } };
}

test("one run sends one trace, and nothing from the folder's files is in it", async () => {
  process.env.LANGFUSE_PUBLIC_KEY ||= "pk-lf-test";
  process.env.LANGFUSE_SECRET_KEY ||= "sk-lf-test-only";
  const { startTracing, flushTracing, flushScores, useLangfuseTransport } = await import("../core/tracing.js");
  const { runInterview } = await import("../cli/interview/loop.js");

  const exporter = new InMemorySpanExporter();
  assert.equal(startTracing({ exporter }), true);
  const scores = [];
  useLangfuseTransport((method, apiPath, body) => { scores.push(body); return {}; });

  const app = staticApp();
  const indexHtml = fs.readFileSync(path.join(app, "index.html"), "utf8");
  const plan = YAML.parse(fs.readFileSync(path.join(root, "plans", "static-plan.yaml"), "utf8"));

  const result = await runInterview({
    appPath: app,
    apiBaseUrl: api,
    model: "claude-sonnet-5",
    user: "greg",
    client: scriptedClient(plan),
    ask: async () => `Customers. Our key is ${ANSWER_SECRET}`
  });
  await flushTracing();
  await flushScores();

  assert.equal(result.status, "submitted", JSON.stringify(result.errors || result.message));
  assert.match(result.traceId, /^[0-9a-f]{32}$/);

  const spans = exporter.getFinishedSpans();
  assert.ok(spans.every(s => s.spanContext().traceId === result.traceId), "one trace");

  const names = spans.map(s => s.name).sort();
  assert.deepEqual(names, [
    "answer given",
    "list_files",
    "plan checked",
    "question asked",
    "read_file",
    "read_file",
    "sealeye run",
    "turn 1",
    "turn 2",
    "turn 3",
    "turn 4"
  ]);

  // The point of D2: nothing from inside the developer's files, and no secrets.
  // Attribute values as they are sent, joined without re-serializing: a fragment with
  // quotes in it would be escaped once more and never match, so the fragments searched
  // for are plain text.
  const everything = spans.flatMap(s => Object.values(s.attributes).map(String)).join("\n");
  const fragments = (indexHtml.match(/[A-Za-z][A-Za-z ,.'-]{24,}/g) || []).map(f => f.trim());
  assert.ok(fragments.length > 0, "the fixture has plain text worth looking for");
  for (const fragment of fragments) {
    assert.ok(!everything.includes(fragment), `index.html contents leaked: ${fragment}`);
  }
  assert.ok(!everything.includes(ENV_SECRET), "no .env contents");
  assert.ok(!everything.includes(ANSWER_SECRET), "an answer's secret is masked");

  const attrs = name => spans.filter(s => s.name === name).map(s => s.attributes);
  const [root_] = attrs("sealeye run");
  assert.equal(root_["session.id"], "static-website");
  assert.equal(root_["user.id"], "greg");
  assert.deepEqual(JSON.parse(root_["langfuse.observation.output"]), { status: "submitted", questions: 1 });

  const [turn1] = attrs("turn 1");
  assert.equal(turn1["langfuse.observation.metadata.retried"], "true", "the retry is on the same turn");
  assert.ok(turn1["langfuse.observation.usage_details"], "usage recorded");

  const reads = attrs("read_file").map(a => JSON.parse(a["langfuse.observation.output"]));
  const dotenv = reads.find(r => r.path === ".env");
  const index = reads.find(r => r.path === "index.html");
  assert.match(dotenv.refused, /holds secret values/);
  assert.equal(index.bytes, Buffer.byteLength(indexHtml));

  const [checked] = attrs("plan checked");
  assert.equal(JSON.parse(checked["langfuse.observation.output"]).valid, true);

  const [answer] = attrs("answer given");
  assert.match(answer["langfuse.observation.input"], /\[value redacted\]/);

  // The interview's own scores, against this trace. The rest come from the CLI at
  // "Deploy this?" and when a deployment finishes.
  assert.ok(scores.every(b => b.traceId === result.traceId));
  assert.deepEqual(
    Object.fromEntries(scores.map(b => [b.name, b.value])),
    { questions_asked: 1, plan_valid_first_try: 1, validation_retries: 0 }
  );
});
