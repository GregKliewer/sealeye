// The interview service on its own: how long an interview's data lives, how it ends,
// and tracing turned off for one interview. A scripted model, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";
import { MemorySaver } from "@langchain/langgraph";

import { createInterviewService, INTERVIEW_TTL_MS, NotWaiting } from "../api/interview/service.js";
import { startTracing } from "../core/tracing.js";

const asks = { content: [{ type: "text", text: "Who is it for?" }], stop_reason: "end_turn", usage: {} };
const stops = { content: [{ type: "text", text: "This version cannot build that." }], stop_reason: "end_turn", usage: {} };
const client = (...turns) => {
  let i = 0;
  return { calls: () => i, messages: { create: async () => turns[Math.min(i++, turns.length - 1)] } };
};

function setup(model, { clock = { t: Date.now() }, checkpointer = new MemorySaver() } = {}) {
  const scratchBase = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-svc-"));
  const service = createInterviewService({ client: model, now: () => clock.t, scratchBase, checkpointer });
  const zip = zipSync({ "index.html": new TextEncoder().encode("<h1>hi</h1>") });
  return { service, scratchBase, zip, clock, checkpointer };
}

const scratchDirs = base => fs.readdirSync(base).filter(n => n.startsWith("int-"));

test("an interview waiting on a question is gone after a day, code and all", async () => {
  const { service, scratchBase, zip, clock, checkpointer } = setup(client(asks));
  const { interviewId } = await service.startFromUpload({ zip, app: "site" });
  await service.settled(interviewId);
  assert.ok(await checkpointer.getTuple({ configurable: { thread_id: interviewId } }), "saved while it waits");

  assert.equal(service.get(interviewId).waitingFor, "question");
  assert.equal(scratchDirs(scratchBase).length, 1);

  clock.t += INTERVIEW_TTL_MS + 1000;
  await service.sweep();

  assert.equal(service.get(interviewId), null);
  assert.deepEqual(scratchDirs(scratchBase), []);
  assert.equal(await checkpointer.getTuple({ configurable: { thread_id: interviewId } }), undefined);
  service.close();
});

test("an interview that stops ends at once and keeps nothing of the app", async () => {
  const { service, scratchBase, zip, checkpointer } = setup(client(stops));
  const { interviewId } = await service.startFromUpload({ zip, app: "site" });
  await service.settled(interviewId);
  assert.equal(await checkpointer.getTuple({ configurable: { thread_id: interviewId } }), undefined, "the saved conversation is gone");

  const done = service.get(interviewId);
  assert.equal(done.status, "finished");
  assert.equal(done.result.status, "stopped");
  assert.match(done.result.message, /cannot build/);
  assert.deepEqual(scratchDirs(scratchBase), []);
  assert.throws(() => service.answer(interviewId, "hello"), NotWaiting);
  service.close();
});

test("tracing turned off for one interview records nothing, in a process that traces", async () => {
  process.env.LANGFUSE_PUBLIC_KEY ||= "pk-lf-test";
  process.env.LANGFUSE_SECRET_KEY ||= "sk-lf-test-only";
  const exporter = new InMemorySpanExporter();
  assert.equal(startTracing({ exporter }), true);

  const model = client(asks, stops);
  const { service, zip } = setup(model);

  const quiet = await service.startFromUpload({ zip, app: "quiet", trace: false });
  await service.settled(quiet.interviewId);
  service.answer(quiet.interviewId, "Everyone");
  await service.settled(quiet.interviewId);
  assert.equal(model.calls(), 2);
  assert.equal(exporter.getFinishedSpans().length, 0, "no spans at all");
  assert.equal(service.get(quiet.interviewId).traceId, undefined);

  const loud = await service.startFromUpload({ zip, app: "loud" });
  await service.settled(loud.interviewId);
  assert.ok(exporter.getFinishedSpans().length > 0, "the next interview is traced as usual");
  service.close();
});

test("a long read is the interview's limit to stop, not LangGraph's", async () => {
  const read = { content: [{ type: "tool_use", id: "r", name: "list_files", input: { path: "." } }], stop_reason: "tool_use", usage: {} };
  const model = client(...Array(20).fill(read), stops);
  const { service, zip } = setup(model);
  const { interviewId } = await service.startFromUpload({ zip, app: "site" });
  await service.settled(interviewId);

  const done = service.get(interviewId);
  assert.equal(done.status, "finished", JSON.stringify(done));
  assert.equal(done.result.status, "stopped");
  assert.equal(model.calls(), 21);
  service.close();
});

test("LangChain's own tracer is switched off, whatever the environment says", () => {
  process.env.LANGSMITH_TRACING = "true";
  process.env.LANGCHAIN_TRACING_V2 = "true";
  const { service } = setup(client(stops));
  assert.equal(process.env.LANGSMITH_TRACING, "false");
  assert.equal(process.env.LANGCHAIN_TRACING_V2, "false");
  service.close();
});

test("a developer who leaves takes their app with them", async () => {
  const { service, scratchBase, zip, checkpointer } = setup(client(asks));
  const { interviewId } = await service.startFromUpload({ zip, app: "app (1) café" });
  await service.settled(interviewId);
  assert.equal(scratchDirs(scratchBase).length, 1);

  assert.equal(await service.remove(interviewId), true);
  assert.equal(service.get(interviewId), null);
  assert.deepEqual(scratchDirs(scratchBase), []);
  assert.equal(await checkpointer.getTuple({ configurable: { thread_id: interviewId } }), undefined);
  assert.equal(await service.remove(interviewId), false);
  service.close();
});

test("an interview saved as ended, whose last event was never written, says how it ended after a restart", async () => {
  const scratchBase = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-svc-restore-"));
  const scratchRoot = path.join(scratchBase, "int-left");
  fs.mkdirSync(scratchRoot);
  const t = Date.now();
  const saved = [
    {
      record: { id: "int_finished", status: "finished", result: { status: "ready" }, approved: false, ownsDir: true, scratchRoot, createdAt: t - 1000 },
      events: [{ seq: 1, type: "question" }, { seq: 3, type: "plan" }]   // numbers need not be contiguous
    },
    {
      record: { id: "int_failed", status: "failed", failure: "The model stopped answering.", createdAt: t - 1000 },
      events: []
    },
    {
      record: { id: "int_whole", status: "finished", result: { status: "ready" }, createdAt: t - 1000 },
      events: [{ seq: 1, type: "finished", status: "ready" }]
    }
  ];
  const added = [];
  const persistence = {
    loadAll: async () => saved,
    save() {},
    addEvent: (id, event) => added.push([id, event.seq, event.type]),
    remove() {},
    flush: async () => {}
  };
  const service = createInterviewService({ client: client(asks), now: () => t, scratchBase, persistence });
  await service.restore();

  assert.deepEqual(added, [["int_finished", 4, "finished"], ["int_failed", 1, "failed"]], "only the two missing their end, numbered after the last");
  const seen = [];
  service.subscribe("int_failed", 0, e => seen.push(e));
  assert.equal(seen.at(-1).message, "The model stopped answering.");
  assert.ok(!fs.existsSync(scratchRoot), "its copy of the app is gone");
  service.close();
});
