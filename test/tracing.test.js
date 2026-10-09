// What a trace may contain (DESIGN.md, "Tracing the interview with LangFuse"). No
// network: the export path is LangFuse's real span processor with an in-memory exporter,
// so these tests read exactly what would have left the machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";
import {
  conversationShape,
  eventAttributes,
  flushTracing,
  flushScores,
  maskSecrets,
  scoreDeploymentOutcome,
  scoreTrace,
  startTracing,
  toolAttributes,
  traceEvent,
  traceRun,
  traceTool,
  traceTurn,
  turnOutput,
  usageDetails,
  useScoreSender
} from "../core/tracing.js";

const root = path.resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------------------------
// The mask, one test per pattern.

const SECRETS = {
  "an AWS access key id": ["key AKIAIOSFODNN7EXAMPLE here", "AKIAIOSFODNN7EXAMPLE"],
  "an AWS temporary key id": ["ASIAIOSFODNN7EXAMPLE", "ASIAIOSFODNN7EXAMPLE"],
  "an Anthropic key": ["use sk-ant-api03-abcdefghijklmnop", "sk-ant-api03-abcdefghijklmnop"],
  "a LangFuse secret key": ["sk-lf-1234abcd-5678efgh", "sk-lf-1234abcd-5678efgh"],
  "a bearer token": ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload", "eyJhbGciOiJIUzI1NiJ9.payload"],
  "a private key block": [
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEA"
  ],
  "a private key cut off by the read limit": ["-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0B", "MIIEvQIBADANBgkqhkiG9w0B"],
  "a NAME=value line with KEY": ["STRIPE_API_KEY=pk_live_51abc", "pk_live_51abc"],
  "a NAME=value line with SECRET": ["export CLIENT_SECRET=s3cr3t-value", "s3cr3t-value"],
  "a NAME=value line with TOKEN": ["GITHUB_TOKEN = ghp_abc123", "ghp_abc123"],
  "a NAME=value line with PASSWORD": ['DB_PASSWORD="hunter2 two"', "hunter2 two"],
  "a lowercase name": ["db_password=hunter2", "hunter2"]
};

for (const [what, [text, secret]] of Object.entries(SECRETS)) {
  test(`the mask redacts ${what}`, () => {
    const masked = maskSecrets(text);
    assert.ok(!masked.includes(secret), masked);
    assert.match(masked, /\[value redacted\]/);
  });
}

test("the mask keeps the setting name, so a reader knows what was there", () => {
  assert.equal(maskSecrets("DB_PASSWORD=hunter2"), "DB_PASSWORD=[value redacted]");
});

test("the mask keeps serialized JSON valid", () => {
  const data = JSON.stringify({ text: 'API_KEY="abc def"', nested: ["sk-ant-abcdefghijk", 3] });
  const masked = JSON.parse(maskSecrets(data));
  assert.equal(masked.text, "API_KEY=[value redacted]");
  assert.deepEqual(masked.nested, ["[value redacted]", 3]);
});

test("the mask leaves ordinary text alone and is safe to run twice", () => {
  const plain = "PORT=3000 and a primary key on the users table";
  assert.equal(maskSecrets(plain), plain);
  const once = maskSecrets("TOKEN=abc");
  assert.equal(maskSecrets(once), once);
});

// ---------------------------------------------------------------------------------
// What each helper may record, by construction.

test("the conversation shape holds no block contents", () => {
  const messages = [
    { role: "user", content: "Folder name: demo" },
    { role: "assistant", content: [{ type: "tool_use", name: "read_file", input: { path: "index.js" } }] },
    { role: "user", content: [{ type: "tool_result", content: "const secret = 'FILE BODY';" }] }
  ];
  const shape = JSON.stringify(conversationShape(messages));
  assert.ok(!shape.includes("FILE BODY"));
  assert.ok(!shape.includes("Folder name"));
  assert.match(shape, /"path":"index.js"/);
  assert.match(shape, /"chars":27/);
});

test("a turn's output records the plan whole and other tool calls by path only", () => {
  const out = turnOutput({
    content: [
      { type: "tool_use", name: "read_file", input: { path: "a.js", extra: "x" } },
      { type: "tool_use", name: "submit_plan", input: { plan: { app: "demo" } } }
    ]
  });
  assert.deepEqual(out[0], { type: "tool_use", name: "read_file", path: "a.js" });
  assert.deepEqual(out[1].input, { plan: { app: "demo" } });
});

test("traceTool's fields drop content, whatever the caller passes", () => {
  const attrs = toolAttributes({ name: "read_file", path: "x.js", bytes: 10, content: "FILE BODY", text: "FILE BODY" });
  assert.deepEqual(attrs, { name: "read_file", path: "x.js", bytes: 10 });
});

