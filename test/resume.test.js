// Deployments in flight when the API stopped are picked up again when it starts: a
// running one is watched to its real end, a tear-down is finished, and one that was
// still being prepared fails with the reason. A stand-in `aws` on the PATH plays
// CloudFormation. No AWS.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import YAML from "yaml";

const root = path.resolve(import.meta.dirname, "..");

test("in-flight deployments after a restart: watched, finished or failed, never guessed", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-resume-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  const calls = path.join(home, "aws-calls.log");
  fs.writeFileSync(path.join(bin, "aws"), `#!/bin/sh
echo "$*" >> "${calls}"
name=""; prev=""
for a in "$@"; do [ "$prev" = "--stack-name" ] && name="$a"; prev="$a"; done
case "$2" in
  describe-stacks)
    case "$name" in
      sealeye-b) echo '{"Stacks":[{"StackStatus":"CREATE_COMPLETE","Outputs":[{"OutputKey":"ApiUrl","OutputValue":"https://b.example"}]}]}' ;;
      sealeye-c) echo '{"Stacks":[{"StackStatus":"UPDATE_COMPLETE","Outputs":[]}]}' ;;
      sealeye-s) echo '{"Stacks":[{"StackStatus":"CREATE_COMPLETE","Outputs":[{"OutputKey":"BucketName","OutputValue":"site-bucket"}]}]}' ;;
      *) echo "Stack with id $name does not exist" >&2; exit 254 ;;
    esac ;;
  describe-stack-events) echo '{"StackEvents":[]}' ;;
  *) echo '{}' ;;
esac
`, { mode: 0o755 });

  const plan = YAML.parse(fs.readFileSync(path.join(root, "plans", "api-plan.yaml"), "utf8"));
  const staticPlan = YAML.parse(fs.readFileSync(path.join(root, "plans", "static-plan.yaml"), "utf8"));
  const ago = ms => new Date(Date.now() - ms).toISOString();
  const base = { backend: "cloudformation", kind: "api", plan, app: plan.app, startedAt: ago(60_000), outputs: {} };
  // The static site's uploaded copy, still there from before the restart.
  const siteCopy = path.join(home, "deploy-uploads", "dep_5a5a5a5a5a5a", "app");
  fs.mkdirSync(siteCopy, { recursive: true });
  fs.writeFileSync(path.join(siteCopy, "index.html"), "<h1>hi</h1>");
  fs.writeFileSync(path.join(home, "deployments.json"), JSON.stringify([
    { ...base, deploymentId: "dep_aaaaaaaaaaaa", status: "packaging" },
    { ...base, deploymentId: "dep_bbbbbbbbbbbb", status: "running", stackName: "sealeye-b", stackStatus: "CREATE_IN_PROGRESS" },
    { ...base, deploymentId: "dep_cccccccccccc", status: "running", stackName: "sealeye-c" },
    { ...base, deploymentId: "dep_dddddddddddd", status: "destroying", stackName: "sealeye-d" },
    { ...base, deploymentId: "dep_eeeeeeeeeeee", status: "succeeded", stackName: "sealeye-e" },
    // Not this platform's to act on: each stays as it was, and nothing is asked of AWS.
    { ...base, deploymentId: "dep_ffffffffffff", status: "running", stackName: "sealeye-f", stackStatus: "CREATE_IN_PROGRESS", importedAt: ago(1000) },
    { ...base, deploymentId: "dep_000000000aaa", status: "destroying", stackName: "sealeye-g", startedAt: ago(2 * 24 * 3600_000) },
    { ...base, deploymentId: "dep_000000000bbb", status: "destroying", stackName: "sealeye-b", startedAt: ago(3600_000) },
    // A tear-down asked for a minute ago, of a deployment from days ago: still ours.
    { ...base, deploymentId: "dep_000000000ccc", status: "destroying", stackName: "sealeye-h", startedAt: ago(3 * 24 * 3600_000), destroyRequestedBy: { surface: "cli", at: ago(60_000) } },
    // A failed first create whose removal was under way: waited for again, then open.
    { ...base, deploymentId: "dep_000000000ddd", status: "failed", stackName: "sealeye-x", cleaningUp: true, cleanupStartedAt: ago(60_000), failureReason: "it rolled back" },
    // A static site whose stack had finished, seen under way, while its files were syncing.
    { ...base, deploymentId: "dep_5a5a5a5a5a5a", kind: "static", plan: staticPlan, app: staticPlan.app, status: "running",
      stackName: "sealeye-s", stackStatus: "CREATE_COMPLETE", sawInProgress: true, source: "upload" }
  ]));

  const port = 4700 + Math.floor(Math.random() * 90);
  const api = `http://localhost:${port}`;
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PORT: String(port), HOME: home, SEALEYE_HOME: home, SEALEYE_TEST_POLL_MS: "20", SEALEYE_AUTH: "off" };
  delete env.DATABASE_URL;
  const server = spawn(process.execPath, ["api/server.js"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout.on("data", d => (log += d));
  server.stderr.on("data", d => (log += d));

  try {
    const status = async id => (await (await fetch(`${api}/deployments/${id}`)).json());
    let records = {};
    for (let i = 0; i < 100; i++) {
      try {
        for (const id of ["dep_aaaaaaaaaaaa", "dep_bbbbbbbbbbbb", "dep_cccccccccccc", "dep_dddddddddddd", "dep_eeeeeeeeeeee"]) records[id] = await status(id);
        for (const id of ["dep_ffffffffffff", "dep_000000000aaa", "dep_000000000bbb", "dep_5a5a5a5a5a5a"]) records[id] = await status(id);
        for (const id of ["dep_000000000ccc", "dep_000000000ddd"]) records[id] = await status(id);
        if (["dep_bbbbbbbbbbbb", "dep_cccccccccccc", "dep_dddddddddddd", "dep_5a5a5a5a5a5a", "dep_000000000ccc"].every(id => !["running", "destroying"].includes(records[id].status)) &&
          !records.dep_000000000ddd.cleaningUp) break;
      } catch {}
      await new Promise(r => setTimeout(r, 100));
    }

    assert.equal(records.dep_aaaaaaaaaaaa.status, "failed", log);
    assert.match(records.dep_aaaaaaaaaaaa.failureReason, /restarted while getting this deployment ready/);

    assert.equal(records.dep_bbbbbbbbbbbb.status, "succeeded", "seen under way before, so the final status is its own");
    assert.equal(records.dep_bbbbbbbbbbbb.outputs.ApiUrl, "https://b.example");

    assert.equal(records.dep_cccccccccccc.status, "failed", "never seen under way: not claimed as a success");
    assert.match(records.dep_cccccccccccc.failureReason, /cannot say it happened/);

    assert.equal(records.dep_dddddddddddd.status, "destroyed");
    assert.equal(records.dep_000000000ccc.status, "destroyed", "a tear-down's age counts from when it was asked for");
    assert.equal(records.dep_000000000ddd.cleaningUp, false);
    assert.equal(records.dep_000000000ddd.status, "failed");
    assert.equal(records.dep_000000000ddd.rolledBackStackRemoved, true);

    assert.equal(records.dep_eeeeeeeeeeee.status, "succeeded", "a finished deployment is left alone");
    for (const id of ["dep_aaaaaaaaaaaa", "dep_bbbbbbbbbbbb", "dep_cccccccccccc", "dep_dddddddddddd", "dep_eeeeeeeeeeee", "dep_5a5a5a5a5a5a"]) {
      assert.equal(records[id].interrupted, undefined, id);
    }
    assert.match(log, /dep_bbbbbbbbbbbb: watching the stack again/);

    assert.equal(records.dep_5a5a5a5a5a5a.status, "succeeded", `finished after the restart, files and all\n${log}`);
    const awsCalls = fs.readFileSync(calls, "utf8");
    assert.match(awsCalls, /s3 sync \S+dep_5a5a5a5a5a5a\/app s3:\/\/site-bucket/);
    for (let i = 0; i < 40 && fs.existsSync(siteCopy); i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(!fs.existsSync(siteCopy), "the uploaded copy is removed once it ended");

    for (const [id, why] of [["dep_ffffffffffff", /imported/], ["dep_000000000aaa", /older than a day/], ["dep_000000000bbb", /a newer deployment/]]) {
      assert.equal(records[id].interrupted, true, id);
      assert.match(log, new RegExp(`${id}: left as it was \\(${why.source}`));
    }
    assert.equal(records.dep_000000000bbb.status, "destroying", "the newer deployment on sealeye-b is not torn down");
    assert.doesNotMatch(awsCalls, /sealeye-f|sealeye-g/);
    assert.doesNotMatch(awsCalls, /delete-stack/);
  } finally {
    server.kill();
  }
});
