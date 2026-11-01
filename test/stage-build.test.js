// A made-up sit environment, built and torn down with the stand-in `tofu` (PHASE5-PLAN
// Step 3): the executor builds a record for the stage it says, never dev by rule. Its
// name, its module's name, its state, the stage the module is told and the platform
// values it is given are all sit's, and dev's are untouched. Nothing asks to build a
// stage past dev yet (Step 8), so the record is made here, as the executor gets one.
// No AWS, no GitHub, no model.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-stage-build-"));
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-stage-tofu-"));
const bin = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-stage-bin-"));
const COMMIT = "5e63aa573473e988a2e2e40616ad32614a30e98b";
const REPO = "GregKliewer/sealeye-sample-platform";

// What tofu is asked, and the root it was handed; a site's two outputs.
fs.writeFileSync(path.join(bin, "tofu.cjs"), `
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2), log = ${JSON.stringify(logDir)};
fs.appendFileSync(path.join(log, "tofu.log"), JSON.stringify({ args, profile: process.env.AWS_PROFILE || null }) + "\\n");
if (fs.existsSync("main.tf.json")) fs.copyFileSync("main.tf.json", path.join(log, "main.tf.json"));
const say = m => process.stdout.write(JSON.stringify(m) + "\\n");
if (args[0] === "plan") { fs.writeFileSync("tfplan", "plan"); say({ type: "change_summary", changes: { add: 3, change: 0, remove: 0, operation: "plan" } }); }
if (args[0] === "apply") say({ type: "change_summary", changes: { add: 3, change: 0, remove: 0, operation: "apply" } });
if (args[0] === "destroy") say({ type: "change_summary", changes: { add: 0, change: 0, remove: 3, operation: "destroy" } });
if (args[0] === "output") process.stdout.write(JSON.stringify({ bucket_name: { value: "juniper-site-sit" }, url: { value: "https://sit.example.net" } }));
process.exit(0);
`);
fs.writeFileSync(path.join(bin, "tofu"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, "tofu.cjs")}" "$@"\n`, { mode: 0o755 });
// The AWS CLI: a site's files synced, and its bucket emptied before a tear-down.
fs.writeFileSync(path.join(bin, "aws"), `#!/bin/sh\necho "$AWS_PROFILE $1 $2" >> "${path.join(logDir, "aws.log")}"\necho '{}'\n`, { mode: 0o755 });

Object.assign(process.env, {
  SEALEYE_HOME: home, HOME: home, DATABASE_URL: "", SEALEYE_TRACING: "off",
  SEALEYE_TOFU: path.join(bin, "tofu"), SEALEYE_TOFU_CONFIG: "/nonexistent",
  SEALEYE_BUCKET: "platform-sealeye-123456789012-ca-central-1",
  SEALEYE_TERRAFORM_PROFILE: "sealeye-deploy-terraform",
  PATH: `${bin}:${process.env.PATH}`
});

const { openStore, putDeployment, getDeployment } = await import("../api/store.js");
const { openPlatform, setPlatformValue, valuesAt } = await import("../api/platform.js");
const { startTerraformDeployment, startTerraformDestroy } = await import("../api/executor/terraform/index.js");
const { namingFor } = await import("../api/executor/compose.js");
const { environmentName, moduleName } = await import("../core/names.js");

const BOUNDARY = { dev: "arn:aws:iam::123456789012:policy/boundary-dev", sit: "arn:aws:iam::123456789012:policy/boundary-sit" };

/** A site module, as Juniper's library has it, that takes a value only the platform gives. */
function catalog(stage) {
  return {
    catalog: { name: "juniper", version: 3 },
    discovery: { library: [{ repo: REPO, commit: COMMIT }] },
    platform: { stage, names: ["permissions_boundary_arn"] },
    modules: [{
      id: "static_site", line: "A public website.", availability: "available", builds_with: "terraform", source: "modules/static-site",
      inputs: { name: { required: true }, stage: { required: true }, permissions_boundary_arn: { required: true } },
      outputs: { bucket_name: { line: "The site's files." }, url: { line: "The site's address." } },
      delivers: { kind: "files", output: "bucket_name", address: "url" }, runs: []
    }]
  };
}

