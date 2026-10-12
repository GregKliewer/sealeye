// The change record in six lines, as `sealeye evidence` and seaLeye.online both show it
// (core/evidence-summary.js). The words are the contract between the two surfaces.
import { test } from "node:test";
import assert from "node:assert/strict";

import { evidenceSummary, humanDuration, shortHash } from "../core/evidence-summary.js";

const live = {
  subject: { app: { name: "payments-api" }, deploymentId: "dep_1", stackName: "sealeye-payments-api", profile: "dev", kind: "api" },
  requested: { requestedBy: { user: "ana@example.com", name: "Ana", host: "a-laptop" }, startedAt: "2026-10-01T10:00:00Z", origin: { planSource: "interview", answers: [1, 2] }, durationSeconds: 168 },
  approved: { planSha256: "ab".repeat(32), modules: ["http_api_serverless", "observability_basic"], needs: [] },
  built: { artifactKey: "sealeye-payments-api/dep_1.zip", events: [1, 2, 3], templatePath: "templates/http_api_serverless.yaml" },
  checkedNow: { stack: { exists: true }, answered: { status: 200, ms: 812 }, template: { result: "matches" }, changesOutside: [] },
  history: [{ startedAt: "2026-09-01T10:00:00Z" }, { startedAt: "2026-10-01T10:00:00Z" }]
};

test("a live environment reads as six labelled lines, none needing attention", () => {
  const { title, rows } = evidenceSummary(live, { name: "seaLeye", command: "sealeye" });
  assert.equal(title, "Change record for payments-api (stack sealeye-payments-api, profile dev)");
  assert.deepEqual(rows.map(r => r.label), ["Requested by", "Approved plan", "Built", "Checked now", "History"]);
  assert.match(rows[0].text, /^Ana \(ana@example\.com\) on a-laptop, .*, via sealeye run, two questions answered$/);
  assert.equal(rows[1].text, "sha256 ababab...abab, two modules, no needs");
  assert.equal(rows[2].text, "http_api_serverless template, artifact sealeye-payments-api/dep_1.zip, three CloudFormation events, 2 min 48 s");
  assert.equal(rows[3].text, "answered 200 in 0.8 s; the stack runs the template that was approved; no changes outside seaLeye");
  assert.match(rows[4].text, /^two deployments to this environment, the first on Sep 1 2026$/);
  assert.ok(rows.every(r => !r.alarm));
});

test("what needs a person is marked, and a draft says nothing was built", () => {
  const drifted = { ...live, checkedNow: { stack: { exists: false }, answered: { error: "no answer" }, template: { result: "differs" }, changesOutside: [1] } };
  const check = evidenceSummary(drifted).rows.find(r => r.label === "Checked now");
  assert.equal(check.alarm, true);
  assert.match(check.text, /the stack is gone; did not answer \(no answer\); the stack runs a different template/);

  const draft = {
    ...live,
    subject: { ...live.subject, stackName: null },
    requested: { ...live.requested, requestedBy: "not recorded", startedAt: "not recorded", origin: "not recorded" },
    approved: { ...live.approved, needs: [{}] },
    built: { none: true, sentence: "Nothing was built. The plan is drafted." },
    checkedNow: { none: true },
    history: [{ startedAt: "not recorded" }]
  };
  const { title, rows } = evidenceSummary(draft);
  assert.equal(title, "Change record for payments-api (no stack, profile dev)");
  assert.equal(rows[0].text, "not recorded, origin not recorded before 2.16.0");
  assert.match(rows[1].text, /one need$/);
  assert.equal(rows[2].text, "nothing. The plan is drafted.");
  assert.equal(rows[3].text, "nothing to check");
  assert.equal(rows[4].text, "one deployment for this app");
});

test("a deployment made again says whose code it ran and where its plan came from", () => {
  const again = { ...live, requested: { ...live.requested, origin: { planSource: "again", fromDeployment: "dep_0", planGiven: false } } };
  assert.match(evidenceSummary(again).rows[0].text, /, deployed again with dep_0's code, same plan$/);
  const withPlan = { ...live, requested: { ...live.requested, origin: { planSource: "again", fromDeployment: "dep_0", planGiven: true, file: "sealeye.yaml" } } };
  assert.match(evidenceSummary(withPlan).rows[0].text, /, deployed again with dep_0's code, plan from sealeye\.yaml$/);
});

test("an interview held in the portal says so", () => {
  const portal = { ...live, requested: { ...live.requested, origin: { command: null, planSource: "interview", answers: [1] } } };
  assert.match(evidenceSummary(portal).rows[0].text, /, in the portal, one question answered$/);
});

test("helpers", () => {
  assert.equal(humanDuration(48), "48 s");
  assert.equal(humanDuration(168), "2 min 48 s");
  assert.equal(shortHash("not a hash"), "not a hash");
});
