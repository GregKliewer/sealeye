// A stack from before each team's environments had names of their own can hold two
// teams' records: both deployed an app called foo, and both landed on sealeye-foo. The
// team that deployed there last is in it. The other may then neither change nor tear it
// down (DESIGN.md, "Each team's environments have names of their own"). A laptop API
// seeded with such records, and a stand-in aws; no AWS.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import YAML from "yaml";
import { freePort } from "./helpers/free-port.js";

const root = path.resolve(import.meta.dirname, "..");
let home, api, server, log = "";
const env = () => ({ ...process.env, HOME: home, SEALEYE_HOME: home, DATABASE_URL: "", SEALEYE_AUTH: "" });

function issue(email, name, ...flags) {
  const out = execFileSync(process.execPath, ["scripts/tokens.js", "add", email, name, ...flags], { cwd: root, env: env(), encoding: "utf8" });
  return out.match(/sl_[A-Za-z0-9_-]{43}/)[0];
}
const call = (route, { token, method = "GET", body } = {}) =>
  fetch(`${api}${route}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {})
  });

let greg, ana, boss;
const at = minutes => new Date(Date.UTC(2026, 9, 11, 12, minutes)).toISOString();

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-shared-"));
  greg = issue("greg@example.com", "Greg K");
  ana = issue("ana@example.com", "Ana P", "--team", "payments");
  boss = issue("boss@example.com", "Boss Person", "--org-wide");
  const legacy = { backend: "cloudformation", kind: "static", stackName: "sealeye-foo", parameters: { AppName: "foo" }, app: { name: "foo" }, outputs: {}, orgId: "default" };
  fs.writeFileSync(path.join(home, "deployments.json"), JSON.stringify([
    { ...legacy, deploymentId: "dep_000000000ana", teamId: "payments", status: "succeeded", startedAt: at(0), finishedAt: at(1) },
    { ...legacy, deploymentId: "dep_00000000greg", teamId: "default", status: "succeeded", startedAt: at(5), finishedAt: at(6) },
    // Another organization deployed to sealeye-bar last.
    { ...legacy, stackName: "sealeye-bar", parameters: { AppName: "bar" }, app: { name: "bar" }, deploymentId: "dep_0000000bar01", teamId: "default", status: "succeeded", startedAt: at(0) },
    { ...legacy, stackName: "sealeye-bar", parameters: { AppName: "bar" }, app: { name: "bar" }, deploymentId: "dep_0000000bar02", orgId: "other-org", teamId: "default", status: "succeeded", startedAt: at(5) }
  ]));
  // A stand-in aws: every stack is already gone, so a tear down finishes at once.
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "aws"), "#!/bin/sh\necho 'Stack does not exist' >&2\nexit 254\n", { mode: 0o755 });
  const port = await freePort();
  api = `http://localhost:${port}`;
  const e = { ...env(), PORT: String(port), SEALEYE_TRACING: "off", PATH: `${path.join(home, "bin")}:${process.env.PATH}` };
  server = spawn(process.execPath, ["api/server.js"], { cwd: root, env: e, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", d => (log += d));
  server.stderr.on("data", d => (log += d));
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${api}/health`)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`API did not start:\n${log}`);
});

after(() => server?.kill());

test("a team cannot tear down a stack another team's environment also uses", async () => {
  const res = await call("/deployments/dep_000000000ana", { method: "DELETE", token: ana });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, "SHARED_ENVIRONMENT");
  const gregs = await (await call("/deployments/dep_00000000greg", { token: greg })).json();
  assert.equal(gregs.status, "succeeded", "the other team's environment is untouched");
  const anas = await (await call("/deployments/dep_000000000ana", { token: ana })).json();
  assert.equal(anas.destroyRequestedBy, undefined, "and nothing was recorded as asked for");
});

test("a team's next deploy of that app gets a name of its own, not the shared stack", async () => {
  const { createDeployment } = await import("../cli/client.js");
  const plan = YAML.parse(fs.readFileSync(path.join(root, "plans", "static-plan.yaml"), "utf8"));
  const folder = path.join(home, "foo");
  fs.cpSync(path.join(root, "apps", "static-website"), folder, { recursive: true });
  process.env.SEALEYE_TOKEN = ana;
  let deploymentId;
  try {
    ({ deploymentId } = await createDeployment({ apiBaseUrl: api, backend: "cloudformation", plan: { ...plan, app: { ...plan.app, name: "foo" } }, appPath: folder }));
  } finally {
    delete process.env.SEALEYE_TOKEN;
  }
  let record;
  for (let i = 0; i < 50 && !record?.stackName; i++) {
    record = await (await call(`/deployments/${deploymentId}`, { token: ana })).json();
    if (!record.stackName) await new Promise(r => setTimeout(r, 100));
  }
  assert.match(record.stackName, /^sealeye-payments-foo-[0-9a-f]{6}$/);
  assert.equal(record.parameters.AppName, record.stackName, "nor the other team's function or bucket");
});

test("the team that deployed last is in the stack: its next deploy updates it", async () => {
  const { createDeployment } = await import("../cli/client.js");
  const plan = YAML.parse(fs.readFileSync(path.join(root, "plans", "static-plan.yaml"), "utf8"));
  const folder = path.join(home, "foo-greg");
  fs.cpSync(path.join(root, "apps", "static-website"), folder, { recursive: true });
  process.env.SEALEYE_TOKEN = greg;
  let deploymentId;
  try {
    ({ deploymentId } = await createDeployment({ apiBaseUrl: api, backend: "cloudformation", plan: { ...plan, app: { ...plan.app, name: "foo" } }, appPath: folder }));
  } finally {
    delete process.env.SEALEYE_TOKEN;
  }
  let record;
  for (let i = 0; i < 50 && !record?.stackName; i++) {
    record = await (await call(`/deployments/${deploymentId}`, { token: greg })).json();
    if (!record.stackName) await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(record.stackName, "sealeye-foo", "not a second copy beside the one already live");
  // One change at a time: let it finish before anything else changes that environment.
  for (let i = 0; i < 100 && !["succeeded", "failed"].includes(record.status); i++) {
    await new Promise(r => setTimeout(r, 100));
    record = await (await call(`/deployments/${deploymentId}`, { token: greg })).json();
  }
  assert.ok(["succeeded", "failed"].includes(record.status), record.status);
});

test("an organization-wide token, which sees both teams, may tear the shared stack down", async () => {
  const res = await call("/deployments/dep_000000000ana", { method: "DELETE", token: boss });
  assert.ok(res.ok, `${res.status}`);
  let gregs;
  for (let i = 0; i < 50; i++) {
    gregs = await (await call("/deployments/dep_00000000greg", { token: greg })).json();
    if (gregs.status === "destroyed") break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(gregs.status, "destroyed", "the other team's record on that stack is closed too, since the stack is gone");
});

test("but never a stack another organization deployed to last", async () => {
  const res = await call("/deployments/dep_0000000bar01", { method: "DELETE", token: boss });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, "SHARED_ENVIRONMENT");
});
