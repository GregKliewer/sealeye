// src/executor/index.js
// The deployment lifecycle: compose -> package -> deploy -> poll until CloudFormation
// says it is done. Status is never invented; it mirrors the stack.
import { compose, namingFor, resourceNameOf } from "./compose.js";
import { storeFolder } from "./settings.js";
import { stage, cleanStage, stagePaths, sha256File, sha256Template } from "./package.js";
import { artifactExists, functionPaused, deploy, describe, firstFailure, deleteStack, emptyBucket, listStoredSettings, syncSite } from "./cfn.js";
import { renderReport } from "./report.js";
import { putDeployment, listDeployments } from "../store.js";
import { requireSetting } from "../../core/config.js";
import { flushScores, scoreDeploymentOutcome } from "../../core/tracing.js";

// Every 5 s, as CLAUDE.md says. Tests that stand in for CloudFormation poll faster.
const POLL_MS = Number(process.env.SEALEYE_TEST_POLL_MS) || 5000;
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
/**
 * How a deployment's status changes, written to the store each time. The API holds the
 * LangFuse keys, so it scores how a deployment ended against the interview that
 * produced it the moment it knows (core/tracing.js): a final status only, never a guess.
 */
// How long to wait for a failed first create to be removed before saying it was not.
const CLEANUP_MAX_MS = Number(process.env.SEALEYE_TEST_CLEANUP_MAX_MS) || 15 * 60 * 1000;

/** Wait until a stack is gone: { ok: true }, or { ok: false, error } in words. */
async function untilGone(stackName) {
  const until = Date.now() + CLEANUP_MAX_MS;
  let errors = 0;
  while (Date.now() < until) {
    await sleep(POLL_MS);
    let described;
    try {
      described = await describe(stackName);
    } catch (err) {
      if (++errors >= MAX_POLL_ERRORS) return { ok: false, error: err.message };
      continue;
    }
    if (described.status === null) return { ok: true };
    if (described.status === "DELETE_FAILED") return { ok: false, error: described.statusReason || "the stack could not be deleted" };
  }
  return { ok: false, error: "the failed stack was still being removed when the platform stopped waiting" };
}

/**
 * After a restart, go on waiting for a failed first create's removal, so the
 * environment opens again when it is gone rather than when the half hour is up.
 */
export async function finishCleanup(record) {
  const gone = await untilGone(record.stackName);
  record.rolledBackStackRemoved = gone.ok;
  if (!gone.ok) record.cleanupError = gone.error;
  record.cleaningUp = false;
  record.step = null;
  return putDeployment(record);
}

export function settersFor(record) {
  const set = (status, patch = {}) => {
    Object.assign(record, { status, ...patch });
    if (status === "succeeded" || status === "failed") {
      scoreDeploymentOutcome(record);
      flushScores().catch(() => {});
    }
    return putDeployment(record);
  };
  const fail = reason => set("failed", { failureReason: reason, finishedAt: now(), step: null });
  return { set, fail };
}

