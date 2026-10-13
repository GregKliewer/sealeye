// A first create that fails and rolls back leaves a dead stack, which the platform
// removes (DESIGN.md, "One change at a time"). The removal takes minutes, and until the
// stack is gone the environment takes no other change: a deploy started meanwhile would
// meet it half-deleted and fail for a reason that is not the real one.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { changeUnderWay } from "../api/busy.js";
import { startApi, token } from "./helpers/api-with-aws.js";

const ANA = token("a");
const stack = "sealeye-default-roll-api-aaaaaa";
const plan = {
  planVersion: "0.4", app: { name: "roll-api", type: "api" }, profile: "dev",
  modules: [{ id: "http_api_serverless", inputs: { runtime: "nodejs", entry_point: "index.js", trigger: "http" } }],
  outputs: ["public_url"]
};
let api;

before(async () => {
  api = await startApi({
    tokens: [{ token: ANA, id: "ana", name: "Ana", team: "default" }],
    records: [{
      backend: "cloudformation", orgId: "default", teamId: "default", surface: "cli", outputs: {}, kind: "api", settings: [],
      deploymentId: "dep_roll0000001", app: { name: "roll-api" }, status: "succeeded", stackName: stack, resourceName: stack,
      plan, startedAt: new Date(Date.now() - 3600_000).toISOString(), artifactKey: `${stack}/dep_roll0000001.zip`, artifactSha256: "c".repeat(64)
    }],
    // The deploy rolls back; once deleting is asked for, the stack is half-deleted for a
    // while, then gone. Whether the stack may go yet is a file the test writes.
    aws: `
const path = require("path");
const state = p => path.join(process.env.HOME, p);
if (args[1] === "head-object") out({});
if (args[1] === "get-parameters-by-path") out([]);
if (args[1] === "deploy") { setTimeout(() => fail("Waiter StackCreateComplete failed"), 200); return; }
if (args[1] === "delete-stack") { fs.writeFileSync(state("deleting"), ""); out({}); }
if (args[1] === "describe-stack-events") out({ StackEvents: [{ ResourceStatus: "CREATE_FAILED", ResourceStatusReason: "The function could not be created", LogicalResourceId: "Fn" }] });
if (args[1] === "describe-stacks") {
  if (fs.existsSync(state("gone"))) fail("Stack with id x does not exist");
  if (fs.existsSync(state("deleting"))) out({ Stacks: [{ StackStatus: "DELETE_IN_PROGRESS", Outputs: [] }] });
  const n = Number(fs.existsSync(state("n")) ? fs.readFileSync(state("n"), "utf8") : 0) + 1;
  fs.writeFileSync(state("n"), String(n));
  out({ Stacks: [{ StackStatus: n < 3 ? "CREATE_IN_PROGRESS" : "ROLLBACK_COMPLETE", Outputs: [] }] });
}
`,
    env: { SEALEYE_BUCKET: "artifacts", SEALEYE_LWA_VERSION: "25", SEALEYE_FUNCTION_BOUNDARY_ARN: "arn:aws:iam::123456789012:policy/boundary" }
  });
});

after(() => api?.stop());

const again = () => api.call("/deployments", { token: ANA, method: "POST", body: { backend: "cloudformation", fromDeployment: "dep_roll0000001" } });

test("the environment stays closed until the failed stack is gone, and then opens", async () => {
  const fs = await import("node:fs");
  const first = await again();
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const id = first.body.deploymentId;

  let record;
  for (let i = 0; i < 200; i++) {
    record = (await api.call(`/deployments/${id}`, { token: ANA })).body;
    if (record.status === "failed" && record.cleaningUp) break;
    await new Promise(r => setTimeout(r, 25));
  }
  assert.equal(record.status, "failed", "it failed, and says so at once");
  assert.equal(record.cleaningUp, true, JSON.stringify({ status: record.status, reason: record.failureReason }));
  assert.match(record.failureReason, /could not be created/);

  const refused = await again();
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, "ENVIRONMENT_BUSY");
  assert.match(refused.body.error.message, /^roll-api is being cleared after a build that failed right now \(dep_/);

  fs.writeFileSync(path.join(api.home, "gone"), "");
  for (let i = 0; i < 200 && record.cleaningUp; i++) {
    await new Promise(r => setTimeout(r, 25));
    record = (await api.call(`/deployments/${id}`, { token: ANA })).body;
  }
  assert.equal(record.cleaningUp, false);
  assert.equal(record.rolledBackStackRemoved, true);
  assert.equal(record.status, "failed", "and its result stays its own");

  const open = await again();
  assert.notEqual(open.body.error?.code, "ENVIRONMENT_BUSY", JSON.stringify(open.body));
});

test("a removal still marked after half an hour stops counting", () => {
  const t = Date.parse("2026-10-12T12:00:00Z");
  const at = ms => new Date(t - ms).toISOString();
  const r = { deploymentId: "d", status: "failed", stackName: "s", cleaningUp: true, startedAt: at(2 * 3600_000) };
  assert.equal(changeUnderWay("s", { now: t, records: [{ ...r, cleanupStartedAt: at(60_000) }] })?.deploymentId, "d");
  assert.equal(changeUnderWay("s", { now: t, records: [{ ...r, cleanupStartedAt: at(31 * 60_000) }] }), null);
  assert.equal(changeUnderWay("s", { now: t, records: [{ ...r, cleaningUp: false, cleanupStartedAt: at(60_000) }] }), null);
});
