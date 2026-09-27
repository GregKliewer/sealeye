// src/doctor.js
// Preflight for a demo machine on a strange network. Every check answers one question
// a person can act on, and a check that fails says what to do rather than what went
// wrong internally. Nothing here creates anything, and nothing here prints a secret:
// a key is present or absent, and an account is its last four digits.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { repoRoot, loadEnv, loadUserConfig } from "./executor/env.js";
import { region } from "./executor/cfn.js";

const TIMEOUT_MS = 15_000;

/** Run a command, never throwing. A missing binary is a result, not an exception. */
function run(cmd, args, { timeout = TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    let done = false;
    const finish = r => { if (!done) { done = true; resolve(r); } };

    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));
    child.on("error", e => finish({ ok: false, code: -1, stdout: "", stderr: e.message, missing: e.code === "ENOENT" }));
    child.on("close", code => finish({ ok: code === 0, code, stdout, stderr, missing: false }));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, code: -1, stdout, stderr: `no answer within ${timeout / 1000} seconds`, missing: false });
    }, timeout);
    timer.unref?.();
  });
}

const ok = (name, detail) => ({ name, ok: true, detail });
const bad = (name, detail, fix) => ({ name, ok: false, detail, fix });

/** The last four digits only. An account id is not something to put on a screen. */
const lastFour = id => `ending ${String(id).slice(-4)}`;

async function checkApi(apiBaseUrl) {
  const name = "Platform API";
  try {
    const res = await fetch(`${apiBaseUrl}/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return bad(name, `${apiBaseUrl} answered ${res.status}`, `Restart it: cd deployme && npm start`);
    const body = await res.json();
    return ok(name, `${apiBaseUrl}, version ${body.version}, ${body.deployments} records`);
  } catch (err) {
    return bad(name, `${apiBaseUrl} did not answer (${err.message})`, `Start it: cd deployme && npm start`);
  }
}

function checkNode() {
  const name = "Node";
  const major = Number(process.versions.node.split(".")[0]);
  return major >= 20
    ? ok(name, `v${process.versions.node}`)
    : bad(name, `v${process.versions.node}`, "Install Node 20 or newer, then run this again.");
}

async function checkTool(binary, args, fix) {
  const r = await run(binary, args);
  if (r.missing) return bad(binary, "not on the PATH", fix);
  if (!r.ok) return bad(binary, r.stderr.trim().split("\n")[0] || `exited ${r.code}`, fix);
  return ok(binary, (r.stdout || r.stderr).trim().split("\n")[0]);
}

async function checkCredentials() {
  const name = "AWS credentials";
  const r = await run("aws", ["sts", "get-caller-identity", "--output", "json"]);
  if (r.missing) return bad(name, "the aws CLI is not on the PATH", "Install the AWS CLI, then run this again.");
  if (!r.ok) {
    return bad(name, r.stderr.trim().split("\n")[0] || `exited ${r.code}`, "Sign in again: aws sso login, or set AWS_PROFILE.");
  }

  let account;
  try {
    account = JSON.parse(r.stdout).Account;
  } catch {
    return bad(name, "get-caller-identity returned something that is not JSON", "Check the AWS CLI is a supported version.");
  }

  loadEnv();
  const expected = process.env.DEPLOYME_ACCOUNT;
  if (!expected) return ok(name, `signed in to the account ${lastFour(account)}`);

  return expected === account
    ? ok(name, `signed in to the account ${lastFour(account)}, which is the one DEPLOYME_ACCOUNT names`)
    : bad(
        name,
        `signed in to the account ${lastFour(account)}, but DEPLOYME_ACCOUNT names ${lastFour(expected)}`,
        "Switch profile, or correct DEPLOYME_ACCOUNT in .env."
      );
}

function checkRegion() {
  loadEnv();
  const set = process.env.DEPLOYME_REGION;
  const r = region();
  if (!set) return ok("Region", `${r}`);
  return r === "ca-central-1"
    ? ok("Region", `${r} (DEPLOYME_REGION is set to it)`)
    : ok("Region", `${r}, because DEPLOYME_REGION is set. The demo was built in ca-central-1.`);
}

async function checkBucket() {
  const name = "Artifact bucket";
  loadEnv();
  const bucket = process.env.DEPLOYME_BUCKET;
  if (!bucket) return bad(name, "DEPLOYME_BUCKET is not set", "Set DEPLOYME_BUCKET in .env at the repo root.");

  const r = await run("aws", ["s3api", "head-bucket", "--bucket", bucket, "--region", region()]);
  return r.ok
    ? ok(name, bucket)
    : bad(name, `${bucket} did not answer (${r.stderr.trim().split("\n")[0] || `exited ${r.code}`})`, "Check the bucket name and that this account can reach it.");
}

async function checkAdapterLayer() {
  const name = "Adapter layer";
  loadEnv();
  const version = process.env.DEPLOYME_LWA_VERSION;
  if (!version) return bad(name, "DEPLOYME_LWA_VERSION is not set", "Set DEPLOYME_LWA_VERSION in .env at the repo root.");

  // The account and layer name are the ones in templates/http_api_serverless.yaml.
  const template = fs.readFileSync(path.join(repoRoot, "templates", "http_api_serverless.yaml"), "utf8");
  const match = /arn:aws:lambda:\$\{AWS::Region\}:(\d+):layer:([A-Za-z0-9-]+):/.exec(template);
  if (!match) return bad(name, "the adapter layer arn is not in templates/http_api_serverless.yaml", "Check the template has not been edited.");

  const arn = `arn:aws:lambda:${region()}:${match[1]}:layer:${match[2]}:${version}`;
  const r = await run("aws", ["lambda", "get-layer-version-by-arn", "--arn", arn, "--region", region(), "--output", "json"]);

  return r.ok
    ? ok(name, `${match[2]} version ${version} in ${region()}`)
    : bad(name, `${match[2]} version ${version} is not reachable in ${region()}`, "Check DEPLOYME_LWA_VERSION, and that the layer is published in this region.");
}

function checkModelKey() {
  const name = "ANTHROPIC_API_KEY";
  loadEnv();
  loadUserConfig();
  // Present or absent. Never its value, and never a request to the model.
  return process.env.ANTHROPIC_API_KEY
    ? ok(name, "present")
    : bad(name, "absent", `Put it in the environment or in ${path.join("~", ".deployme", "config")}. Only the interview needs it.`);
}

async function checkNotifier() {
  const name = "terminal-notifier";
  const r = await run("which", ["terminal-notifier"]);
  return r.ok
    ? ok(name, r.stdout.trim())
    : bad(
        name,
        "not on the PATH",
        "brew install terminal-notifier, then run it once so macOS asks. Under a Focus mode, add it to that mode's allowed apps and test one notification with the mode on."
      );
}

/** Every check, in the order a person would want them. */
export async function runDoctor({ apiBaseUrl }) {
  const checks = [
    await checkApi(apiBaseUrl),
    checkNode(),
    await checkTool("aws", ["--version"], "Install the AWS CLI, then run this again."),
    await checkTool("zip", ["-v"], "Install zip (it ships with macOS; on Linux, apt install zip)."),
    await checkTool("rsync", ["--version"], "Install rsync."),
    await checkCredentials(),
    checkRegion(),
    await checkBucket(),
    await checkAdapterLayer(),
    checkModelKey(),
    await checkNotifier()
  ];

  return { host: os.hostname(), checks, ok: checks.every(c => c.ok) };
}