export async function startDeployment(record, plan, appPath, sent = {}) {
  const { set, fail } = settersFor(record);

  let composed;
  try {
    set("packaging", { step: "Reading your plan and picking the AWS template" });

    // `sent` holds setting values from the deploy request. They go into this
    // deployment's parameters and nowhere else: compose keeps names and sources only.
    // The names this environment has in AWS: its own team's, kept from its record when
    // it already exists (DESIGN.md, "Each team's environments have names of their own").
    const naming = {
      ...namingFor({
        app: plan?.app?.name,
        org: record.orgId || "default",
        team: record.teamId || "default",
        records: listDeployments()
      }),
      // For the cost allocation tags.
      team: record.teamId || "default"
    };
    // Which of the app's settings are in the organization's store (PHASE2-PLAN Part B).
    // Those the app reads itself when it starts; the rest are passed in as before. A
    // store that cannot be asked stops the deploy, rather than building an app that
    // starts without settings it has.
    let store = {};
    const isApi = (plan?.modules || []).some(m => m && m.enabled !== false && m.id === "http_api_serverless");
    // An app's name over 100 characters cannot have stored settings (storeFolder), so it
    // deploys as before, unless the command expected some there.
    const storable = String(plan?.app?.name || "").length <= 100 || (record.expectStored || []).length > 0;
    if (isApi && storable) {
      const folder = storeFolder({ team: record.teamId || "default", app: plan?.app?.name });
      set("packaging", { step: "Checking which of your settings are in your organization's store" });
      const listed = await listStoredSettings(folder);
      if (!listed.ok) throw new Error(`the platform could not ask your organization's settings store which settings this app has (${listed.error})`);
      store = { folder, stored: listed.settings.map(x => x.name) };
      const gone = (record.expectStored || []).filter(name => !store.stored.includes(name));
      if (gone.length) {
        throw new Error(`this deploy expected ${gone.join(", ")} in your organization's settings store for ${plan?.app?.name}, and the platform cannot find ${gone.length === 1 ? "it" : "them"} there now, so nothing was built. Check the app's settings (sealeye settings, or Settings in the portal) and deploy again.`);
      }
    }
    composed = compose(plan, record.deploymentId, appPath, sent, naming, store);
    Object.assign(record, {
      kind: composed.kind,
      stackName: composed.stackName,
      resourceName: composed.resourceName,
      templatePath: composed.templatePath,
      // The values belong to the developer; the record keeps the names and where they
      // came from, and nothing else.
      parameters: composed.safeParameters,
      settings: composed.settings
    });
    putDeployment(record);

    // Deployed again (PHASE2-PLAN Step 14): the code an earlier deployment packaged,
    // as it is in S3, so nothing is staged or uploaded, and its checksum is that
    // deployment's (already on the record).
    const again = record.source === "again";
    let artifactKey;
    if (again) {
      artifactKey = record.artifactKey;
      const by = record.packagedBy || record.fromDeployment;
      set("packaging", { step: `Finding the code ${by} packaged` });
      const found = await artifactExists(requireSetting("BUCKET"), artifactKey);
      if (!found.ok) {
        throw new Error(found.missing
          ? `the code ${by} packaged is no longer kept, so nothing was built. Run sealeye run in the app's folder to package it again.`
          : `the platform could not check the code ${by} packaged is still there (${found.error}), so nothing was built`);
      }
      composed.parameters.ArtifactKey = artifactKey;
      composed.safeParameters.ArtifactKey = artifactKey;
      record.parameters = composed.safeParameters;
    } else {
      artifactKey = await stage(appPath, record.deploymentId, composed, line =>
        set(record.status, { step: line })
      );
    }
    if (artifactKey) record.artifactKey = artifactKey;

    // Two checksums on the way past, for the change record: the template this stack is
    // built from and the artifact that went to S3. Read after they exist, never written
    // to anything, and a file that cannot be read is said so rather than guessed.
    try {
      record.templateSha256 = sha256Template(composed.templatePath);
    } catch (err) {
      record.templateSha256 = null;
      record.templateSha256Error = err.message;
    }
    if (artifactKey && !again) {
      try {
        record.artifactSha256 = sha256File(stagePaths(record.deploymentId).zipPath);
      } catch (err) {
        record.artifactSha256 = null;
        record.artifactSha256Error = err.message;
      }
    }
    putDeployment(record);

    set("running", { step: `Creating your AWS environment (stack ${composed.stackName})` });
  } catch (err) {
    return fail(err.message);
  }

  // Fire and forget: the poll below, not this promise, is the source of truth.
  const child = { exited: false, result: null };
  deploy(composed)
    .catch(err => ({ ok: false, code: -1, stdout: "", stderr: err.message }))
    .then(result => {
      child.result = result;
      child.exited = true;
    });

  return followStack(record, { plan, appPath, stackName: composed.stackName, child, set, fail });
}

/**
 * Poll one deployment's stack until it reaches a final status, and record it. Shared by
 * a deployment in progress and one picked up again after the API restarted
 * (`resumed`), when the deploy command is long gone and only CloudFormation knows.
 */
