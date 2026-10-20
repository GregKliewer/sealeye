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
  assert.match(terraformBuilds(api({ delivers: null }), { names: ["permissions_boundary_arn"] }).why, /does not connect modules to each other yet/);
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
