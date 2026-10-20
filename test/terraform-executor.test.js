// The Terraform executor (PHASE4-PLAN Step 9), end to end against a real API, with
// stand-ins for `tofu` and `aws` that log what they are asked and answer as each would.
// No AWS, no GitHub, no model. The organization's library is already in the API's home,
// as a commit fetched earlier is. GitHub Actions runs the real OpenTofu on the root
// modules seaLeye writes (.github/workflows/tofu.yml).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { zipFolder } from "../core/upload.js";
import { startApi, token } from "./helpers/api-with-aws.js";

const root = path.resolve(import.meta.dirname, "..");
const COMMIT = "5e63aa573473e988a2e2e40616ad32614a30e98b";
const REPO = "GregKliewer/sealeye-sample-platform";
const BOUNDARY = "arn:aws:iam::123456789012:policy/sealeye-function-boundary-terraform";

const PLATFORM = token("p");     // Juniper's platform engineer: organization-wide
const DEV = token("d");          // a developer on Juniper's payments team
const OTHER = token("o");        // the default organization's developer

/** Juniper's catalog 3, as discovery writes one now: with what code read of each module. */
function juniperCatalog() {
  const doc = JSON.parse(fs.readFileSync(path.join(root, "test/fixtures/juniper-catalog-3.json"), "utf8"));
  doc.discovery.library = [{ repo: REPO, commit: COMMIT }];
  for (const m of doc.modules) {
    m.runs = [];
    m.outputs = {};
    m.delivers = null;
  }
  const http = doc.modules.find(m => m.id === "http_api");
  http.outputs = { url: { line: "The API's address." }, role_name: { line: "The function's role." } };
  http.delivers = { kind: "package", package: "package_path", handler: "handler", address: "url" };
  const site = doc.modules.find(m => m.id === "static_site");
  site.outputs = { bucket_name: { line: "Upload the site's files here." }, url: { line: "The site's address." } };
  site.delivers = { kind: "files", output: "bucket_name", address: "url" };
  return doc;
}

const TOFU = `
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const log = process.env.TOFU_LOG_DIR_UNUSED || __LOG__;
fs.appendFileSync(path.join(log, "tofu.log"), JSON.stringify({ args, cwd: process.cwd(), profile: process.env.AWS_PROFILE || null, input: process.env.TF_INPUT || null, keys: Object.keys(process.env).sort() }) + "\\n");
const say = m => process.stdout.write(JSON.stringify(m) + "\\n");
const fail = (summary, detail) => { say({ type: "diagnostic", diagnostic: { severity: "error", summary, detail } }); process.exit(1); };
const failing = fs.existsSync(path.join(log, "fail-" + args[0])) ? fs.readFileSync(path.join(log, "fail-" + args[0]), "utf8") : null;
if (failing) fail(failing, "as the test asked");
const root = fs.existsSync("main.tf.json") ? JSON.parse(fs.readFileSync("main.tf.json", "utf8")) : null;
if (root) fs.writeFileSync(path.join(log, "main.tf.json"), JSON.stringify(root, null, 2));
switch (args[0]) {
  case "init": process.exit(0);
  case "plan":
    if (args.includes("-refresh-only")) { say({ type: "change_summary", changes: { add: 0, change: 0, remove: 0 } }); process.exit(0); }
    say({ type: "planned_change", change: { resource: { addr: "module.app.aws_lambda_function.fn" }, action: "create" } });
    say({ type: "change_summary", changes: { add: 9, change: 0, remove: 0, operation: "plan" } });
    fs.writeFileSync("tfplan", "plan"); process.exit(0);
  case "apply":
    say({ type: "apply_complete", hook: { resource: { addr: "module.app.aws_lambda_function.fn" }, action: "create" } });
    say({ type: "change_summary", changes: { add: 9, change: 0, remove: 0, operation: "apply" } });
    process.exit(0);
  case "output": {
    const site = root && root.output && root.output.bucket_name;
    process.stdout.write(JSON.stringify(site ? { bucket_name: { value: "juniper-site-sealeye-x-dev" }, url: { value: "https://d111.cloudfront.net" } } : { url: { value: "https://abc.execute-api.ca-central-1.amazonaws.com" } }));
    process.exit(0);
  }
  case "destroy": say({ type: "change_summary", changes: { add: 0, change: 0, remove: 9, operation: "destroy" } }); process.exit(0);
  case "state": process.stdout.write(fs.existsSync(path.join(log, "state-left")) ? "module.app.aws_s3_bucket.site\\n" : ""); process.exit(0);
  default: process.exit(0);
}
`;

