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
  http.outputs = { url: { line: "The API's address." }, role_name: { line: "The function's role." }, log_group: { line: "Where the app's logs are kept." } };
  http.delivers = { kind: "package", package: "package_path", handler: "handler", address: "url", logs: "log_group" };
  // What code reads of how modules connect (api/discovery/terraform.js, connectsOf).
  http.inputs.policy_arns = { required: false, default: [] };
  http.inputs.secret_arns = { required: false, default: [] };
  http.accepts = { policies: "policy_arns", secrets: "secret_arns", environment: "environment" };
  const table = doc.modules.find(m => m.id === "document_table");
  table.outputs = { table_name: { line: "The table." }, table_arn: { line: "The table." }, access_policy_arn: { line: "Reads and writes it." }, read_only_policy_arn: { line: "Reads it." } };
  table.offers = { access: "access_policy_arn", narrower: ["read_only_policy_arn"], secrets: [], values: ["table_name"] };
  const site = doc.modules.find(m => m.id === "static_site");
  site.outputs = { bucket_name: { line: "Upload the site's files here." }, url: { line: "The site's address." } };
  site.delivers = { kind: "files", output: "bucket_name", address: "url" };
  // A database in the private network, as catalog 9 has it: the app joins the network
  // through the inputs http-api 1.2.0 took, and signs in with its own identity.
  http.inputs.subnet_ids = { required: false, default: [] };
  http.inputs.security_group_ids = { required: false, default: [] };
  const pg = doc.modules.find(m => m.id === "postgres");
  pg.outputs = { address: { line: "Where the database answers." }, port: { line: "Its port." }, database_user: { line: "The app's user." }, access_policy_arn: { line: "Signs in as that user." }, password_secret_arn: { line: "The master password, kept." } };
  pg.offers = { access: "access_policy_arn", narrower: [], secrets: ["password_secret_arn"], values: ["address", "port", "database_user"] };
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
    // A build held under way while a test looks at it (wait-apply in the log folder).
    while (fs.existsSync(path.join(log, "wait-apply"))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    say({ type: "apply_complete", hook: { resource: { addr: "module.app.aws_lambda_function.fn" }, action: "create" } });
    say({ type: "change_summary", changes: { add: 9, change: 0, remove: 0, operation: "apply" } });
    process.exit(0);
  case "output": {
    const site = root && root.output && root.output.bucket_name;
    const name = root && root.module && root.module.app && root.module.app.name;
    const group = fs.existsSync(path.join(log, "log-group-elsewhere")) ? fs.readFileSync(path.join(log, "log-group-elsewhere"), "utf8") : "/aws/lambda/" + name + "-dev-api";
    process.stdout.write(JSON.stringify(site ? { bucket_name: { value: "juniper-site-sealeye-x-dev" }, url: { value: "https://d111.cloudfront.net" } } : { url: { value: "https://abc.execute-api.ca-central-1.amazonaws.com" }, log_group: { value: group } }));
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
  put("modules/document-table/main.tf", 'resource "aws_dynamodb_table" "table" {}\n');
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
      // What the app wrote, read from the group the module named.
      if (args[1] === "filter-log-events") {
        const group = args[args.indexOf("--log-group-name") + 1];
        const start = Number(args[args.indexOf("--start-time") + 1]);
        const end = args.includes("--end-time") ? Number(args[args.indexOf("--end-time") + 1]) : Infinity;
        const at = Date.now() - 1000;   // one line, written a second ago, in its window only
        const tail = group.includes("orders") ? "ORDERS_TABLE=orders-table-dev" : "DB_PASSWORD=hunter2";
        out(at >= start && at < end ? [{ timestamp: at, message: "listening on 8080, logs from " + group + " " + tail }] : []);
      }
      // The private network's leftover interfaces, as the test plants them (sweep.json).
      if (args[1] === "describe-network-interfaces") {
        const planted = ${JSON.stringify(path.join(logDir, "sweep.json"))};
        out(require("fs").existsSync(planted) ? JSON.parse(require("fs").readFileSync(planted, "utf8")) : []);
      }
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

const planFor = (app, type, modules) => ({
  planVersion: modules.some(m => m.connect) ? "0.6" : "0.5", catalog: 3, app: { name: app, type }, profile: "dev", modules, outputs: ["public_url"]
});

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
  assert.match(pg.why, /the platform has no subnet_ids and security_group_ids value for the module that runs the app to join that network with/);

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
  assert.deepEqual(done.operations, ["deploy-again", "status", "watch", "teardown", "logs", "evidence", "plan", "online"], "logs, since the module says where they are");
  assert.match(done.report, /your organization's own module, `modules\/http-api`/);
  assert.doesNotMatch(done.report, /Terraform|OpenTofu|CloudFormation|Lambda/, "no product name in a developer's report");
  // The module said where the app's logs are kept, so they are read from there, through
  // the Terraform role, masked as the starter's are, and the report says how.
  assert.equal(done.outputs.LogGroup, `/aws/lambda/${done.resourceName}-dev-api`);
  assert.match(done.report, /## Logs\n\nEverything your app prints, from the first request\. Read them with `sealeye logs lookup`/);
  fs.writeFileSync(path.join(logDir, "aws-profile.log"), "");
  const appLogs = await h.call(`/deployments/${done.deploymentId}/logs`, { token: DEV });
  assert.equal(appLogs.status, 200, JSON.stringify(appLogs.body));
  assert.equal(appLogs.body.lines.length, 1);
  assert.match(appLogs.body.lines[0].message, new RegExp(`logs from /aws/lambda/${done.resourceName}-dev-api`));
  assert.match(appLogs.body.lines[0].message, /DB_PASSWORD=\[value redacted\]/, "masked as the starter's logs are");
  assert.match(fs.readFileSync(path.join(logDir, "aws-profile.log"), "utf8"), /^sealeye-deploy-terraform logs filter-log-events$/m, "read through the Terraform role");
  const listed = (await h.call("/deployments", { token: DEV })).body.deployments.find(d => d.deploymentId === done.deploymentId);
  assert.ok(listed.operations.includes("logs"), "the listing says so too, for the portal's card");
  assert.ok(!(await h.call("/catalog", { token: DEV })).body.document.modules.find(m => m.id === "static_site").operations.includes("logs"), "a site offers none");
  assert.ok((await h.call("/catalog", { token: DEV })).body.document.modules.find(m => m.id === "http_api").operations.includes("logs"), "the catalog's entry offers them, so the card promises them");

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
  assert.deepEqual(Object.keys(root.output), ["url", "log_group"]);

  const calls = tofuCalls();
  assert.deepEqual(calls.map(c => c.args[0]), ["init", "plan", "apply", "output"]);
  for (const c of calls) {
    assert.equal(c.profile, "sealeye-deploy-terraform");
    assert.equal(c.input, "0");
    for (const kept of ["ANTHROPIC_API_KEY", "SEALEYE_BUCKET", "SEALEYE_HOME", "DATABASE_URL", "SEALEYE_TOFU"]) assert.ok(!c.keys.includes(kept), `${kept} is not in tofu's environment`);
  }
  // The work folder goes when the deployment ends; the state is in S3.
  assert.equal(fs.existsSync(path.join(h.home, "tofu", done.deploymentId)), false);

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

  // A deploy again that fails has no group of its own, and the environment's logs are
  // still read, from the record that has one; the newest record still offers them.
  fs.writeFileSync(path.join(logDir, "fail-apply"), "creating Lambda Function: AccessDeniedException");
  const broken = await h.call("/deployments", { token: DEV, method: "POST", body: { backend: "cloudformation", fromDeployment: done.deploymentId } });
  assert.equal(broken.status, 201, JSON.stringify(broken.body));
  const failed = await waitFor(broken.body.deploymentId, DEV);
  fs.rmSync(path.join(logDir, "fail-apply"), { force: true });
  assert.equal(failed.status, "failed");
  assert.equal(failed.outputs.LogGroup, undefined);
  assert.ok(failed.operations.includes("logs"), "the environment's group is on an earlier record");
  const stillRead = await h.call(`/deployments/${failed.deploymentId}/logs`, { token: DEV });
  assert.equal(stillRead.status, 200, JSON.stringify(stillRead.body));
  assert.match(stillRead.body.lines[0].message, new RegExp(`logs from /aws/lambda/${done.resourceName}-dev-api`));

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
  assert.match(two.body.error.message, /more than one module that runs the app/);

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

test("an app and the table it uses are built as one environment, connected through what the library offers", async () => {
  const zip = await appZip({ "package.json": JSON.stringify({ name: "orders", main: "index.js" }), "index.js": "1" });
  const post = plan => h.call("/deployments", { token: DEV, method: "POST", body: { backend: "cloudformation", plan, zip, appPath: "orders" } });

  // The checks a connected plan meets, before anything is recorded.
  const check = plan => h.call("/plans/validate", { token: DEV, method: "POST", body: plan });
  const unnamed = await check(planFor("orders", "api", [{ id: "http_api" }, { id: "document_table" }]));
  assert.match(JSON.stringify(unnamed.body.errors), /must say the setting the app reads each of its values from, in connect: table_name/);
  const wrong = await check(planFor("orders", "api", [{ id: "http_api" }, { id: "document_table", connect: { table_arn: "ORDERS_TABLE" } }]));
  assert.match(JSON.stringify(wrong.body.errors), /offers no value called table_arn; it offers table_name/);
  const alone = await check(planFor("orders", "api", [{ id: "document_table", connect: { table_name: "ORDERS_TABLE" } }]));
  assert.match(JSON.stringify(alone.body.errors), /needs exactly one module that runs the app/);
  const old = await check({ ...planFor("orders", "api", [{ id: "http_api" }, { id: "document_table", connect: { table_name: "ORDERS_TABLE" } }]), planVersion: "0.5" });
  assert.match(JSON.stringify(old.body.errors), /a plan that connects modules is planVersion 0\.6/);

  const plan = planFor("orders", "api", [{ id: "http_api" }, { id: "document_table", inputs: { key: "orderId" }, connect: { table_name: "ORDERS_TABLE" } }]);
  assert.equal((await check(plan)).body.valid, true);
  const res = await post(plan);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const done = await waitFor(res.body.deploymentId, DEV);
  assert.equal(done.status, "succeeded", done.failureReason);

  const root = lastRoot();
  assert.deepEqual(Object.keys(root.module).sort(), ["app", "document_table"], "the app's module stays app; the table goes by its id");
  assert.equal(root.module.document_table.source, "./library/modules/document-table");
  assert.equal(root.module.document_table.name, done.resourceName);
  assert.equal(root.module.document_table.stage, "dev");
  assert.equal(root.module.document_table.key, "orderId", "an optional input the plan gives is passed on");
  assert.deepEqual(root.module.app.policy_arns, ["${module.document_table.access_policy_arn}"], "the library's own policy, never one seaLeye writes");
  assert.deepEqual(root.module.app.environment, { ORDERS_TABLE: "${module.document_table.table_name}" });
  assert.equal(root.resource, undefined, "the root makes nothing of its own");
  assert.equal(root.data, undefined);

  assert.equal(done.terraform.parts.length, 1);
  const part = done.terraform.parts[0];
  assert.deepEqual([part.id, part.source, part.repo, part.commit], ["document_table", "modules/document-table", REPO, COMMIT]);
  assert.ok(part.line, "the catalog's own words for it, for the report and a tear-down");
  assert.deepEqual(done.terraform.settings, { ORDERS_TABLE: "document_table.table_name" });
  assert.deepEqual(done.terraform.inputs.find(i => i.name === "policy_arns"), { name: "policy_arns", source: "the modules your app uses", from: "document_table" });
  assert.match(done.report, /which your app finds through `ORDERS_TABLE`\. Your app is given what it needs to use it, and nothing more\./);
  assert.doesNotMatch(done.report, /policy|Terraform|DynamoDB/i, "the report says what the app got, in its words");
  const { teardownDataWords } = await import("../core/plan-report-words.js");
  const listed = (await h.call("/deployments", { token: DEV })).body.deployments.find(d => d.deploymentId === done.deploymentId);
  assert.equal(teardownDataWords(listed).length, 1, "the list carries what a tear-down would delete");
  assert.match(teardownDataWords(listed)[0], /^This also deletes .+, and everything in it\.$/);
  const ev = await h.call(`/deployments/${done.deploymentId}/evidence`, { token: DEV });
  assert.match(ev.body.markdown, /- Connected: `document_table`, the folder `modules\/document-table` at commit/);
  assert.match(ev.body.markdown, /`ORDERS_TABLE` is `document_table\.table_name` \(names only\)/);
  // The setting the table reaches the app under is masked by name in its logs, as the
  // starter's settings are, since its value is the platform's own.
  const masked = await h.call(`/deployments/${done.deploymentId}/logs`, { token: DEV });
  assert.equal(masked.status, 200, JSON.stringify(masked.body));
  assert.match(masked.body.lines[0].message, /ORDERS_TABLE=\[value redacted\]/);
  assert.doesNotMatch(masked.body.lines[0].message, /orders-table-dev/);

  // Torn down together, from the same root.
  fs.rmSync(path.join(logDir, "main.tf.json"), { force: true });
  await h.call(`/deployments/${done.deploymentId}`, { token: DEV, method: "DELETE" });
  const gone = await waitFor(done.deploymentId, DEV, st => ["destroyed", "failed"].includes(st));
  assert.equal(gone.status, "destroyed", gone.failureReason);
  assert.deepEqual(Object.keys(lastRoot().module).sort(), ["app", "document_table"]);
});

test("an environment that joined the private network says a tear-down can take up to 20 minutes, and sweeps the interfaces the network leaves behind", async () => {
  // The platform's values the app joins the network with, and the database's own.
  for (const [name, value] of [["subnet_ids", "subnet-0a1 subnet-0b2"], ["security_group_ids", "sg-apps0001"], ["postgres.subnet_group_name", "juniper-dev-databases"], ["postgres.security_group_ids", "sg-dbs00001"]]) {
    const set = await h.call(`/platform/values/${name}`, { token: PLATFORM, method: "PUT", body: { value: value.includes(" ") ? value.split(" ") : value } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
  }
  const zip = await appZip({ "package.json": JSON.stringify({ name: "notes", main: "index.js" }), "index.js": "1" });
  const plan = planFor("notes", "api", [{ id: "http_api" }, { id: "postgres", connect: { address: "DATABASE_HOST", port: "DATABASE_PORT", database_user: "DATABASE_USER" } }]);
  const checked = await h.call("/plans/validate", { token: DEV, method: "POST", body: plan });
  assert.equal(checked.body.valid, true, JSON.stringify(checked.body.errors));

  // Before a build, a sweep finds nothing to delete: the platform answers with no interfaces.
  fs.rmSync(path.join(logDir, "sweep.json"), { force: true });
  fs.writeFileSync(path.join(logDir, "aws-profile.log"), "");
  const res = await h.call("/deployments", { token: DEV, method: "POST", body: { backend: "cloudformation", plan, zip, appPath: "notes" } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const done = await waitFor(res.body.deploymentId, DEV);
  assert.equal(done.status, "succeeded", done.failureReason);
  assert.equal(done.terraform.network, true, "the record says the app joined the private network");
  assert.deepEqual(done.terraform.swept, { at: done.terraform.swept.at, interfaces: [] });
  assert.match(fs.readFileSync(path.join(logDir, "aws-profile.log"), "utf8"), /^sealeye-deploy-terraform ec2 describe-network-interfaces$/m, "read through the Terraform role");
  assert.deepEqual(lastRoot().module.app.subnet_ids, ["subnet-0a1", "subnet-0b2"]);

  const { teardownWaitWords, teardownDataWords } = await import("../core/plan-report-words.js");
  const listed = (await h.call("/deployments", { token: DEV })).body.deployments.find(d => d.deploymentId === done.deploymentId);
  assert.equal(teardownWaitWords(listed), "Its connections into the private network take up to 20 minutes to remove.");
  assert.equal(teardownDataWords(listed).length, 1);
  const table = (await h.call("/deployments", { token: DEV })).body.deployments.find(d => d.app?.name === "orders");
  assert.equal(teardownWaitWords(table), null, "an environment outside the network says nothing of it");

  // After the tear-down, the two interfaces the platform did not get to are deleted;
  // one it still uses is not even listed, and what was swept is on the record.
  fs.writeFileSync(path.join(logDir, "sweep.json"), JSON.stringify([
    { id: "eni-0aaa", description: `AWS Lambda VPC ENI-${done.resourceName}-dev-api-1111` },
    { id: "eni-0bbb", description: `AWS Lambda VPC ENI-${done.resourceName}-dev-db-setup-2222` }
  ]));
  await h.call(`/deployments/${done.deploymentId}`, { token: DEV, method: "DELETE" });
  const gone = await waitFor(done.deploymentId, DEV, st => ["destroyed", "failed"].includes(st));
  assert.equal(gone.status, "destroyed", gone.failureReason);
  assert.deepEqual(gone.terraform.swept.interfaces, ["eni-0aaa", "eni-0bbb"]);
  assert.equal(gone.terraform.swept.notDeleted, undefined);
  const calls = h.awsCalls().filter(c => c.startsWith("ec2 "));
  assert.ok(calls.includes("ec2 delete-network-interface --network-interface-id eni-0aaa --region ca-central-1"), calls.join("\n"));
  assert.ok(calls.includes("ec2 delete-network-interface --network-interface-id eni-0bbb --region ca-central-1"), calls.join("\n"));
  assert.ok(calls.some(c => c.includes(`Name=description,Values=AWS Lambda VPC ENI-${done.resourceName}-*`) && c.includes("Name=status,Values=available")), "only detached interfaces named for this environment's functions");
  fs.rmSync(path.join(logDir, "sweep.json"), { force: true });
});

test("an environment whose module does not say where its logs are has none to read, and says why", async () => {
  const startedAt = new Date().toISOString();
  const quiet = await startApi({
    tokens: [{ token: DEV, id: "dev", team: "payments", org: "juniper" }],
    records: [{ backend: "terraform", orgId: "juniper", teamId: "payments", startedAt, kind: "api", deploymentId: "dep_tfnologs000", status: "succeeded", stackName: "sealeye-payments-q-123456", app: { name: "q" }, outputs: { ApiUrl: "https://q.example" }, terraform: {} }],
    aws: ""
  });
  try {
    const r = await quiet.call("/deployments/dep_tfnologs000/logs", { token: DEV });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "NO_LOGS");
    assert.match(r.body.error.message, /does not say where your app's logs are kept/);
    const rec = (await quiet.call("/deployments/dep_tfnologs000", { token: DEV })).body;
    assert.ok(!rec.operations.includes("logs"), "so neither surface offers them");
    assert.deepEqual(quiet.awsCalls(), [], "nothing was asked of AWS");
  } finally {
    quiet.stop();
  }
});

test("a module that names a group that is not the environment's own is not believed: no logs, and the record says why", async () => {
  const zip = await appZip({ "package.json": JSON.stringify({ name: "sly", main: "index.js" }), "index.js": "1" });
  fs.writeFileSync(path.join(logDir, "log-group-elsewhere"), "/aws/lambda/sealeye-payments-api");
  fs.writeFileSync(path.join(logDir, "aws-profile.log"), "");
  try {
    const res = await h.call("/deployments", { token: DEV, method: "POST", body: { backend: "cloudformation", plan: planFor("sly", "api", [{ id: "http_api" }]), zip, appPath: "sly" } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const done = await waitFor(res.body.deploymentId, DEV);
    assert.equal(done.status, "succeeded", done.failureReason);
    assert.equal(done.outputs.LogGroup, undefined, "another environment's group is never kept");
    assert.equal(done.terraform.logsNotKept, "the module named a group that is not this environment's own");
    assert.ok(!done.operations.includes("logs"));
    const r = await h.call(`/deployments/${done.deploymentId}/logs`, { token: DEV });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "NO_LOGS");
    assert.match(r.body.error.message, /named a place for your app's logs that is not this environment's own, so the platform did not believe it/);
    assert.doesNotMatch(fs.readFileSync(path.join(logDir, "aws-profile.log"), "utf8"), /filter-log-events/, "nothing was read");
    assert.match(done.report, /does not say where, so seaLeye cannot read it back to you/);
    // The setup function's group is the platform team's, whatever a module outputs.
    const { ownLogGroup } = await import("../api/executor/terraform/index.js");
    assert.equal(ownLogGroup(`/aws/lambda/${done.resourceName}-dev-db-setup`, done.resourceName), false);
    assert.equal(ownLogGroup(`/aws/lambda/${done.resourceName}-dev-api`, done.resourceName), true);
    assert.equal(ownLogGroup(`/aws/lambda/${done.resourceName}x-dev-api`, done.resourceName), false, "a longer name is another environment");
    assert.equal(ownLogGroup("/aws/lambda/platform-sealeye-api", done.resourceName), false);
  } finally {
    fs.rmSync(path.join(logDir, "log-group-elsewhere"), { force: true });
  }
});

test("a Terraform environment's refusal to read logs says what is true of the record", async () => {
  const { noTerraformLogsWords } = await import("../api/logs.js");
  assert.equal(noTerraformLogsWords({ status: "running" }), "Your environment is still being built. Its logs can be read once it is up.");
  assert.equal(noTerraformLogsWords({ status: "packaging" }), "Your environment is still being built. Its logs can be read once it is up.");
  assert.match(noTerraformLogsWords({ status: "failed" }), /did not get as far as a running app/);
  assert.match(noTerraformLogsWords({ status: "failed", terraform: { logsNotKept: "the module named a group that is not this environment's own" } }), /did not believe it/);
  assert.match(noTerraformLogsWords({ status: "succeeded" }), /does not say where your app's logs are kept/);
  // And through the API, a build under way (the stand-in's apply waits on a file).
  fs.writeFileSync(path.join(logDir, "wait-apply"), "");
  const zip = await appZip({ "package.json": JSON.stringify({ name: "slow", main: "index.js" }), "index.js": "1" });
  const res = await h.call("/deployments", { token: DEV, method: "POST", body: { backend: "cloudformation", plan: planFor("slow", "api", [{ id: "http_api" }]), zip, appPath: "slow" } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  try {
    const building = await waitFor(res.body.deploymentId, DEV, s => s === "running");
    assert.equal(building.status, "running");
    const r = await h.call(`/deployments/${building.deploymentId}/logs`, { token: DEV });
    assert.equal(r.status, 409);
    assert.match(r.body.error.message, /still being built/);
  } finally {
    fs.rmSync(path.join(logDir, "wait-apply"), { force: true });
  }
  const done = await waitFor(res.body.deploymentId, DEV);
  assert.equal(done.status, "succeeded", done.failureReason);
  assert.equal((await h.call(`/deployments/${done.deploymentId}/logs`, { token: DEV })).status, 200, "and read once it is up");
});
