// `sealeye platform` (PHASE4-PLAN Step 9) against a real API: the values at a stage, what
// each module still needs, setting a word or a list, removing one, and the API's
// refusals in its own words.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { startApi, token } from "./helpers/api-with-aws.js";

const root = path.resolve(import.meta.dirname, "..");
const PLAT = token("q");
const TEAM = token("t");
let api;

before(async () => {
  const doc = JSON.parse(fs.readFileSync(path.join(root, "test/fixtures/juniper-catalog-3.json"), "utf8"));
  for (const m of doc.modules) { m.runs = []; m.outputs = {}; m.delivers = null; }
  Object.assign(doc.modules.find(m => m.id === "http_api"), { delivers: { kind: "package", package: "package_path", handler: "handler", address: "url" }, outputs: { url: {} } });
  const at = new Date().toISOString();
  api = await startApi({
    tokens: [
      { token: PLAT, id: "plat", team: "platform", scope: "org", org: "juniper" },
      { token: TEAM, id: "team", team: "payments", org: "juniper" }
    ],
    records: [],
    aws: "",
    files: { "catalogs.json": [{ org: "juniper", version: 3, status: "live", document: doc, createdBy: "p", createdAt: at, approvedBy: "p", approvedAt: at, madeLiveBy: "p", madeLiveAt: at }] }
  });
});

after(() => api?.stop());

const sealeye = (args, tok) => promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), ...args, "--api", api.api], {
  env: { ...process.env, NO_COLOR: "1", SEALEYE_TOKEN: tok, SEALEYE_HOME: api.home }
}).catch(err => err);

test("sealeye platform lists the values and what each module still needs, then sets and removes one", async () => {
  const first = await sealeye(["platform"], PLAT);
  assert.match(first.stdout, /Platform values for dev, the stage developers' environments are built as:/);
  assert.match(first.stdout, /none yet/);
  assert.match(first.stdout, /http_api\s+not built: the platform has no value for its permissions_boundary_arn input/);
  assert.match(first.stdout, /Set one with: sealeye platform set permissions_boundary_arn <value>/);

  const set = await sealeye(["platform", "set", "permissions_boundary_arn", "arn:aws:iam::123456789012:policy/b"], PLAT);
  assert.match(set.stdout, /permissions_boundary_arn is set for dev in juniper: arn:aws:iam::123456789012:policy\/b\./);
  const list = await sealeye(["platform", "set", "subnet_ids", "subnet-1", "subnet-2", "--stage", "staging"], PLAT);
  assert.match(list.stdout, /subnet_ids is set for staging in juniper: subnet-1, subnet-2\./);

  const after = await sealeye(["platform"], PLAT);
  assert.match(after.stdout, /permissions_boundary_arn\s+arn:aws:iam::123456789012:policy\/b/);
  assert.match(after.stdout, /http_api\s+built/);
  const staging = JSON.parse((await sealeye(["platform", "--stage", "staging", "--json"], PLAT)).stdout);
  assert.deepEqual(staging.values.map(v => [v.name, v.value]), [["subnet_ids", ["subnet-1", "subnet-2"]]]);

  const gone = await sealeye(["platform", "unset", "subnet_ids", "--stage", "staging"], PLAT);
  assert.match(gone.stdout, /subnet_ids is removed for staging in juniper\./);
  const again = await sealeye(["platform", "unset", "subnet_ids", "--stage", "staging"], PLAT);
  assert.match(again.stdout, /was not set for staging in juniper, so nothing changed/);
});

test("sealeye platform says the API's refusal in its own words", async () => {
  const secret = await sealeye(["platform", "set", "api_key", "ghp_0123456789abcdefghijABCDEFGHIJ0123456789"], PLAT);
  assert.match(secret.stderr, /looks like a secret, so it was not kept/);
  assert.doesNotMatch(`${secret.stdout}${secret.stderr}`, /ghp_0123/);
  const team = await sealeye(["platform"], TEAM);
  assert.match(team.stderr, /Platform values are for your platform team/);
  const odd = await sealeye(["platform", "frob"], PLAT);
  assert.match(odd.stderr, /takes set or unset/);
});
