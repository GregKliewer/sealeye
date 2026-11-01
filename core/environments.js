// What the command and the portal both call one environment. It runs in a browser, so
// the portal imports it too: `sealeye list` and Environments group the same records the
// same way, and `sealeye online <app>` opens the page the portal keeps for that
// environment (/environments/<key>).

import { FIRST_STAGE } from "./stages.js";

/**
 * The stage a record is for (PHASE5-PLAN D5): dev when it says none, so every record
 * made before stages is dev, as it was built.
 * @param {{ stage?: string|null }|null|undefined} dep
 * @returns {string}
 */
export function environmentStage(dep) {
  return typeof dep?.stage === "string" && dep.stage ? dep.stage : FIRST_STAGE;
}

/**
 * The key of the environment a record belongs to. Each stage of an app is an
 * environment of its own, with a name of its own (core/names.js), so the key is one per
 * app and stage. A stack is one environment. A draft
 * has no stack, so it is its team's app: two teams' drafts of the same name are two (an
 * organization-wide token sees both).
 * @param {{ stackName?: string|null, environment?: string|null, teamId?: string|null, app?: { name?: string }|null, deploymentId: string }} dep
 * @returns {string}
 */
export function environmentKey(dep) {
  if (dep.stackName || dep.environment) return dep.stackName || dep.environment;
  if (!dep.app?.name) return dep.deploymentId;
  // A draft has no name in the cloud: its team's app, and its stage past dev.
  const stage = environmentStage(dep);
  return `${dep.teamId || "default"}:${dep.app.name}${stage === FIRST_STAGE ? "" : `:${stage}`}`;
}

/** The portal's address for one environment's page, relative to the portal. */
export function environmentPath(dep) {
  return `/environments/${encodeURIComponent(environmentKey(dep))}`;
}

// The order stages are usually walked in, for showing an app's stages side by side when
// no catalog is at hand. A stage a catalog names that is not here comes after, by name.
const USUAL_ORDER = ["dev", "sit", "uat", "staging", "perf", "prod"];

/** Sorts stage names dev first, then as a path to production usually runs. */
export function compareStages(a, b) {
  const ia = USUAL_ORDER.indexOf(a);
  const ib = USUAL_ORDER.indexOf(b);
  if (ia !== -1 || ib !== -1) return (ia === -1 ? USUAL_ORDER.length : ia) - (ib === -1 ? USUAL_ORDER.length : ib);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The app a record is for, across its stages: its team and its name. `sealeye list` and
 * Environments show one row per app, with its stages (PHASE5-PLAN D5).
 * @param {{ teamId?: string|null, app?: { name?: string }|null, deploymentId: string }} dep
 */
export function appKey(dep) {
  return dep.app?.name ? `${dep.teamId || "default"}:${dep.app.name}` : dep.deploymentId;
}
