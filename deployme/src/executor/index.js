// src/executor/index.js
// The deployment lifecycle: compose -> package -> deploy -> poll until CloudFormation
// says it is done. Status is never invented; it mirrors the stack.
import { compose } from "./compose.js";
import { stage } from "./package.js";
import { deploy, describe, firstFailure } from "./cfn.js";
import { putDeployment } from "../store.js";

const POLL_MS = 5000;
// Once the deploy command has exited, describe() is the only way to learn anything.
// If it will not answer either, give up rather than poll forever.
const MAX_POLL_ERRORS = 3;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();

/** The CLAUDE.md status map. null means the stack does not exist. */
export function mapStackStatus(stackStatus) {
  if (!stackStatus) return null;
  if (/ROLLBACK|FAILED/.test(stackStatus)) return "failed";
  if (stackStatus === "CREATE_COMPLETE" || stackStatus === "UPDATE_COMPLETE") return "succeeded";
  if (stackStatus === "DELETE_COMPLETE") return "destroyed";
  if (stackStatus === "DELETE_IN_PROGRESS") return "destroying";
  return "running"; // CREATE_IN_PROGRESS, UPDATE_IN_PROGRESS, *_CLEANUP_IN_PROGRESS, REVIEW_IN_PROGRESS
}

/**
 * Drive one deployment to a terminal state, mutating `record` in place as it goes.
 * Returns the record; never rejects — a thrown error becomes status "failed".
 */
export async function startDeployment(record, plan, appPath) {
  const set = (status, patch = {}) => {
    Object.assign(record, { status, ...patch });
    return putDeployment(record);
  };
  const fail = reason => set("failed", { failureReason: reason, finishedAt: now(), step: null });

  let composed;
  try {
    set("packaging", { step: "Reading your plan and picking the AWS template" });

    composed = compose(plan, record.deploymentId);
    Object.assign(record, {
      kind: composed.kind,
      stackName: composed.stackName,
      templatePath: composed.templatePath,
      parameters: composed.parameters
    });
    putDeployment(record);

    const artifactKey = await stage(appPath, record.deploymentId, composed, line =>
      set(record.status, { step: line })
    );
    if (artifactKey) record.artifactKey = artifactKey;

    set("running", { step: `Creating your AWS environment (stack ${composed.stackName})` });
  } catch (err) {
    return fail(err.message);
  }

  // Fire and forget: the poll below, not this promise, is the source of truth.
  let childExited = false;
  let childResult = null;
  deploy(composed)
    .catch(err => ({ ok: false, code: -1, stdout: "", stderr: err.message }))
    .then(result => {
      childResult = result;
      childExited = true;
    });

  let pollErrors = 0;
  // Set once this deployment's own operation is visibly under way. Until then a
  // terminal stack status belongs to a previous deploy, not to this one.
  let sawInProgress = false;

  while (true) {
    await sleep(POLL_MS);

    let described;
    try {
      described = await describe(composed.stackName);
    } catch (err) {
      // A transient describe failure is not a deployment failure. Note it and retry,
      // unless the deploy is over and this is all we are going to get.
      record.pollError = err.message;
      putDeployment(record);
      if (childExited && ++pollErrors >= MAX_POLL_ERRORS) {
        return fail(`${err.message}${childResult?.stderr ? `\n${childResult.stderr.trim()}` : ""}`);
      }
      continue;
    }
    pollErrors = 0;
    record.pollError = null;
    record.stackStatus = described.status;

    const mapped = mapStackStatus(described.status);
    if (Object.keys(described.outputs).length) record.outputs = described.outputs;
    if (/IN_PROGRESS/.test(described.status || "")) sawInProgress = true;

    // A terminal stack status is only ours once this deployment's operation has
    // started, or once the AWS CLI has exited. Otherwise a redeploy would report the
    // previous run's CREATE_COMPLETE (or ROLLBACK) a second after it began.
    // record.stackStatus always carries the literal CloudFormation status.
    if (!childExited && !sawInProgress) {
      set("running");
      continue;
    }

    if (mapped === "succeeded") {
      return set("succeeded", {
        outputs: described.outputs,
        failureReason: null,
        finishedAt: now(),
        step: null
      });
    }

    if (mapped === "failed") {
      const reason =
        (await firstFailure(composed.stackName)) ||
        described.statusReason ||
        childResult?.stderr?.trim() ||
        `stack ${described.status}`;
      return fail(reason);
    }

    if (mapped === null) {
      // No stack. Either the command exited before creating one, or one existed a
      // moment ago and something outside this deployment deleted it.
      if (!childExited) {
        set("running");
        continue;
      }
      return fail(
        childResult?.stderr?.trim() || "the deploy command exited without creating a stack"
      );
    }

    // Still moving (cleanup, or a delete someone started elsewhere). Keep polling.
    set(mapped === "destroying" ? "destroying" : "running");
  }
}
