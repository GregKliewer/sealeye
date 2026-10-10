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
      seen.push({ method: req.method, url: req.url, key: req.headers["x-api-key"], body: JSON.parse(body || "{}") });
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
});

test("unset, the client uses Anthropic's own address", async () => {
  delete process.env.SEALEYE_MODEL_URL;
  const { modelClient } = await import("../cli/interview/loop.js");
  assert.match(modelClient("k").baseURL, /^https:\/\/api\.anthropic\.com/);
});

test("set, one interview turn goes to the stand-in and nowhere else", async () => {
  process.env.SEALEYE_MODEL_URL = standIn;
  const { runInterview } = await import("../cli/interview/loop.js");

  const result = await runInterview({
    appPath: path.join(root, "apps", "static-website"),
    apiBaseUrl: "http://127.0.0.1:1",   // never called: the stand-in stops without a plan
    ask: () => { throw new Error("no question expected"); }
  });

  assert.equal(result.status, "stopped");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, "/v1/messages");
  assert.equal(seen[0].key, "sk-ant-test-not-real");
  assert.equal(seen[0].body.model, "claude-sonnet-5");
});
