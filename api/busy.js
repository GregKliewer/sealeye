// api/busy.js
// One change at a time per environment (DESIGN.md, "One change at a time"). A deploy,
// a deploy again, a configure change, a tear-down, a pause or a resume is refused while
// another change to the same environment is queued, packaging, running or tearing down:
// a tear-down during packaging would otherwise be undone when the deploy finishes, and
// two updates at once leave one failed for a reason nobody chose. The refusal says what
// is under way, who started it and when, so the person can wait for it or follow it.
import { listDeployments } from "./store.js";

export const UNDER_WAY = new Set(["queued", "packaging", "running", "destroying"]);
// A change still marked as under way after a day is not one: the platform would have
// resolved it when it restarted. It stops counting rather than lock the environment.
const STALE_MS = 24 * 60 * 60 * 1000;

const environmentOf = r => r?.stackName || r?.environment || null;
// When the change under way began: a tear-down when it was asked for, a deploy when it started.
const changedAt = r => (r.status === "destroying" && r.destroyRequestedBy?.at) || r.startedAt;

/** The change under way on an environment, other than `except`, or null. */
export function changeUnderWay(environment, { except = null, now = Date.now(), records = listDeployments() } = {}) {
  if (!environment) return null;
  return records.find(r =>
    r.deploymentId !== except &&
    environmentOf(r) === environment &&
    UNDER_WAY.has(r.status) &&
    !r.interrupted &&
    now - Date.parse(changedAt(r) || 0) < STALE_MS) || null;
}

const WORDS = {
  queued: "waiting to start",
  packaging: "being packaged",
  running: "being built",
  destroying: "being torn down"
};

function ago(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso || 0)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} minute${s < 120 ? "" : "s"} ago`;
  return `${Math.floor(s / 3600)} hour${s < 7200 ? "" : "s"} ago`;
}

/** The refusal for a change while `busy` is under way, the same sentence on both surfaces. */
export function busyRefusal(busy, { now = Date.now() } = {}) {
  const tearingDown = busy.status === "destroying";
  const by = tearingDown ? busy.destroyRequestedBy : busy.requestedBy;
  const who = by?.name || by?.user || null;
  const from = (tearingDown ? busy.destroyRequestedBy?.surface : busy.surface) === "portal" ? "the portal" : "the command line";
  const what = tearingDown ? "a tear-down" : "a deploy";
  const app = busy.app?.name || "This environment";
  return {
    error: {
      code: "ENVIRONMENT_BUSY",
      message: `${app} is ${WORDS[busy.status] || "changing"} right now (${busy.deploymentId}, ${what}${who ? ` started by ${who}` : ""} from ${from}, ${ago(changedAt(busy), now)}). One change at a time: wait for it to finish, or follow it with sealeye watch ${busy.deploymentId}.`,
      details: { deploymentId: busy.deploymentId, status: busy.status }
    }
  };
}
