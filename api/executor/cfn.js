// src/executor/cfn.js
// Every CloudFormation call the executor makes, plus the handful of S3 calls that go
// with them, shelling out to the AWS CLI. No SDK dependency; JSON in, JSON out.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { region } from "../../core/config.js";
import { normalizeTemplate } from "./package.js";

// region() lives in core/config.js so the CLI can read it without importing the API.
export { region };

/** Spawn `aws ...` and resolve when it exits. Never rejects on a non-zero exit. */
function runAws(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("aws", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));
    child.on("error", e => reject(new Error(`aws: ${e.message} (is the AWS CLI installed?)`)));
    child.on("close", code => resolve({ ok: code === 0, code, stdout, stderr }));
  });
}

/** runAws for the store calls: a missing AWS CLI is a failure to report, not a throw. */
const tryAws = args => runAws(args).catch(err => ({ ok: false, code: -1, stdout: "", stderr: err.message }));

// ---------------------------------------------------------------------------------
// An app's settings in the organization's store (PHASE2-PLAN Part B, D3): Parameter
// Store, encrypted, one folder per team's app (api/executor/settings.js). Values go in
// through a private temporary file and never come back out through here: listing asks for names
// and dates only.

/** The settings in a folder: names and when each last changed. Never values. */
export async function listStoredSettings(folder) {
  const r = await tryAws([
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

/**
 * Store one setting, encrypted, replacing any earlier value.
 *
 * The value reaches the AWS CLI in a file only the API can read, in a folder of its own,
 * removed as soon as the call ends; never on a command line. Not on standard input: Node
 * gives a child a socket there, which the CLI cannot open as /dev/stdin, and it reads its
 * input file more than once, which a pipe cannot be (Oct 12, 2026, the first live use).
 */
export async function putStoredSetting(name, value) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-setting-"));
  const file = path.join(dir, "input.json");
  try {
    fs.chmodSync(dir, 0o700);
    fs.writeFileSync(file, JSON.stringify({ Name: name, Value: value, Type: "SecureString", Overwrite: true }), { mode: 0o600 });
    const r = await tryAws(["ssm", "put-parameter", "--cli-input-json", `file://${file}`, "--region", region(), "--output", "json"]);
    return r.ok ? { ok: true } : { ok: false, error: errorName(r.stderr, value) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Remove one setting. One that is not there is not an error. */
export async function deleteStoredSetting(name) {
  const r = await tryAws(["ssm", "delete-parameter", "--name", name, "--region", region()]);
  if (r.ok || /ParameterNotFound/.test(r.stderr)) return { ok: true, existed: r.ok };
  return { ok: false, error: firstLine(r.stderr) };
}

// The CLI's own error line, for calls that are given no value (listing, removing).
const firstLine = text => String(text || "").trim().split("\n")[0] || "the AWS CLI gave no reason";
// For a call that carried a value: AWS's error name alone, such as AccessDeniedException,
// since AWS's own messages can quote the value they refused. The CLI's own complaint,
// made before anything reached AWS, is shown when it does not contain the value.
function errorName(text, value) {
  const s = String(text || "");
  const name = /An error occurred \(([A-Za-z0-9]+)\)/.exec(s)?.[1];
  if (name) return name;
  const line = s.trim().split("\n")[0].slice(0, 200);
  return line && !(value && s.includes(value)) ? `the AWS CLI said: ${line}` : "the store refused it, without a reason that can be shown";
}

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
 * Whether an artifact an earlier deployment uploaded is still in the bucket, so a
 * deployment of it again (PHASE2-PLAN Step 14) fails before anything changes, not
 * halfway through CloudFormation. Reads the object's headers, never its bytes.
 * @returns {Promise<{ok: boolean, missing?: boolean, error?: string}>}
 */
export async function artifactExists(bucket, key) {
  const r = await tryAws(["s3api", "head-object", "--bucket", bucket, "--key", key, "--region", region(), "--output", "json"]);
  if (r.ok) return { ok: true };
  const text = String(r.stderr || "");
  if (/\(404\)|Not Found|NoSuchKey/.test(text)) return { ok: false, missing: true };
  return { ok: false, error: firstLine(text) };
}

/**
 * An app's most recent log lines (PHASE2-PLAN Step 16): what its function wrote since
 * `sinceMs`, oldest first as CloudWatch gives them, at most `maxItems`. Read only.
 * @returns {Promise<{ok: true, events: {timestamp: number, message: string}[]} | {ok: false, missing?: boolean, error?: string}>}
 */
export async function recentLogs(logGroup, { sinceMs, maxItems = 2000 } = {}) {
  const r = await tryAws([
    "logs", "filter-log-events", "--log-group-name", logGroup,
    "--start-time", String(Math.floor(sinceMs)), "--max-items", String(maxItems),
    "--query", "events[].{timestamp: timestamp, message: message}",
    "--region", region(), "--output", "json"
  ]);
  if (!r.ok) {
    if (/ResourceNotFoundException/.test(r.stderr)) return { ok: false, missing: true };
    return { ok: false, error: firstLine(r.stderr) };
  }
  try {
    return { ok: true, events: JSON.parse(r.stdout || "[]") || [] };
  } catch {
    return { ok: false, error: "the log service's answer was not JSON" };
  }
}

/**
 * Whether an app's function is paused: its reserved concurrency is zero, so it takes no
 * requests (PHASE2-PLAN D7). Read from AWS each time, never assumed.
 * @returns {Promise<{ok: true, paused: boolean} | {ok: false, missing?: boolean, error: string}>}
 */
export async function functionPaused(functionName) {
  const r = await tryAws(["lambda", "get-function-concurrency", "--function-name", functionName, "--region", region(), "--output", "json"]);
  if (!r.ok) return { ok: false, missing: /ResourceNotFoundException/.test(r.stderr), error: firstLine(r.stderr) };
  try {
    return { ok: true, paused: (JSON.parse(r.stdout || "{}") || {}).ReservedConcurrentExecutions === 0 };
  } catch {
    return { ok: false, error: "the function service's answer was not JSON" };
  }
}

/** Pause (reserved concurrency zero) or resume (no reservation) an app's function. */
export async function setFunctionPaused(functionName, paused) {
  const r = await tryAws(paused
    ? ["lambda", "put-function-concurrency", "--function-name", functionName, "--reserved-concurrent-executions", "0", "--region", region(), "--output", "json"]
    : ["lambda", "delete-function-concurrency", "--function-name", functionName, "--region", region()]);
  return r.ok ? { ok: true } : { ok: false, error: firstLine(r.stderr) };
}

/**
 * Readings from an app's function over a window (PHASE2-PLAN Step 20): requests,
 * errors, refused requests, and the time its code took, per period and over the whole
 * window. What happened, never what it can take.
 * @param {string} functionName
 * @param {{ startMs: number, endMs: number, periodSec: number }} window
 * @returns {Promise<{ok: true, results: {Id: string, Timestamps: string[], Values: number[]}[]} | {ok: false, error: string}>}
 */
export async function functionMetrics(functionName, { startMs, endMs, periodSec }) {
  const whole = Math.max(60, Math.ceil((endMs - startMs) / 1000 / 60) * 60);
  const q = (id, metric, stat, period) => ({
    Id: id,
    MetricStat: { Metric: { Namespace: "AWS/Lambda", MetricName: metric, Dimensions: [{ Name: "FunctionName", Value: functionName }] }, Period: period, Stat: stat },
    ReturnData: true
  });
  const queries = [
    q("requests", "Invocations", "Sum", periodSec), q("errors", "Errors", "Sum", periodSec),
    q("refused", "Throttles", "Sum", periodSec), q("average", "Duration", "Average", periodSec), q("slowest", "Duration", "p95", periodSec),
    q("totalRequests", "Invocations", "Sum", whole), q("totalErrors", "Errors", "Sum", whole), q("totalRefused", "Throttles", "Sum", whole),
    q("totalAverage", "Duration", "Average", whole), q("totalSlowest", "Duration", "p95", whole)
  ];
  const r = await tryAws([
    "cloudwatch", "get-metric-data",
    "--start-time", new Date(startMs).toISOString(), "--end-time", new Date(endMs).toISOString(),
    "--metric-data-queries", JSON.stringify(queries),
    "--query", "MetricDataResults[].{Id: Id, Timestamps: Timestamps, Values: Values}",
    "--region", region(), "--output", "json"
  ]);
  if (!r.ok) return { ok: false, error: firstLine(r.stderr) };
  try {
    return { ok: true, results: JSON.parse(r.stdout || "[]") || [] };
  } catch {
    return { ok: false, error: "the metrics service's answer was not JSON" };
  }
}

/**
 * What the account spent, by the sealeye:app tag (and sealeye:team, for every team), a
 * day at a time between two dates (PHASE2-PLAN Step 20). Cost Explorer answers from
 * us-east-1 whatever the region, about a day behind, and charges for each call, so the
 * caller keeps the answer for a while.
 * @param {{ start: string, end: string, team?: string|null }} range  YYYY-MM-DD, end exclusive
 * @returns {Promise<{ok: true, groups: {keys: string[], amount: number, unit: string}[]} | {ok: false, error: string}>}
 */
export async function costsByTag({ start, end, team = null }) {
  const groups = [];
  let token = null;
  for (let page = 0; page < 10; page++) {
    const args = [
      "ce", "get-cost-and-usage", "--time-period", `Start=${start},End=${end}`, "--granularity", "DAILY",
      "--metrics", "UnblendedCost",
      "--group-by", ...(team ? ["Type=TAG,Key=sealeye:app"] : ["Type=TAG,Key=sealeye:team", "Type=TAG,Key=sealeye:app"]),
      ...(team ? ["--filter", JSON.stringify({ Tags: { Key: "sealeye:team", Values: [team] } })] : []),
      ...(token ? ["--next-page-token", token] : []),
      "--region", "us-east-1", "--output", "json"
    ];
    const r = await tryAws(args);
    if (!r.ok) return { ok: false, error: firstLine(r.stderr) };
    let body;
    try { body = JSON.parse(r.stdout || "{}"); } catch { return { ok: false, error: "the cost service's answer was not JSON" }; }
    for (const day of body.ResultsByTime || []) {
      for (const g of day.Groups || []) {
        groups.push({ keys: g.Keys || [], amount: Number(g.Metrics?.UnblendedCost?.Amount || 0), unit: g.Metrics?.UnblendedCost?.Unit || "USD" });
      }
    }
    token = body.NextPageToken || null;
    if (!token) break;
  }
  return { ok: true, groups };
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
