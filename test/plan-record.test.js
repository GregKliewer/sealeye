// The plan and report for each deployment (Oct 14, 2026): the files a deployment was
// approved with are kept on its record and served, beside its report, by
// GET /deployments/{id}/plan. api/plan-record.js on its own, then the API on a spare
// port with tokens, sample records and a stand-in `aws`. No AWS, no model.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { interviewNotesFor, noteInterviewPlan, planFilesFor, planView } from "../api/plan-record.js";
import { startApi, token } from "./helpers/api-with-aws.js";

const root = path.resolve(import.meta.dirname, "..");
const sampleApp = path.join(root, "apps", "beneficiary-lookup-api");
const ANA = token("a");
const PAT = token("p");
const stack = "sealeye-default-orders-api-aaaaaa";
const plan = {
  planVersion: "0.4", app: { name: "orders-api", type: "api" }, profile: "dev",
  modules: [
    { id: "http_api_serverless", inputs: { runtime: "nodejs", entry_point: "index.js", trigger: "http" } },
    { id: "observability_basic", inputs: { target: "auto", retention_days: 30 } }
  ],
  outputs: ["public_url", "logs"]
};
const ana = { org: "default", team: "default", email: "ana@example.com" };
const notes = { summary: "A small API that looks up orders.", assumptions: ["It listens on the port it is given."] };

// --- api/plan-record.js -------------------------------------------------------------

test("what the interview said is found again only by the person who answered, for the same plan", () => {
  noteInterviewPlan(ana, { plan, ...notes });
  assert.deepEqual(interviewNotesFor(ana, plan), notes);
  assert.deepEqual(interviewNotesFor(ana, JSON.parse(JSON.stringify(plan))), notes, "the same plan sent back as JSON");
  assert.equal(interviewNotesFor({ ...ana, email: "pat@example.com" }, plan), null, "another person");
  assert.equal(interviewNotesFor({ ...ana, team: "payments" }, plan), null, "another team");
  assert.equal(interviewNotesFor(ana, { ...plan, profile: "prod" }), null, "a changed plan");
  assert.deepEqual(interviewNotesFor(ana, plan), notes, "still there for a deploy sent again");
  assert.equal(interviewNotesFor(ana, plan, Date.now() + 2 * 60 * 60 * 1000), null, "gone after an hour");
});

test("with the interview's notes, DEPLOYMENT_PLAN.md is the one the developer saw", () => {
  const { planFiles } = planFilesFor(plan, notes, new Date("2026-10-14T12:00:00Z"));
  assert.equal(planFiles.notesKept, true);
  const md = planFiles.files["DEPLOYMENT_PLAN.md"];
  assert.match(md, /A small API that looks up orders\./);
  assert.match(md, /It listens on the port it is given\./);
  assert.match(md, /October 14, 2026/);
  assert.match(planFiles.files["sealeye.yaml"], /name: orders-api/);
});

