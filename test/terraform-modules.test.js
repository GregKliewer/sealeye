// What a Terraform module needs before seaLeye builds it (core/terraform-modules.js), what
// discovery's code reads of a module to say so (api/discovery/terraform.js), the name a
// module is given, and the root module seaLeye writes. No network, no OpenTofu.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { platformWanted, terraformBuilds } from "../core/terraform-modules.js";
import { isBuildable } from "../core/catalog.js";
import { environmentName, moduleName } from "../core/names.js";
import { deliversOf, moduleOutputs, moduleRuns, withoutComments } from "../api/discovery/terraform.js";
import { inputsFor, rootModule, stateKeyFor } from "../api/executor/terraform/root.js";
import { cleanValue } from "../api/platform.js";
import { environmentOperations } from "../core/operations.js";

const api = (more = {}) => ({
  id: "http_api", builds_with: "terraform", availability: "available", runs: [],
  delivers: { kind: "package", package: "package_path", handler: "handler", address: "url" },
  inputs: {
    name: { required: true }, stage: { required: true }, tags: { required: false },
    package_path: { required: true }, handler: { required: false },
    permissions_boundary_arn: { required: true }, environment: { required: false }
  },
  outputs: { url: {} },
  ...more
});

test("a Terraform module is built only when every required input has a source", () => {
  assert.deepEqual(terraformBuilds(api(), { names: [] }), {
    builds: false, why: "the platform has no value for its permissions_boundary_arn input", missing: ["permissions_boundary_arn"]
  });
  assert.equal(terraformBuilds(api(), { names: ["permissions_boundary_arn"] }).builds, true);
  assert.equal(terraformBuilds(api(), { names: ["http_api.permissions_boundary_arn"] }).builds, true, "a value for this module's input");
  assert.equal(terraformBuilds(api(), { names: ["postgres.permissions_boundary_arn"] }).builds, false, "not another module's");
  const catalog = { modules: [api()], platform: { names: ["permissions_boundary_arn"] } };
  assert.equal(isBuildable("http_api", catalog), true);
  assert.equal(isBuildable("http_api", { modules: [api()] }), false, "a catalog read without the platform's values builds nothing that needs them");
});

