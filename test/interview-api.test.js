// The interview behind the API, end to end over HTTP: the CLI's client uploads a folder,
// follows the events, answers a question and says yes. A stand-in on localhost plays
// the model, reached through SEALEYE_MODEL_URL, so the API holds the only model key
// and nothing leaves the machine. No AWS.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import YAML from "yaml";

import { abandonInterview, answerInterview, followInterview, startInterview } from "../cli/client.js";

const root = path.resolve(import.meta.dirname, "..");
const ENV_SECRET = "sk-live-from-the-dotenv-file";
const plan = YAML.parse(fs.readFileSync(path.join(root, "plans", "static-plan.yaml"), "utf8"));

const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });
const turns = [
  { content: [toolUse("t1", "list_files", { path: "." })], stop_reason: "tool_use" },
  { content: [toolUse("t2", "read_file", { path: ".env" }), toolUse("t3", "read_file", { path: "index.html" })], stop_reason: "tool_use" },
  { content: [{ type: "text", text: "It looks like a marketing site.\nWho is this site for?" }], stop_reason: "end_turn" },
  { content: [toolUse("t4", "submit_plan", { plan, summary: "A static site.", assumptions: [] })], stop_reason: "tool_use" }
];

const calls = [];
let model;
let api;
let apiBase;
let tmp;

before(async () => {
  model = http.createServer((req, res) => {
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", () => {
      calls.push({ key: req.headers["x-api-key"], body });
      const turn = turns[calls.length - 1] || { content: [{ type: "text", text: "Done." }], stop_reason: "end_turn" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: `msg_${calls.length}`, type: "message", role: "assistant", model: "claude-sonnet-5",
        usage: { input_tokens: 100, output_tokens: 10 }, ...turn
      }));
    });
  });
  await new Promise(r => model.listen(0, "127.0.0.1", r));

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-interview-api-"));
  const port = 4100 + Math.floor(Math.random() * 90);
  apiBase = `http://localhost:${port}`;
  api = spawn(process.execPath, ["api/server.js"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOME: tmp,
      SEALEYE_HOME: tmp,
      SEALEYE_TRACING: "off",
      SEALEYE_AUTH: "off",
      ANTHROPIC_API_KEY: "sk-ant-the-apis-own-key",
      SEALEYE_MODEL_URL: `http://127.0.0.1:${model.address().port}`
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  api.stdout.on("data", d => (log += d));
  api.stderr.on("data", d => (log += d));
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${apiBase}/health`)).ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`API did not start:\n${log}`);
});

after(() => {
  api?.kill();
  model?.close();
});

test("an interview runs in the API: upload, a question, a plan, a yes", async () => {
  // The CLI side holds no model key at all.
  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  const app = path.join(tmp, "static-website");
  fs.cpSync(path.join(root, "apps", "static-website"), app, { recursive: true });
  fs.writeFileSync(path.join(app, ".env"), `STRIPE_KEY=${ENV_SECRET}\n`);

  const started = await startInterview({ apiBaseUrl: apiBase, appPath: app, user: "greg" });
  assert.match(started.interviewId, /^int_[0-9a-f]{16}$/);
  assert.deepEqual(started.withheld, [".env"]);

  const seen = [];
  let callsWhenAsked = null;
  const atPlan = await followInterview({
    apiBaseUrl: apiBase,
    interviewId: started.interviewId,
    onEvent: async event => {
      seen.push(event.type === "step" ? `step: ${event.line}` : event.type);
      if (event.type === "question") {
        assert.equal(event.question, "Who is this site for?");
        assert.deepEqual(event.lead, ["It looks like a marketing site."]);
        callsWhenAsked = calls.length;
        await answerInterview({ apiBaseUrl: apiBase, interviewId: started.interviewId, answer: "Customers" });
      }
      if (event.type === "plan") return "stop";
    }
  });

  // Open, so the portal can pick it up: GET /interviews lists it until it ends.
  const listed = await (await fetch(`${apiBase}/interviews`)).json();
  assert.ok(listed.interviews.some(i => i.interviewId === started.interviewId && i.waitingFor === "confirm"));
  assert.equal(atPlan.type, "plan");
  assert.equal(atPlan.status, "submitted");
  assert.equal(atPlan.questions, 1);
  assert.deepEqual(atPlan.plan.modules.map(m => m.id).sort(), plan.modules.map(m => m.id).sort());
  // The two files the command writes into the folder come with the plan, for the portal.
  assert.match(atPlan.files["DEPLOYMENT_PLAN.md"], /^## |\n## /);
  assert.equal(YAML.parse(atPlan.files["sealeye.yaml"]).app.name, atPlan.plan.app.name);
  assert.deepEqual(seen, [
    "started",
    "step: Looking at .",
    "step: Nothing to read at .env, moving on",
    "step: Reading index.html",
    "question",
    "answered",
    "step: Checking the plan against the seaLeye.run plan contract",
    "plan"
  ]);

  // Resuming at the answer made no model call again: three calls before the question,
  // one after it.
  assert.equal(callsWhenAsked, 3);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(c => c.key === "sk-ant-the-apis-own-key"), "the API's own key");
  assert.ok(calls.every(c => !c.body.includes(ENV_SECRET)), "the .env never reached the model, or the API");
  assert.match(calls[2].body, /holds secret values/);

  // "Deploy this?" is an answer like any other.
  await answerInterview({ apiBaseUrl: apiBase, interviewId: started.interviewId, answer: "y" });
  const end = await followInterview({ apiBaseUrl: apiBase, interviewId: started.interviewId, after: atPlan.lastSeq, onEvent: () => {} });
  assert.equal(end.type, "finished");
  assert.equal(end.approved, true);
  assert.equal(calls.length, 4, "saying yes calls no model");

  // Over means over: no more answers, and the uploaded copy is gone.
  await assert.rejects(
    answerInterview({ apiBaseUrl: apiBase, interviewId: started.interviewId, answer: "y" }),
    /not waiting for an answer/
  );
  const scratch = path.join(tmp, "interviews");
  assert.deepEqual(fs.existsSync(scratch) ? fs.readdirSync(scratch) : [], []);

  // A late subscriber gets the whole story and the stream ends.
  const replay = [];
  await followInterview({ apiBaseUrl: apiBase, interviewId: started.interviewId, onEvent: e => { replay.push(e.type); } });
  assert.equal(replay.at(-1), "finished");

  if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey;
});

test("an upload that is not a zip is refused in a sentence", async () => {
  const res = await fetch(`${apiBase}/interviews`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app: "x", zip: Buffer.from("nope").toString("base64") })
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /not a zip file/);
});

test("an unknown interview is a 404", async () => {
  const res = await fetch(`${apiBase}/interviews/int_0000000000000000/events`);
  assert.equal(res.status, 404);
});

test("a developer who leaves mid-interview is forgotten at once", async () => {
  const app = path.join(tmp, "leaving");
  fs.cpSync(path.join(root, "apps", "static-website"), app, { recursive: true });
  calls.length = 2;   // the stand-in's next turn is the question
  const started = await startInterview({ apiBaseUrl: apiBase, appPath: app });
  await followInterview({ apiBaseUrl: apiBase, interviewId: started.interviewId, onEvent: e => (e.type === "question" ? "stop" : undefined) });

  await abandonInterview({ apiBaseUrl: apiBase, interviewId: started.interviewId });
  const res = await fetch(`${apiBase}/interviews/${started.interviewId}/events`);
  assert.equal(res.status, 404);
  assert.deepEqual(fs.readdirSync(path.join(tmp, "interviews")), []);
});
