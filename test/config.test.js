// The rename from deployme to sealeye: the new names are what everything says, and the
// old ones are still read, so nobody's .env, config file or deployment store is lost.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");

// Each case runs in its own process with its own HOME and environment, because config
// is read once per process.
function inChild(code, env = {}) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("SEALEYE_") && !k.startsWith("DEPLOYME_"))
  );
  return execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: root,
    env: { ...clean, ...env },
    encoding: "utf8"
  }).trim();
}

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-test-"));
}

test("setting() reads SEALEYE_ names", () => {
  const out = inChild(`import { setting } from "./core/config.js"; console.log(setting("PROBE"));`, { SEALEYE_PROBE: "new" });
  assert.equal(out, "new");
});

test("setting() still reads DEPLOYME_ names", () => {
  const out = inChild(`import { setting } from "./core/config.js"; console.log(setting("PROBE"));`, { DEPLOYME_PROBE: "old" });
  assert.equal(out, "old");
});

test("the new name wins when both are set", () => {
  const out = inChild(`import { setting } from "./core/config.js"; console.log(setting("PROBE"));`, { SEALEYE_PROBE: "new", DEPLOYME_PROBE: "old" });
  assert.equal(out, "new");
});

test("region() defaults to ca-central-1 and honours either name", () => {
  const code = `import { region } from "./core/config.js"; console.log(region());`;
  assert.equal(inChild(code, { HOME: tempHome() }), "ca-central-1");
  assert.equal(inChild(code, { SEALEYE_REGION: "us-east-1" }), "us-east-1");
  assert.equal(inChild(code, { DEPLOYME_REGION: "us-west-2" }), "us-west-2");
});

test("~/.sealeye/config is read, and ~/.deployme/config still is", () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, ".sealeye"));
  fs.mkdirSync(path.join(home, ".deployme"));
  fs.writeFileSync(path.join(home, ".sealeye", "config"), "ORG=New Bank\nONLY_NEW=1\n");
  fs.writeFileSync(path.join(home, ".deployme", "config"), "ORG=Old Bank\nONLY_OLD=1\n");

  const out = inChild(
    `import { loadUserConfig } from "./core/config.js"; loadUserConfig();
     console.log([process.env.ORG, process.env.ONLY_NEW, process.env.ONLY_OLD].join("|"));`,
    { HOME: home }
  );
  assert.equal(out, "New Bank|1|1");
});

test("the old deployment store is copied in once, and left as it was", () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, ".deployme"));
  const legacy = path.join(home, ".deployme", "deployments.json");
  const records = JSON.stringify([{ deploymentId: "dep_000000000001", status: "succeeded", createdAt: "2026-10-01T00:00:00Z" }]);
  fs.writeFileSync(legacy, records);

  const out = inChild(
    `import { listDeployments } from "./api/store.js"; console.log(listDeployments().map(d => d.deploymentId).join(","));`,
    { HOME: home }
  );

  assert.equal(out, "dep_000000000001");
  assert.equal(fs.readFileSync(path.join(home, ".sealeye", "deployments.json"), "utf8"), records);
  assert.equal(fs.readFileSync(legacy, "utf8"), records);
});

test("an existing new store is never overwritten by the old one", () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, ".deployme"));
  fs.mkdirSync(path.join(home, ".sealeye"));
  fs.writeFileSync(path.join(home, ".deployme", "deployments.json"), JSON.stringify([{ deploymentId: "dep_old", status: "succeeded" }]));
  fs.writeFileSync(path.join(home, ".sealeye", "deployments.json"), JSON.stringify([{ deploymentId: "dep_new", status: "succeeded" }]));

  const out = inChild(
    `import { listDeployments } from "./api/store.js"; console.log(listDeployments().map(d => d.deploymentId).join(","));`,
    { HOME: home }
  );
  assert.equal(out, "dep_new");
});
