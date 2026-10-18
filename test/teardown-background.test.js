// A tear-down hands the terminal back the way run and deploy do (DESIGN.md, "A tear-down
// carries on in the background"): a few seconds of its steps, then a detached notifier
// that says when it is gone or why it failed. --watch stays until it is done. And
// `sealeye watch` ends on a tear-down, in the tear-down's own words.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { startApi, token } from "./helpers/api-with-aws.js";

const root = path.resolve(import.meta.dirname, "..");
const ANA = token("a");
const base = { backend: "cloudformation", orgId: "default", teamId: "default", outputs: {}, kind: "api", settings: [], surface: "cli" };
const plan = name => ({
  planVersion: "0.4", app: { name, type: "api" }, profile: "dev",
  modules: [{ id: "http_api_serverless", inputs: { runtime: "nodejs", entry_point: "index.js", trigger: "http" } }],
  outputs: ["public_url"]
});
const built = (name, id, extra = {}) => {
  const stack = `sealeye-default-${name}-aaaaaa`;
  return { ...base, deploymentId: id, app: { name }, status: "succeeded", stackName: stack, resourceName: stack, plan: plan(name), startedAt: new Date().toISOString(), ...extra };
};
let api;
let notified;

before(async () => {
  api = await startApi({
    tokens: [{ token: ANA, id: "ana", name: "Ana", team: "default" }],
    records: [
      built("slow-api", "dep_slow0000001"),
      built("broken-api", "dep_broke000001"),
      built("watched-api", "dep_watch000001"),
      // Never got as far as a stack: its tear-down ends inside the window.
      { ...built("quick-api", "dep_quick000001"), stackName: null, resourceName: null, status: "failed" },
      // Torn down already, and one whose tear-down failed, for `sealeye watch`.
      { ...built("gone-api", "dep_gone0000001"), status: "destroyed", destroyedAt: new Date().toISOString(), destroyRequestedBy: { surface: "cli", at: new Date().toISOString() } },
      { ...built("stuck-api", "dep_stuck000001"), status: "failed", failureReason: "a bucket was not empty", destroyRequestedBy: { surface: "portal", at: new Date().toISOString() } }
    ],
    // A stack is still being deleted until the test drops a file named for it in the
    // API's home, and fails once a file named "broken-" for it is there.
    aws: `
const home = process.env.HOME;
const stack = opt("--stack-name");
if (args[1] === "describe-stacks") {
  if (fs.existsSync(home + "/gone-" + stack)) fail("Stack with id " + stack + " does not exist");
  if (fs.existsSync(home + "/broken-" + stack)) out({ Stacks: [{ StackStatus: "DELETE_FAILED", StackStatusReason: "a role is still in use", Outputs: [] }] });
  out({ Stacks: [{ StackStatus: fs.existsSync(home + "/deleting-" + stack) ? "DELETE_IN_PROGRESS" : "CREATE_COMPLETE", Outputs: [] }] });
}
if (args[1] === "delete-stack") { fs.writeFileSync(home + "/deleting-" + stack, ""); out(""); }
if (args[1] === "describe-stack-events") out({ StackEvents: [] });
`
  });

  // The notifier reaches for terminal-notifier first. This one writes down what it was
  // asked to say, so the test reads the notification the developer would see.
  notified = path.join(api.home, "notified.log");
  fs.writeFileSync(notified, "");
  fs.writeFileSync(path.join(api.home, "bin", "terminal-notifier"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${notified}"\n`, { mode: 0o755 });
});

after(() => api?.stop());

const run = (...args) => promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), ...args, "--api", api.api], {
  cwd: api.home,
  env: {
    ...process.env, HOME: api.home, SEALEYE_HOME: api.home, SEALEYE_TOKEN: ANA, NO_COLOR: "1",
    PATH: `${path.join(api.home, "bin")}:${process.env.PATH}`, SEALEYE_TEST_NOTIFY_POLL_MS: "100", SEALEYE_TRACING: "off"
  },
  timeout: 60_000
}).then(r => r, err => err);

const broken = name => fs.writeFileSync(path.join(api.home, `broken-sealeye-default-${name}-aaaaaa`), "");
const gone = name => fs.writeFileSync(path.join(api.home, `gone-sealeye-default-${name}-aaaaaa`), "");

async function notificationFor(name) {
  for (let i = 0; i < 100; i++) {
    const line = fs.readFileSync(notified, "utf8").split("\n").find(l => l.includes(name));
    if (line) return line;
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
}

test("a tear-down hands the terminal back, then says when everything is gone", async () => {
  const started = Date.now();
  const res = await run("teardown", "slow-api");
  assert.equal(res.code ?? 0, 0, res.stderr);
  assert.ok(Date.now() - started < 20_000, "the terminal came back while the stack was still being deleted");
  assert.match(res.stdout, /Tearing down in the background\. I'll let you know when it's complete\./);
  assert.doesNotMatch(res.stdout, /is gone/);
  assert.equal((await api.call("/deployments/dep_slow0000001", { token: ANA })).body.status, "destroying");

  gone("slow-api");
  const line = await notificationFor("slow-api");
  assert.ok(line, "a notification came");
  assert.match(line, /-subtitle slow-api · dep_slow0000001/);
  assert.match(line, /-message Everything seaLeye\.run created for slow-api is gone\./);
  assert.match(line, /-sound Glass/);
});

test("a tear-down that fails in the background says so, and why", async () => {
  const res = await run("teardown", "broken-api");
  assert.match(res.stdout, /Tearing down in the background/);
  broken("broken-api");
  const line = await notificationFor("broken-api");
  assert.ok(line, "a notification came");
  assert.match(line, /-message Tear-down failed: a role is still in use\./);
  assert.doesNotMatch(line, /was not created/);
  assert.match(line, /-sound Basso/);
});

test("a tear-down that ends inside the window is reported there, with nothing left behind", async () => {
  const res = await run("teardown", "quick-api");
  assert.equal(res.code ?? 0, 0, res.stderr);
  assert.match(res.stdout, /Everything seaLeye\.run created for quick-api is gone/);
  assert.doesNotMatch(res.stdout, /in the background/);
});

test("--watch stays until the tear-down is done", async () => {
  setTimeout(() => gone("watched-api"), 6000);
  const res = await run("teardown", "watched-api", "--watch");
  assert.equal(res.code ?? 0, 0, res.stderr);
  assert.match(res.stdout, /Everything seaLeye\.run created for watched-api is gone/);
  assert.doesNotMatch(res.stdout, /in the background/);
});

test("sealeye watch ends on a tear-down, in the tear-down's words", async () => {
  const done = await run("watch", "dep_gone0000001");
  assert.equal(done.code ?? 0, 0, done.stderr);
  assert.match(done.stdout, /Everything seaLeye\.run created for gone-api is gone/);

  const failed = await run("watch", "dep_stuck000001");
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /Tear-down failed: a bucket was not empty/);
  assert.doesNotMatch(failed.stdout, /was not created/);
});
