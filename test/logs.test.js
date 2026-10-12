// sealeye logs and GET /deployments/{id}/logs (PHASE2-PLAN Step 16): an app's recent
// lines, newest first, with anything that looks like a secret, and the value of any
// setting the app has in the store, taken out before either surface sees it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { startApi, token } from "./helpers/api-with-aws.js";

const root = path.resolve(import.meta.dirname, "..");
const ANA = token("a");
const PAT = token("p");
let api;

const base = { backend: "cloudformation", orgId: "default", teamId: "default", surface: "cli", outputs: {}, startedAt: new Date().toISOString() };

before(async () => {
  api = await startApi({
    tokens: [{ token: ANA, id: "ana", team: "default" }, { token: PAT, id: "pat", team: "payments" }],
    records: [
      { ...base, deploymentId: "dep_api00000001", app: { name: "orders-api" }, kind: "api", status: "succeeded", stackName: "sealeye-default-orders-api-aaaaaa", resourceName: "sealeye-default-orders-api-aaaaaa" },
      { ...base, deploymentId: "dep_quiet000001", app: { name: "quiet-api" }, kind: "api", status: "succeeded", stackName: "sealeye-default-quiet-api-bbbbbb", resourceName: "sealeye-default-quiet-api-bbbbbb" },
      { ...base, deploymentId: "dep_site0000001", app: { name: "site" }, kind: "static", status: "succeeded", stackName: "sealeye-default-site-cccccc" },
      { ...base, deploymentId: "dep_draft000001", app: { name: "draft-api" }, status: "drafted" }
    ],
    aws: `
if (args[1] === "get-parameters-by-path") out([{ name: opt("--path") + "GREETING", changedAt: null }]);
if (args[1] === "filter-log-events") {
  if (opt("--log-group-name").includes("quiet")) fail("An error occurred (ResourceNotFoundException) when calling the FilterLogEvents operation: The specified log group does not exist.");
  const t = Date.now();
  out([
    { timestamp: t - 3000, message: "starting with GREETING=hello-from-the-store\\n" },
    { timestamp: t - 2000, message: "called with Authorization: Bearer abcdefghijklmnopqrstuvwxyz and sk-ant-api03-supersecretvalue" },
    { timestamp: t - 1000, message: "token sl_${"z".repeat(43)} and API_KEY=plain-text-key" }
  ]);
}
`
  });
});

after(() => api?.stop());

test("an app's lines come newest first, with secrets and stored setting values taken out", async () => {
  const { status, body } = await api.call("/deployments/dep_api00000001/logs?since=15m", { token: ANA });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.since, "15m");
  assert.equal(body.lines.length, 3);
  assert.match(body.lines[0].message, /^token \[value redacted\] and API_KEY=\[value redacted\]$/);
  assert.match(body.lines[1].message, /Bearer \[value redacted\] and \[value redacted\]$/);
  assert.equal(body.lines[2].message, "starting with GREETING=[value redacted]");
  const all = JSON.stringify(body);
  for (const secret of ["hello-from-the-store", "abcdefghijklmnop", "supersecret", "plain-text-key", "zzzzzzzzzz"]) assert.ok(!all.includes(secret), secret);

  const call = api.awsCalls().find(l => l.startsWith("logs filter-log-events"));
  assert.match(call, /--log-group-name \/aws\/lambda\/sealeye-default-orders-api-aaaaaa/);
  const start = Number(/--start-time (\d+)/.exec(call)[1]);
  assert.ok(Date.now() - start < 16 * 60_000 && Date.now() - start > 14 * 60_000, "the window asked for");
});

test("what has no logs says why, and nobody else's are readable", async () => {
  const quiet = await api.call("/deployments/dep_quiet000001/logs", { token: ANA });
  assert.equal(quiet.status, 200);
  assert.match(quiet.body.note, /has not written anything yet/);

  const site = await api.call("/deployments/dep_site0000001/logs", { token: ANA });
  assert.equal(site.status, 409);
  assert.match(site.body.error.message, /static site has no code of its own running/);

  const draft = await api.call("/deployments/dep_draft000001/logs", { token: ANA });
  assert.equal(draft.status, 409);
  assert.match(draft.body.error.message, /Nothing was built/);

  assert.equal((await api.call("/deployments/dep_api00000001/logs?since=1y", { token: ANA })).status, 400);
  assert.equal((await api.call("/deployments/dep_api00000001/logs", { token: PAT })).status, 404, "another team's");
});

test("sealeye logs prints them oldest first, by app name", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), "logs", "orders-api", "--since", "15m", "--api", api.api], {
    cwd: api.home, env: { ...process.env, HOME: api.home, SEALEYE_HOME: api.home, SEALEYE_TOKEN: ANA, NO_COLOR: "1" }
  });
  const lines = stdout.split("\n").filter(l => /^\d\d:\d\d:\d\d {2}/.test(l));
  assert.equal(lines.length, 3);
  assert.match(lines[0], /starting with GREETING=\[value redacted\]/);
  assert.ok(!stdout.includes("hello-from-the-store"));
});
