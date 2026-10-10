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

/** @returns {{ deploymentId: string, as: string }[]} what was picked up, and how */
export function resumeInFlight() {
  const picked = [];

  for (const dep of listDeployments()) {
    if (!dep.interrupted) continue;
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