test("without them, it says they were not kept and never that none were needed", () => {
  const { planFiles } = planFilesFor(plan, null);
  assert.equal(planFiles.notesKept, false);
  const md = planFiles.files["DEPLOYMENT_PLAN.md"];
  assert.match(md, /summary and assumptions are not part of this deployment's record/);
  assert.doesNotMatch(md, /No assumptions were needed/);
  assert.doesNotMatch(md, /\u2014/, "no em dash");
});

test("a plan the files cannot be written for gets the reason, not an exception", () => {
  const written = planFilesFor(null, null);
  assert.equal(written.planFiles, undefined);
  assert.match(written.planFilesError, /\S/);
  const view = planView({ deploymentId: "dep_x", status: "failed", planFilesError: "the template is missing" });
  assert.equal(view.files, null);
  assert.equal(view.filesError, "the template is missing");
});

test("an old plan naming a module seaLeye cannot build is written down as a draft, not refused", () => {
  const old = { planVersion: "0.3", app: { name: "orders-api", type: "api" }, profile: "dev",
    modules: [...plan.modules, { id: "secrets_basic", enabled: true, inputs: {} }], outputs: ["public_url"] };
  const view = planView({ deploymentId: "dep_old03", status: "succeeded", plan: old, startedAt: "2026-08-01T12:00:00Z" });
  assert.equal(view.filesError, undefined, view.filesError);
  assert.doesNotMatch(view.files["DEPLOYMENT_PLAN.md"], /secrets_basic/);
});

test("an older record is written down from its plan, dated when it started, and marked rebuilt", () => {
  const view = planView({ deploymentId: "dep_old", app: { name: "orders-api" }, status: "succeeded", plan, startedAt: "2026-09-02T15:00:00Z", report: "# Report\n" });
  assert.equal(view.rebuilt, true);
  assert.equal(view.notesKept, false);
  assert.match(view.files["DEPLOYMENT_PLAN.md"], /September 2, 2026/);
  assert.equal(view.report, "# Report\n");
  assert.equal(planView({ deploymentId: "dep_none", status: "failed" }).files, null);
});

// --- GET /deployments/{id}/plan -----------------------------------------------------

let api;

before(async () => {
  const kept = planFilesFor(plan, notes, new Date("2026-10-01T12:00:00Z")).planFiles;
  api = await startApi({
    tokens: [{ token: ANA, id: "ana", team: "default" }, { token: PAT, id: "pat", team: "payments" }],
    records: [
      {
        backend: "cloudformation", orgId: "default", teamId: "default", surface: "portal", outputs: {}, startedAt: new Date().toISOString(),
        deploymentId: "dep_orders00002", app: { name: "orders-api" }, kind: "api", status: "succeeded", stackName: stack, resourceName: stack,
        plan, planFiles: kept, report: "# Deployment Report\n\nIt worked.\n", settings: [], artifactKey: `${stack}/dep_orders00002.zip`, artifactSha256: "c".repeat(64)
      },
      {
        backend: "cloudformation", orgId: "default", teamId: "default", surface: "cli", outputs: {}, startedAt: "2026-09-02T15:00:00Z",
        deploymentId: "dep_orders00001", app: { name: "orders-api" }, kind: "api", status: "failed", failureReason: "it did not start", stackName: stack, plan
      }
    ],
    aws: `
if (args[1] === "get-parameters-by-path") out([]);
if (args[1] === "head-object") out({});
if (args[1] === "deploy") process.exit(0);
if (args[1] === "describe-stacks") out({ Stacks: [{ StackStatus: "UPDATE_COMPLETE", Outputs: [] }] });
if (args[1] === "get-function-concurrency") out({});
`,
    env: { SEALEYE_BUCKET: "artifacts", SEALEYE_LWA_VERSION: "25", SEALEYE_FUNCTION_BOUNDARY_ARN: "arn:aws:iam::123456789012:policy/boundary" }
  });
});

after(() => api?.stop());

test("a deployment's plan comes back as approved, with its report", async () => {
  const res = await api.call("/deployments/dep_orders00002/plan", { token: ANA });
  assert.equal(res.status, 200);
  assert.equal(res.body.rebuilt, false);
  assert.equal(res.body.notesKept, true);
  assert.match(res.body.files["DEPLOYMENT_PLAN.md"], /A small API that looks up orders\./);
  assert.match(res.body.files["sealeye.yaml"], /orders-api/);
  assert.match(res.body.report, /It worked\./);
});

test("a failed deployment from before plans were kept: its plan, rebuilt, and no report", async () => {
  const res = await api.call("/deployments/dep_orders00001/plan", { token: ANA });
  assert.equal(res.status, 200);
  assert.equal(res.body.rebuilt, true);
  assert.equal(res.body.report, null);
  assert.equal(res.body.status, "failed");
  assert.match(res.body.files["DEPLOYMENT_PLAN.md"], /not part of this deployment's record/);
});

test("another team's deployment, or none, is not found", async () => {
  assert.equal((await api.call("/deployments/dep_orders00002/plan", { token: PAT })).status, 404);
  assert.equal((await api.call("/deployments/dep_nothing0000/plan", { token: ANA })).status, 404);
  assert.equal((await api.call("/deployments/dep_orders00002/plan")).status, 401);
});

test("the record itself, polled while a change is watched, leaves the files to /plan", async () => {
  const res = await api.call("/deployments/dep_orders00002", { token: ANA });
  assert.equal(res.status, 200);
  assert.equal(res.body.planFiles, undefined);
  assert.ok(res.body.plan, "the plan is still there");
});

test("the list stays small: no plan files or report in it", async () => {
  const res = await api.call("/deployments", { token: ANA });
  const row = (res.body.deployments || res.body).find(d => d.deploymentId === "dep_orders00002");
  assert.ok(row);
  assert.equal(row.planFiles, undefined);
  assert.equal(row.report, undefined);
});

test("a drafted plan is kept with its files, saying the interview's notes were not sent with it", async () => {
  const drafted = { ...plan, app: { name: "stream-reader", type: "api" }, needs: [{ kind: "continuous_service", line: "x", evidence: [{ file: "index.js", shows: "reads a stream in a loop" }] }] };
  const res = await api.call("/deployments", { token: ANA, method: "POST", body: { backend: "cloudformation", plan: drafted, appPath: sampleApp } });
  assert.equal(res.status, 422);
  const id = res.body.error.details.deploymentId;
  const view = await api.call(`/deployments/${id}/plan`, { token: ANA });
  assert.equal(view.status, 200);
  assert.equal(view.body.rebuilt, false);
  assert.equal(view.body.notesKept, false);
  assert.match(view.body.files["DEPLOYMENT_PLAN.md"], /What Your App Needs That No Module Supports Yet/);
  assert.equal(view.body.report, null);
});

test("deploying the same plan again keeps the files that were approved; a changed plan is written down fresh", async () => {
  const same = await api.call("/deployments", { token: ANA, method: "POST", body: { backend: "cloudformation", fromDeployment: "dep_orders00002" } });
  assert.equal(same.status, 201, JSON.stringify(same.body));
  let view = await api.call(`/deployments/${same.body.deploymentId}/plan`, { token: ANA });
  assert.equal(view.body.notesKept, true);
  assert.match(view.body.files["DEPLOYMENT_PLAN.md"], /A small API that looks up orders\./);

  // Wait for it to finish, so the next change is not refused as busy, and for its report.
  for (let i = 0; i < 100; i++) {
    view = await api.call(`/deployments/${same.body.deploymentId}/plan`, { token: ANA });
    if (view.body.status === "succeeded" || view.body.status === "failed") break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(view.body.status, "succeeded");
  assert.match(view.body.report || "", /\S/, "the report this deployment made");

  const changed = { ...plan, modules: [plan.modules[0], { id: "observability_basic", inputs: { target: "auto", retention_days: 14 } }] };
  const other = await api.call("/deployments", { token: ANA, method: "POST", body: { backend: "cloudformation", fromDeployment: same.body.deploymentId, plan: changed } });
  assert.equal(other.status, 201, JSON.stringify(other.body));
  view = await api.call(`/deployments/${other.body.deploymentId}/plan`, { token: ANA });
  assert.equal(view.body.notesKept, false);
  assert.match(view.body.files["sealeye.yaml"], /retention_days: 14/);
});

// --- sealeye plan -------------------------------------------------------------------

const sealeye = (...args) => promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), ...args, "--api", api.api], {
  cwd: api.home, env: { ...process.env, HOME: api.home, SEALEYE_HOME: api.home, SEALEYE_TOKEN: ANA, NO_COLOR: "1" }
});

