// Configure (PHASE2-PLAN Step 18): how long an app's logs are kept, changed as a deploy
// of the same code again with the plan changed (core/retention.js), from the command and
// the portal alike.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { RETENTION_CHOICES, retentionOf, withRetention } from "../core/retention.js";
import { startApi, token } from "./helpers/api-with-aws.js";

const root = path.resolve(import.meta.dirname, "..");
const ANA = token("a");
const stack = "sealeye-default-orders-api-aaaaaa";
const plan = {
  planVersion: "0.4", app: { name: "orders-api", type: "api" }, profile: "dev",
  modules: [
    { id: "http_api_serverless", inputs: { runtime: "nodejs", entry_point: "index.js", trigger: "http" } },
    { id: "observability_basic", inputs: { target: "auto", retention_days: 30 } }
  ],
  outputs: ["public_url", "logs"]
};
let api;

before(async () => {
  api = await startApi({
    tokens: [{ token: ANA, id: "ana", team: "default" }],
    records: [{
      backend: "cloudformation", orgId: "default", teamId: "default", surface: "cli", outputs: {}, startedAt: new Date().toISOString(),
      deploymentId: "dep_orders00001", app: { name: "orders-api" }, kind: "api", status: "succeeded", stackName: stack, resourceName: stack,
      plan, settings: [], artifactKey: `${stack}/dep_orders00001.zip`, artifactSha256: "c".repeat(64)
    }],
    aws: `
if (args[1] === "get-parameters-by-path") out([]);
if (args[1] === "head-object") out({});
if (args[1] === "deploy") process.exit(0);
if (args[1] === "describe-stacks") out({ Stacks: [{ StackStatus: "UPDATE_COMPLETE", Outputs: [] }] });
// The API was paused before this deploy, and a deploy does not change that.
if (args[1] === "get-function-concurrency") out({ ReservedConcurrentExecutions: 0 });
`,
    env: { SEALEYE_BUCKET: "artifacts", SEALEYE_LWA_VERSION: "25", SEALEYE_FUNCTION_BOUNDARY_ARN: "arn:aws:iam::123456789012:policy/boundary" }
  });
});

after(() => api?.stop());

const sealeye = (...args) => promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), ...args, "--api", api.api], {
  cwd: api.home, env: { ...process.env, HOME: api.home, SEALEYE_HOME: api.home, SEALEYE_TOKEN: ANA, NO_COLOR: "1" }
});

test("the plan with a new retention changes that and nothing else", () => {
  const next = withRetention(plan, 14);
  assert.equal(retentionOf(next), 14);
  assert.deepEqual(next.modules[0], plan.modules[0]);
  assert.equal(retentionOf(plan), 30, "the original is untouched");
  assert.throws(() => withRetention(plan, 13), /can be kept for/);
  assert.equal(retentionOf(withRetention({ ...plan, modules: [plan.modules[0]] }, 7)), 7, "a plan without it gets it");
  assert.ok(RETENTION_CHOICES.includes(30));
});

test("sealeye config shows how long logs are kept, and changes it as a deploy", async () => {
  assert.match((await sealeye("config", "orders-api")).stdout, /Logs kept for\s+30 days/);
  await assert.rejects(sealeye("config", "orders-api", "--retention", "13"), err => /can be kept for 1, 3, 7/.test(err.stderr));

  api.clearAwsCalls();
  const { stdout } = await sealeye("config", "orders-api", "--retention", "14", "--json");
  const made = JSON.parse(stdout.slice(stdout.indexOf("{")));
  assert.equal(made.source, "again");
  assert.equal(retentionOf(made.plan), 14);
  for (let i = 0; i < 100; i++) {
    const r = (await api.call(`/deployments/${made.deploymentId}`, { token: ANA })).body;
    if (r.status === "succeeded" || r.status === "failed") {
      assert.equal(r.status, "succeeded", r.failureReason);
      assert.equal(r.paused, true, "a deploy of a paused API says it is still paused");
      assert.match(r.report, /Your app is paused/);
      break;
    }
    await new Promise(res => setTimeout(res, 50));
  }
  assert.match(api.awsCalls().find(l => l.startsWith("cloudformation deploy")), /RetentionDays=14/);
});
