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
