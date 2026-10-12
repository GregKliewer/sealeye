// Costs (PHASE2-PLAN Step 20): what each app has cost, by the sealeye:app and
// sealeye:team tags, a team's own or every team's, kept for an hour, and every
// environment deployed from now on carries the tags.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { compose } from "../api/executor/compose.js";
import { startApi, token } from "./helpers/api-with-aws.js";

const root = path.resolve(import.meta.dirname, "..");
const ANA = token("a");
const LEE = token("l");
let api;

before(async () => {
  api = await startApi({
    tokens: [{ token: ANA, id: "ana", team: "default" }, { token: LEE, id: "lee", team: "platform", scope: "org" }],
    records: [],
    aws: `
if (args[1] === "get-cost-and-usage") {
  const byTeam = args.includes("Type=TAG,Key=sealeye:team");
  const g = (keys, amount) => ({ Keys: keys, Metrics: { UnblendedCost: { Amount: String(amount), Unit: "USD" } } });
  const days = byTeam
    ? [{ Groups: [g(["sealeye:team$default", "sealeye:app$orders-api"], 1.25), g(["sealeye:team$payments", "sealeye:app$ledger"], 0.5), g(["sealeye:team$", "sealeye:app$"], 9)] },
       { Groups: [g(["sealeye:team$default", "sealeye:app$orders-api"], 0.75)] }]
    : [{ Groups: [g(["sealeye:app$orders-api"], 1.25), g(["sealeye:app$site"], 0.1), g(["sealeye:app$"], 9)] }, { Groups: [g(["sealeye:app$orders-api"], 0.75)] }];
  out({ ResultsByTime: days });
}
`
  });
});

after(() => api?.stop());

test("a team sees its own apps' costs, by tag, summed over the window, untagged left out", async () => {
  const { status, body } = await api.call("/costs?since=7d", { token: ANA });
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.apps, [{ app: "orders-api", team: "default", amount: 2 }, { app: "site", team: "default", amount: 0.1 }]);
  assert.equal(body.total, 2.1);
  assert.match(body.note, /about a day behind/);
  const call = api.awsCalls().find(l => l.startsWith("ce get-cost-and-usage"));
  assert.match(call, /"Key":"sealeye:team","Values":\["default"\]/);
  assert.match(call, /--region us-east-1/);
});

test("an organization-wide token sees every team's, and answers are kept for an hour", async () => {
  const { body } = await api.call("/costs?since=30d", { token: LEE });
  assert.equal(body.everyTeam, true);
  assert.deepEqual(body.apps.map(a => `${a.team}/${a.app}:${a.amount}`), ["default/orders-api:2", "payments/ledger:0.5"]);
  const calls = api.awsCalls().filter(l => l.startsWith("ce ")).length;
  await api.call("/costs?since=30d", { token: LEE });
  assert.equal(api.awsCalls().filter(l => l.startsWith("ce ")).length, calls, "kept, not asked again");
  assert.equal((await api.call("/costs?since=1y", { token: ANA })).status, 400);
});

test("sealeye costs prints a line per app and the total", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), "costs", "--since", "7d", "--api", api.api], {
    cwd: api.home, env: { ...process.env, HOME: api.home, SEALEYE_HOME: api.home, SEALEYE_TOKEN: ANA, NO_COLOR: "1" }
  });
  assert.match(stdout, /orders-api\s+2\.00 USD/);
  assert.match(stdout, /2\.10 USD from \d{4}-\d\d-\d\d to/);
});

test("every environment from now on carries the app and team as cost tags", () => {
  process.env.SEALEYE_BUCKET = "b"; process.env.SEALEYE_LWA_VERSION = "25"; process.env.SEALEYE_FUNCTION_BOUNDARY_ARN = "arn:aws:iam::1:policy/x";
  const plan = { planVersion: "0.4", app: { name: "Orders API", type: "api" }, modules: [{ id: "http_api_serverless", inputs: { entry_point: "index.js" } }] };
  const api_ = compose(plan, "dep_abc", null, {}, { stackName: "sealeye-pay-orders-api-1a2b3c", resourceName: "sealeye-pay-orders-api-1a2b3c", team: "Pay" });
  assert.equal(api_.parameters.TagApp, "orders-api");
  assert.equal(api_.parameters.TagTeam, "pay");
  const site = compose({ ...plan, modules: [{ id: "static_site_edge" }] }, "dep_abc", null, {}, { stackName: "s", resourceName: "s", team: "default" });
  assert.deepEqual([site.parameters.TagApp, site.parameters.TagTeam], ["orders-api", "default"]);
});