let h;
let logDir;

const libraryHome = home => path.join(home, "tofu-libraries", `GregKliewer--sealeye-sample-platform--${COMMIT}`);

/** The two modules the tests build, as Juniper's library has them, enough to be read. */
function writeLibrary(home) {
  const lib = libraryHome(home);
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(lib, rel)), { recursive: true });
    fs.writeFileSync(path.join(lib, rel), text);
  };
  put("modules/http-api/main.tf", 'resource "aws_lambda_function" "fn" {}\n');
  put("modules/http-api/variables.tf", ["name", "stage", "tags", "package_path", "handler", "environment", "permissions_boundary_arn"].map(v => `variable "${v}" {}`).join("\n"));
  put("modules/static-site/main.tf", 'resource "aws_s3_bucket" "site" {}\n');
  put("modules/static-site/variables.tf", 'variable "name" {}\nvariable "stage" {}\n');
  put("modules/postgres/main.tf", 'resource "aws_db_instance" "db" {}\n');
  put(".complete", `${REPO}@${COMMIT}\n`);
}

before(async () => {
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-tofu-log-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-tofu-bin-"));
  fs.writeFileSync(path.join(bin, "tofu.cjs"), TOFU.replace("__LOG__", JSON.stringify(logDir)));
  fs.writeFileSync(path.join(bin, "tofu"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, "tofu.cjs")}" "$@"\n`, { mode: 0o755 });
  const at = new Date().toISOString();
  h = await startApi({
    tokens: [
      { token: PLATFORM, id: "platform", team: "platform", org: "juniper", scope: "org" },
      { token: DEV, id: "dev", team: "payments", org: "juniper" },
      { token: OTHER, id: "other", team: "web" }
    ],
    records: [],
    aws: `
      require("fs").appendFileSync(${JSON.stringify(path.join(logDir, "aws-profile.log"))}, (process.env.AWS_PROFILE || "-") + " " + args.slice(0, 2).join(" ") + "\\n");
      if (args[0] === "ssm") out([]);
    `,
    files: {
      "catalogs.json": [{ org: "juniper", version: 3, status: "live", document: juniperCatalog(), createdBy: "platform@example.com", createdAt: at, approvedBy: "platform@example.com", approvedAt: at, madeLiveBy: "platform@example.com", madeLiveAt: at }]
    },
    env: {
      SEALEYE_TOFU: path.join(bin, "tofu"),
      SEALEYE_BUCKET: "platform-sealeye-123456789012-ca-central-1",
      SEALEYE_TERRAFORM_PROFILE: "sealeye-deploy-terraform",
      SEALEYE_TOFU_CONFIG: "/nonexistent",
      ANTHROPIC_API_KEY: "sk-ant-never-for-tofu"
    }
  });
  writeLibrary(h.home);
});

after(() => h?.stop());