test("a module not checked, one that runs commands, and one that takes no app are not built, each saying why", () => {
  const { runs: _r, ...unchecked } = api();
  assert.match(terraformBuilds(unchecked, { names: ["permissions_boundary_arn"] }).why, /not been checked for commands/);
  assert.match(terraformBuilds(api({ runs: ["a provisioner (local-exec)"] }), { names: ["permissions_boundary_arn"] }).why, /would run commands on the platform's server \(a provisioner \(local-exec\)\)/);
  assert.match(terraformBuilds(api({ delivers: null }), { names: ["permissions_boundary_arn"] }).why, /offers an app nothing it can connect to/);
  assert.match(terraformBuilds(api({ delivers: { kind: "package", package: "package_path" } }), {}).why, /which input takes the app/);
  assert.match(terraformBuilds({ ...api(), builds_with: "cloudformation" }).why, /not a Terraform module/);
});

test("the platform engineer sees each module's inputs only the platform gives, and which value fills each", () => {
  const db = { id: "postgres", builds_with: "terraform", availability: "available", runs: [], delivers: null, inputs: { name: { required: true }, subnet_group_name: { required: true, line: "Where it goes." } } };
  const old = { ...db, id: "old", availability: "deprecated" };
  const wanted = platformWanted({ modules: [api(), db, old] }, ["permissions_boundary_arn"]);
  assert.deepEqual(wanted.map(w => w.module), ["http_api", "postgres"], "only what is offered");
  assert.deepEqual(wanted[0].inputs.map(i => [i.input, i.required, i.filledBy]), [
    ["permissions_boundary_arn", true, "permissions_boundary_arn"], ["environment", false, null]
  ]);
  assert.equal(wanted[0].builds, true);
  assert.deepEqual(wanted[1].inputs, [{ input: "subnet_group_name", required: true, line: "Where it goes.", filledBy: null }]);
  assert.equal(wanted[1].builds, false);
});

test("a module's name is short enough for every name a module makes from it, and starts with sealeye-", () => {
  for (const app of ["a", "beneficiary-lookup-api", "x".repeat(80), "Payments API!!", "1-numeric-first"]) {
    const name = moduleName({ org: "juniper", team: "payments", app });
    assert.match(name, /^[a-z][a-z0-9-]{1,30}$/, name);
    assert.ok(name.startsWith("sealeye-"));
    assert.equal(name.slice(-6), environmentName({ org: "juniper", team: "payments", app }).slice(-6), "the environment's own hash");
  }
  assert.notEqual(moduleName({ team: "a", app: "x" }), moduleName({ team: "b", app: "x" }), "two teams' apps of one name are two names");
});

test("discovery's code reads how a module takes an app, from its inputs and outputs", () => {
  assert.deepEqual(deliversOf({ package_path: {}, handler: {}, name: {} }, { url: {} }), { kind: "package", package: "package_path", handler: "handler", address: "url" });
  // A module that says where the app's logs are kept (http-api 1.2.3): `sealeye logs` reads there.
  assert.deepEqual(deliversOf({ package_path: {}, handler: {}, name: {} }, { url: {}, log_group: {} }), { kind: "package", package: "package_path", handler: "handler", address: "url", logs: "log_group" });
  assert.equal(deliversOf({ name: {} }, { bucket_name: { line: "Upload the site's files here." }, url: {}, log_group: {} }).logs, undefined, "a site has no app logs");
  assert.deepEqual(deliversOf({ name: {} }, { bucket_name: { line: "Upload the site's files here." }, url: {} }), { kind: "files", output: "bucket_name", address: "url" });
  assert.equal(deliversOf({ name: {} }, { bucket_name: { line: "The bucket." }, bucket_arn: {} }), null, "a bucket an app keeps its own files in is not a site");
  assert.equal(deliversOf({ package_path: {} }, {}), null, "a package with no function named is not enough");
});

function library(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-lib-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

test("discovery's code finds what a module would run on the platform's server, nested modules too, and not in comments", () => {
  const lib = library({
    "modules/clean/main.tf": '# provisioner "local-exec" is mentioned here only\nresource "aws_s3_bucket" "b" {\n  bucket = "x # not a comment"\n}\n/* data "external" "x" {} */\n',
    "modules/clean/outputs.tf": 'output "bucket_name" {\n  description = "Upload the site\'s files here."\n  value = aws_s3_bucket.b.id\n}\n',
    "modules/runs/main.tf": 'resource "terraform_data" "x" {\n  provisioner "local-exec" {\n    command = "curl evil"\n  }\n}\ndata "external" "y" {\n  program = ["sh"]\n}\n',
    "modules/other/main.tf": 'terraform {\n  required_providers {\n    random = { source = "hashicorp/random" }\n    aws = { source = "hashicorp/aws" }\n  }\n}\nresource "null_resource" "n" {}\n',
    "modules/nested/main.tf": 'module "inner" {\n  source = "../runs"\n}\nmodule "far" {\n  source = "git::https://example.com/x.git"\n}\n',
    "modules/escape/main.tf": 'module "up" {\n  source = "../../../elsewhere"\n}\ndata "terraform_remote_state" "s" {}\n'
  });
  assert.deepEqual(moduleRuns(lib, "modules/clean"), []);
  assert.deepEqual(moduleRuns(lib, "modules/runs"), ["a provisioner (local-exec)", "the external data source"]);
  assert.deepEqual(moduleRuns(lib, "modules/other"), ["the hashicorp/random provider", "the null provider"]);
  assert.deepEqual(moduleRuns(lib, "modules/nested"), ["a module from outside the library (far: git::https://example.com/x.git)", "a provisioner (local-exec)", "the external data source"]);
  assert.deepEqual(moduleRuns(lib, "modules/escape"), ["a module from outside the library (up: ../../../elsewhere)", "another environment's state (terraform_remote_state)"]);
  assert.deepEqual(moduleOutputs(path.join(lib, "modules/clean")), { bucket_name: { line: "Upload the site's files here." } });
  assert.match(withoutComments('a = "x # y" # z'), /^a = "x # y" $/);
});

test("Juniper's library, read by discovery's code: http-api takes a package, static-site files, and nothing runs commands", { skip: !process.env.SEALEYE_SAMPLE_PLATFORM && "set SEALEYE_SAMPLE_PLATFORM to a clone" }, async () => {
  const lib = process.env.SEALEYE_SAMPLE_PLATFORM;
  const { listModules, moduleInputs } = await import("../api/discovery/terraform.js");
  const found = Object.fromEntries(listModules(lib).map(s => [s, deliversOf(moduleInputs(path.join(lib, s)), moduleOutputs(path.join(lib, s)))?.kind || null]));
  assert.equal(found["modules/http-api"], "package");
  assert.equal(found["modules/static-site"], "files");
  assert.equal(Object.values(found).filter(Boolean).length, 2);
  for (const s of listModules(lib)) assert.deepEqual(moduleRuns(lib, s), [], s);
});

test("the root module gives each input from one source, and the plan only what is its to give", () => {
  const given = inputsFor({
    entry: api(),
    planModule: { id: "http_api", inputs: { name: "mine", handler: "x.y", permissions_boundary_arn: "arn:other" } },
    name: "sealeye-app-abc123",
    tags: { "sealeye:app": "app" },
    platform: { permissions_boundary_arn: "arn:aws:iam::1:policy/b", subnet_ids: ["s-1"] },
    code: { package: "/work/package.zip" }
  });
  assert.deepEqual(given.inputs, {
    name: "sealeye-app-abc123", stage: "dev", tags: { "sealeye:app": "app" },
    package_path: "/work/package.zip", handler: "sealeye-handler.handler", permissions_boundary_arn: "arn:aws:iam::1:policy/b"
  });
  assert.deepEqual(given.ignored, ["handler", "name", "permissions_boundary_arn"]);
  assert.throws(() => inputsFor({ entry: api(), planModule: { id: "http_api", inputs: { environment: { A: "1" } } }, name: "n", tags: {}, platform: { permissions_boundary_arn: "x" }, code: { package: "p" } }), /settings do not reach/);
  assert.throws(() => inputsFor({ entry: api(), planModule: { id: "http_api" }, name: "n", tags: {}, platform: {}, code: { package: "p" } }), /no value for permissions_boundary_arn/);
  const withExtra = api({ inputs: { ...api().inputs, extra: { required: false } } });
  assert.throws(() => inputsFor({ entry: withExtra, planModule: { id: "http_api", inputs: { extra: { nested: { deep: 1 } } } }, name: "n", tags: {}, platform: { permissions_boundary_arn: "x" }, code: { package: "p" } }), /cannot pass on/);

  const root = rootModule({ moduleSource: "./library/modules/http-api", inputs: given.inputs, outputs: ["url"], state: { bucket: "b", key: stateKeyFor({ org: "juniper", environment: "sealeye-x" }) }, tags: { a: "b" } });
  assert.equal(root.terraform.backend.s3.key, "tofu-state/juniper/sealeye-x.tfstate");
  assert.equal(root.output.url.value, "${module.app.url}");
  assert.equal(root.module.app.source, "./library/modules/http-api");
});

test("a platform value is a word or a list of words, and never something that looks like a secret", () => {
  assert.equal(cleanValue("subnet_ids", "subnet-0abc"), "subnet-0abc");
  assert.deepEqual(cleanValue("security_group_ids", ["sg-1", "sg-2"]), ["sg-1", "sg-2"]);
  assert.equal(cleanValue("postgres.subnet_group_name", "db-private"), "db-private");
  assert.throws(() => cleanValue("x", "has space"), /no spaces/);
  assert.throws(() => cleanValue("x", ""), /no spaces/);
  assert.throws(() => cleanValue("x", { a: 1 }), /no spaces/);
  assert.throws(() => cleanValue("Bad Name", "x"), /named after the input/);
  assert.throws(() => cleanValue("api_key", "ghp_0123456789abcdefghijABCDEFGHIJ0123456789"), err => err.code === "LOOKS_LIKE_A_SECRET" && !err.message.includes("ghp_"));
});

test("an environment built from the organization's modules offers fewer operations, until the rest are built for it", () => {
  assert.deepEqual(environmentOperations("terraform"), ["deploy-again", "status", "watch", "teardown", "evidence", "plan", "online"]);
  for (const id of ["logs", "pause", "resume", "perf", "config", "settings"]) {
    assert.ok(environmentOperations("cloudformation").includes(id));
    assert.ok(!environmentOperations("terraform").includes(id));
  }
});

test("on the server, nothing is built from an organization's modules until the Terraform role is set up", async () => {
  const { terraformNotReady } = await import("../api/executor/terraform/tofu.js");
  assert.match(terraformNotReady({ DATABASE_URL: "postgres://x", AWS_PROFILE: "sealeye-deploy" }), /not set up to build from your organization's own modules yet/);
  assert.equal(terraformNotReady({ DATABASE_URL: "postgres://x", SEALEYE_TERRAFORM_PROFILE: "sealeye-deploy-terraform" }), null);
  assert.equal(terraformNotReady({}), null, "a laptop API uses what credentials it has");
});

test("the change record says which attributes changed outside seaLeye, and lists what was built without what is only read", async () => {
  const { builtParts, driftDetail } = await import("../api/executor/terraform/tofu.js");
  const plan = {
    resource_drift: [
      { address: "module.app.aws_apigatewayv2_stage.default", mode: "managed", change: { actions: ["update"], before: { deployment_id: "a1", name: "$default", tags: { x: "1" } }, after: { deployment_id: "b2", name: "$default", tags: { x: "1" } } } },
      { address: "module.app.data.aws_iam_policy_document.assume", mode: "data", change: { actions: ["read"], before: {}, after: { json: "{}" } } }
    ]
  };
  assert.deepEqual(driftDetail(plan), [{ address: "module.app.aws_apigatewayv2_stage.default", action: "update", attributes: ["deployment_id"] }]);
  assert.deepEqual(driftDetail({}), []);
  // The first fresh build's five: empty read back as empty, and a stage that deploys itself.
  const fresh = { resource_drift: [
    { address: "module.app.aws_apigatewayv2_integration.fn", type: "aws_apigatewayv2_integration", mode: "managed", change: { actions: ["update"], before: { request_parameters: null, request_templates: null }, after: { request_parameters: {}, request_templates: {} } } },
    { address: "module.app.aws_lambda_function.fn", type: "aws_lambda_function", mode: "managed", change: { actions: ["update"], before: { layers: null, memory_size: 128 }, after: { layers: [], memory_size: 128 } } },
    { address: "module.app.aws_iam_role.fn", type: "aws_iam_role", mode: "managed", change: { actions: ["update"], before: { managed_policy_arns: [] }, after: { managed_policy_arns: ["arn:aws:iam::aws:policy/AdministratorAccess"] } } },
    { address: "module.app.aws_apigatewayv2_stage.default", type: "aws_apigatewayv2_stage", mode: "managed", change: { actions: ["update"], before: { auto_deploy: true, deployment_id: "", stage_variables: null }, after: { auto_deploy: true, deployment_id: "x9", stage_variables: {} } } }
  ] };
  // A policy someone attached is still a change.
  assert.deepEqual(driftDetail(fresh), [{ address: "module.app.aws_iam_role.fn", action: "update", attributes: ["managed_policy_arns"] }]);
  // The role reads back the policy the environment's own attachment put on it: not a change.
  // One more, that nothing in the environment attached, still is.
  const basic = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole";
  const role = extra => ({ resource_drift: [
    { address: "module.app.aws_iam_role.fn", type: "aws_iam_role", mode: "managed", change: { actions: ["update"], before: { name: "sealeye-x-dev-api", managed_policy_arns: [] }, after: { name: "sealeye-x-dev-api", managed_policy_arns: [basic, ...extra] } } }
  ], prior_state: { values: { root_module: { child_modules: [{ resources: [
    { type: "aws_iam_role_policy_attachment", mode: "managed", values: { role: "sealeye-x-dev-api", policy_arn: basic } }
  ] }] } } } });
  assert.deepEqual(driftDetail(role([])), []);
  assert.deepEqual(driftDetail(role(["arn:aws:iam::aws:policy/AdministratorAccess"])), [{ address: "module.app.aws_iam_role.fn", action: "update", attributes: ["managed_policy_arns"] }]);
  // The bucket reads back the policy its own bucket policy part set: not a change. A
  // different one is.
  const own = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:GetObject" }] });
  const bucket = policy => ({ resource_drift: [
    { address: "module.app.aws_s3_bucket.site", type: "aws_s3_bucket", mode: "managed", change: { actions: ["update"], before: { bucket: "juniper-site-x-dev", policy: "" }, after: { bucket: "juniper-site-x-dev", policy } } }
  ], prior_state: { values: { root_module: { child_modules: [{ resources: [
    { type: "aws_s3_bucket_policy", mode: "managed", values: { bucket: "juniper-site-x-dev", policy: own } }
  ] }] } } } });
  assert.deepEqual(driftDetail(bucket(JSON.stringify({ Statement: [{ Action: "s3:GetObject", Effect: "Allow" }], Version: "2012-10-17" }))), []);
  assert.deepEqual(driftDetail(bucket(JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:*" }] }))), [{ address: "module.app.aws_s3_bucket.site", action: "update", attributes: ["policy"] }]);
  // A table's access policy counts the environment's own attachment of it (the first
  // connected build): not a change. Attached once more by something else, it is.
  const access = "arn:aws:iam::123456789012:policy/sealeye-x-dev-table-read-write";
  const policy = count => ({ resource_drift: [
    { address: "module.document_table.aws_iam_policy.read_write", type: "aws_iam_policy", mode: "managed", change: { actions: ["update"], before: { arn: access, attachment_count: 0 }, after: { arn: access, attachment_count: count } } }
  ], prior_state: { values: { root_module: { child_modules: [{ resources: [
    { type: "aws_iam_role_policy_attachment", mode: "managed", values: { role: "sealeye-x-dev-api", policy_arn: access } }
  ] }] } } } });
  assert.deepEqual(driftDetail(policy(1)), []);
  assert.deepEqual(driftDetail(policy(2)), [{ address: "module.document_table.aws_iam_policy.read_write", action: "update", attributes: ["attachment_count"] }]);
  assert.deepEqual(builtParts("module.app.data.aws_iam_policy_document.assume\nmodule.app.aws_lambda_function.fn\n\n"), ["module.app.aws_lambda_function.fn"]);
  assert.deepEqual(builtParts("data.aws_caller_identity.me\naws_s3_bucket.b\n"), ["aws_s3_bucket.b"]);
});

test("a module's version comes from its library's tags: releases, the newest, and what changed", async () => {
  const { changesBetween, compareVersions, majorOf, moduleRelease, newestReleases, releaseFor } = await import("../core/module-versions.js");
  assert.deepEqual(moduleRelease("http-api/v1.4.0"), { module: "http-api", version: "1.4.0", parts: [1, 4, 0] });
  assert.deepEqual(moduleRelease("modules/http-api/v2.0.1")?.module, "modules/http-api");
  for (const not of ["v1.0.0", "http-api/v2.0.0-rc1", "http-api/1.0.0", "http-api/v01.0.0", "release-2026"]) assert.equal(moduleRelease(not), null, not);
  assert.ok(compareVersions("1.10.0", "1.9.3") > 0, "by number, not by letter");
  assert.equal(majorOf("2.3.4"), 2);
  const releases = newestReleases([{ name: "http-api/v1.9.0", commit: "a" }, { name: "http-api/v1.10.0", commit: "b" }, { name: "site/v1.0.0", commit: "c" }]);
  assert.deepEqual(releaseFor(releases, "modules/http-api"), { version: "1.10.0", tag: "http-api/v1.10.0", commit: "b" });
  assert.equal(releaseFor(releases, "modules/queue"), null);
  const log = "# Changelog\n\n## 1.2.0\n\n- Takes policy_arns.\n- Logs for a year from staging.\n\n## 1.1.0\n\n- Outputs role_name.\n\n## 1.0.0\n\n- First.\n";
  assert.deepEqual(changesBetween(log, "1.0.0", "1.2.0"), ["Takes policy_arns.", "Logs for a year from staging.", "Outputs role_name."]);
  assert.deepEqual(changesBetween(log, "1.1.0", "1.1.0"), []);
  assert.deepEqual(changesBetween("", "1.0.0", "2.0.0"), []);
});

test("in a library that releases its modules, one with no release is not built", async () => {
  const { terraformBuilds } = await import("../core/terraform-modules.js");
  const entry = { id: "site", source: "modules/site", builds_with: "terraform", runs: [], delivers: { kind: "files", output: "bucket_name" }, inputs: { name: { required: true }, stage: { required: true } } };
  assert.equal(terraformBuilds(entry).builds, true);
  const no = terraformBuilds({ ...entry, unreleased: true });
  assert.equal(no.builds, false);
  assert.match(no.why, /has not released it yet \(a release is a tag such as site\/v1\.0\.0\)/);
});

test("a released module is fetched at the commit its release points to, not the catalog's", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-release-"));
  const was = process.env.SEALEYE_HOME;
  process.env.SEALEYE_HOME = home;
  try {
    const { moduleCode, librariesDir } = await import("../api/executor/terraform/library.js");
    const READ = "a".repeat(40);
    const RELEASED = "b".repeat(40);
    const lib = path.join(librariesDir(), `acme--library--${RELEASED}`);
    fs.mkdirSync(path.join(lib, "modules/site"), { recursive: true });
    fs.writeFileSync(path.join(lib, "modules/site/main.tf"), 'resource "aws_s3_bucket" "b" {}\n');
    fs.writeFileSync(path.join(lib, ".complete"), `acme/library@${RELEASED}\n`);
    const catalog = { discovery: { library: [{ repo: "acme/library", commit: READ }] } };
    const got = await moduleCode(catalog, { source: "modules/site", version: "1.1.0", tag: "site/v1.1.0", commit: RELEASED });
    assert.equal(got.library.commit, RELEASED);
    assert.equal(got.library.version, "1.1.0");
    assert.equal(got.libraryDir, lib, "no reader was needed: that commit was already here");
    await assert.rejects(moduleCode(catalog, { source: "modules/site", unreleased: true }), /has not released modules\/site yet/);
  } finally {
    if (was === undefined) delete process.env.SEALEYE_HOME; else process.env.SEALEYE_HOME = was;
  }
});

test("a deploy builds the live catalog's release of the module; a new major version is refused", async () => {
  const { majorVersionWords, versionMove, withLiveReleases } = await import("../api/executor/terraform/versions.js");
  const entry = (version, commit) => ({ id: "http_api", source: "modules/http-api", builds_with: "terraform", version, tag: `http-api/v${version}`, commit });
  const planDoc = { catalogVersion: 3, modules: [entry("1.0.0", "a".repeat(40)), { id: "static_site_edge", builds_with: "static_site_edge" }] };
  const liveDoc = { catalogVersion: 4, modules: [entry("1.1.0", "b".repeat(40))] };
  const built = withLiveReleases(planDoc, liveDoc);
  assert.equal(built.modules[0].version, "1.1.0");
  assert.equal(built.modules[0].commit, "b".repeat(40));
  assert.equal(built.modules[1], planDoc.modules[1], "anything else is as the plan's catalog has it");
  assert.equal(planDoc.modules[0].version, "1.0.0", "the plan's catalog is not changed");
  assert.equal(withLiveReleases(planDoc, { modules: [{ ...entry("1.1.0", "b".repeat(40)), source: "modules/other" }] }).modules[0].version, "1.0.0", "only the same module");
  assert.equal(withLiveReleases(planDoc, { modules: [{ id: "http_api", source: "modules/http-api", builds_with: "terraform" }] }).modules[0].version, "1.0.0", "a live catalog that releases nothing changes nothing");

  const had = { version: "1.0.0", source: "modules/http-api" };
  assert.equal(versionMove(had, entry("1.0.0")), null);
  assert.equal(versionMove(null, entry("1.1.0")), null, "a first build moves nothing");
  assert.deepEqual(versionMove(had, entry("1.1.0")), { from: "1.0.0", to: "1.1.0", major: false });
  const major = versionMove(had, entry("2.0.0"));
  assert.equal(major.major, true);
  assert.match(majorVersionWords(entry("2.0.0"), major), /new major version of modules\/http-api \(1\.0\.0 to 2\.0\.0\).*Run sealeye run again.*Nothing was deployed\./);
});

test("how modules connect is read by code: what one offers an app, and what an app's module takes", async () => {
  const { connectsOf } = await import("../api/discovery/terraform.js");
  const table = connectsOf({ name: {}, stage: {}, key: {} }, { table_name: {}, table_arn: {}, access_policy_arn: {}, read_only_policy_arn: {} });
  assert.deepEqual(table, { offers: { access: "access_policy_arn", narrower: ["read_only_policy_arn"], secrets: [], values: ["table_name"] } });
  const db = connectsOf({ name: {} }, { address: {}, port: {}, password_secret_arn: {} });
  assert.deepEqual(db.offers, { access: null, narrower: [], secrets: ["password_secret_arn"], values: ["address", "port"] });
  assert.deepEqual(connectsOf({ package_path: {}, handler: {}, environment: {}, policy_arns: {}, secret_arns: {} }, { url: {}, role_name: {} }), { accepts: { policies: "policy_arns", secrets: "secret_arns", environment: "environment" } });
  assert.deepEqual(connectsOf({ name: {} }, { secret_arns: {} }), {}, "a map of secrets is not one an app can be given");
  assert.deepEqual(connectsOf({ name: {} }, { url: {} }), {}, "a module that grants nothing offers nothing");
});

test("a plan connects what its app uses to exactly one module that runs it, by the settings the code reads", async () => {
  const { connectionProblems, isPart } = await import("../core/terraform-modules.js");
  const catalog = { modules: [
    { id: "api", delivers: { kind: "package" }, accepts: { policies: "policy_arns", secrets: "secret_arns", environment: "environment" } },
    { id: "site", delivers: { kind: "files" } },
    { id: "table", offers: { access: "access_policy_arn", narrower: [], secrets: [], values: ["table_name"] } },
    { id: "db", offers: { access: null, narrower: [], secrets: ["password_secret_arn"], values: ["address"] } }
  ] };
  assert.equal(isPart(catalog.modules[2]), true);
  assert.equal(isPart(catalog.modules[0]), false);
  const words = plan => connectionProblems(plan, catalog).map(p => p.message);
  assert.deepEqual(words({ modules: [{ id: "api" }] }), [], "nothing to connect");
  assert.deepEqual(words({ modules: [{ id: "api" }, { id: "table", connect: { table_name: "ORDERS" } }, { id: "db", connect: { address: "DB_HOST" } }] }), []);
  assert.match(words({ modules: [{ id: "site" }, { id: "table", connect: { table_name: "ORDERS" } }] }).join(" "), /site cannot be given what the app needs to use table: it takes no policies/);
  assert.match(words({ modules: [{ id: "api" }, { id: "table", connect: { table_name: "orders" } }] })[0], /orders is not a setting's name/);
  assert.match(words({ modules: [{ id: "api", inputs: { environment: { ORDERS: "x" } } }, { id: "table", connect: { table_name: "ORDERS" } }] })[0], /ORDERS is already a setting the app reads/);
  assert.match(words({ modules: [{ id: "api", connect: { x: "Y" } }] })[0], /is not a module the app uses, so it connects nothing/);
  assert.deepEqual(words({ modules: [{ id: "api" }, { id: "table", enabled: false }] }), [], "a module left out connects nothing");
});

test("the interview hears how to connect modules only from a catalog that has them", async () => {
  const { interviewPassages } = await import("../core/catalog.js");
  const doc = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures/juniper-catalog-3.json"), "utf8"));
  const plain = interviewPassages(doc);
  assert.doesNotMatch(plain.module_guidance, /Connecting modules/, "catalog 3, as discovery first wrote it, connects nothing");
  for (const m of doc.modules) { m.runs = []; m.outputs = m.outputs || {}; }
  const http = doc.modules.find(m => m.id === "http_api");
  http.delivers = { kind: "package", package: "package_path", handler: "handler", address: "url" };
  http.accepts = { policies: "policy_arns", environment: "environment" };
  const table = doc.modules.find(m => m.id === "document_table");
  table.offers = { access: "access_policy_arn", narrower: [], secrets: [], values: ["table_name"] };
  doc.platform = { names: ["permissions_boundary_arn"] };
  const connected = interviewPassages(doc);
  assert.match(connected.module_guidance, /### Connecting modules/);
  assert.match(connected.module_guidance, /- document_table gives the app \W*table_name/);
  assert.match(connected.plan_description, /with connect naming the setting the app reads each of its values from/);
});

test("an app reaches a database in the private network: its module joins the network only then, and never reads the master password", async () => {
  const { NETWORK_INPUTS, connectionProblems, inNetwork, joinsNetwork, platformInputs, terraformBuilds: builds } = await import("../core/terraform-modules.js");
  const { connectionInputs } = await import("../api/executor/terraform/root.js");
  const joining = api({ inputs: { ...api().inputs, policy_arns: { required: false }, secret_arns: { required: false }, subnet_ids: { required: false }, security_group_ids: { required: false } }, accepts: { policies: "policy_arns", secrets: "secret_arns", environment: "environment" } });
  const db = {
    id: "postgres", builds_with: "terraform", availability: "available", runs: [], delivers: null,
    inputs: { name: { required: true }, stage: { required: true }, subnet_group_name: { required: true }, security_group_ids: { required: true }, permissions_boundary_arn: { required: false } },
    outputs: { address: {}, port: {}, database_name: {}, database_user: {}, access_policy_arn: {}, password_secret_arn: {} },
    offers: { access: "access_policy_arn", narrower: [], secrets: ["password_secret_arn"], values: ["address", "database_name", "database_user", "port"] }
  };
  const table = { id: "table", delivers: null, inputs: { name: { required: true } }, offers: { access: "access_policy_arn", narrower: [], secrets: [], values: ["table_name"] } };
  const vault = { id: "vault", delivers: null, inputs: { name: { required: true } }, offers: { access: null, narrower: [], secrets: ["password_secret_arn"], values: ["address"] } };
  assert.equal(inNetwork(db), true);
  assert.equal(inNetwork(table), false);
  assert.equal(inNetwork(joining), false, "a module that runs an app is never a part in the network");
  assert.equal(joinsNetwork(joining), true);
  assert.equal(joinsNetwork(api()), false);

  // Built only once the platform has the network values for the module that runs the app,
  // and only when it lets the app sign in with its own identity.
  const own = ["postgres.subnet_group_name", "postgres.security_group_ids"];
  assert.match(builds({ ...db, offers: { ...db.offers, access: null } }, { names: [...own, "subnet_ids", "security_group_ids"] }).why, /signs in with its own identity, which this module does not offer/);
  assert.match(builds(db, { names: own }).why, /^an app reaches it over the private network, and the platform has no subnet_ids and security_group_ids value/);
  assert.deepEqual(builds(db, { names: own }).missing, ["subnet_ids", "security_group_ids"]);
  assert.match(builds(db, { names: [...own, "subnet_ids"] }).why, /no security_group_ids value/);
  assert.equal(builds(db, { names: [...own, "http_api.subnet_ids", "http_api.security_group_ids"] }).builds, false, "a module's own network value may be another part's, so only the plain name builds a part");
  assert.equal(builds(db, { names: [...own, "subnet_ids", "cache_redis.security_group_ids"] }).builds, false, "a cache's own groups never let an app join the network");
  assert.equal(builds(db, { names: [...own, "subnet_ids", "security_group_ids"] }).builds, true);

  // The app's module is given the network inputs only when the plan has a part in the network.
  const values = { permissions_boundary_arn: "b", subnet_ids: ["subnet-a", "subnet-b"], security_group_ids: ["sg-apps"], "postgres.subnet_group_name": "dbs", "postgres.security_group_ids": ["sg-dbs"] };
  assert.deepEqual(Object.keys(platformInputs(joining, values)), ["permissions_boundary_arn"]);
  assert.deepEqual(Object.keys(platformInputs(joining, values, { network: true })).sort(), ["permissions_boundary_arn", "security_group_ids", "subnet_ids"]);
  assert.deepEqual(platformInputs(db, values).security_group_ids, { from: "postgres.security_group_ids", value: ["sg-dbs"] }, "a part's own group is its own required input, whatever the plan");
  const outside = inputsFor({ entry: joining, planModule: { id: "http_api" }, name: "n", tags: {}, platform: values, code: { package: "p" }, parts: [{ key: "table", entry: table }] });
  assert.equal("subnet_ids" in outside.inputs, false, "an app that uses a table stays outside the network");
  const inside = inputsFor({ entry: joining, planModule: { id: "http_api" }, name: "n", tags: {}, platform: values, code: { package: "p" }, parts: [{ key: "postgres", entry: db }] });
  assert.deepEqual(inside.inputs.subnet_ids, ["subnet-a", "subnet-b"]);
  assert.deepEqual(inside.sources.find(s => s.name === "security_group_ids"), { name: "security_group_ids", source: "platform value", from: "security_group_ids" });
  const { subnet_ids: _s, ...noNetwork } = values;
  assert.throws(() => inputsFor({ entry: joining, planModule: { id: "http_api" }, name: "n", tags: {}, platform: noNetwork, code: { package: "p" }, parts: [{ key: "postgres", entry: db }] }), /uses something inside the platform's private network, and the platform has no way set up yet for your app to join that network/);

  // A module that grants access keeps its secret; one that only has a secret hands it over.
  const wired = connectionInputs(joining, [{ key: "postgres", entry: db, planModule: { connect: { address: "DATABASE_HOST" } } }, { key: "vault", entry: vault, planModule: { connect: { address: "VAULT" } } }]);
  assert.deepEqual(wired.inputs.secret_arns, ["${module.vault.password_secret_arn}"]);
  assert.deepEqual(wired.inputs.policy_arns, ["${module.postgres.access_policy_arn}"]);
  assert.equal(wired.sources.find(s => s.name === "secret_arns").from, "vault");

  // The plan check says what the network needs, in the catalog's words.
  const noSecrets = { ...joining, inputs: { ...api().inputs, policy_arns: {}, subnet_ids: {}, security_group_ids: {} }, accepts: { policies: "policy_arns", environment: "environment" } };
  const cannotJoin = { ...joining, inputs: { ...api().inputs, policy_arns: {} }, accepts: { policies: "policy_arns", environment: "environment" } };
  const plan = { modules: [{ id: "http_api" }, { id: "postgres", connect: { address: "H", port: "P", database_name: "D", database_user: "U" } }] };
  const words = (app, names) => connectionProblems(plan, { modules: [app, db], platform: { names } }).map(p => p.message);
  assert.deepEqual(words(noSecrets, [...own, "subnet_ids", "security_group_ids"]), [], "a database that grants access needs no secrets input on the app's module");
  assert.match(words(cannotJoin, [...own, "subnet_ids", "security_group_ids"])[0], /postgres is in the private network, and http_api cannot join it: it takes no subnet_ids and security_group_ids/);
  assert.match(words(noSecrets, own)[0], /the platform has no subnet_ids and security_group_ids value for http_api to join the private network with, which using postgres needs/);
  assert.deepEqual(NETWORK_INPUTS, ["subnet_ids", "security_group_ids"]);
});

test("a plan never sets how an app is wired or networked, a password, or a reference to another part", async () => {
  const { platformInputs, terraformBuilds: builds } = await import("../core/terraform-modules.js");
  const joining = api({
    inputs: { ...api().inputs, policy_arns: { required: false }, secret_arns: { required: false }, subnet_ids: { required: false }, security_group_ids: { required: false }, memory: { required: false } },
    accepts: { policies: "policy_arns", secrets: "secret_arns", environment: "environment" }
  });
  const values = { permissions_boundary_arn: "b" };
  const given = inputsFor({
    entry: joining, name: "n", tags: {}, platform: values, code: { package: "p" },
    planModule: { id: "http_api", inputs: {
      secret_arns: ["${module.postgres.password_secret_arn}"], policy_arns: ["arn:aws:iam::1:policy/admin"],
      subnet_ids: ["subnet-x"], security_group_ids: ["sg-databases"], memory: 512
    } }
  });
  assert.deepEqual(given.ignored, ["policy_arns", "secret_arns", "security_group_ids", "subnet_ids"], "only code wires and networks the app's module");
  assert.equal(given.inputs.memory, 512);
  for (const k of given.ignored) assert.equal(k in given.inputs, false);
  assert.throws(() => inputsFor({ entry: joining, name: "n", tags: {}, platform: values, code: { package: "p" }, planModule: { id: "http_api", inputs: { memory: "${module.db.address}" } } }), /points at another part of the environment/);
  assert.throws(() => inputsFor({ entry: joining, name: "n", tags: {}, platform: values, code: { package: "p" }, planModule: { id: "http_api", inputs: { memory: ["a", "%{ if true }x%{ endif }"] } } }), /points at another part/);

  const db = {
    id: "postgres", builds_with: "terraform", availability: "available", runs: [], delivers: null,
    inputs: { name: { required: true }, stage: { required: true }, subnet_group_name: { required: true }, security_group_ids: { required: true }, master_password: { required: false, sensitive: true }, admin_token: { required: false }, instance_class: { required: false } },
    offers: { access: "access_policy_arn", narrower: [], secrets: ["password_secret_arn"], values: ["address"] }
  };
  const part = inputsFor({ entry: db, name: "n", tags: {}, platform: { subnet_group_name: "dbs", "postgres.security_group_ids": ["sg-dbs"] },
    planModule: { id: "postgres", inputs: { master_password: "hunter2hunter2", admin_token: "x", instance_class: "db.t4g.small" } } });
  assert.deepEqual(part.ignored, ["admin_token", "master_password"], "a sensitive or secret-named input is never the plan's");
  assert.equal(part.inputs.instance_class, "db.t4g.small");
  assert.equal(JSON.stringify(part).includes("hunter2"), false, "and the value is kept nowhere");

  // A database's own groups come only from its own value, never the apps group.
  assert.deepEqual(platformInputs(db, { security_group_ids: ["sg-apps"], subnet_group_name: "dbs" }), { subnet_group_name: { from: "subnet_group_name", value: "dbs" } });
  assert.deepEqual(builds(db, { names: ["subnet_group_name", "security_group_ids", "subnet_ids"] }).missing, ["security_group_ids"], "the apps group does not fill the database's");
  assert.equal(builds(db, { names: ["subnet_group_name", "security_group_ids", "subnet_ids", "postgres.security_group_ids"] }).builds, true);
});

test("discovery's code records an input the module marks sensitive", async () => {
  const { moduleInputs } = await import("../api/discovery/terraform.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-sensitive-"));
  fs.writeFileSync(path.join(dir, "variables.tf"), `variable "master_password" {\n  type      = string\n  default   = null\n  sensitive = true\n}\nvariable "size" {\n  default = "small"\n}\n`);
  const inputs = moduleInputs(dir);
  assert.equal(inputs.master_password.sensitive, true);
  assert.equal("sensitive" in inputs.size, false);
});

test("the Terraform role changes only the security groups seaLeye's environments made, and never the platform's", () => {
  const text = fs.readFileSync(path.join(import.meta.dirname, "..", "deploy", "terraform-role.yaml"), "utf8");
  const block = sid => {
    const at = text.indexOf(`- Sid: ${sid}\n`);
    assert.ok(at >= 0, `the role has ${sid}`);
    const next = text.indexOf("- Sid: ", at + 8);
    return text.slice(at, next < 0 ? undefined : next);
  };
  const change = block("SetupGroupsChange");
  for (const a of ["ec2:DeleteSecurityGroup", "ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupEgress", "ec2:ModifySecurityGroupRules"]) assert.match(change, new RegExp(a));
  assert.match(change, /aws:ResourceTag\/sealeye:environment: "false"/, "changes only a group an environment made");
  assert.match(block("SetupGroupsCreate"), /aws:RequestTag\/sealeye:environment: "false"/, "made only with the environment's tag");
  assert.match(block("SetupGroupsTagOnCreate"), /ec2:CreateAction/, "tagged only as it is made");
  const keep = block("KeepThePlatformsGroups");
  assert.match(keep, /Effect: Deny/);
  assert.match(keep, /ec2:CreateTags/, "a platform group's tags cannot be rewritten to slip past the deny");
  assert.match(keep, /aws:cloudformation:stack-name/, "keyed on the tag CloudFormation sets, which nobody can edit");
  // Only the setup function's boundary reads a kept master password.
  const fn = text.slice(text.indexOf("  FunctionBoundary:"), text.indexOf("  SetupBoundary:"));
  assert.doesNotMatch(fn, /secret:rds!db-/, "no app function may read a master password");
  const setup = text.slice(text.indexOf("  SetupBoundary:"), text.indexOf("  TerraformRole:"));
  assert.match(setup, /rds!db-\*/);
  assert.doesNotMatch(setup, /rds-db:connect/);
  // Reading an app's logs back: only groups named for seaLeye's environments, and only
  // read (Greg, Oct 22, 2026).
  const read = block("ReadAppLogs");
  assert.match(read, /Action: logs:FilterLogEvents\n/, "read, nothing else");
  assert.match(read, /log-group:\/aws\/lambda\/sealeye-\*/);
  assert.doesNotMatch(read, /Resource: "\*"/);
});


test("a platform value reaches an input in the shape the module declares it", async () => {
  const { shapedFor } = await import("../api/executor/terraform/root.js");
  const { moduleInputs } = await import("../api/discovery/terraform.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-types-"));
  fs.writeFileSync(path.join(dir, "variables.tf"), `variable "security_group_ids" {\n  type    = list(string)\n  default = []\n}\nvariable "subnet_group_name" {\n  type = string\n}\nvariable "tags" {\n  type    = map(string)\n  default = {}\n}\nvariable "anything" {}\n`);
  const read = moduleInputs(dir);
  assert.equal(read.security_group_ids.type, "list");
  assert.equal(read.subnet_group_name.type, "string");
  assert.equal(read.tags.type, "map");
  assert.equal("type" in read.anything, false);
  // Oct 21, 2026: the apps group, one word, reached http-api's list(string) as a string.
  assert.deepEqual(shapedFor(read.security_group_ids, "sg-apps"), ["sg-apps"]);
  assert.deepEqual(shapedFor(read.security_group_ids, ["sg-a", "sg-b"]), ["sg-a", "sg-b"]);
  assert.equal(shapedFor(read.subnet_group_name, ["dbs"]), "dbs");
  assert.equal(shapedFor(read.anything, "x"), "x");
  const joining = api({ inputs: { ...api().inputs, subnet_ids: { required: false, type: "list" }, security_group_ids: { required: false, type: "list" } } });
  const db = { id: "postgres", delivers: null, inputs: { subnet_group_name: { required: true } }, offers: { access: "access_policy_arn", secrets: [], values: [] } };
  const given = inputsFor({ entry: joining, planModule: { id: "http_api" }, name: "n", tags: {}, platform: { permissions_boundary_arn: "b", subnet_ids: ["s-a", "s-b"], security_group_ids: "sg-apps" }, code: { package: "p" }, parts: [{ key: "postgres", entry: db }] });
  assert.deepEqual(given.inputs.security_group_ids, ["sg-apps"]);
  assert.equal(given.inputs.permissions_boundary_arn, "b");
});

test("a database's latest restorable time is the cloud's own, and any other change to it still shows", async () => {
  const { driftDetail } = await import("../api/executor/terraform/tofu.js");
  const db = (before, after) => ({ resource_drift: [{ address: "module.postgres.aws_db_instance.db", type: "aws_db_instance", mode: "managed", change: { actions: ["update"], before, after } }] });
  // The first database build, Oct 21, 2026.
  assert.deepEqual(driftDetail(db({ latest_restorable_time: "2026-10-21T22:35:00Z", instance_class: "db.t4g.small" }, { latest_restorable_time: "2026-10-21T22:45:00Z", instance_class: "db.t4g.small" })), []);
  assert.deepEqual(driftDetail(db({ latest_restorable_time: "a", instance_class: "db.t4g.small" }, { latest_restorable_time: "b", instance_class: "db.t4g.large" })), [{ address: "module.postgres.aws_db_instance.db", action: "update", attributes: ["instance_class"] }]);
});

