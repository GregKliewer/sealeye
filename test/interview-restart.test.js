// The Step 10 "done when" for interviews: one paused at a question resumes after the
// API restarts, from the answer endpoint, with no model call repeated. Real Postgres
// (test/helpers/pg.js, skipped without one), a stand-in model through SEALEYE_MODEL_URL.
// No AWS.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import YAML from "yaml";

import { answerInterview, followInterview, startInterview } from "../cli/client.js";
import { freshDatabase, pgAvailable } from "./helpers/pg.js";

const root = path.resolve(import.meta.dirname, "..");
const plan = YAML.parse(fs.readFileSync(path.join(root, "plans", "static-plan.yaml"), "utf8"));
const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });
const turns = [
  { content: [toolUse("t1", "list_files", { path: "." })], stop_reason: "tool_use" },
  { content: [{ type: "text", text: "Who is this site for?" }], stop_reason: "end_turn" },
  { content: [toolUse("t2", "submit_plan", { plan, summary: "A static site.", assumptions: [] })], stop_reason: "tool_use" }
];

test("an interview paused at a question resumes after the API restarts", { skip: !pgAvailable && "no SEALEYE_TEST_DATABASE_URL" }, async () => {
  const calls = [];
  const model = http.createServer((req, res) => {
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", () => {
      calls.push(body);
      const turn = turns[calls.length - 1] || { content: [{ type: "text", text: "Done." }], stop_reason: "end_turn" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: `m${calls.length}`, type: "message", role: "assistant", model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 }, ...turn }));
    });
  });
  await new Promise(r => model.listen(0, "127.0.0.1", r));

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-restart-"));
  const port = 4800 + Math.floor(Math.random() * 90);
  const apiBase = `http://localhost:${port}`;
  const env = {
    ...process.env,
    PORT: String(port), HOME: home, SEALEYE_HOME: home, SEALEYE_TRACING: "off",
    DATABASE_URL: await freshDatabase(),
    ANTHROPIC_API_KEY: "sk-ant-test", SEALEYE_MODEL_URL: `http://127.0.0.1:${model.address().port}`
  };

  const startApi = async () => {
    const child = spawn(process.execPath, ["api/server.js"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    child.log = "";
    child.stdout.on("data", d => (child.log += d));
    child.stderr.on("data", d => (child.log += d));
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${apiBase}/health`)).ok) return child; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`API did not start:\n${child.log}`);
  };
  const stopApi = child => new Promise(r => { child.once("close", r); child.kill("SIGTERM"); });

  let api = await startApi();
  try {
    const app = path.join(home, "site");
    fs.cpSync(path.join(root, "apps", "static-website"), app, { recursive: true });
    const { interviewId } = await startInterview({ apiBaseUrl: apiBase, appPath: app });
    const asked = await followInterview({ apiBaseUrl: apiBase, interviewId, onEvent: e => (e.type === "question" ? "stop" : undefined) });
    assert.equal(asked.type, "question");
    assert.equal(calls.length, 2);

    await stopApi(api);
    api = await startApi();
    assert.match(api.log, new RegExp(`${interviewId}: waiting for an answer`));

    await answerInterview({ apiBaseUrl: apiBase, interviewId, answer: "Customers" });
    const atPlan = await followInterview({ apiBaseUrl: apiBase, interviewId, after: asked.lastSeq, onEvent: e => (e.type === "plan" ? "stop" : undefined) });
    assert.equal(atPlan.type, "plan", JSON.stringify(atPlan) + api.log);
    assert.equal(atPlan.status, "submitted");
    assert.equal(calls.length, 3, "the answer cost one model call, and nothing before it ran again");

    // And the plan waits through a second restart for its "Deploy this?".
    await stopApi(api);
    api = await startApi();
    await answerInterview({ apiBaseUrl: apiBase, interviewId, answer: "n" });
    const end = await followInterview({ apiBaseUrl: apiBase, interviewId, after: atPlan.lastSeq, onEvent: () => {} });
    assert.equal(end.type, "finished");
    assert.equal(end.approved, false);
    assert.equal(calls.length, 3);

    // The replay a reconnecting client gets is the whole interview, across both restarts.
    const replay = [];
    await followInterview({ apiBaseUrl: apiBase, interviewId, onEvent: e => { replay.push(e.type); } });
    assert.deepEqual(replay.filter(t => t !== "step"), ["started", "question", "answered", "plan", "answered", "finished"]);
    assert.deepEqual(fs.readdirSync(path.join(home, "interviews")), [], "the uploaded copy is gone");
  } finally {
    await stopApi(api);
    model.close();
  }
});