test("sealeye plan prints the plan, and only the plan when its output goes to a file", async () => {
  const { stdout } = await sealeye("plan", "dep_orders00002");
  assert.match(stdout, /^# Deployment Plan/, "no banner and no extra lines when piped");
  assert.match(stdout, /A small API that looks up orders\./);
});

test("sealeye plan --report prints the report, or says why there is none", async () => {
  const { stdout } = await sealeye("plan", "dep_orders00002", "--report");
  assert.equal(stdout, "# Deployment Report\n\nIt worked.\n");
  await assert.rejects(sealeye("plan", "dep_orders00001", "--report"), err => {
    assert.equal(err.code, 1, "a script can tell there was none");
    assert.equal(err.stdout, "");
    assert.match(err.stderr, /This deployment failed, so there is no report\. The platform said: it did not start/);
    return true;
  });
});

test("sealeye plan --out writes the files into a folder, and never over one that is there", async () => {
  const folder = path.join(api.home, "kept-plan");
  await sealeye("plan", "dep_orders00002", "--out", folder);
  assert.deepEqual(fs.readdirSync(folder).sort(), ["DEPLOYMENT_PLAN.md", "DEPLOYMENT_REPORT.md", "sealeye.yaml"]);
  await assert.rejects(sealeye("plan", "dep_orders00002", "--out"), err => /Name the folder to write into/.test(err.stderr));
  fs.writeFileSync(path.join(folder, "sealeye.yaml"), "mine\n");
  await assert.rejects(sealeye("plan", "dep_orders00002", "--out", folder), err => /never writes over a file/.test(err.stderr));
  assert.equal(fs.readFileSync(path.join(folder, "sealeye.yaml"), "utf8"), "mine\n", "left as it was");
});

test("sealeye plan --json is the API's answer", async () => {
  const { stdout } = await sealeye("plan", "dep_orders00002", "--json");
  const view = JSON.parse(stdout);
  assert.equal(view.deploymentId, "dep_orders00002");
  assert.equal(view.notesKept, true);
  assert.ok(view.files["sealeye.yaml"]);
});
