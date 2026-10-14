// SEALEYE_MODEL_URL: the interview's model calls go to the address it names, and
// nowhere else. A stand-in server on localhost plays the model. No network beyond it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-model-url-"));

let server;
let standIn;
const seen = [];

before(async () => {
  process.env.SEALEYE_HOME = home;
  process.env.SEALEYE_TRACING = "off";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-real";

  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        key: req.headers["x-api-key"],
        gatewayKey: req.headers["x-sealeye-gateway-key"],
        authorization: req.headers.authorization,
        body: JSON.parse(body || "{}")
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_standin",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "This version of the platform cannot build this app." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 }
      }));
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  standIn = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  delete process.env.SEALEYE_MODEL_URL;
  delete process.env.SEALEYE_GATEWAY_KEY;
});

test("unset, the client uses Anthropic's own address", async () => {
  delete process.env.SEALEYE_MODEL_URL;
  const { modelClient } = await import("../api/interview/model.js");
  assert.match(modelClient("k").baseURL, /^https:\/\/api\.anthropic\.com/);
});

test("set, one interview turn goes to the stand-in and nowhere else", async () => {
  process.env.SEALEYE_MODEL_URL = standIn;
  const { runInterview } = await import("../api/interview/service.js");

  const result = await runInterview({
    appPath: path.join(root, "apps", "static-website"),
    ask: () => { throw new Error("no question expected"); }
  });

  assert.equal(result.status, "stopped");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, "/v1/messages");
  assert.equal(seen[0].key, "sk-ant-test-not-real");
  assert.equal(seen[0].body.model, "claude-sonnet-5");
});

test("with the platform's gateway key, the API sends that key and never a model key", async () => {
  // The model key is still in this process's environment, as on a laptop: the gateway
  // key wins, and the model key is not sent (DESIGN.md, "The model gateway on the server").
  process.env.SEALEYE_MODEL_URL = standIn;
  process.env.SEALEYE_GATEWAY_KEY = "spike-gateway-key-not-real";
  const before = seen.length;
  const { runInterview } = await import("../api/interview/service.js");

  const result = await runInterview({
    appPath: path.join(root, "apps", "static-website"),
    ask: () => { throw new Error("no question expected"); }
  });

  assert.equal(result.status, "stopped");
  const call = seen[before];
  assert.equal(call.url, "/v1/messages");
  assert.equal(call.gatewayKey, "spike-gateway-key-not-real");
  assert.equal(call.key, undefined, "no x-api-key reaches the gateway");
  assert.equal(call.authorization, undefined);
  delete process.env.SEALEYE_GATEWAY_KEY;
});

test("a gateway key with no gateway address is not used: the model key goes to Anthropic", async () => {
  delete process.env.SEALEYE_MODEL_URL;
  process.env.SEALEYE_GATEWAY_KEY = "spike-gateway-key-not-real";
  const { modelCredential } = await import("../api/interview/model.js");
  assert.deepEqual(modelCredential(), { apiKey: "sk-ant-test-not-real" });
  delete process.env.SEALEYE_GATEWAY_KEY;
});

test("a spent gateway budget stops the turn at once, and says so without calling the model busy", async () => {
  // The gateway's refusal, as the Step 4 spike recorded it.
  let calls = 0;
  const refusing = http.createServer((req, res) => {
    calls++;
    req.resume();
    res.writeHead(429, { "content-type": "application/json", "retry-after": "1674325" });
    res.end(JSON.stringify({ error: { message: "Budget exceeded", type: "rate_limit_error", code: "budget_exceeded" } }));
  });
  await new Promise(r => refusing.listen(0, "127.0.0.1", r));
  process.env.SEALEYE_MODEL_URL = `http://127.0.0.1:${refusing.address().port}`;
  process.env.SEALEYE_GATEWAY_KEY = "spike-gateway-key-not-real";
  try {
    const { createWithOneRetry, modelClient, modelCredential } = await import("../api/interview/model.js");
    const steps = [];
    await assert.rejects(
      createWithOneRetry(modelClient(modelCredential()), { model: "claude-sonnet-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }, s => steps.push(s)),
      err => {
        assert.match(err.message, /used its model budget for this period/);
        assert.doesNotMatch(err.message, /busy|\$|\d/);
        return true;
      }
    );
    assert.equal(calls, 1, "never retried");
    assert.deepEqual(steps, []);
  } finally {
    refusing.close();
    delete process.env.SEALEYE_GATEWAY_KEY;
  }
});

test("in gateway mode, no other credential the SDK knows of is looked for or sent", async () => {
  // Stand-ins for the variables the SDK's own credential chain reads. With these set, a
  // plain client would try a token exchange and add an Authorization header.
  const stray = {
    ANTHROPIC_FEDERATION_RULE_ID: "fdrl_not_real",
    ANTHROPIC_ORGANIZATION_ID: "00000000-0000-0000-0000-000000000000",
    ANTHROPIC_IDENTITY_TOKEN: "not-a-real-token",
    ANTHROPIC_AUTH_TOKEN: "not-a-real-token",
    ANTHROPIC_CUSTOM_HEADERS: "authorization: Bearer not-real\nx-api-key: not-real",
    ANTHROPIC_LOG: "debug"
  };
  Object.assign(process.env, stray);
  process.env.SEALEYE_MODEL_URL = standIn;
  process.env.SEALEYE_GATEWAY_KEY = "spike-gateway-key-not-real";
  const logged = [];
  const original = console.debug;
  console.debug = (...a) => logged.push(a.join(" "));
  try {
    const before = seen.length;
    const { modelClient, modelCredential } = await import("../api/interview/model.js");
    const client = modelClient(modelCredential());
    await client.messages.create({ model: "claude-sonnet-5", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
    assert.equal(seen.length, before + 1, "one call, to the stand-in only");
    const call = seen.at(-1);
    assert.equal(call.gatewayKey, "spike-gateway-key-not-real");
    assert.equal(call.key, undefined);
    assert.equal(call.authorization, undefined);
    assert.ok(!logged.some(l => l.includes("spike-gateway-key-not-real")), "the debug log never shows the gateway key");
  } finally {
    console.debug = original;
    for (const name of Object.keys(stray)) delete process.env[name];
    delete process.env.SEALEYE_GATEWAY_KEY;
  }
});
