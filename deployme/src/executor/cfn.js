// src/executor/cfn.js
// Every CloudFormation call the executor makes, shelling out to the AWS CLI.
// No SDK dependency; JSON in, JSON out.
import { spawn } from "node:child_process";

import { loadEnv } from "./env.js";

/** Hard rule: ca-central-1. DEPLOYME_REGION is an explicit opt-out, nothing else. */
export function region() {
  loadEnv();
  return process.env.DEPLOYME_REGION || "ca-central-1";
}

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
