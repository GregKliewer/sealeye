// The cap on a run (PHASE3-PLAN Step 3): each reply is priced from core/model-prices.js
// and added up; before each call the run stops if it has reached its cap, with words
// for both surfaces; a model with no price never starts. A scripted model, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { MemorySaver } from "@langchain/langgraph";

import { createInterviewService, ModelNotPriced } from "../api/interview/service.js";
import { MAX_TURNS } from "../api/interview/graph.js";
import { addSpend, DEFAULT_RUN_CAP, priceUsage, pricesAgeDays, runCap, spendingLimitWords } from "../core/model-prices.js";

test("a reply is priced as Anthropic prices it, and the measured run comes out the same", () => {
  // The largest sample run of Oct 14 (DESIGN.md), which LangFuse priced at $0.0795.
  const run = priceUsage("claude-sonnet-5", { input_tokens: 8999, output_tokens: 2224, cache_read_input_tokens: 56145, cache_creation_input_tokens: 11229 });
  assert.equal(run.cost.toFixed(4), "0.0795");
  // Haiku is priced by the length of each prompt, cache reads and writes included.
  assert.equal(priceUsage("claude-haiku-5-5", { input_tokens: 1_000_000 }).cost.toFixed(2), "0.50");
  assert.equal(priceUsage("claude-haiku-5-5", { input_tokens: 50_000 }).cost.toFixed(4), "0.0050");
  assert.deepEqual(addSpend({ cost: 0.1, input: 1 }, { cost: 0.2, output: 2 }), { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.30000000000000004 });
  assert.throws(() => priceUsage("claude-unknown", {}), ModelNotPriced);
});

test("the cap is SEALEYE_RUN_CAP in dollars, a dollar without it, and a sentence when it is wrong", () => {
  assert.equal(DEFAULT_RUN_CAP, 1);
  assert.equal(runCap(undefined), 1);
  assert.equal(runCap("2.50"), 2.5);
  assert.throws(() => runCap("lots"), /SEALEYE_RUN_CAP must be an amount in US dollars above zero/);
  assert.throws(() => runCap("0"), /above zero/);
});

test("the prices say when they were last checked", () => {
  assert.equal(pricesAgeDays(Date.parse("2026-10-14T12:00:00Z")), 0);
  assert.equal(pricesAgeDays(Date.parse("2027-01-13T00:00:00Z")), 91);
});

// A reply that reads a file and costs $0.40 (200,000 input tokens of claude-sonnet-5).
const dear = { input_tokens: 200_000, output_tokens: 0 };
const listForever = () => ({ content: [{ type: "tool_use", id: `t${Math.random()}`, name: "list_files", input: { path: "." } }], stop_reason: "tool_use", usage: dear });

function service(turns) {
  let i = 0;
  const calls = () => i;
  const client = { messages: { create: async () => (typeof turns === "function" ? turns(i++) : turns[Math.min(i++, turns.length - 1)]) } };
  const scratchBase = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-cap-"));
  return { calls, svc: createInterviewService({ client, scratchBase, checkpointer: new MemorySaver() }) };
}
const zip = zipSync({ "index.js": strToU8("require('http').createServer().listen(process.env.PORT)") });
const finished = (svc, id) => new Promise(resolve => svc.subscribe(id, 0, e => { if (e?.type === "finished" || e?.type === "plan") resolve(e); }));

test("a run that reads forever is stopped by its cap, long before its turns run out, and is told why", async () => {
  const { svc, calls } = service(() => listForever());
  const { interviewId } = await svc.startFromUpload({ zip, app: "looping-api" });
  const end = await finished(svc, interviewId);
  assert.equal(end.status, "stopped");
  assert.equal(end.reason, "spending_limit");
  assert.equal(end.message, spendingLimitWords("sealeye"));
  assert.equal(calls(), 3, "$0.40, $0.80, $1.20: the third reply crosses the dollar, and no fourth call is made");
  assert.ok(calls() < MAX_TURNS);
  assert.equal(end.spent.toFixed(2), "1.20", "one reply past the cap, as DESIGN.md says it can be");
  assert.doesNotMatch(end.message, /\d|\$/, "no amount and no count for the developer");
  svc.close();
});

test("the reply that crosses the cap is used: if it is the plan, the developer has a plan", async () => {
  const plan = {
    planVersion: "0.4", app: { name: "looping-api", type: "api" }, profile: "dev",
    modules: [{ id: "http_api_serverless", inputs: { runtime: "nodejs", entry_point: "index.js", trigger: "http" } }, { id: "observability_basic", inputs: { target: "auto", retention_days: 30 } }],
    outputs: ["public_url", "logs"]
  };
  const { svc } = service(i => (i < 2 ? listForever() : { content: [{ type: "tool_use", id: "s", name: "submit_plan", input: { plan, summary: "An API.", assumptions: [] } }], stop_reason: "tool_use", usage: dear }));
  const { interviewId } = await svc.startFromUpload({ zip, app: "looping-api" });
  const end = await finished(svc, interviewId);
  assert.equal(end.type, "plan");
  assert.equal(end.status, "submitted");
  svc.close();
});

test("a model with no price never starts a run, and nothing is unpacked", async () => {
  const { svc, calls } = service(() => listForever());
  await assert.rejects(svc.startFromUpload({ zip, app: "looping-api", model: "claude-made-up-9" }), err => {
    assert.ok(err instanceof ModelNotPriced);
    assert.match(err.message, /no price for the model claude-made-up-9/);
    return true;
  });
  assert.equal(calls(), 0);
  svc.close();
});
