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
    env: { ...process.env, PORT: String(port), SEALEYE_HOME: home, HOME: home, SEALEYE_AUTH: "off" },
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

test("POST /plans/validate says whether a plan is ready or drafted, with each need in the catalog's words", async () => {
  const post = async plan => (await fetch(`${api}/plans/validate`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(plan)
  })).json();
  const plan = YAML.parse(fs.readFileSync(path.join(root, "plans", "api-plan.yaml"), "utf8"));
  const ready = await post(plan);
  assert.equal(ready.status, "ready");
  assert.deepEqual(ready.needs, []);

  const drafted = await post({ ...plan, needs: [{ kind: "continuous_service", line: "whatever the plan said", evidence: [{ file: "index.js", shows: "reads a stream in a loop" }] }] });
  assert.equal(drafted.valid, true);
  assert.equal(drafted.status, "drafted");
  assert.equal(drafted.needs.length, 1);
  assert.equal(drafted.needs[0].kind, "continuous_service");
  assert.notEqual(drafted.needs[0].line, "whatever the plan said");
  assert.deepEqual(drafted.needs[0].evidence, [{ file: "index.js", shows: "reads a stream in a loop" }]);

  // A current plan is drafted by its needs, whatever status it claims.
  const current = await post({ ...plan, planVersion: "0.4", status: "ready", modules: plan.modules.map(({ enabled, ...m }) => m), needs: drafted.needs.map(n => ({ ...n, line: "x" })) });
  assert.equal(current.valid, true, JSON.stringify(current.errors));
  assert.equal(current.status, "drafted");

  const invalid = await post({ planVersion: "0.4", app: { name: "x" }, modules: [] });
  assert.equal(invalid.status, undefined);
});

test("sealeye validate never calls a drafted plan simply valid", async () => {
  const plan = YAML.parse(fs.readFileSync(path.join(root, "plans", "api-plan.yaml"), "utf8"));
  plan.needs = [{ kind: "continuous_service", line: "x", evidence: [{ file: "index.js", shows: "reads a stream in a loop" }] }];
  const file = path.join(home, "drafted.yaml");
  fs.writeFileSync(file, YAML.stringify(plan));
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["cli/bin/sealeye", "validate", "-f", file, "--api", api],
    { cwd: root, env: { ...process.env, HOME: home, NO_COLOR: "1" } }
  );
  assert.match(stdout, /it is drafted/);
  assert.match(stdout, /reads a stream in a loop \(index\.js\)/);
  assert.doesNotMatch(stdout, /valid and ready/);
});

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

test("POST /deployments keeps origin.traceId on the record, so an outcome can be scored", async () => {
  // A drafted plan: the API refuses it and saves the record, with no AWS involved.
  const plan = YAML.parse(fs.readFileSync(path.join(root, "plans", "static-plan.yaml"), "utf8"));
  plan.planVersion = "0.4";
  plan.needs = [{
    kind: "continuous_service",
    line: "a service that runs continuously",
    evidence: [{ file: "index.js", shows: "it reads a stream in a loop" }]
  }];
  const traceId = "0123456789abcdef0123456789abcdef";

  const res = await fetch(`${api}/deployments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      backend: "cloudformation",
      plan,
      appPath: path.join(root, "apps", "static-website"),
      origin: { command: "run", planSource: "interview", answers: [], traceId }
    })
  });
  const body = await res.json();
  assert.equal(res.status, 422);
  assert.equal(body.error.code, "UNSUPPORTED_NEEDS");

  const id = body.error.details.deploymentId;
  const record = await (await fetch(`${api}/deployments/${id}`)).json();
  assert.equal(record.origin.traceId, traceId);
});
