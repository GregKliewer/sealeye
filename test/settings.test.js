// Setting values for a deployment: where each comes from, what a deploy request may
// carry, and that a value never reaches anything that is kept. No AWS, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { envValuesFor, settingNamesFor } from "../core/settings.js";
import { acceptSent, settingValues, sourceInWords } from "../api/executor/settings.js";

const SECRET = "sk-live-sent-once";

const plan = {
  planVersion: "0.4",
  app: { name: "pay-api" },
  modules: [
    { id: "http_api_serverless", enabled: true, inputs: { entry_point: "index.js" } },
    { id: "observability_basic", enabled: true, inputs: {} },
    { id: "config_basic", enabled: true, inputs: { variables: { STRIPE_KEY: "set me", REGION_NAME: "ca", FROM_PLAN: "default", PORT: "8080" } } }
  ]
};

function folder(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-settings-"));
  fs.writeFileSync(path.join(dir, ".env"), env);
  return dir;
}

test("the plan's settings, without the platform's own", () => {
  assert.deepEqual(settingNamesFor(plan), ["STRIPE_KEY", "REGION_NAME", "FROM_PLAN"]);
});

test("the CLI sends only what the plan asks for, from the .env", () => {
  const dir = folder(`STRIPE_KEY=${SECRET}\nREGION_NAME=ca-central\nUNRELATED=nope\nPORT=1\n`);
  assert.deepEqual(envValuesFor(plan, dir), { STRIPE_KEY: SECRET, REGION_NAME: "ca-central" });
});

test("the API takes only strings for settings the plan names", () => {
  assert.deepEqual(
    acceptSent(plan, { STRIPE_KEY: SECRET, EXTRA: "x", REGION_NAME: 5, PORT: "1", FROM_PLAN: "y".repeat(5000) }),
    { STRIPE_KEY: SECRET }
  );
  assert.deepEqual(acceptSent(plan, "nope"), {});
  assert.deepEqual(acceptSent(plan, undefined), {});
});

test("sent beats the folder, the folder beats the plan, and each says where it came from", () => {
  const dir = folder("STRIPE_KEY=from-folder\nREGION_NAME=from-folder\n");
  const values = settingValues(plan, { sent: { STRIPE_KEY: SECRET }, appPath: dir });
  assert.deepEqual(values, [
    { name: "STRIPE_KEY", value: SECRET, source: "sent" },
    { name: "REGION_NAME", value: "from-folder", source: ".env" },
    { name: "FROM_PLAN", value: "default", source: "plan" }
  ]);
  assert.match(sourceInWords("sent"), /sent with the deploy request/);
  assert.equal(sourceInWords("sent", { forDeveloper: true }), "the `.env` in your folder");
});

test("a composed deployment keeps names and sources, never a value", async () => {
  process.env.SEALEYE_LWA_VERSION = "7";
  process.env.SEALEYE_BUCKET = "test-bucket";
  process.env.SEALEYE_FUNCTION_BOUNDARY_ARN = "arn:aws:iam::123456789012:policy/sealeye-function-boundary-pilot";
  const { compose } = await import("../api/executor/compose.js");
  const composed = compose(plan, "dep_test", undefined, { STRIPE_KEY: SECRET });

  assert.ok(Object.values(composed.parameters).includes(SECRET), "the value reaches the parameters");
  const kept = JSON.stringify({ settings: composed.settings, safe: composed.safeParameters });
  assert.ok(!kept.includes(SECRET), "and nothing that is kept");
  assert.deepEqual(composed.settings.map(s => s.source), ["sent", "plan", "plan"]);
  fs.rmSync(composed.templatePath, { force: true });
});

test("a setting in the store is read by the app at start, never passed in, and only its folder is readable", async () => {
  process.env.SEALEYE_LWA_VERSION = "7";
  process.env.SEALEYE_BUCKET = "test-bucket";
  process.env.SEALEYE_FUNCTION_BOUNDARY_ARN = "arn:aws:iam::123456789012:policy/sealeye-function-boundary-pilot";
  const { compose } = await import("../api/executor/compose.js");
  const folder = "/sealeye-apps/payments/pay-api/";
  const composed = compose(plan, "dep_store", undefined, { STRIPE_KEY: SECRET }, undefined, { folder, stored: ["STRIPE_KEY"] });

  assert.deepEqual(composed.settings, [
    { name: "STRIPE_KEY", source: "store" },
    { name: "REGION_NAME", source: "plan" },
    { name: "FROM_PLAN", source: "plan" }
  ], "the store wins over a value sent from .env");
  assert.ok(!Object.values(composed.parameters).includes(SECRET), "a stored setting's value is never passed in");
  assert.equal(composed.parameters.SettingsFolder, "/sealeye-apps/payments/pay-api");
  assert.equal(composed.parameters.FunctionBoundaryArn, process.env.SEALEYE_FUNCTION_BOUNDARY_ARN);
  const template = fs.readFileSync(composed.templatePath, "utf8");
  assert.match(template, /REGION_NAME: !Ref ConfigValue1/);
  assert.doesNotMatch(template, /STRIPE_KEY: !Ref/, "the stored one is not in the template");
  fs.rmSync(composed.templatePath, { force: true });

  const none = compose(plan, "dep_none", undefined, {}, undefined, { folder, stored: [] });
  assert.equal(none.parameters.SettingsFolder, "", "with nothing stored the function reads nothing");
  fs.rmSync(none.templatePath, { force: true });
  assert.match(sourceInWords("store", { forDeveloper: true }), /organization's settings store/);
});
