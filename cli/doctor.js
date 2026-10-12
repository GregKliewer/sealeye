// cli/doctor.js
// What this machine needs, checked. Every check answers one question a person can act
// on, and a check that fails says what to do rather than what went wrong internally.
// Nothing here creates anything, and nothing here prints a secret: a key is present or
// absent, and an account is its last four digits.
//
// Which checks run depends on where the API is. A developer using the hosted API needs
// only Node, the API and a token: the platform does the building. An API on this
// machine (localhost) builds from here, so it also needs the AWS CLI, credentials, the
// bucket, the adapter layer and the model key.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { repoRoot, loadEnv, loadUserConfig, region, setting, USER_CONFIG_HINT } from "../core/config.js";
import { seesInWords } from "../core/token.js";
import { whoAmI } from "./client.js";

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

/** Whether the API runs on this machine, as a laptop API does. */
export function isLocalApi(apiBaseUrl) {
  try {
    const host = new URL(apiBaseUrl).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || /^127\./.test(host);
  } catch {
    return false;
  }
}

async function checkApi(apiBaseUrl, local) {
  const name = "Platform API";
  const fix = local
    ? "Start it: npm start, from the repo root"
    : "Check this machine is online. If it still does not answer, tell your platform team.";
  try {
    const res = await fetch(`${apiBaseUrl}/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return bad(name, `${apiBaseUrl} answered ${res.status}`, fix);
    const body = await res.json();
    return ok(name, local ? `${apiBaseUrl}, version ${body.version}, ${body.deployments} records` : `${apiBaseUrl}, version ${body.version}`);
  } catch (err) {
    return bad(name, `${apiBaseUrl} did not answer (${err.message})`, fix);
  }
}

async function checkSignedIn(apiBaseUrl) {
  const name = "Signed in";
  if (!setting("TOKEN")) return bad(name, "no token on this machine", "Run sealeye login with the token your platform team gave you.");
  try {
    const me = await whoAmI({ apiBaseUrl });
    return me.auth === "off" ? ok(name, "this platform does not ask who is calling") : ok(name, `${me.name} (${me.email}), ${seesInWords(me)}`);
  } catch (err) {
    return bad(name, err.message, "Ask your platform team for a new token, then run sealeye login.");
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
  const expected = setting("ACCOUNT");
  if (!expected) return ok(name, `signed in to the account ${lastFour(account)}`);

  return expected === account
    ? ok(name, `signed in to the account ${lastFour(account)}, which is the one SEALEYE_ACCOUNT names`)
    : bad(
        name,
        `signed in to the account ${lastFour(account)}, but SEALEYE_ACCOUNT names ${lastFour(expected)}`,
        "Switch profile, or correct SEALEYE_ACCOUNT in .env."
      );
}

function checkRegion() {
  loadEnv();
  const set = setting("REGION");
  const r = region();
  if (!set) return ok("Region", `${r}`);
  return r === "ca-central-1"
    ? ok("Region", `${r} (SEALEYE_REGION is set to it)`)
    : ok("Region", `${r}, because SEALEYE_REGION is set. seaLeye is built for ca-central-1.`);
}

async function checkBucket() {
  const name = "Artifact bucket";
  loadEnv();
  const bucket = setting("BUCKET");
  if (!bucket) return bad(name, "SEALEYE_BUCKET is not set", "Set SEALEYE_BUCKET in .env at the repo root.");

  const r = await run("aws", ["s3api", "head-bucket", "--bucket", bucket, "--region", region()]);
  return r.ok
    ? ok(name, bucket)
    : bad(name, `${bucket} did not answer (${r.stderr.trim().split("\n")[0] || `exited ${r.code}`})`, "Check the bucket name and that this account can reach it.");
}

async function checkAdapterLayer() {
  const name = "Adapter layer";
  loadEnv();
  const version = setting("LWA_VERSION");
  if (!version) return bad(name, "SEALEYE_LWA_VERSION is not set", "Set SEALEYE_LWA_VERSION in .env at the repo root.");

  // The account and layer name are the ones in templates/http_api_serverless.yaml.
  const template = fs.readFileSync(path.join(repoRoot, "templates", "http_api_serverless.yaml"), "utf8");
  const match = /arn:aws:lambda:\$\{AWS::Region\}:(\d+):layer:([A-Za-z0-9-]+):/.exec(template);
  if (!match) return bad(name, "the adapter layer arn is not in templates/http_api_serverless.yaml", "Check the template has not been edited.");

  const arn = `arn:aws:lambda:${region()}:${match[1]}:layer:${match[2]}:${version}`;
  const r = await run("aws", ["lambda", "get-layer-version-by-arn", "--arn", arn, "--region", region(), "--output", "json"]);

  return r.ok
    ? ok(name, `${match[2]} version ${version} in ${region()}`)
    : bad(name, `${match[2]} version ${version} is not reachable in ${region()}`, "Check SEALEYE_LWA_VERSION, and that the layer is published in this region.");
}

// An API on this machine gives every function role the platform's boundary, and asks
// the settings store before each API deploy (PHASE2-PLAN Part B).
function checkBoundary() {
  const name = "Function boundary";
  loadEnv();
  const arn = setting("FUNCTION_BOUNDARY_ARN");
  if (!arn) return bad(name, "SEALEYE_FUNCTION_BOUNDARY_ARN is not set", "Set it in .env at the repo root to the deploy-role stack's FunctionBoundaryArn output (deploy/README.md).");
  return /^arn:aws:iam::\d{12}:policy\/.+/.test(arn) ? ok(name, arn.replace(/::\d{8}(\d{4}):/, "::\u2026$1:")) : bad(name, "SEALEYE_FUNCTION_BOUNDARY_ARN is not a policy ARN", "Copy the deploy-role stack's FunctionBoundaryArn output exactly.");
}

function checkModelKey() {
  const name = "ANTHROPIC_API_KEY";
  loadEnv();
  loadUserConfig();
  // Present or absent. Never its value, and never a request to the model.
  return process.env.ANTHROPIC_API_KEY
    ? ok(name, "present")
    : bad(name, "absent", `Put it in the environment or in ${USER_CONFIG_HINT} on the machine the API runs on. The interview runs in the API and only the API needs it.`);
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

/**
 * A notice when a deploy finishes, on a Mac. Nice to have, so with the hosted API its
 * absence is advice, not a failure.
 */
async function checkNotice() {
  const name = "Notices";
  if (process.platform !== "darwin") return ok(name, "not on a Mac: follow a deploy with sealeye watch");
  const r = await run("which", ["terminal-notifier"]);
  return r.ok
    ? ok(name, "a notice when a deploy finishes")
    : ok(name, "none when a deploy finishes; brew install terminal-notifier for one, or follow it with sealeye watch");
}

/**
 * Every check this machine needs, in the order a person would want them.
 * @param {{ apiBaseUrl: string, local?: boolean }} options  local: the API runs here
 */
export async function runDoctor({ apiBaseUrl, local = isLocalApi(apiBaseUrl) }) {
  if (!local) {
    const checks = [await checkApi(apiBaseUrl, false), await checkSignedIn(apiBaseUrl), checkNode(), await checkNotice()];
    return { host: os.hostname(), local: false, checks, ok: checks.every(c => c.ok) };
  }

  const checks = [
    await checkApi(apiBaseUrl, true),
    await checkSignedIn(apiBaseUrl),
    checkNode(),
    await checkTool("aws", ["--version"], "Install the AWS CLI, then run this again."),
    await checkTool("zip", ["-v"], "Install zip (it ships with macOS; on Linux, apt install zip)."),
    await checkTool("rsync", ["--version"], "Install rsync."),
    await checkCredentials(),
    checkRegion(),
    await checkBucket(),
    await checkAdapterLayer(),
    checkBoundary(),
    checkModelKey(),
    await checkNotifier()
  ];

  return { host: os.hostname(), local: true, checks, ok: checks.every(c => c.ok) };
}
