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
  fs.writeFileSync(path.join(bin, "aws"), `#!/bin/sh
name=""; prev=""
for a in "$@"; do [ "$prev" = "--stack-name" ] && name="$a"; prev="$a"; done
case "$2" in
  describe-stacks)
    case "$name" in
      sealeye-b) echo '{"Stacks":[{"StackStatus":"CREATE_COMPLETE","Outputs":[{"OutputKey":"ApiUrl","OutputValue":"https://b.example"}]}]}' ;;
      sealeye-c) echo '{"Stacks":[{"StackStatus":"UPDATE_COMPLETE","Outputs":[]}]}' ;;
      *) echo "Stack with id $name does not exist" >&2; exit 254 ;;
    esac ;;
  describe-stack-events) echo '{"StackEvents":[]}' ;;
  *) echo '{}' ;;
esac
`, { mode: 0o755 });

  const plan = YAML.parse(fs.readFileSync(path.join(root, "plans", "api-plan.yaml"), "utf8"));
  const base = { backend: "cloudformation", kind: "api", plan, app: plan.app, startedAt: "2026-10-10T10:00:00Z", outputs: {} };
  fs.writeFileSync(path.join(home, "deployments.json"), JSON.stringify([
    { ...base, deploymentId: "dep_aaaaaaaaaaaa", status: "packaging" },
    { ...base, deploymentId: "dep_bbbbbbbbbbbb", status: "running", stackName: "sealeye-b", stackStatus: "CREATE_IN_PROGRESS" },
    { ...base, deploymentId: "dep_cccccccccccc", status: "running", stackName: "sealeye-c" },
    { ...base, deploymentId: "dep_dddddddddddd", status: "destroying", stackName: "sealeye-d" },
    { ...base, deploymentId: "dep_eeeeeeeeeeee", status: "succeeded", stackName: "sealeye-e" }
  ]));

  const port = 4700 + Math.floor(Math.random() * 90);
  const api = `http://localhost:${port}`;
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PORT: String(port), HOME: home, SEALEYE_HOME: home, SEALEYE_TEST_POLL_MS: "20" };
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
        if (["dep_bbbbbbbbbbbb", "dep_cccccccccccc", "dep_dddddddddddd"].every(id => !["running", "destroying"].includes(records[id].status))) break;
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

    assert.equal(records.dep_eeeeeeeeeeee.status, "succeeded", "a finished deployment is left alone");
    for (const r of Object.values(records)) assert.equal(r.interrupted, undefined);
    assert.match(log, /dep_bbbbbbbbbbbb: watching the stack again/);
  } finally {
    server.kill();
  }
});
