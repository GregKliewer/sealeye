// Each record says its stage (PHASE5-PLAN Step 3, D5): dev when it says none, as every
// record made before does. Nothing past dev is built again from the API until its gate
// is asked (Step 8). A real API with records; no AWS.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { startApi, token } from "./helpers/api-with-aws.js";
import { environmentName } from "../core/names.js";

const DEV = token("d");
const who = { org: "default", team: "payments", app: "notes" };
const at = new Date(Date.now() - 3600_000).toISOString();
const base = { app: { name: "notes", type: "api" }, teamId: "payments", orgId: "default", kind: "api", backend: "terraform", artifactKey: "x/dep.zip", plan: { planVersion: "0.5", catalog: "starter", app: { name: "notes", type: "api" }, profile: "dev", modules: [] }, startedAt: at, finishedAt: at, outputs: {} };

let h;
before(async () => {
  h = await startApi({
    tokens: [{ token: DEV, id: "dev", team: "payments" }],
    records: [
      { ...base, deploymentId: "dep_sit000000001", stage: "sit", status: "succeeded", stackName: environmentName({ ...who, stage: "sit" }), resourceName: "sealeye-notes-sit" },
      { ...base, deploymentId: "dep_dev000000001", status: "succeeded", stackName: environmentName(who), resourceName: "sealeye-notes" }
    ],
    aws: ""
  });
});
after(() => h?.stop());

test("the listing and each record say their stage, dev for a record that says none", async () => {
  const list = (await h.call("/deployments", { token: DEV })).body.deployments;
  const byId = Object.fromEntries(list.map(d => [d.deploymentId, d]));
  assert.equal(byId.dep_dev000000001.stage, "dev");
  assert.equal(byId.dep_sit000000001.stage, "sit");
  assert.notEqual(byId.dep_dev000000001.environment, byId.dep_sit000000001.environment, "two environments");
  assert.equal(byId.dep_dev000000001.replaced, false, "a later stage's success does not replace dev's");
  assert.equal((await h.call("/deployments/dep_dev000000001", { token: DEV })).body.stage, "dev");
  assert.equal((await h.call("/deployments/dep_sit000000001", { token: DEV })).body.stage, "sit");
});

test("a stage past dev is not built again from here: it waits on its gate", async () => {
  const res = await h.call("/deployments", { token: DEV, method: "POST", body: { backend: "cloudformation", fromDeployment: "dep_sit000000001" } });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, "STAGE_WAITS_ON_ITS_GATE");
  assert.match(res.body.error.message, /^The sit environment of notes changes only once that stage's approval is given/);
});
