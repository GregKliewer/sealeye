// api/executor/resume.js
// Deployments that were in flight when the API stopped (PHASE1-PLAN Step 10). The file
// store only ever marked them "interrupted"; now the API picks each one up again:
//
// - running: CloudFormation carried on without us. Poll the stack again until it says
//   how it ended, through the same loop a live deployment uses (followStack, resumed).
// - destroying: start the tear-down again. Every step of it is safe to repeat.
// - queued or packaging: the platform stopped while getting it ready, before the stack
//   step. That work cannot be resumed, and saying so is the honest status.
import { listDeployments, putDeployment } from "../store.js";
import { followStack, settersFor, startDestroy } from "./index.js";
import { removeUpload, uploadDirFor } from "./uploads.js";

const now = () => new Date().toISOString();
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether an interrupted record is still this platform's to act on. One that is not
 * stays marked "interrupted", the last status we knew, and nothing is done in AWS:
 *
 * - imported from another machine's store (`deploy/server.sh import`), whose role and
 *   account may not be this server's;
 * - more than a day old: whatever it was doing ended long ago, and its stack may since
 *   belong to a newer deployment;
 * - not the newest record for its stack: acting on it could tear down or take the
 *   result of the deployment that came after it.
 */
function stillOurs(dep, all, nowMs) {
  if (dep.importedAt) return "imported from another machine";
  const started = Date.parse(dep.startedAt || "");
  if (!Number.isFinite(started) || nowMs - started > DAY_MS) return "older than a day";
  if (dep.stackName) {
    const newer = all.some(o => o !== dep && o.stackName === dep.stackName && String(o.startedAt || "") > String(dep.startedAt || ""));
    if (newer) return "a newer deployment has used the same environment since";
  }
  return null;
}

/** @returns {{ deploymentId: string, as: string }[]} what was picked up, and how */
export function resumeInFlight({ nowMs = Date.now() } = {}) {
  const picked = [];
  const all = listDeployments();

  for (const dep of all) {
    if (!dep.interrupted) continue;
    const notOurs = stillOurs(dep, all, nowMs);
    if (notOurs) {
      picked.push({ deploymentId: dep.deploymentId, as: `left as it was (${notOurs})` });
      continue;
    }
    delete dep.interrupted;
    dep.resumedAt = now();
    const { set, fail } = settersFor(dep);
    const done = () => { if (dep.source === "upload") removeUpload(dep.deploymentId); };

    if (dep.status === "destroying") {
      putDeployment(dep);
      startDestroy(dep).catch(err => fail(err.message));
      picked.push({ deploymentId: dep.deploymentId, as: "tear-down started again" });
      continue;
    }

    if (dep.status === "running" && dep.stackName) {
      putDeployment(dep);
      const appPath = dep.source === "upload" ? uploadDirFor(dep.deploymentId) : dep.appPath;
      followStack(dep, {
        plan: dep.plan,
        appPath,
        stackName: dep.stackName,
        child: { exited: true, result: null },
        set,
        fail,
        resumed: true
      })
        .catch(err => fail(err.message))
        .finally(done);
      picked.push({ deploymentId: dep.deploymentId, as: "watching the stack again" });
      continue;
    }

    fail("The platform restarted while getting this deployment ready, before your environment was created. Run it again.");
    done();
    picked.push({ deploymentId: dep.deploymentId, as: "failed: restarted while being prepared" });
  }

  return picked;
}
