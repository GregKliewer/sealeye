#!/usr/bin/env node
// scripts/try-package.js — dev harness for compose() + stage(). Not part of the product.
//
//   node deployme/scripts/try-package.js plans/api-plan.yaml apps/sample-expressjs
//   node deployme/scripts/try-package.js plans/api-plan.yaml apps/sample-expressjs --compose-only
//
// --compose-only skips staging and the S3 upload (useful without AWS creds).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import Ajv from "ajv";
import addFormats from "ajv-formats";

import { planSchema } from "../src/schema.js";
import { compose } from "../src/executor/compose.js";
import { stage, stagePaths } from "../src/executor/package.js";
import { loadPlanFromYaml } from "../lib/run.js";

const args = process.argv.slice(2);
const composeOnly = args.includes("--compose-only");
const [planPath, appPath] = args.filter(a => !a.startsWith("--"));

if (!planPath || !appPath) {
  console.error("usage: node deployme/scripts/try-package.js <plan.yaml> <appPath> [--compose-only]");
  process.exit(1);
}
if (!fs.existsSync(planPath)) {
  console.error(`plan not found: ${planPath}`);
  process.exit(1);
}

const plan = loadPlanFromYaml(planPath);

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(planSchema);

if (!validate(plan)) {
  console.error(`plan failed validation: ${planPath}`);
  for (const e of validate.errors) console.error(`  ${e.instancePath || "/"} ${e.message}`);
  process.exit(1);
}

const deploymentId = `dep_${crypto.randomBytes(6).toString("hex")}`;

console.log(`plan          ${path.resolve(planPath)}`);
console.log(`app           ${path.resolve(appPath)}`);
console.log(`deploymentId  ${deploymentId}`);
console.log("");

const composed = compose(plan, deploymentId);

console.log("compose()");
console.log(`  kind          ${composed.kind}`);
console.log(`  templatePath  ${composed.templatePath}`);
console.log(`  stackName     ${composed.stackName}`);
console.log("  parameters");
for (const [k, v] of Object.entries(composed.parameters)) {
  console.log(`    ${k.padEnd(20)} ${v}`);
}
console.log("");

if (composeOnly) {
  console.log("stage()       skipped (--compose-only)");
  process.exit(0);
}

const startedAt = Date.now();
const key = await stage(appPath, deploymentId, composed, line => console.log(`  ${line}`));
const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

console.log("");
if (key === null) {
  console.log(`stage()       null — ${composed.kind} has no artifact; files sync after the stack exists`);
} else {
  const { stageDir, zipPath } = stagePaths(deploymentId);
  console.log(`stage()       ${key}`);
  console.log(`  s3          s3://${process.env.DEPLOYME_BUCKET}/${key}`);
  console.log(`  zip         ${zipPath} (${(fs.statSync(zipPath).size / 1024).toFixed(0)} KB)`);
  console.log(`  stageDir    ${stageDir}`);
}
console.log(`took          ${seconds}s`);
