// Pause and resume (PHASE2-PLAN Step 17): an API stops taking requests and starts again,
// with the state read back from AWS each time, never assumed. A static site says it
// cannot be paused.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { startApi, token } from "./helpers/api-with-aws.js";

const root = path.resolve(import.meta.dirname, "..");
const ANA = token("a");
const PAT = token("p");
const LEE = token("l");
let api;
const base = { backend: "cloudformation", orgId: "default", teamId: "default", surface: "cli", outputs: {}, startedAt: new Date().toISOString() };

before(async () => {
  api = await startApi({
    tokens: [{ token: ANA, id: "ana", team: "default" }, { token: PAT, id: "pat", team: "payments" }, { token: LEE, id: "lee", team: "platform", scope: "org" }],
    records: [
      { ...base, deploymentId: "dep_api00000002", app: { name: "orders-api" }, kind: "api", status: "succeeded", stackName: "sealeye-default-orders-api-aaaaaa", resourceName: "sealeye-default-orders-api-aaaaaa" },
      { ...base, deploymentId: "dep_api00000001", app: { name: "orders-api" }, kind: "api", status: "succeeded", stackName: "sealeye-default-orders-api-aaaaaa", resourceName: "sealeye-default-orders-api-aaaaaa" },
      // A stack from before teams had names: team default deployed to it first, payments since.
      { ...base, teamId: "payments", deploymentId: "dep_shared00002", app: { name: "shared-api" }, kind: "api", status: "succeeded", stackName: "sealeye-shared-api" },
      { ...base, deploymentId: "dep_shared00001", app: { name: "shared-api" }, kind: "api", status: "succeeded", stackName: "sealeye-shared-api" },
      { ...base, deploymentId: "dep_site0000001", app: { name: "site" }, kind: "static", status: "succeeded", stackName: "sealeye-default-site-cccccc" }
    ],
    // The function's reservation lives in a file, as AWS would keep it.
    aws: `
const state = require("path").join(process.env.HOME, "concurrency.json");
const read = () => { try { return JSON.parse(fs.readFileSync(state, "utf8")); } catch { return {}; } };
if (args[1] === "put-function-concurrency") { fs.writeFileSync(state, JSON.stringify({ ReservedConcurrentExecutions: Number(opt("--reserved-concurrent-executions")) })); out(read()); }
if (args[1] === "delete-function-concurrency") { fs.writeFileSync(state, "{}"); process.exit(0); }
if (args[1] === "get-function-concurrency") out(read());
`
  });
});

after(() => api?.stop());

test("pause and resume change the API, read it back, and say who did it", async () => {
  const before_ = await api.call("/deployments/dep_api00000001/paused", { token: ANA });
  assert.deepEqual(before_.body, { app: "orders-api", paused: false });

  // Asked through an older record: it is the environment that pauses.
  const paused = await api.call("/deployments/dep_api00000001/pause", { token: ANA, method: "POST" });
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  assert.equal(paused.body.paused, true);
  assert.ok(api.awsCalls().some(l => /^lambda put-function-concurrency --function-name sealeye-default-orders-api-aaaaaa --reserved-concurrent-executions 0/.test(l)));

  const list = (await api.call("/deployments", { token: ANA })).body.deployments;
  const newest = list.find(d => d.deploymentId === "dep_api00000002");
  assert.equal(newest.paused, true, "on the environment's newest record");
  assert.equal(newest.pauses[0].action, "paused");
  assert.equal(newest.pauses[0].by.user, "ana@example.com");

  const resumed = await api.call("/deployments/dep_api00000002/resume", { token: ANA, method: "POST" });
  assert.equal(resumed.body.paused, false);
  assert.equal((await api.call("/deployments/dep_api00000002/paused", { token: ANA })).body.paused, false);
});

test("a static site cannot be paused, and another team cannot pause yours", async () => {
  const site = await api.call("/deployments/dep_site0000001/pause", { token: ANA, method: "POST" });
  assert.equal(site.status, 409);
  assert.match(site.body.error.message, /static site cannot be paused/);
  assert.equal((await api.call("/deployments/dep_api00000002/pause", { token: PAT, method: "POST" })).status, 404);
  // The platform team's organization-wide token may, as it may tear down.
  assert.equal((await api.call("/deployments/dep_api00000002/pause", { token: LEE, method: "POST" })).status, 200);
  await api.call("/deployments/dep_api00000002/resume", { token: LEE, method: "POST" });
});

test("an older record of a stack another team now runs cannot read or change it", async () => {
  for (const [route, method] of [["pause", "POST"], ["paused", "GET"], ["logs", "GET"], ["performance", "GET"]]) {
    const r = await api.call(`/deployments/dep_shared00001/${route}`, { token: ANA, method });
    assert.equal(r.status, 409, route);
    assert.equal(r.body.error.code, "SHARED_ENVIRONMENT");
  }
});

test("sealeye pause and resume by app name", async () => {
  const run = cmd => promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), cmd, "orders-api", "--api", api.api], {
    cwd: api.home, env: { ...process.env, HOME: api.home, SEALEYE_HOME: api.home, SEALEYE_TOKEN: ANA, NO_COLOR: "1" }
  });
  assert.match((await run("pause")).stdout, /orders-api is paused: it takes no requests until you run sealeye resume orders-api/);
  assert.match((await run("resume")).stdout, /orders-api is taking requests again/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(api.home, "concurrency.json"), "utf8")).ReservedConcurrentExecutions, undefined);
});
