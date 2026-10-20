// core/token.js
// The shape of a seaLeye token, which the command (before it sends one) and the API
// (before it looks one up) must agree on. Issuing and checking tokens is the API's
// (api/tokens.js); this is only what one looks like.
export const TOKEN_PREFIX = "sl_";

/** Whether a string has the shape of a token at all: sl_ and 43 base64url characters. */
export function looksLikeToken(value) {
  return typeof value === "string" && /^sl_[A-Za-z0-9_-]{43}$/.test(value);
}

/**
 * Whose environments a signed-in person sees, in words, the same on every surface:
 * "team payments", or for an organization-wide token "team default, and every team's
 * environments" (DESIGN.md, "Each team sees its own environments").
 */
export function seesInWords({ team, scope } = {}) {
  return scope === "org" ? `team ${team}, and every team's environments` : `team ${team}`;
}

/**
 * Which organization a signed-in person acts for, in words, the same on both surfaces:
 * its name for the first organization ("default", named by the server's ORG), and its id
 * for any other ("juniper"), so a token for another organization never looks like the
 * first's (Greg, Oct 16, 2026).
 */
export function organizationInWords({ org, organizationName } = {}) {
  if (org && org !== "default") return org;
  return organizationName || "your organization";
}

/**
 * Whether an app's settings and costs are kept for this person's organization. Both are
 * kept by team and not yet by organization, so only the first organization has them
 * (DESIGN.md, "A catalog goes live through a self-test"); the portal shows nothing it
 * cannot do, and the API refuses the rest (409 NOT_FOR_THIS_ORGANIZATION).
 */
export function hasSettingsAndCosts({ org, auth } = {}) {
  return auth === "off" || !org || org === "default";
}

/** What both surfaces say where an app's settings or costs are not kept: "settings" or "costs". */
export function notKeptForOrganization(what) {
  return `${what === "costs" ? "Costs" : "App settings"} are not available to your organization yet: the platform keeps them by team, and not yet by organization.`;
}
