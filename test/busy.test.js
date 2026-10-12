// One change at a time (DESIGN.md): while a deploy or a tear-down of an environment is
// under way, another deploy, deploy again, tear-down, pause or resume of it is refused
// with ENVIRONMENT_BUSY, naming what is under way, on both surfaces. A drafted plan
// changes nothing, so it is still saved; a change interrupted long ago stops counting.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { busyRefusal, changeUnderWay } from "../api/busy.js";
import { startApi, token } from "./helpers/api-with-aws.js";

const root = path.resolve(import.meta.dirname, "..");
const ANA = token("a");
const stack = "sealeye-default-orders-api-aaaaaa";
const quiet = "sealeye-default-quiet-api-bbbbbb";
const plan = name => ({
  planVersion: "0.4", app: { name, type: "api" }, profile: "dev",
  modules: [{ id: "http_api_serverless", inputs: { runtime: "nodejs", entry_point: "index.js", trigger: "http" } }],
  outputs: ["public_url"]
});
const now = new Date().toISOString();
const twoDaysAgo = new Date(Date.now() - 2 * 86400_000).toISOString();
const base = { backend: "cloudformation", orgId: "default", teamId: "default", outputs: {}, kind: "api", settings: [] };
let api;

before(async () => {
  api = await startApi({
    tokens: [{ token: ANA, id: "ana", name: "Ana", team: "default" }],
    records: [
      // Newest first: a deploy of orders-api under way, started from the portal.
      { ...base, surface: "portal", deploymentId: "dep_orders00002", app: { name: "orders-api" }, status: "running", stackName: stack, resourceName: stack,
        plan: plan("orders-api"), startedAt: now, requestedBy: { user: "pat@example.com", name: "Pat", verified: "token" } },
      { ...base, surface: "cli", deploymentId: "dep_orders00001", app: { name: "orders-api" }, status: "succeeded", stackName: stack, resourceName: stack,
        plan: plan("orders-api"), startedAt: twoDaysAgo, artifactKey: `${stack}/dep_orders00001.zip`, artifactSha256: "c".repeat(64) },
      // quiet-api was being built two days ago when the API stopped: it stays interrupted
      // and no longer counts.
      { ...base, surface: "cli", deploymentId: "dep_quiet000002", app: { name: "quiet-api" }, status: "running", stackName: quiet, resourceName: quiet,
        plan: plan("quiet-api"), startedAt: twoDaysAgo }
    ],
    aws: `
if (args[1] === "describe-stacks") out({ Stacks: [{ StackStatus: "UPDATE_IN_PROGRESS", Outputs: [] }] });
if (args[1] === "describe-stack-events") out({ StackEvents: [] });
if (args[1] === "get-function-concurrency") out({});
if (args[1] === "put-function-concurrency") out({ ReservedConcurrentExecutions: 0 });
`,
    env: { SEALEYE_BUCKET: "artifacts", SEALEYE_LWA_VERSION: "25", SEALEYE_FUNCTION_BOUNDARY_ARN: "arn:aws:iam::123456789012:policy/boundary" }
  });
});

after(() => api?.stop());

