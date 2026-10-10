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
  const { interviewId } = service.startFromUpload({ zip, app: "site" });
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
  const { interviewId } = service.startFromUpload({ zip, app: "site" });
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

  const quiet = service.startFromUpload({ zip, app: "quiet", trace: false });
  await service.settled(quiet.interviewId);
  service.answer(quiet.interviewId, "Everyone");
  await service.settled(quiet.interviewId);
  assert.equal(model.calls(), 2);
  assert.equal(exporter.getFinishedSpans().length, 0, "no spans at all");
  assert.equal(service.get(quiet.interviewId).traceId, undefined);

  const loud = service.startFromUpload({ zip, app: "loud" });
  await service.settled(loud.interviewId);
  assert.ok(exporter.getFinishedSpans().length > 0, "the next interview is traced as usual");
  service.close();
});
