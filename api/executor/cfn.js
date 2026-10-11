// src/executor/cfn.js
// Every CloudFormation call the executor makes, plus the handful of S3 calls that go
// with them, shelling out to the AWS CLI. No SDK dependency; JSON in, JSON out.
import { spawn } from "node:child_process";

import { region } from "../../core/config.js";
import { normalizeTemplate } from "./package.js";

// region() lives in core/config.js so the CLI can read it without importing the API.
export { region };

/**
 * Spawn `aws ...` and resolve when it exits. Never rejects on a non-zero exit.
 * `input`, when given, is written to its standard input: how a setting's value reaches
 * the CLI without ever being on a command line, where any process could read it.
 */
function runAws(args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("aws", args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));
    child.on("error", e => reject(new Error(`aws: ${e.message} (is the AWS CLI installed?)`)));
    child.on("close", code => resolve({ ok: code === 0, code, stdout, stderr }));
    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

// ---------------------------------------------------------------------------------
// An app's settings in the organization's store (PHASE2-PLAN Part B, D3): Parameter
// Store, encrypted, one folder per team's app (api/executor/settings.js). Values go in
// through standard input and never come back out through here: listing asks for names
// and dates only.

/** The settings in a folder: names and when each last changed. Never values. */
export async function listStoredSettings(folder) {
  const r = await runAws([
    "ssm", "get-parameters-by-path", "--path", folder, "--no-with-decryption", "--region", region(),
    "--query", "Parameters[].{name: Name, changedAt: LastModifiedDate}", "--output", "json"
  ]);
  if (!r.ok) return { ok: false, error: firstLine(r.stderr) };
  try {
    const rows = JSON.parse(r.stdout || "[]") || [];
    return { ok: true, settings: rows.map(p => ({ name: String(p.name).slice(folder.length), changedAt: p.changedAt ? new Date(p.changedAt).toISOString() : null })) };
  } catch {
    return { ok: false, error: "the store's answer was not JSON" };
  }
}

/** Store one setting, encrypted, replacing any earlier value. */
export async function putStoredSetting(name, value) {
  const input = JSON.stringify({ Name: name, Value: value, Type: "SecureString", Overwrite: true });
  const r = await runAws(["ssm", "put-parameter", "--cli-input-json", "file:///dev/stdin", "--region", region(), "--output", "json"], { input });
  // AWS's validation messages can quote the value they refused, so a failure here is
  // reported by the error's name alone, never by its message.
  return r.ok ? { ok: true } : { ok: false, error: errorName(r.stderr) };
}

/** Remove one setting. One that is not there is not an error. */
export async function deleteStoredSetting(name) {
  const r = await runAws(["ssm", "delete-parameter", "--name", name, "--region", region()]);
  if (r.ok || /ParameterNotFound/.test(r.stderr)) return { ok: true, existed: r.ok };
  return { ok: false, error: firstLine(r.stderr) };
}

// The CLI's own error line, for calls that are given no value (listing, removing).
const firstLine = text => String(text || "").trim().split("\n")[0] || "the AWS CLI gave no reason";
// Only the error's name, such as AccessDeniedException, for a call that carried a value.
const errorName = text => /\(([A-Za-z]+(?:Exception|Error))\)/.exec(String(text || ""))?.[1] || "the store refused it";

/**
 * `aws cloudformation deploy` — runs in the background; the promise resolves when the
 * child exits. The CLI itself waits for the stack, so the exit is the end of the deploy.
 * Failure is reported through the resolved value, not a rejection: the authoritative
 * status comes from describe(), and stderr is only the fallback explanation.
 *
 * @returns {Promise<{ok: boolean, code: number, stdout: string, stderr: string}>}
 */
export function deploy({ templatePath, stackName, parameters }) {
  const args = [
    "cloudformation", "deploy",
    "--template-file", templatePath,
    "--stack-name", stackName,
    "--region", region(),
    "--capabilities", "CAPABILITY_NAMED_IAM",
    "--no-fail-on-empty-changeset"
  ];

  // Variadic, so it goes last.
  const overrides = Object.entries(parameters || {}).map(([k, v]) => `${k}=${v}`);
  if (overrides.length) args.push("--parameter-overrides", ...overrides);

  return runAws(args);
}

/**
 * `aws cloudformation delete-stack` — returns as soon as CloudFormation accepts the
 * request; the caller polls describe() for the rest.
 */
export function deleteStack(stackName) {
  return runAws(["cloudformation", "delete-stack", "--stack-name", stackName, "--region", region()]);
}

/**
 * Empty a bucket. CloudFormation will not delete a bucket with anything in it, so
 * this has to happen before delete-stack on the static path.
 */
export function emptyBucket(bucketName) {
  return runAws(["s3", "rm", `s3://${bucketName}`, "--recursive", "--region", region()]);
}

/**
 * Fill a bucket from a folder. `--delete` means a file the developer deleted stops
 * being served on the next deploy, so the site matches the folder rather than
 * accumulating. The folder is only ever read.
 */
export function syncSite(appPath, bucketName) {
  return runAws([
    "s3", "sync", appPath, `s3://${bucketName}`,
    "--delete",
    "--exclude", ".git/*",
    "--region", region()
  ]);
}