const busy = (res, label) => {
  assert.equal(res.status, 409, `${label}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.error.code, "ENVIRONMENT_BUSY", label);
  assert.match(res.body.error.message, /^orders-api is being built right now \(dep_orders00002, a deploy started by Pat from the portal, (just now|1 minute ago)\)\. One change at a time: wait for it to finish, or follow it with sealeye watch dep_orders00002\.$/, label);
};

test("nothing else changes an environment while it is being built", async () => {
  busy(await api.call("/deployments", { token: ANA, method: "POST", body: { backend: "cloudformation", fromDeployment: "dep_orders00001" } }), "deploy again");
  busy(await api.call("/deployments", { token: ANA, method: "POST", body: { backend: "cloudformation", plan: plan("orders-api"), appPath: root } }), "deploy");
  busy(await api.call("/deployments/dep_orders00001", { token: ANA, method: "DELETE" }), "tear down from an older record");
  busy(await api.call("/deployments/dep_orders00002", { token: ANA, method: "DELETE" }), "tear down the one being built");
  busy(await api.call("/deployments/dep_orders00001/pause", { token: ANA, method: "POST" }), "pause");
  busy(await api.call("/deployments/dep_orders00002/resume", { token: ANA, method: "POST" }), "resume");
  assert.ok(!api.awsCalls().some(l => /cloudformation (deploy|delete-stack)|put-function-concurrency/.test(l)), "nothing reached AWS");
  assert.equal((await api.call("/deployments/dep_orders00002", { token: ANA })).body.status, "running");
});

test("a drafted plan is still saved while the environment is busy", async () => {
  const drafted = { ...plan("orders-api"), needs: [{ kind: "continuous_service", line: "x", evidence: [{ file: "index.js", shows: "reads a stream in a loop" }] }] };
  const res = await api.call("/deployments", { token: ANA, method: "POST", body: { backend: "cloudformation", plan: drafted, appPath: root } });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, "UNSUPPORTED_NEEDS");
});

test("a change interrupted more than a day ago does not hold the environment", async () => {
  const res = await api.call("/deployments/dep_quiet000002/pause", { token: ANA, method: "POST" });
  assert.notEqual(res.body.error?.code, "ENVIRONMENT_BUSY", JSON.stringify(res.body));
});

test("sealeye says the same sentence and how to follow it", async () => {
  const run = (...args) => promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), ...args, "--api", api.api], {
    cwd: api.home, env: { ...process.env, HOME: api.home, SEALEYE_HOME: api.home, SEALEYE_TOKEN: ANA, NO_COLOR: "1" }
  });
  for (const args of [["destroy", "orders-api", "--yes"], ["pause", "orders-api"], ["deploy", "--again", "dep_orders00001"]]) {
    await assert.rejects(run(...args), err => {
      const said = err.stdout + err.stderr;
      assert.match(said, /orders-api is being built right now/, args.join(" "));
      assert.match(said, /sealeye watch dep_orders00002/, args.join(" "));
      assert.ok(!said.includes('"code"'), `${args.join(" ")} says it in words, not JSON`);
      return true;
    });
  }
});

test("what counts as under way, and the words for it", () => {
  const t = Date.parse("2026-10-12T12:00:00Z");
  const at = ms => new Date(t - ms).toISOString();
  const records = [
    { deploymentId: "d1", status: "queued", environment: "env-a", startedAt: at(1000), app: { name: "a" }, surface: "cli" },
    { deploymentId: "d2", status: "packaging", stackName: "env-b", startedAt: at(25 * 3600_000) },
    { deploymentId: "d3", status: "destroying", stackName: "env-c", startedAt: at(30 * 86400_000), destroyRequestedBy: { name: "Lee", surface: "portal", at: at(5 * 60_000) }, app: { name: "c" } },
    { deploymentId: "d4", status: "running", stackName: "env-d", startedAt: at(1000), interrupted: true },
    { deploymentId: "d5", status: "succeeded", stackName: "env-e", startedAt: at(1000) }
  ];
  const find = env => changeUnderWay(env, { now: t, records })?.deploymentId || null;
  assert.equal(find("env-a"), "d1", "a queued deploy, named before its stack exists");
  assert.equal(find("env-b"), null, "older than a day");
  assert.equal(find("env-c"), "d3", "a tear-down counts from when it was asked for");
  assert.equal(find("env-d"), null, "interrupted");
  assert.equal(find("env-e"), null, "finished");
  assert.equal(find(null), null);
  assert.equal(changeUnderWay("env-a", { now: t, records, except: "d1" }), null);
  assert.equal(busyRefusal(records[2], { now: t }).error.message,
    "c is being torn down right now (d3, a tear-down started by Lee from the portal, 5 minutes ago). One change at a time: wait for it to finish, or follow it with sealeye watch d3.");
  assert.match(busyRefusal(records[0], { now: t }).error.message, /^a is waiting to start right now \(d1, a deploy from the command line, just now\)/);
});

test("two deploys again at once: the second is refused, even while the first waits on the store", async () => {
  const slowStack = "sealeye-default-slow-api-cccccc";
  const slowPlan = { ...plan("slow-api"), modules: [...plan("slow-api").modules, { id: "config_basic", inputs: { variables: { GREETING: "" } } }] };
  const slow = await startApi({
    tokens: [{ token: ANA, id: "ana", name: "Ana", team: "default" }],
    records: [{ ...base, surface: "cli", deploymentId: "dep_slow0000001", app: { name: "slow-api" }, status: "succeeded", stackName: slowStack, resourceName: slowStack,
      plan: slowPlan, startedAt: now, artifactKey: `${slowStack}/dep_slow0000001.zip`, artifactSha256: "c".repeat(64), settings: [{ name: "GREETING", source: "store" }] }],
    aws: `
if (args[1] === "get-parameters-by-path") { setTimeout(() => out([{ name: opt("--path") + "GREETING", changedAt: null }]), 800); return; }
if (args[1] === "describe-stacks") out({ Stacks: [{ StackStatus: "UPDATE_IN_PROGRESS", Outputs: [] }] });
`,
    env: { SEALEYE_BUCKET: "artifacts", SEALEYE_LWA_VERSION: "25", SEALEYE_FUNCTION_BOUNDARY_ARN: "arn:aws:iam::123456789012:policy/boundary" }
  });
  try {
    const again = () => slow.call("/deployments", { token: ANA, method: "POST", body: { backend: "cloudformation", fromDeployment: "dep_slow0000001" } });
    const results = await Promise.all([again(), again()]);
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409], JSON.stringify(results.map(r => r.body)));
    assert.equal(results.find(r => r.status === 409).body.error.code, "ENVIRONMENT_BUSY");
  } finally {
    slow.stop();
  }
});