test("a tool name the model made up is not recorded as given", () => {
  assert.equal(toolAttributes({ name: "drop_tables; sk-ant-abcdefghijk" }).name, "unknown_tool");
});

test("event fields drop content and nested objects, and mask strings", () => {
  const attrs = eventAttributes({
    answer: "my TOKEN=abc123",
    fileContent: "FILE BODY",
    raw: { content: "FILE BODY" },
    errors: ["bad id", { nested: true }],
    count: 2
  });
  assert.deepEqual(attrs, { answer: "my TOKEN=[value redacted]", errors: ["bad id"], count: 2 });
});

test("usage is recorded under the names LangFuse prices by", () => {
  assert.deepEqual(
    usageDetails({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 }),
    { input: 10, output: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 }
  );
});

// ---------------------------------------------------------------------------------
// Off unless configured. A fresh process with no keys anywhere.

test("with no LangFuse keys, tracing is off and every helper passes through", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-tracing-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("LANGFUSE_") && !k.startsWith("SEALEYE_"))
  );
  const code = `
    import * as t from "./core/tracing.js";
    const started = t.startTracing();
    const run = await t.traceRun({ app: "demo" }, async r => { r.set({ status: "x" }); return "run-value"; });
    const turn = await t.traceTurn({ turn: 0 }, async h => { h.retried(new Error("e")); return "turn-value"; });
    t.traceTool({ name: "read_file", path: "a" });
    t.traceEvent("asked", { q: "?" });
    const scored = t.scoreTrace("${"0".repeat(32)}", "questions_asked", 1);
    await t.flushTracing();
    await t.flushScores();
    let thrown;
    try { await t.traceRun({ app: "demo" }, async () => { throw new TypeError("boom"); }); } catch (e) { thrown = e.name + ":" + e.message; }
    console.log(JSON.stringify({ configured: t.tracingConfigured(), started, run, turn, thrown, scored }));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: root,
    env: { ...env, HOME: home, SEALEYE_HOME: home },
    encoding: "utf8"
  });
  assert.deepEqual(JSON.parse(out), {
    configured: false,
    started: false,
    run: "run-value",
    turn: "turn-value",
    thrown: "TypeError:boom",
    scored: false
  });
});

// ---------------------------------------------------------------------------------
// On. Everything below reads what LangFuse's processor would have sent.

const exporter = new InMemorySpanExporter();
process.env.LANGFUSE_PUBLIC_KEY ||= "pk-lf-test";
process.env.LANGFUSE_SECRET_KEY ||= "sk-lf-test-only";

async function exported() {
  await flushTracing();
  return exporter.getFinishedSpans();
}

test("with keys, a run is one trace: the run, its turn, its tool calls and its events", async () => {
  assert.equal(startTracing({ exporter }), true);
  exporter.reset();

  const FILE_BODY = "module.exports = { stripeKey: process.env.KEY } // FILE BODY";
  const result = await traceRun(
    { app: "beneficiary-lookup-api", mode: "first run", model: "claude-sonnet-5", promptSha: "abc123", user: "greg" },
    async run => {
      await traceTurn(
        {
          turn: 0,
          model: "claude-sonnet-5",
          messages: [
            { role: "user", content: "Folder name: beneficiary-lookup-api" },
            { role: "assistant", content: [{ type: "tool_use", name: "read_file", input: { path: "index.js" } }] },
            { role: "user", content: [{ type: "tool_result", content: FILE_BODY }] }
          ]
        },
        async turn => {
          turn.retried(Object.assign(new Error("overloaded"), { name: "APIError", status: 529 }));
          return {
            content: [{ type: "text", text: "Does it need to remember anything between requests?" }],
            usage: { input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 900 },
            stop_reason: "end_turn"
          };
        }
      );
      traceTool({ name: "read_file", path: "index.js", bytes: FILE_BODY.length, truncated: false, content: FILE_BODY });
      traceTool({ name: "read_file", path: ".env", refused: ".env holds secret values; read .env.example instead, if there is one" });
      traceEvent("answer", { text: "no, and the key is API_KEY=sk-ant-abcdefghijklmnop" });
      run.set({ status: "submitted", questions: 1 });
      return { status: "submitted", traceId: run.traceId };
    }
  );

  assert.equal(result.status, "submitted");
  const spans = await exported();
  assert.deepEqual(spans.map(s => s.name).sort(), ["answer", "read_file", "read_file", "sealeye run", "turn 1"]);
  assert.ok(spans.every(s => s.spanContext().traceId === result.traceId), "all in one trace");

  const all = JSON.stringify(spans.map(s => s.attributes));
  assert.ok(!all.includes("FILE BODY"), "no file contents in any exported field");
  assert.ok(!all.includes("sk-ant-abcdefghijklmnop"), "no keys in any exported field");

  const turn = spans.find(s => s.name === "turn 1").attributes;
  assert.equal(turn["langfuse.observation.type"], "generation");
  assert.deepEqual(JSON.parse(turn["langfuse.observation.usage_details"]), {
    input: 1200, output: 40, cache_read_input_tokens: 900
  });
  assert.equal(turn["langfuse.observation.metadata.retried"], "true");
  assert.equal(turn["session.id"], "beneficiary-lookup-api");

  const refused = spans.find(s => s.name === "read_file" && s.attributes["langfuse.observation.output"].includes("refused"));
  assert.ok(refused, "a refused read is recorded with its reason");
});

test("with keys, the work's own error reaches the caller unchanged", async () => {
  exporter.reset();
  const boom = new RangeError("the model said no");
  await assert.rejects(
    traceRun({ app: "demo" }, async () => traceTurn({ turn: 0, model: "m", messages: [] }, async () => { throw boom; })),
    err => err === boom
  );
  const spans = await exported();
  const turn = spans.find(s => s.name === "turn 1");
  assert.equal(turn.attributes["langfuse.observation.level"], "ERROR");
  assert.equal(turn.attributes["langfuse.observation.status_message"], "RangeError");
});

test("with keys, a broken exporter never breaks a run", async () => {
  const original = exporter.export.bind(exporter);
  exporter.export = () => { throw new Error("network down"); };
  try {
    const value = await traceRun({ app: "demo" }, async () => "still fine");
    assert.equal(value, "still fine");
    await flushTracing(500);
  } finally {
    exporter.export = original;
  }
});

// ---------------------------------------------------------------------------------
// Scores. A stand-in sender records what would have been sent.

function fakeSender() {
  const sent = [];
  useScoreSender(body => { sent.push(body); });
  return sent;
}

const TRACE = "fedcba9876543210fedcba9876543210";

test("a score has a fixed id per trace, so a same-day re-read replaces it", async () => {
  const sent = fakeSender();
  scoreTrace(TRACE, "questions_asked", 2);
  scoreTrace(TRACE, "questions_asked", 3);
  await flushScores();
  assert.deepEqual(sent.map(b => b.id), [`${TRACE}-questions_asked`, `${TRACE}-questions_asked`]);
  assert.deepEqual(sent[1], { id: `${TRACE}-questions_asked`, traceId: TRACE, name: "questions_asked", value: 3, dataType: "NUMERIC" });
});

test("yes-or-no scores are sent as 1 and 0", async () => {
  const sent = fakeSender();
  scoreTrace(TRACE, "developer_said_yes", true);
  scoreTrace(TRACE, "needs_refused", false);
  await flushScores();
  assert.deepEqual(sent.map(b => [b.name, b.value, b.dataType]), [
    ["developer_said_yes", 1, "BOOLEAN"],
    ["needs_refused", 0, "BOOLEAN"]
  ]);
});

test("unknown names, bad trace ids and values of the wrong kind are not sent", async () => {
  const sent = fakeSender();
  assert.equal(scoreTrace(TRACE, "developer_comment", 1), false);
  assert.equal(scoreTrace("not-a-trace", "questions_asked", 1), false);
  assert.equal(scoreTrace(undefined, "questions_asked", 1), false);
  assert.equal(scoreTrace(TRACE, "developer_said_yes", "yes"), false);
  assert.equal(scoreTrace(TRACE, "questions_asked", "four"), false);
  await flushScores();
  assert.deepEqual(sent, []);
});

test("a deployment is scored only on a final status read from the platform", async () => {
  const sent = fakeSender();
  const origin = { traceId: TRACE };
  for (const status of ["running", "destroying", "destroyed", "drafted", undefined]) {
    assert.equal(scoreDeploymentOutcome({ status, origin }), false, String(status));
  }
  assert.equal(scoreDeploymentOutcome({ status: "succeeded" }), false, "no trace, no score");
  scoreDeploymentOutcome({ status: "succeeded", origin });
  scoreDeploymentOutcome({ status: "failed", origin });
  await flushScores();
  assert.deepEqual(sent.map(b => [b.name, b.value]), [["deployment_succeeded", 1], ["deployment_succeeded", 0]]);
});

test("a score that cannot be sent is dropped, and flushScores never throws", async () => {
  useScoreSender(() => { throw new Error("network down"); });
  scoreTrace(TRACE, "questions_asked", 1);
  await flushScores(200);
  const sent = fakeSender();
  await flushScores();
  assert.deepEqual(sent, [], "a failed score is not sent again");
});
