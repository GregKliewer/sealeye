// What the command and the portal both call one environment. It runs in a browser, so
// the portal imports it too: `sealeye list` and Environments group the same records the
// same way, and `sealeye online <app>` opens the page the portal keeps for that
// environment (/environments/<key>).

/**
 * The key of the environment a record belongs to. A stack is one environment. A draft
 * has no stack, so it is its team's app: two teams' drafts of the same name are two (an
 * organization-wide token sees both).
 * @param {{ stackName?: string|null, environment?: string|null, teamId?: string|null, app?: { name?: string }|null, deploymentId: string }} dep
 * @returns {string}
 */
export function environmentKey(dep) {
  return dep.stackName || dep.environment || (dep.app?.name ? `${dep.teamId || "default"}:${dep.app.name}` : dep.deploymentId);
}

/** The portal's address for one environment's page, relative to the portal. */
export function environmentPath(dep) {
  return `/environments/${encodeURIComponent(environmentKey(dep))}`;
}