/**
 * Current stack status and outputs, read fresh.
 * @returns {Promise<{status: string|null, outputs: object, statusReason: string|null}>}
 *          status is null when the stack does not exist.
 */
export async function describe(stackName) {
  const r = await runAws([
    "cloudformation", "describe-stacks",
    "--stack-name", stackName,
    "--region", region(),
    "--output", "json"
  ]);

  if (!r.ok) {
    if (/does not exist/i.test(r.stderr)) return { status: null, outputs: {}, statusReason: null };
    throw new Error(`describe-stacks ${stackName} exited ${r.code}\n${r.stderr.trim()}`);
  }

  const stack = JSON.parse(r.stdout).Stacks?.[0];
  if (!stack) return { status: null, outputs: {}, statusReason: null };

  const outputs = {};
  for (const o of stack.Outputs || []) outputs[o.OutputKey] = o.OutputValue;

  return {
    status: stack.StackStatus,
    outputs,
    statusReason: stack.StackStatusReason || null
  };
}

/**
 * The first failure reason — the cause, not the cascade. Events come back newest
 * first, so they are reversed; "cancelled" entries are siblings that were abandoned
 * because of the real failure, so they are skipped. Pass `statuses` to look at a
 * different failure, e.g. DELETE_FAILED on a tear-down.
 * @returns {Promise<string|null>}
 */
export async function firstFailure(stackName, statuses = ["CREATE_FAILED", "UPDATE_FAILED"]) {
  const r = await runAws([
    "cloudformation", "describe-stack-events",
    "--stack-name", stackName,
    "--region", region(),
    "--output", "json"
  ]);
  if (!r.ok) return null;

  const failures = (JSON.parse(r.stdout).StackEvents || [])
    .filter(e => statuses.includes(e.ResourceStatus) && e.ResourceStatusReason)
    .reverse();

  if (!failures.length) return null;

  const cause = failures.find(e => !/cancelled/i.test(e.ResourceStatusReason)) || failures[0];
  return cause.ResourceStatusReason;
}

// ---------------------------------------------------------------------------
// Read-only, for the change record. Same style as describe() and firstFailure():
// a stack that does not answer is reported, never thrown.
// ---------------------------------------------------------------------------

/**
 * Every event on the stack, oldest first.
 * @returns {Promise<{ok: boolean, events: Array<{at: string, logicalId: string, type: string, status: string, reason: string|null}>, error: string|null}>}
 */
export async function stackEvents(stackName) {
  const r = await runAws([
    "cloudformation", "describe-stack-events",
    "--stack-name", stackName,
    "--region", region(),
    "--output", "json"
  ]);
  if (!r.ok) return { ok: false, events: [], error: r.stderr.trim() || `describe-stack-events exited ${r.code}` };

  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (err) {
    return { ok: false, events: [], error: `describe-stack-events returned something that is not JSON: ${err.message}` };
  }

  const events = (parsed.StackEvents || [])
    .map(e => ({
      at: e.Timestamp,
      logicalId: e.LogicalResourceId,
      type: e.ResourceType,
      status: e.ResourceStatus,
      reason: e.ResourceStatusReason || null
    }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));

  return { ok: true, events, error: null };
}

/**
 * The template the stack was built from, as CloudFormation kept it, normalized the
 * same way the executor normalizes before hashing so the two hashes compare.
 * @returns {Promise<{ok: boolean, template: string|null, error: string|null}>}
 */
export async function stackTemplate(stackName) {
  const r = await runAws([
    "cloudformation", "get-template",
    "--stack-name", stackName,
    "--template-stage", "Original",
    "--region", region(),
    "--output", "json"
  ]);
  if (!r.ok) return { ok: false, template: null, error: r.stderr.trim() || `get-template exited ${r.code}` };

  let body;
  try {
    body = JSON.parse(r.stdout).TemplateBody;
  } catch (err) {
    return { ok: false, template: null, error: `get-template returned something that is not JSON: ${err.message}` };
  }

  // YAML comes back as the original string; a JSON template comes back parsed.
  const text = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  return { ok: true, template: normalizeTemplate(text), error: null };
}

/**
 * The parameter keys the stack was given. Keys only: a NoEcho value is **** and is
 * not something the change record keeps anyway.
 * @returns {Promise<{ok: boolean, keys: string[], error: string|null}>}
 */
export async function stackParameters(stackName) {
  const r = await runAws([
    "cloudformation", "describe-stacks",
    "--stack-name", stackName,
    "--region", region(),
    "--output", "json"
  ]);
  if (!r.ok) return { ok: false, keys: [], error: r.stderr.trim() || `describe-stacks exited ${r.code}` };

  let stack;
  try {
    stack = JSON.parse(r.stdout).Stacks?.[0];
  } catch (err) {
    return { ok: false, keys: [], error: `describe-stacks returned something that is not JSON: ${err.message}` };
  }
  if (!stack) return { ok: false, keys: [], error: "the stack does not exist" };

  return { ok: true, keys: (stack.Parameters || []).map(p => p.ParameterKey).sort(), error: null };
}