before(async () => {
  const lib = path.join(home, "tofu-libraries", `GregKliewer--sealeye-sample-platform--${COMMIT}`);
  fs.mkdirSync(path.join(lib, "modules/static-site"), { recursive: true });
  fs.writeFileSync(path.join(lib, "modules/static-site/main.tf"), 'resource "aws_s3_bucket" "site" {}\n');
  fs.writeFileSync(path.join(lib, "modules/static-site/variables.tf"), 'variable "name" {}\nvariable "stage" {}\nvariable "permissions_boundary_arn" {}\n');
  fs.writeFileSync(path.join(lib, ".complete"), `${REPO}@${COMMIT}\n`);
  await openStore();
  await openPlatform();
  for (const stage of ["dev", "sit"]) await setPlatformValue({ org: "juniper", stage, name: "permissions_boundary_arn", value: BOUNDARY[stage], by: "platform@example.com" });
});

test("a sit environment is built as sit: its own name, state, stage and platform values, apart from dev's", async () => {
  assert.equal(valuesAt("juniper", "sit").permissions_boundary_arn, BOUNDARY.sit);
  const site = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-stage-site-"));
  fs.writeFileSync(path.join(site, "index.html"), "<h1>sit</h1>");
  const plan = { planVersion: "0.5", catalog: 3, app: { name: "brochure", type: "static-site" }, profile: "dev", modules: [{ id: "static_site" }], outputs: ["public_url"] };
  const who = { org: "juniper", team: "payments", app: "brochure" };
  const naming = namingFor({ ...who, stage: "sit", records: [] });
  assert.equal(naming.stackName, environmentName({ ...who, stage: "sit" }));
  const record = putDeployment({
    deploymentId: "dep_sit000000001", status: "queued", stage: "sit", kind: "static", environment: naming.stackName,
    orgId: "juniper", teamId: "payments", app: plan.app, plan, startedAt: new Date().toISOString(), outputs: {}
  });

  await startTerraformDeployment(record, plan, site, catalog("sit"));
  const built = getDeployment("dep_sit000000001");
  assert.equal(built.status, "succeeded", built.failureReason);
  assert.equal(built.stage, "sit");
  assert.match(built.stackName, /^sealeye-payments-brochure-sit-[0-9a-f]{6}$/);
  assert.equal(built.resourceName, moduleName({ ...who, stage: "sit" }));
  assert.notEqual(built.resourceName, moduleName(who), "not dev's module name");
  assert.equal(built.terraform.stateKey, `tofu-state/juniper/sit/${built.stackName}.tfstate`);

  const root = JSON.parse(fs.readFileSync(path.join(logDir, "main.tf.json"), "utf8"));
  assert.equal(root.module.app.stage, "sit", "told the stage it is built for");
  assert.equal(root.module.app.permissions_boundary_arn, BOUNDARY.sit, "given sit's platform values, not dev's");
  assert.equal(root.module.app.name, built.resourceName);
  assert.equal(root.terraform.backend.s3.key, built.terraform.stateKey);
  assert.deepEqual(built.terraform.inputs.find(i => i.name === "stage"), { name: "stage", source: "seaLeye" });
  assert.match(fs.readFileSync(path.join(logDir, "aws.log"), "utf8"), /^sealeye-deploy-terraform s3 sync$/m, "its files synced through the Terraform role");

  // Torn down from the same state, under sit, and only sit's.
  fs.writeFileSync(path.join(logDir, "tofu.log"), "");
  await startTerraformDestroy(built, catalog("sit"));
  const gone = getDeployment("dep_sit000000001");
  assert.equal(gone.status, "destroyed", gone.failureReason);
  const destroyRoot = JSON.parse(fs.readFileSync(path.join(logDir, "main.tf.json"), "utf8"));
  assert.equal(destroyRoot.terraform.backend.s3.key, `tofu-state/juniper/sit/${built.stackName}.tfstate`);
  assert.equal(destroyRoot.module.app.stage, "sit");
});
