// The API end to end on a spare port, with its own empty home: health, plan validation
// for the plans in plans/, and the needs ledger. Nothing here calls AWS or a model.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import YAML from "yaml";

const root = path.resolve(import.meta.dirname, "..");
const port = 3900 + Math.floor(Math.random() * 90);
const api = `http://localhost:${port}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-api-"));
let server;

before(async () => {
  server = spawn(process.execPath, ["api/server.js"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), SEALEYE_HOME: home, HOME: home },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  server.stdout.on("data", d => (log += d));
  server.stderr.on("data", d => (log += d));

  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${api}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`API did not start:\n${log}`);
});

after(() => server?.kill());

test("GET /health answers with the package version", async () => {
  const body = await (await fetch(`${api}/health`)).json();
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(body.ok, true);
  assert.equal(body.version, pkg.version);
  assert.equal(body.deployments, 0);
});

for (const file of fs.readdirSync(path.join(root, "plans")).filter(f => f.endsWith(".yaml"))) {
  test(`POST /plans/validate accepts plans/${file}`, async () => {
    const plan = YAML.parse(fs.readFileSync(path.join(root, "plans", file), "utf8"));
    const res = await fetch(`${api}/plans/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(plan)
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body.errors, []);
    assert.equal(body.valid, true);
  });
}

test("POST /plans/validate refuses a plan with no modules", async () => {
  const res = await fetch(`${api}/plans/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planVersion: "0.4", app: { name: "x" }, modules: [] })
  });
  const body = await res.json();
  assert.equal(body.valid, false);
  assert.ok(body.errors.length > 0);
});

test("GET /needs answers on an empty store", async () => {
  const res = await fetch(`${api}/needs`);
  assert.equal(res.status, 200);
});

test("the CLI prints its help as sealeye, never deployme", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["cli/bin/sealeye", "--help"], { cwd: root, env: { ...process.env, HOME: home } });
  assert.match(stdout, /sealeye run/);
  assert.doesNotMatch(stdout, /\bdeployme\b/i);
});

test("sealeye validate checks a plan file against the running API", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["cli/bin/sealeye", "validate", "-f", "plans/api-plan.yaml", "--api", api],
    { cwd: root, env: { ...process.env, HOME: home, NO_COLOR: "1" } }
  );
  assert.match(stdout, /Your plan is valid/);
});

test("sealeye list works against an empty store", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["cli/bin/sealeye", "list", "--api", api],
    { cwd: root, env: { ...process.env, HOME: home, NO_COLOR: "1" } }
  );
  assert.match(stdout, /No environments yet/);
});
