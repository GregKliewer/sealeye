// core/names.js
// The one rule for turning an app name into something AWS will accept. The CLI uses it
// to say which environment a folder belongs to, the API uses it to name the stack, and
// they have to agree, so it lives in core rather than in either of them.
import crypto from "node:crypto";

/** Lowercase, [a-z0-9-] only: safe for a stack name, a function name and an S3 prefix. */
export function safeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// The readable part of an environment's name stops here, so that everything named after
// it fits AWS's limits: a function name stops at 64 characters, and a static site's
// bucket, "<name>-<12-digit account>", at 63. "sealeye-" (8) + 34 + "-" + 6 = 49.
const READABLE_MAX = 34;

/**
 * The name an environment has in AWS: its stack, function, log group, API and static
 * site bucket are all named after it (DESIGN.md, "Each team's environments have names
 * of their own"). Two teams' apps of the same name get two names, and the developer
 * still sees only their app's name.
 *
 * "sealeye-<team>-<app>-<hash>". The hash is of the organization, team and app, and is
 * always there, because hyphens alone are ambiguous: team "a" with app "b-c" and team
 * "a-b" with app "c" would both be "sealeye-a-b-c", and team "payments" with app "foo"
 * would be the "sealeye-payments-foo" an app called payments-foo had before teams had
 * names of their own. The organization is in the hash, so two organizations sharing an
 * account would not meet either.
 *
 * @returns {string} lowercase [a-z0-9-], at most 49 characters
 */
export function environmentName({ org = "default", team = "default", app }) {
  const appName = safeName(app);
  if (!appName) throw new Error("an environment needs an app name with at least one [a-z0-9] character");
  const teamName = safeName(team) || "default";
  const hash = crypto.createHash("sha256").update(`${safeName(org) || "default"}/${teamName}/${appName}`, "utf8").digest("hex").slice(0, 6);
  const readable = `${teamName}-${appName}`.slice(0, READABLE_MAX).replace(/-+$/, "");
  return `sealeye-${readable}-${hash}`;
}

/** The file seaLeye.run writes into the developer's folder: the plan as submitted. */
export const CONFIG_FILE = "sealeye.yaml";

/** What that file was called before 2.17.0. Still read, never written. */
export const LEGACY_CONFIG_FILE = "deployme.yaml";