export async function followStack(record, { plan, appPath, stackName, child, set, fail, resumed = false }) {
  const composed = { stackName };
  let pollErrors = 0;
  // Set once this deployment's own operation is visibly under way. Until then a
  // terminal stack status belongs to a previous deploy, not to this one.
  // After a restart, the last status read before it counts: a change seen under way
  // then is this deployment's, whatever final status it has reached since.
  // Kept on the record (sawInProgress), so a static site that was being synced when the
  // API stopped, its stack already complete, is still known to be this deployment's.
  let sawInProgress =
    resumed &&
    (record.sawInProgress === true ||
      (/IN_PROGRESS/.test(record.stackStatus || "") && record.stackStatus !== "REVIEW_IN_PROGRESS"));

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
      if (child.exited && ++pollErrors >= MAX_POLL_ERRORS) {
        return fail(`${err.message}${child.result?.stderr ? `\n${child.result.stderr.trim()}` : ""}`);
      }
      continue;
    }
    pollErrors = 0;
    record.pollError = null;
    record.stackStatus = described.status;

    const mapped = mapStackStatus(described.status);
    if (Object.keys(described.outputs).length) record.outputs = described.outputs;
    // A change set that was made and never run: the deploy command stopped between the
    // two, or the platform restarted there. Nothing will move it on.
    if (described.status === "REVIEW_IN_PROGRESS" && (child.exited || resumed)) {
      return fail(
        resumed
          ? "The platform restarted before your environment was created, so nothing was built. Run it again."
          : child.result?.stderr?.trim() || "the change was prepared but never run"
      );
    }
    if (/IN_PROGRESS/.test(described.status || "") && described.status !== "REVIEW_IN_PROGRESS") {
      sawInProgress = true;
      record.sawInProgress = true;
    }

    // A terminal stack status is only ours once this deployment's operation has
    // started, or once the AWS CLI has exited. Otherwise a redeploy would report the
    // previous run's CREATE_COMPLETE (or ROLLBACK) a second after it began.
    // record.stackStatus always carries the literal CloudFormation status.
    if (!child.exited && !sawInProgress) {
      set("running");
      continue;
    }

    // Picked up after a restart, with this deployment's change never seen under way:
    // a final status now could be the previous deploy's, or the change set may never
    // have been run. Status is real, so this is said, not guessed.
    if (resumed && !sawInProgress && mapped !== "running" && mapped !== "destroying") {
      return fail(
        "The platform restarted before this deployment's change could be seen starting, so seaLeye.run cannot say it happened. Your environment is as it was before; run it again."
      );
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
        record.syncedFrom = record.source === "upload" ? "the uploaded copy of your folder" : appPath;
      }

      // A paused API stays paused through a deploy (the template sets no reservation),
      // so the record says so, read from AWS now, rather than look like it is serving.
      let paused = false;
      if (record.kind === "api") {
        const state = await functionPaused(resourceNameOf(record) || record.resourceName);
        paused = state.ok && state.paused;
      }

      set("succeeded", {
        outputs: described.outputs,
        failureReason: null,
        finishedAt: now(),
        step: null,
        ...(paused ? { paused: true } : {})
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
        child.result?.stderr?.trim() ||
        `stack ${described.status}`;

      // ROLLBACK_COMPLETE is a dead stack — a create that failed and undid itself.
      // CloudFormation will not update it and will not create over it, so leaving it
      // there means every later deploy fails for a reason that is no longer the real
      // one. Remove it so the next attempt starts clean.
      // UPDATE_ROLLBACK_COMPLETE is deliberately not touched: that stack is the
      // developer's previous environment, still up and still serving.
      if (described.status === "ROLLBACK_COMPLETE") {
        // The deploy has failed, and says so from now. Removing what it left takes a
        // while, and the environment takes no other change until it is gone
        // (api/busy.js counts cleaningUp): a deploy started meanwhile would meet the
        // stack half-deleted and fail for a reason that is not the real one.
        Object.assign(record, { failureReason: reason, cleaningUp: true, cleanupStartedAt: now() });
        set("failed", { step: `Removing the failed stack ${composed.stackName} so you can deploy again` });
        const removed = await deleteStack(composed.stackName);
        if (!removed.ok) {
          record.cleanupError = removed.stderr.trim() || `delete-stack exited ${removed.code}`;
          record.rolledBackStackRemoved = false;
        } else {
          const gone = await untilGone(composed.stackName);
          record.rolledBackStackRemoved = gone.ok;
          if (!gone.ok) record.cleanupError = gone.error;
        }
        Object.assign(record, { cleaningUp: false, finishedAt: now(), step: null });
        return putDeployment(record);
      }

      return fail(reason);
    }

    if (mapped === null) {
      // No stack. Either the command exited before creating one, or one existed a
      // moment ago and something outside this deployment deleted it.
      if (!child.exited) {
        set("running");
        continue;
      }
      return fail(
        resumed && sawInProgress
          ? "Your environment's stack no longer exists: it was removed after this deployment started. Run it again."
          : resumed
            ? "The platform restarted before your environment was created, so nothing was built. Run it again."
            : child.result?.stderr?.trim() || "the deploy command exited without creating a stack"
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
/**
 * A stack is one environment, and every record that deployed to it is a sibling. When
 * one of them tears the stack down, the others are describing something that no longer
 * exists: same URL, still reading succeeded. CLAUDE.md says never fake a transition,
 * and a record claiming success for a deleted stack is that, one table over.
 *
 * The note names the deployment that did it, so a record changing under a developer is
 * traceable rather than mysterious.
 *
 * @returns {string[]} the sibling ids that were closed
 */
function closeSiblings(record) {
  if (!record.stackName) return [];

  const closed = [];

  for (const sibling of listDeployments()) {
    if (sibling.deploymentId === record.deploymentId) continue;
    if (sibling.stackName !== record.stackName) continue;
    if (sibling.status !== "succeeded") continue;

    Object.assign(sibling, {
      status: "destroyed",
      destroyedAt: now(),
      step: null,
      note: `the environment was torn down by ${record.deploymentId}`
    });

    putDeployment(sibling);
    closed.push(sibling.deploymentId);
  }

  return closed;
}

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

    // The stack is gone for every record that shares it, not only for this one.
    closeSiblings(record);

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
      return done(`Stack ${record.stackName} was already gone, so there was nothing left to delete.`);
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
