// api/pause.js
// Pause and resume (PHASE2-PLAN Step 17, D7): an API's function stops taking requests
// (its reserved concurrency is zero) and starts again. APIs only: a static site says
// plainly it cannot be paused. The state is read back from AWS after every change and
// whenever it is asked for, never assumed (principle 4); each change is written on the
// environment's newest record, with who asked and from where.
import { functionPaused, setFunctionPaused } from "./executor/cfn.js";
import { resourceNameOf } from "./executor/compose.js";
import { listDeployments, putDeployment } from "./store.js";

const refusal = (status, code, message) => ({ status, body: { error: { code, message } } });

function check(record) {
  if (record.kind === "static") {
    return refusal(409, "CANNOT_PAUSE", "A static site cannot be paused: its files are served straight from storage, with no code running to stop. Tear it down if it should not be reachable.");
  }
  if (!record.stackName) return refusal(409, "CANNOT_PAUSE", "Nothing was built for this deployment, so there is nothing to pause.");
  if (record.status === "destroyed" || record.status === "destroying") {
    return refusal(409, "CANNOT_PAUSE", "This environment has been torn down, so there is nothing to pause.");
  }
  return null;
}

/** GET: whether the environment's API is paused, read from AWS now. */
export async function pausedState(record) {
  const refused = check(record);
  if (refused) return refused;
  const state = await functionPaused(resourceNameOf(record));
  if (!state.ok) {
    return state.missing
      ? refusal(409, "CANNOT_PAUSE", "Your app's code is not running in this environment yet, so there is nothing to pause.")
      : refusal(502, "STATE_UNAVAILABLE", `The platform could not read whether your app is paused (${state.error}).`);
  }
  return { status: 200, body: { app: record.app?.name || null, paused: state.paused } };
}

/** POST: pause (true) or resume (false), then read back what AWS says now. */
export async function changePaused(record, paused, { by, surface }) {
  const refused = check(record);
  if (refused) return refused;
  const fn = resourceNameOf(record);
  const changed = await setFunctionPaused(fn, paused);
  if (!changed.ok) {
    return refusal(502, paused ? "PAUSE_FAILED" : "RESUME_FAILED", `The platform could not ${paused ? "pause" : "resume"} your app (${changed.error}).`);
  }
  const state = await functionPaused(fn);
  if (!state.ok) return refusal(502, "STATE_UNAVAILABLE", `The platform ${paused ? "paused" : "resumed"} your app and could not read it back (${state.error}).`);

  // On the environment's newest record, so its history says who did it and when. Paused
  // is said by the deploy that is running, the newest that succeeded (a failed one
  // rolled back to it), and by no other record of the environment.
  const same = listDeployments().filter(r => r.stackName === record.stackName);
  const newest = same[0] || record;
  const current = same.find(r => r.status === "succeeded") || newest;
  for (const r of same) {
    if (r !== current && r.paused) { r.paused = false; if (r !== newest) putDeployment(r); }
  }
  current.paused = state.paused;
  newest.pauses = [...(newest.pauses || []), { action: paused ? "paused" : "resumed", by, surface, at: new Date().toISOString(), confirmed: state.paused === paused }];
  putDeployment(newest);
  if (current !== newest) putDeployment(current);

  if (state.paused !== paused) {
    return refusal(502, "STATE_DIFFERS", `The platform asked AWS to ${paused ? "pause" : "resume"} your app, and AWS still says it is ${state.paused ? "paused" : "taking requests"}.`);
  }
  return { status: 200, body: { app: record.app?.name || null, paused: state.paused } };
}
