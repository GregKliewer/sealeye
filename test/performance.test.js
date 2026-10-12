// Performance (PHASE2-PLAN Step 20): readings of an API over a window, from CloudWatch,
// per period and in total. Readings of what happened, never a capacity.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { startApi, token } from "./helpers/api-with-aws.js";

const root = path.resolve(import.meta.dirname, "..");
const ANA = token("a");
let api;
const base = { backend: "cloudformation", orgId: "default", teamId: "default", surface: "cli", outputs: {}, startedAt: new Date().toISOString() };

before(async () => {
  api = await startApi({
    tokens: [{ token: ANA, id: "ana", team: "default" }],
    records: [
      { ...base, deploymentId: "dep_api00000001", app: { name: "orders-api" }, kind: "api", status: "succeeded", stackName: "sealeye-default-orders-api-aaaaaa", resourceName: "sealeye-default-orders-api-aaaaaa" },
      { ...base, deploymentId: "dep_site0000001", app: { name: "site" }, kind: "static", status: "succeeded", stackName: "sealeye-default-site-cccccc" }
    ],
    // Two periods with requests, the rest quiet; totals over the whole window.
    aws: `
if (args[1] === "get-metric-data") {
  const start = Date.parse(opt("--start-time"));
  const queries = JSON.parse(opt("--metric-data-queries"));
  const period = queries[0].MetricStat.Period * 1000;
  const t1 = new Date(start + period).toISOString(), t3 = new Date(start + 3 * period).toISOString();
  const per = { requests: [10, 30], errors: [0, 2], refused: [0, 0], average: [80, 120], slowest: [150, 400] };
  const total = { totalRequests: 40, totalErrors: 2, totalRefused: 0, totalAverage: 110, totalSlowest: 390 };
  out(queries.map(q => q.Id in per
    ? { Id: q.Id, Timestamps: [t3, t1], Values: [...per[q.Id]].reverse() }
    : { Id: q.Id, Timestamps: [new Date(start).toISOString()], Values: [total[q.Id]] }));
}
`
  });
});

after(() => api?.stop());

test("readings come per period and in total, with quiet periods as quiet, not as zero time", async () => {
  const { status, body } = await api.call("/deployments/dep_api00000001/performance?since=1h", { token: ANA });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.periodMinutes, 5);
  assert.equal(body.periods.length, 12);
  assert.deepEqual(body.totals, { requests: 40, errors: 2, refused: 0, averageMs: 110, slowestMs: 390 });
  assert.deepEqual(body.periods[1], { at: body.periods[1].at, requests: 10, errors: 0, refused: 0, averageMs: 80, slowestMs: 150 });
  assert.equal(body.periods[3].requests, 30);
  assert.equal(body.periods[0].requests, 0);
  assert.equal(body.periods[0].averageMs, null, "no requests, nothing measured");

  const call = api.awsCalls().find(l => l.startsWith("cloudwatch get-metric-data"));
  assert.match(call, /"FunctionName","Value":"sealeye-default-orders-api-aaaaaa"/);
});

test("a static site has nothing of its own to measure", async () => {
  const site = await api.call("/deployments/dep_site0000001/performance", { token: ANA });
  assert.equal(site.status, 409);
  assert.equal((await api.call("/deployments/dep_api00000001/performance?since=1y", { token: ANA })).status, 400);
});

test("sealeye perf says what happened, and that capacity is a load test's to say", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), "perf", "orders-api", "--since", "1h", "--api", api.api], {
    cwd: api.home, env: { ...process.env, HOME: api.home, SEALEYE_HOME: api.home, SEALEYE_TOKEN: ANA, NO_COLOR: "1" }
  });
  assert.match(stdout, /Requests\s+40\s+▁█▁▃|Requests\s+40\s+/);
  assert.match(stdout, /Errors\s+2 \(5\.0% of requests\)/);
  assert.match(stdout, /Time taken\s+110 ms on average; 95 in 100 within 390 ms/);
  assert.match(stdout, /set by a load test/);
});
