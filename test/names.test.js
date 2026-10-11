// Each team's environments have names of their own (PHASE2-PLAN Step 2, D2): two teams'
// apps of the same name are two environments with two sets of names in AWS, one team's
// app is always the same environment, and environments made before keep their names.
// No AWS.
import { test } from "node:test";
import assert from "node:assert/strict";

import { environmentName } from "../core/names.js";
import { compose, namingFor } from "../api/executor/compose.js";

test("an environment's name: sealeye, the team, the app, and a short hash", () => {
  assert.match(environmentName({ team: "payments", app: "test-app" }), /^sealeye-payments-test-app-[0-9a-f]{6}$/);
  assert.equal(environmentName({ team: "payments", app: "Test App" }), environmentName({ team: "payments", app: "test-app" }), "by the same rule as safeName");
  assert.equal(environmentName({ app: "x" }), environmentName({ org: "default", team: "default", app: "x" }));
  assert.throws(() => environmentName({ team: "payments", app: "!!!" }), /app name/);
});

test("two teams' apps of the same name never share a name, nor do names hyphens make ambiguous", () => {
  const names = [
    environmentName({ team: "payments", app: "test-app" }),
    environmentName({ team: "onboarding", app: "test-app" }),
    environmentName({ team: "a", app: "b-c" }),
    environmentName({ team: "a-b", app: "c" }),
    environmentName({ org: "other-org", team: "payments", app: "test-app" })
  ];
  assert.equal(new Set(names).size, names.length, names.join(" "));
  // Nor a name an environment had before teams had names: sealeye-<app>.
  assert.notEqual(environmentName({ team: "payments", app: "foo" }), "sealeye-payments-foo");
});

test("every name fits AWS: a function name in 64, a static site's bucket in 63", () => {
  const longest = environmentName({ team: "t".repeat(40), app: "a".repeat(100) });
  assert.ok(longest.length <= 49, `${longest} is ${longest.length}`);
  assert.ok(`${longest}-123456789012`.length <= 63, "the bucket is <name>-<account>");
  assert.match(longest, /^[a-z0-9-]+$/);
  assert.doesNotMatch(longest, /--[0-9a-f]{6}$/, "a cut never leaves a hyphen before the hash");
  // Cut to the same readable part, still two names.
  assert.notEqual(environmentName({ team: "t".repeat(40), app: "a".repeat(100) }), environmentName({ team: "t".repeat(40), app: "a".repeat(99) }));
});

const at = minutes => new Date(Date.UTC(2026, 9, 11, 12, minutes)).toISOString();

test("a team's first deploy of an app gets a new name; its next one keeps it", () => {
  const first = namingFor({ app: "test-app", team: "payments", records: [] });
  assert.equal(first.stackName, environmentName({ team: "payments", app: "test-app" }));
  assert.equal(first.resourceName, first.stackName, "everything in it is called after the same name");
  assert.equal(first.reused, false);

  const records = [{ deploymentId: "dep_1", app: { name: "test-app" }, teamId: "payments", status: "succeeded", stackName: first.stackName, resourceName: first.resourceName, startedAt: at(0) }];
  assert.deepEqual(namingFor({ app: "test-app", team: "payments", records }), { ...first, reused: true });
});

test("an environment made before teams had names of their own keeps its name", () => {
  // As records were before this: the stack sealeye-<app>, the bare app name only in AppName.
  const legacy = [{ deploymentId: "dep_old", app: { name: "beneficiary-lookup-api" }, status: "succeeded",
    stackName: "sealeye-beneficiary-lookup-api", parameters: { AppName: "beneficiary-lookup-api" }, startedAt: at(0) }];
  assert.deepEqual(namingFor({ app: "beneficiary-lookup-api", records: legacy }),
    { stackName: "sealeye-beneficiary-lookup-api", resourceName: "beneficiary-lookup-api", reused: true });

  // Imported from the laptop with no organization or team: the "default" team's.
  assert.equal(namingFor({ app: "beneficiary-lookup-api", org: "default", team: "default", records: legacy }).reused, true);
  // Another team's deploy of the same app is another environment, with a name of its own.
  const theirs = namingFor({ app: "beneficiary-lookup-api", team: "payments", records: legacy });
  assert.equal(theirs.reused, false);
  assert.notEqual(theirs.stackName, "sealeye-beneficiary-lookup-api");
});

test("a torn down environment, a draft, and another organization's record are not reused", () => {
  const destroyed = [{ app: { name: "x" }, status: "destroyed", stackName: "sealeye-x", parameters: { AppName: "x" }, startedAt: at(1) },
    { app: { name: "x" }, status: "succeeded", stackName: "sealeye-x", startedAt: at(0) }];
  assert.equal(namingFor({ app: "x", records: destroyed }).stackName, environmentName({ app: "x" }), "the newest record decides, and it is torn down");

  const drafted = [{ app: { name: "x" }, status: "drafted", startedAt: at(0) }];
  assert.equal(namingFor({ app: "x", records: drafted }).reused, false, "a draft has no stack to reuse");

  const otherOrg = [{ app: { name: "x" }, orgId: "other-org", status: "succeeded", stackName: "sealeye-x", startedAt: at(0) }];
  assert.equal(namingFor({ app: "x", records: otherOrg }).reused, false);

  const failed = [{ app: { name: "x" }, status: "failed", stackName: "sealeye-x", parameters: { AppName: "x" }, startedAt: at(0) }];
  assert.equal(namingFor({ app: "x", records: failed }).stackName, "sealeye-x", "a failed stack may still be there, so its name is kept");
});

test("the templates are given the environment's name, never the bare app name", () => {
  const plan = {
    planVersion: "0.4",
    app: { name: "test-app", type: "static" },
    modules: [{ id: "static_site_edge", enabled: true, inputs: {} }]
  };
  const naming = namingFor({ app: "test-app", team: "payments" });
  const composed = compose(plan, "dep_test", undefined, {}, naming);
  assert.equal(composed.stackName, naming.stackName);
  assert.equal(composed.resourceName, naming.stackName);
  assert.deepEqual(composed.parameters, { AppName: naming.stackName });
});

test("the needs ledger counts two teams' drafts of the same app name as two apps", async () => {
  const { rollupNeeds } = await import("../api/needs.js");
  const need = { kind: "work_queue", line: "a queue between it and the work it hands off", evidence: [{ file: "index.js", shows: "hands work to a queue" }] };
  const draft = (id, team, minutes) => ({ deploymentId: id, app: { name: "test-app" }, teamId: team, status: "drafted", needs: [need], startedAt: at(minutes) });
  const ledger = rollupNeeds([draft("dep_3", "payments", 3), draft("dep_2", "onboarding", 2), draft("dep_1", "payments", 1)]);
  assert.equal(ledger.apps, 2, "one app per team, however often it drafted");
  assert.deepEqual(ledger.needs[0].apps.map(a => a.deploymentId), ["dep_3", "dep_2"], "each team's newest draft");
});