const tofuCalls = () => fs.readFileSync(path.join(logDir, "tofu.log"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
const lastRoot = () => JSON.parse(fs.readFileSync(path.join(logDir, "main.tf.json"), "utf8"));

async function appZip(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-tf-app-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const { zip } = await zipFolder(dir, { purpose: "deploy" });
  return Buffer.from(zip).toString("base64");
}

const planFor = (app, type, modules) => ({ planVersion: "0.5", catalog: 3, app: { name: app, type }, profile: "dev", modules, outputs: ["public_url"] });

async function waitFor(id, tok, done = s => ["succeeded", "failed", "destroyed"].includes(s)) {
  for (let i = 0; i < 200; i++) {
    const r = await h.call(`/deployments/${id}`, { token: tok });
    if (done(r.body.status)) return r.body;
    await new Promise(res => setTimeout(res, 50));
  }
  throw new Error(`${id} never finished`);
}

test("until the platform values are set, the module is not built, and the platform engineer is told which input is missing", async () => {
  const before = await h.call("/catalog", { token: DEV });
  assert.ok(!before.body.modules.some(m => m.id === "http_api"), "not offered without its permissions boundary");
  assert.ok(before.body.modules.some(m => m.id === "static_site"), "a site needs nothing from the platform");

  const plan = planFor("lookup", "api", [{ id: "http_api" }]);
  const refused = await h.call("/plans/validate", { token: DEV, method: "POST", body: plan });
  assert.equal(refused.body.valid, false);

  const asked = await h.call("/platform", { token: PLATFORM });
  assert.equal(asked.status, 200);
  const http = asked.body.wanted.find(w => w.module === "http_api");
  assert.equal(http.builds, false);
  assert.match(http.why, /permissions_boundary_arn/);
  assert.deepEqual(http.inputs.filter(i => i.required).map(i => i.input), ["permissions_boundary_arn"]);
  const pg = asked.body.wanted.find(w => w.module === "postgres");
  assert.match(pg.why, /does not take an app's code/);

  assert.equal((await h.call("/platform", { token: DEV })).status, 403, "a team's token cannot see them");
  assert.equal((await h.call("/platform", { token: OTHER })).status, 403);
});

test("a platform value is an id, never a secret, and fills the module's input once set", async () => {
  const secret = await h.call("/platform/values/permissions_boundary_arn", { token: PLATFORM, method: "PUT", body: { value: "AKIAIOSFODNN7EXAMPLE" } });
  assert.equal(secret.status, 400);
  assert.equal(secret.body.error.code, "LOOKS_LIKE_A_SECRET");
  assert.ok(!JSON.stringify(secret.body).includes("AKIAIOSFODNN7EXAMPLE"), "the value is never in the refusal");
  assert.equal((await h.call("/platform/values/permissions_boundary_arn", { token: PLATFORM, method: "PUT", body: { value: "two words" } })).status, 400);
  assert.equal((await h.call("/platform/values/bad%20name", { token: PLATFORM, method: "PUT", body: { value: "x" } })).status, 400);
  assert.equal((await h.call("/platform/values/x", { token: PLATFORM, method: "PUT", body: { value: "x", stage: "moon" } })).status, 400);
  assert.equal((await h.call("/platform/values/permissions_boundary_arn", { token: DEV, method: "PUT", body: { value: BOUNDARY } })).status, 403);

  const set = await h.call("/platform/values/permissions_boundary_arn", { token: PLATFORM, method: "PUT", body: { value: BOUNDARY } });
  assert.equal(set.status, 200);
  assert.equal(set.body.value.setBy, "platform@example.com");
  const list = await h.call("/platform", { token: PLATFORM });
  assert.deepEqual(list.body.values.map(v => [v.name, v.value]), [["permissions_boundary_arn", BOUNDARY]]);
  assert.equal(list.body.wanted.find(w => w.module === "http_api").builds, true);

  const now = await h.call("/catalog", { token: DEV });
  const http = now.body.document.modules.find(m => m.id === "http_api");
  assert.ok(http, "offered now");
  for (const field of ["builds_with", "runs", "delivers", "outputs"]) assert.equal(http[field], undefined, `${field} is the platform's to know`);
});

test("an API is built from the organization's module: packaged with the adapter, through the Terraform role, with no API setting in reach", async () => {
  const zip = await appZip({
    "package.json": JSON.stringify({ name: "lookup", main: "server.js" }),
    "server.js": "require('http').createServer((q, s) => s.end('ok')).listen(process.env.PORT)"
  });
  const plan = planFor("lookup", "api", [{ id: "http_api", inputs: { name: "mine", handler: "x.y" } }]);
  const res = await h.call("/deployments", { token: DEV, method: "POST", body: { backend: "cloudformation", plan, zip, appPath: "lookup" } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.backend, "terraform", "the catalog says what builds it, not the request");
  const done = await waitFor(res.body.deploymentId, DEV);
  assert.equal(done.status, "succeeded", done.failureReason);
  assert.equal(done.outputs.ApiUrl, "https://abc.execute-api.ca-central-1.amazonaws.com");
  assert.equal(done.kind, "api");
  assert.equal(done.entryPoint, "server.js");
  assert.match(done.resourceName, /^sealeye-lookup-[0-9a-f]{6}$/);
  assert.match(done.stackName, /^sealeye-payments-lookup-[0-9a-f]{6}$/);
  assert.deepEqual(done.terraform.module, { id: "http_api", source: "modules/http-api", repo: REPO, commit: COMMIT });
  assert.deepEqual(done.terraform.applied, { add: 9, change: 0, remove: 0 });
  assert.deepEqual(done.terraform.ignoredInputs, ["handler", "name"], "the plan does not name the module or its handler");
  assert.deepEqual(done.terraform.inputs.find(i => i.name === "permissions_boundary_arn"), { name: "permissions_boundary_arn", source: "platform value", from: "permissions_boundary_arn" });
  assert.deepEqual(done.operations, ["deploy-again", "status", "watch", "teardown", "evidence", "plan", "online"]);
  assert.match(done.report, /your organization's own module, `modules\/http-api`/);
  assert.doesNotMatch(done.report, /Terraform|OpenTofu|CloudFormation|Lambda/, "no product name in a developer's report");

  const root = lastRoot();
  assert.equal(root.module.app.source, "./library/modules/http-api");
  assert.equal(root.module.app.stage, "dev");
  assert.equal(root.module.app.name, done.resourceName);
  assert.equal(root.module.app.handler, "sealeye-handler.handler");
  assert.equal(root.module.app.permissions_boundary_arn, BOUNDARY);
  assert.match(root.module.app.package_path, /\.zip$/);
  assert.equal(root.terraform.required_providers.aws.version, "5.100.0");
  assert.equal(root.terraform.backend.s3.use_lockfile, true);
  assert.equal(root.terraform.backend.s3.key, `tofu-state/juniper/${done.stackName}.tfstate`);
  assert.deepEqual(Object.keys(root.output), ["url"]);

  const calls = tofuCalls();
  assert.deepEqual(calls.map(c => c.args[0]), ["init", "plan", "apply", "output"]);
  for (const c of calls) {
    assert.equal(c.profile, "sealeye-deploy-terraform");
    assert.equal(c.input, "0");
    for (const kept of ["ANTHROPIC_API_KEY", "SEALEYE_BUCKET", "SEALEYE_HOME", "DATABASE_URL", "SEALEYE_TOFU"]) assert.ok(!c.keys.includes(kept), `${kept} is not in tofu's environment`);
  }
  // The work folder goes when the deployment ends; the state is in S3.
  assert.equal(fs.existsSync(path.join(h.home, "tofu", done.deploymentId)), false);

  const logs = await h.call(`/deployments/${done.deploymentId}/logs`, { token: DEV });
  assert.equal(logs.status, 409);
  assert.equal(logs.body.error.code, "NOT_FOR_THIS_ENVIRONMENT");
  assert.equal((await h.call(`/deployments/${done.deploymentId}/pause`, { token: DEV, method: "POST" })).body.error.code, "NOT_FOR_THIS_ENVIRONMENT");
  assert.equal((await h.call(`/deployments/${done.deploymentId}/performance`, { token: DEV })).status, 409);

  const ev = await h.call(`/deployments/${done.deploymentId}/evidence`, { token: DEV });
  assert.equal(ev.status, 200, JSON.stringify(ev.body));
  assert.equal(ev.body.evidence.built.module.commit, COMMIT);
  assert.deepEqual(ev.body.evidence.checkedNow.changesOutside, []);
  assert.match(ev.body.markdown, /Built by: OpenTofu 1\.12\.6, with the AWS provider 5\.100\.0/);
  // The summary both surfaces print above it reads this shape too (it once did not).
  const { evidenceSummary } = await import("../core/evidence-summary.js");
  const summary = evidenceSummary(ev.body.evidence);
  assert.match(summary.title, /\(environment sealeye-payments-lookup-[0-9a-f]{6}, profile dev\)/);
  assert.match(summary.rows.find(r => r.label === "Built").text, /^modules\/http-api at 5e63aa573473, artifact /);
  assert.match(ev.body.markdown, /`permissions_boundary_arn`: platform value/);
  assert.ok(!ev.body.markdown.includes(BOUNDARY), "inputs by name and source, not value");

  // Deployed again: the same code, fetched back, built the same way.
  fs.writeFileSync(path.join(logDir, "tofu.log"), "");
  const again = await h.call("/deployments", { token: DEV, method: "POST", body: { backend: "cloudformation", fromDeployment: done.deploymentId } });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  const repeated = await waitFor(again.body.deploymentId, DEV);
  assert.equal(repeated.status, "succeeded", repeated.failureReason);
  assert.equal(repeated.stackName, done.stackName);
  assert.equal(repeated.resourceName, done.resourceName);

  // Torn down: destroy, then the state read to be sure nothing is left.
  fs.writeFileSync(path.join(logDir, "tofu.log"), "");
  const down = await h.call(`/deployments/${repeated.deploymentId}`, { token: DEV, method: "DELETE" });
  assert.equal(down.status, 202);
  const gone = await waitFor(repeated.deploymentId, DEV, s => s === "destroyed" || s === "failed");
  assert.equal(gone.status, "destroyed", gone.failureReason);
  assert.deepEqual(tofuCalls().map(c => c.args[0]), ["init", "destroy", "state"]);
  const first = (await h.call(`/deployments/${done.deploymentId}`, { token: DEV })).body;
  assert.equal(first.status, "destroyed", "the earlier deployment of the environment is closed too");
});

test("a site is built, its files uploaded through the Terraform role, and emptied before it is torn down", async () => {
  fs.writeFileSync(path.join(logDir, "aws-profile.log"), "");
  const zip = await appZip({ "index.html": "<h1>hi</h1>" });
  const res = await h.call("/deployments", { token: DEV, method: "POST", body: { backend: "cloudformation", plan: planFor("brochure", "static-site", [{ id: "static_site", inputs: { index_document: "index.html" } }]), zip, appPath: "brochure" } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const done = await waitFor(res.body.deploymentId, DEV);
  assert.equal(done.status, "succeeded", done.failureReason);
  assert.equal(done.outputs.WebsiteUrl, "https://d111.cloudfront.net");
  assert.equal(done.outputs.BucketName, "juniper-site-sealeye-x-dev");
  // A site's report is written too, in the developer's words (the first builds, Oct 17).
  assert.equal(done.reportError, undefined, done.reportError);
  assert.match(done.report || "", /A public website/);
  assert.equal(lastRoot().module.app.index_document, "index.html", "an optional input the plan gives is passed on");
  assert.match(fs.readFileSync(path.join(logDir, "aws-profile.log"), "utf8"), /^sealeye-deploy-terraform s3 sync$/m);

  fs.writeFileSync(path.join(logDir, "aws-profile.log"), "");
  await h.call(`/deployments/${done.deploymentId}`, { token: DEV, method: "DELETE" });
  const gone = await waitFor(done.deploymentId, DEV, s => s === "destroyed" || s === "failed");
  assert.equal(gone.status, "destroyed", gone.failureReason);
  assert.match(fs.readFileSync(path.join(logDir, "aws-profile.log"), "utf8"), /^sealeye-deploy-terraform s3 rm$/m);
});

test("a tear-down that leaves something behind says so, and is not called destroyed", async () => {
  const zip = await appZip({ "index.html": "<p>left</p>" });
  const res = await h.call("/deployments", { token: DEV, method: "POST", body: { backend: "cloudformation", plan: planFor("leftover", "static-site", [{ id: "static_site" }]), zip, appPath: "leftover" } });
  const done = await waitFor(res.body.deploymentId, DEV);
  assert.equal(done.status, "succeeded", done.failureReason);
  fs.writeFileSync(path.join(logDir, "state-left"), "1");
  try {
    await h.call(`/deployments/${done.deploymentId}`, { token: DEV, method: "DELETE" });
    const after = await waitFor(done.deploymentId, DEV, s => s === "destroyed" || s === "failed");
    assert.equal(after.status, "failed");
    assert.match(after.failureReason, /still there: module\.app\.aws_s3_bucket\.site/);
  } finally {
    fs.rmSync(path.join(logDir, "state-left"));
  }
});

test("OpenTofu's first error is the failure, in its own words", async () => {
  fs.writeFileSync(path.join(logDir, "fail-apply"), "creating Lambda Function: AccessDeniedException");
  try {
    const zip = await appZip({ "index.js": "require('http').createServer((q, s) => s.end('ok')).listen(process.env.PORT)" });
    const res = await h.call("/deployments", { token: DEV, method: "POST", body: { backend: "cloudformation", plan: planFor("denied", "api", [{ id: "http_api" }]), zip, appPath: "denied" } });
    const done = await waitFor(res.body.deploymentId, DEV);
    assert.equal(done.status, "failed");
    assert.equal(done.failureReason, "creating Lambda Function: AccessDeniedException: as the test asked");
  } finally {
    fs.rmSync(path.join(logDir, "fail-apply"));
  }
});

test("what the Terraform executor cannot build is refused before anything is built, in words", async () => {
  const zip = await appZip({ "index.js": "1" });
  const post = plan => h.call("/deployments", { token: DEV, method: "POST", body: { backend: "cloudformation", plan, zip, appPath: "x" } });

  const two = await post(planFor("both", "api", [{ id: "http_api" }, { id: "static_site" }]));
  assert.equal(two.status, 409);
  assert.equal(two.body.error.code, "CANNOT_BUILD");
  assert.match(two.body.error.message, /does not connect your organization's modules to each other yet/);

  const settings = await post(planFor("withenv", "api", [{ id: "http_api", inputs: { environment: { DB_HOST: "x" } } }]));
  assert.equal(settings.status, 201);
  const failed = await waitFor(settings.body.deploymentId, DEV);
  assert.equal(failed.status, "failed");
  assert.match(failed.failureReason, /settings do not reach an app built from your organization's modules yet/);

  const unknown = await post(planFor("unknown", "api", [{ id: "http_api", inputs: { colour: "blue" } }]));
  const u = await waitFor(unknown.body.deploymentId, DEV);
  assert.match(u.failureReason, /an input called colour, which the module does not take/);

  const noEntry = await h.call("/deployments", { token: DEV, method: "POST", body: { backend: "cloudformation", plan: planFor("noentry", "api", [{ id: "http_api" }]), zip: await appZip({ "README.md": "x" }), appPath: "noentry" } });
  const n = await waitFor(noEntry.body.deploymentId, DEV);
  assert.match(n.failureReason, /cannot tell which file your app starts from/);
});

test("a Terraform build the API was in the middle of when it restarted is failed, saying so, with its lock kept", async () => {
  const startedAt = new Date().toISOString();
  const base = { backend: "terraform", orgId: "juniper", teamId: "payments", startedAt, kind: "api" };
  const restarted = await startApi({
    tokens: [{ token: DEV, id: "dev", team: "payments", org: "juniper" }],
    records: [
      { ...base, deploymentId: "dep_tfapply0000", status: "running", stackName: "sealeye-payments-b-123456", app: { name: "b" }, terraform: { phase: "apply" } },
      { ...base, deploymentId: "dep_tfprep00000", status: "packaging", environment: "sealeye-payments-c-123456", app: { name: "c" }, terraform: { phase: null } }
    ],
    aws: ""
  });
  try {
    const applied = (await restarted.call("/deployments/dep_tfapply0000", { token: DEV })).body;
    assert.equal(applied.status, "failed");
    assert.equal(applied.lockKept, true);
    assert.match(applied.failureReason, /may be part-built\. Ask your platform team to release it/);
    const prepared = (await restarted.call("/deployments/dep_tfprep00000", { token: DEV })).body;
    assert.equal(prepared.status, "failed");
    assert.match(prepared.failureReason, /before your environment was built/);
    assert.deepEqual(restarted.awsCalls(), [], "nothing was asked of AWS");
  } finally {
    restarted.stop();
  }
});

test("the default organization's CloudFormation deploys are as they were, and another organization's still refused", async () => {
  const zip = await appZip({ "index.js": "1" });
  const plan = { planVersion: "0.5", catalog: "starter", app: { name: "classic", type: "api" }, profile: "dev", modules: [{ id: "http_api_serverless" }], outputs: [] };
  const juniper = await h.call("/deployments", { token: DEV, method: "POST", body: { backend: "cloudformation", plan: { ...plan, catalog: 3 }, zip, appPath: "classic" } });
  assert.equal(juniper.status, 400, "Juniper's catalog has no such module");
  const res = await h.call("/deployments", { token: OTHER, method: "POST", body: { backend: "cloudformation", plan, zip, appPath: "classic" } });
  assert.equal(res.status, 201);
  assert.equal(res.body.backend, "cloudformation");
  const list = await h.call("/deployments", { token: OTHER });
  const row = list.body.deployments.find(d => d.deploymentId === res.body.deploymentId);
  assert.ok(row.operations.includes("logs") && row.operations.includes("pause"));
});
