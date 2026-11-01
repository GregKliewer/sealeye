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
