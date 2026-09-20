// src/executor/index.js
// The deployment lifecycle: compose -> package -> deploy -> poll until CloudFormation
// says it is done. Status is never invented; it mirrors the stack.
import { compose } from "./compose.js";
import { stage, cleanStage } from "./package.js";
import { deploy, describe, firstFailure, deleteStack, emptyBucket, syncSite } from "./cfn.js";
import { renderReport } from "./report.js";
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
      // The static stack is an empty bucket until the developer's files are in it.
      // Nothing is succeeded until the site actually serves something, so the upload
      // happens before the status changes, not after.
      if (record.kind === "static") {
        const bucket = described.outputs.BucketName;
        if (!bucket) {
          return fail("the stack came up without a BucketName output, so there is nowhere to put your files");
        }

        set("running", { step: `Uploading your files to ${bucket}` });
        const synced = await syncSite(appPath, bucket);
        if (!synced.ok) {
          return fail(
            `could not upload your files to s3://${bucket}: ${synced.stderr.trim() || `exit ${synced.code}`}`
          );
        }
        record.syncedFrom = appPath;
      }

      set("succeeded", {
        outputs: described.outputs,
        failureReason: null,
        finishedAt: now(),
        step: null
      });

      // A report that will not render is a reporting problem, not a failed deployment:
      // the environment is up either way, and saying otherwise would be a lie.
      try {
        record.report = renderReport(record, plan);
      } catch (err) {
        record.reportError = err.message;
      }
      return putDeployment(record);
    }

    if (mapped === "failed") {
      // Read the reason before touching the stack: describe-stack-events goes away
      // with it.
      const reason =
        (await firstFailure(composed.stackName)) ||
        described.statusReason ||
        childResult?.stderr?.trim() ||
        `stack ${described.status}`;

      // ROLLBACK_COMPLETE is a dead stack — a create that failed and undid itself.
      // CloudFormation will not update it and will not create over it, so leaving it
      // there means every later deploy fails for a reason that is no longer the real
      // one. Remove it so the next attempt starts clean.
      // UPDATE_ROLLBACK_COMPLETE is deliberately not touched: that stack is the
      // developer's previous environment, still up and still serving.
      if (described.status === "ROLLBACK_COMPLETE") {
        set("failed", { step: `Removing the failed stack ${composed.stackName} so you can deploy again` });
        const removed = await deleteStack(composed.stackName);
        record.rolledBackStackRemoved = removed.ok;
        if (!removed.ok) {
          record.cleanupError = removed.stderr.trim() || `delete-stack exited ${removed.code}`;
        }
      }

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

/**
 * Tear down everything this deployment created, then throw away the local build
 * artifacts. Mutates `record` in place; never rejects.
 */
export async function startDestroy(record) {
  const set = (status, patch = {}) => {
    Object.assign(record, { status, ...patch });
    return putDeployment(record);
  };
  const fail = reason => set("failed", { failureReason: reason, step: null });

  // Local artifacts are ours, not the developer's: clean them up whatever the stack does.
  const cleanLocal = () => {
    try {
      const removed = cleanStage(record.deploymentId);
      if (removed.length) record.removedArtifacts = removed;
    } catch (err) {
      record.cleanupError = err.message;
    }
  };

  const done = note => {
    cleanLocal();
    return set("destroyed", {
      destroyedAt: now(),
      failureReason: null,
      step: null,
      ...(note ? { note } : {})
    });
  };

  try {
    set("destroying", { step: "Checking what is still there" });

    // A deployment that never got as far as a stack has nothing in AWS to remove.
    if (!record.stackName) {
      return done("No stack was ever created for this deployment.");
    }

    const before = await describe(record.stackName);
    if (before.status === null) {
      return done(`Stack ${record.stackName} was already gone — nothing left to delete.`);
    }

    // CloudFormation refuses to delete a bucket that still has objects in it.
    if (record.kind === "static") {
      const bucket = before.outputs?.BucketName || record.outputs?.BucketName;
      if (bucket) {
        set("destroying", { step: `Emptying the website storage (${bucket})` });
        const emptied = await emptyBucket(bucket);
        if (!emptied.ok) {
          return fail(`could not empty s3://${bucket}: ${emptied.stderr.trim() || `exit ${emptied.code}`}`);
        }
      }
    }

    set("destroying", { step: `Deleting the stack ${record.stackName}` });
    const requested = await deleteStack(record.stackName);
    if (!requested.ok) {
      return fail(requested.stderr.trim() || `delete-stack exited ${requested.code}`);
    }

    let pollErrors = 0;

    while (true) {
      await sleep(POLL_MS);

      let described;
      try {
        described = await describe(record.stackName);
      } catch (err) {
        record.pollError = err.message;
        putDeployment(record);
        if (++pollErrors >= MAX_POLL_ERRORS) return fail(err.message);
        continue;
      }
      pollErrors = 0;
      record.pollError = null;
      record.stackStatus = described.status;

      // describe-stacks by name stops finding the stack the moment it is gone.
      if (described.status === null) return done();

      if (/FAILED/.test(described.status)) {
        const reason =
          (await firstFailure(record.stackName, ["DELETE_FAILED"])) ||
          described.statusReason ||
          `stack ${described.status}`;
        return fail(reason);
      }

      set("destroying");
    }
  } catch (err) {
    return fail(err.message);
  }
}
