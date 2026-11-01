// One app, an environment per stage (PHASE5-PLAN Step 3, D5): each stage past dev has a
// name, a state and a busy rule of its own, and dev keeps everything it had, so nothing
// standing is renamed or moved. No AWS.
import { test } from "node:test";
import assert from "node:assert/strict";

import { environmentName, moduleName, stageForName } from "../core/names.js";
import { environmentKey, environmentStage } from "../core/environments.js";
import { namingFor } from "../api/executor/compose.js";
import { inputsFor, stateKeyFor } from "../api/executor/terraform/root.js";
import { ownOtherLogGroup } from "../core/terraform-modules.js";
import { changeUnderWay } from "../api/busy.js";

const who = { org: "juniper", team: "payments", app: "account-notes-api" };

test("dev keeps the name every environment had; a later stage has the stage in its name and its hash", () => {
  assert.equal(environmentName({ ...who, stage: "dev" }), environmentName(who), "dev is the default");
  assert.match(environmentName(who), /^sealeye-payments-account-notes-api-[0-9a-f]{6}$/);
  const sit = environmentName({ ...who, stage: "sit" });
  assert.match(sit, /^sealeye-payments-account-notes-api-sit-[0-9a-f]{6}$/);
  assert.notEqual(sit.slice(-6), environmentName(who).slice(-6), "the hash is over the stage too");
  const names = ["dev", "sit", "uat", "staging", "prod", "perf"].map(stage => environmentName({ ...who, stage }));
  assert.equal(new Set(names).size, names.length, "every stage is an environment of its own");
});

test("a later stage's name keeps to the limit, and the stage is never cut off by a long app name", () => {
  for (const stage of ["sit", "staging", "a-stage-of-the-catalogs-own-naming"]) {
    const name = environmentName({ org: "o", team: "t".repeat(40), app: "a".repeat(100), stage });
    assert.ok(name.length <= 49, name);
    assert.ok(name.includes(`-${stageForName(stage)}-`), `${name} says ${stage}`);
  }
  assert.equal(stageForName(""), "dev");
  assert.equal(stageForName("Staging"), "staging");
});

test("the module's name stays short, and differs by stage even for a module told no stage", () => {
  const dev = moduleName(who);
  const sit = moduleName({ ...who, stage: "sit" });
  assert.equal(dev, moduleName({ ...who, stage: "dev" }));
  assert.ok(sit.length <= 31 && /^sealeye-/.test(sit));
  assert.notEqual(sit, dev);
  assert.equal(sit.slice(-6), environmentName({ ...who, stage: "sit" }).slice(-6), "the stage's environment's hash");
});

test("a record says its stage, dev when it says none; each stage of an app is its own environment's key", () => {
  assert.equal(environmentStage({}), "dev");
  assert.equal(environmentStage(null), "dev");
  assert.equal(environmentStage({ stage: "sit" }), "sit");
  const dev = { deploymentId: "dep_1", stackName: environmentName(who) };
  const sit = { deploymentId: "dep_2", stackName: environmentName({ ...who, stage: "sit" }), stage: "sit" };
  assert.notEqual(environmentKey(dev), environmentKey(sit));
  // Drafts have no name in the cloud: dev's key is as before, a later stage's says it.
  assert.equal(environmentKey({ deploymentId: "d", teamId: "payments", app: { name: "x" } }), "payments:x");
  assert.equal(environmentKey({ deploymentId: "d", teamId: "payments", app: { name: "x" }, stage: "uat" }), "payments:x:uat");
});

test("each stage keeps its own name from its own records, and another stage's never count", () => {
  const sitName = environmentName({ ...who, stage: "sit" });
  const records = [
    { deploymentId: "dep_s", app: { name: who.app }, orgId: "juniper", teamId: "payments", stage: "sit", status: "succeeded", stackName: sitName, resourceName: "sealeye-x-sit" },
    { deploymentId: "dep_d", app: { name: who.app }, orgId: "juniper", teamId: "payments", status: "succeeded", stackName: "sealeye-account-notes-api", resourceName: "sealeye-account-notes-api" }
  ];
  const dev = namingFor({ ...who, records });
  assert.equal(dev.stackName, "sealeye-account-notes-api", "dev's old name is kept from its record, and the sit record is not taken for it");
  const sit = namingFor({ ...who, stage: "sit", records });
  assert.deepEqual(sit, { stackName: sitName, resourceName: "sealeye-x-sit", reused: true });
  const uat = namingFor({ ...who, stage: "uat", records });
  assert.deepEqual(uat, { stackName: environmentName({ ...who, stage: "uat" }), resourceName: environmentName({ ...who, stage: "uat" }), reused: false });
});

test("dev's state is where it always was; a later stage's is under its stage", () => {
  assert.equal(stateKeyFor({ org: "juniper", environment: "sealeye-a-1" }), "tofu-state/juniper/sealeye-a-1.tfstate");
  assert.equal(stateKeyFor({ org: "juniper", environment: "sealeye-a-1", stage: "dev" }), "tofu-state/juniper/sealeye-a-1.tfstate");
  assert.equal(stateKeyFor({ org: "juniper", environment: "sealeye-a-sit-2", stage: "sit" }), "tofu-state/juniper/sit/sealeye-a-sit-2.tfstate");
});

test("the module is told the stage it is built for, never dev by rule", () => {
  const entry = { id: "static_site", inputs: { name: { required: true }, stage: { required: true } } };
  assert.equal(inputsFor({ entry, planModule: { id: "static_site" }, name: "n", tags: {} }).inputs.stage, "dev");
  const sit = inputsFor({ entry, planModule: { id: "static_site" }, name: "n", tags: {}, stage: "sit" });
  assert.equal(sit.inputs.stage, "sit");
  assert.deepEqual(sit.sources.find(s => s.name === "stage"), { name: "stage", source: "seaLeye" });
});

test("a later stage's own log groups are its own, and dev's are not taken for them", () => {
  assert.equal(ownOtherLogGroup("/aws/rds/instance/sealeye-x-abc123-sit/postgresql", "sealeye-x-abc123", "sit"), true);
  assert.equal(ownOtherLogGroup("/aws/rds/instance/sealeye-x-abc123-dev/postgresql", "sealeye-x-abc123", "sit"), false);
  assert.equal(ownOtherLogGroup("/aws/rds/instance/sealeye-x-abc123-dev/postgresql", "sealeye-x-abc123"), true, "dev unless said");
});

test("one change at a time is per stage: a build under way in dev does not hold sit, nor sit dev", () => {
  const now = Date.now();
  const started = new Date(now - 60_000).toISOString();
  const devName = environmentName(who);
  const sitName = environmentName({ ...who, stage: "sit" });
  const records = [{ deploymentId: "dep_d", status: "running", stackName: devName, startedAt: started, app: { name: who.app } }];
  assert.equal(changeUnderWay(devName, { now, records })?.deploymentId, "dep_d");
  assert.equal(changeUnderWay(sitName, { now, records }), null);
  const sitBusy = [{ deploymentId: "dep_s", status: "queued", environment: sitName, stage: "sit", startedAt: started, app: { name: who.app } }];
  assert.equal(changeUnderWay(sitName, { now, records: sitBusy })?.deploymentId, "dep_s");
  assert.equal(changeUnderWay(devName, { now, records: sitBusy }), null);
});
