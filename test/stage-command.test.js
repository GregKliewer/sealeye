// The command and each stage of an app (PHASE5-PLAN Step 3, D5): `sealeye list` keeps
// one row per app, with its other stages beside it; a command that acts on an
// environment takes --stage, dev when it is left out; and the evidence and the report
// name a stage past dev. A real API with records; no AWS.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { startApi, token } from "./helpers/api-with-aws.js";
import { environmentName } from "../core/names.js";
import { appKey, compareStages } from "../core/environments.js";

const root = path.resolve(import.meta.dirname, "..");
const ANA = token("a");
const who = { org: "default", team: "payments", app: "notes" };
const at = h => `2026-10-31T${String(h).padStart(2, "0")}:00:00Z`;
const base = { backend: "cloudformation", orgId: "default", teamId: "payments", surface: "cli", kind: "api", app: { name: "notes" } };

let api;
before(async () => {
  api = await startApi({
    tokens: [{ token: ANA, id: "ana", team: "payments" }],
    records: [
      { ...base, deploymentId: "dep_sit000000001", stage: "sit", status: "succeeded", stackName: environmentName({ ...who, stage: "sit" }), outputs: { ApiUrl: "https://sit.example/" }, startedAt: at(3) },
      { ...base, deploymentId: "dep_dev000000001", status: "succeeded", stackName: environmentName(who), outputs: { ApiUrl: "https://dev.example/" }, startedAt: at(2) },
      { ...base, deploymentId: "dep_lone00000001", app: { name: "lone" }, stage: "uat", status: "succeeded", stackName: environmentName({ ...who, app: "lone", stage: "uat" }), outputs: { ApiUrl: "https://uat.example/" }, startedAt: at(1) }
    ],
    aws: ""
  });
});
after(() => api?.stop());

const sealeye = async (...args) => {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), ...args, "--api", api.api], {
      cwd: api.home, env: { ...process.env, HOME: api.home, SEALEYE_HOME: api.home, SEALEYE_TOKEN: ANA, NO_COLOR: "1" }
    });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    return { code: err.code, out: (err.stdout || "") + (err.stderr || "") };
  }
};

test("stages sort as a path usually runs, and an app is its team's across its stages", () => {
  assert.deepEqual(["prod", "zeta", "dev", "staging", "alpha", "sit"].sort(compareStages), ["dev", "sit", "staging", "prod", "alpha", "zeta"]);
  assert.equal(appKey({ deploymentId: "d", teamId: "payments", app: { name: "notes" }, stage: "sit" }), appKey({ deploymentId: "e", teamId: "payments", app: { name: "notes" } }));
});

test("list keeps one row per app, with its other stages beside it", async () => {
  const { out } = await sealeye("list");
  const rows = out.split("\n").filter(l => /^(notes|lone)/.test(l));
  assert.equal(rows.length, 2, out);
  assert.match(out, /APP\s+STATUS\s+URL\s+DEPLOYS\s+STAGES\s+LAST/);
  assert.match(rows.find(r => r.startsWith("notes ")), /^notes\s+succeeded\s+https:\/\/dev\.example\/\s+1\s+sit succeeded/, "dev's row, sit beside it");
  assert.match(rows.find(r => r.startsWith("lone")), /^lone \(uat\)\s+succeeded\s+https:\/\/uat\.example\//, "an app with no dev says which stage its row is");
  assert.match(out, /Name one with --stage, as in sealeye status <app> --stage sit/);
  const json = JSON.parse((await sealeye("list", "--json")).out.slice((await sealeye("list", "--json")).out.indexOf("[")));
  assert.deepEqual(json.map(e => [e.app, e.stage]).sort(), [["lone", "uat"], ["notes", "dev"], ["notes", "sit"]], "--json is one entry per environment, each with its stage");
});

test("status takes --stage, and is dev's when it is left out", async () => {
  const dev = await sealeye("status", "notes", "--json");
  assert.equal(dev.code, 0, dev.out);
  assert.match(dev.out, /"deploymentId": "dep_dev000000001"/);
  const sit = await sealeye("status", "notes", "--stage", "sit", "--json");
  assert.match(sit.out, /"deploymentId": "dep_sit000000001"/);
  assert.match(sit.out, /"stage": "sit"/);
  const upper = await sealeye("status", "notes", "--stage", "SIT", "--json");
  assert.match(upper.out, /"deploymentId": "dep_sit000000001"/, "a stage is read as its name in lowercase");
});

test("an app with no environment at the stage asked says which stages it has", async () => {
  const lone = await sealeye("status", "lone");
  assert.notEqual(lone.code, 0);
  assert.match(lone.out, /There is no environment called lone that your team has\. lone has an environment in uat\. Name one with --stage uat\./);
  const prod = await sealeye("logs", "notes", "--stage", "prod");
  assert.match(prod.out, /There is no environment called notes in prod that your team has\. notes has environments in dev and sit\. Name one with --stage dev\./);
  const bad = await sealeye("status", "notes", "--stage");
  assert.notEqual(bad.code, 0);
  assert.match(bad.out, /--stage names a stage of your organization's path to production/);
});

test("the evidence file names a stage past dev in its header", async () => {
  const sit = await api.call("/deployments/dep_sit000000001/evidence", { token: ANA });
  const dev = await api.call("/deployments/dep_dev000000001/evidence", { token: ANA });
  assert.equal(sit.status, 200, JSON.stringify(sit.body));
  assert.match(sit.body.markdown, /environment: sealeye-payments-notes-sit-[0-9a-f]{6} · stage: sit · profile/);
  assert.doesNotMatch(dev.body.markdown, /stage:/);
});

test("the report names a stage past dev in its header, and dev's is as it was", async () => {
  const { renderReport } = await import("../api/executor/report.js");
  const record = { deploymentId: "dep_1", app: { name: "notes", type: "api" }, kind: "api", status: "succeeded", outputs: { ApiUrl: "https://x.example/" }, finishedAt: at(4), stackName: "sealeye-x" };
  const plan = { planVersion: "0.5", catalog: "starter", app: record.app, profile: "dev", modules: [] };
  const header = r => renderReport(r, plan).split("\n").find(l => l.startsWith("app: "));
  assert.match(header({ ...record, stage: "sit" }), /^app: notes · stage: sit · profile: dev/);
  assert.match(header(record), /^app: notes · profile: dev/);
});
