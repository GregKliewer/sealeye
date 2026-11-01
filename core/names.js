// core/names.js
// The one rule for turning an app name into something AWS will accept. The CLI uses it
// to say which environment a folder belongs to, the API uses it to name the stack, and
// they have to agree, so it lives in core rather than in either of them.
import crypto from "node:crypto";
import { FIRST_STAGE } from "./stages.js";

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
 * "sealeye-<team>-<app>-<hash>" at dev, and "sealeye-<team>-<app>-<stage>-<hash>" at a
 * later stage (PHASE5-PLAN D5). The hash is of the organization, team and app (and the
 * stage past dev), and is
 * always there, because hyphens alone are ambiguous: team "a" with app "b-c" and team
 * "a-b" with app "c" would both be "sealeye-a-b-c", and team "payments" with app "foo"
 * would be the "sealeye-payments-foo" an app called payments-foo had before teams had
 * names of their own. The organization is in the hash, so two organizations sharing an
 * account would not meet either.
 *
 * @returns {string} lowercase [a-z0-9-], at most 49 characters
 */
export function environmentName({ org = "default", team = "default", app, stage = FIRST_STAGE }) {
  const appName = safeName(app);
  if (!appName) throw new Error("an environment needs an app name with at least one [a-z0-9] character");
  const teamName = safeName(team) || "default";
  const orgName = safeName(org) || "default";
  const stageName = stageForName(stage);
  // dev keeps the name every environment had before stages (DESIGN.md, "An environment
  // per stage, and a role per stage"), so nothing standing is renamed. A later stage is
  // in the name, read and hashed both: the readable part gives way to it, so it is never
  // cut off, and the hash tells two stages apart even if their readable parts meet.
  if (stageName === FIRST_STAGE) {
    const hash = crypto.createHash("sha256").update(`${orgName}/${teamName}/${appName}`, "utf8").digest("hex").slice(0, 6);
    const readable = `${teamName}-${appName}`.slice(0, READABLE_MAX).replace(/-+$/, "");
    return `sealeye-${readable}-${hash}`;
  }
  const hash = crypto.createHash("sha256").update(`${orgName}/${teamName}/${appName}/${stageName}`, "utf8").digest("hex").slice(0, 6);
  const readable = `${teamName}-${appName}`.slice(0, READABLE_MAX - stageName.length - 1).replace(/-+$/, "");
  return `sealeye-${readable}-${stageName}-${hash}`;
}

// A stage's part of a name: its own name, as safeName makes it, at most this long, so a
// readable app name is left beside it. Stages are short words (dev, sit, uat, staging,
// prod), and a catalog may name its own.
const STAGE_MAX = 12;

/** A stage as it is written into a name: dev when none is given. */
export function stageForName(stage) {
  const name = safeName(stage).slice(0, STAGE_MAX).replace(/-+$/, "");
  return name || FIRST_STAGE;
}

/**
 * The name a Terraform environment gives the organization's module (DESIGN.md, "A
 * Terraform environment's names, status and operations"): "sealeye-<app>-<hash>", at
 * most 31 characters, since a module names things after it and the stage, and starting
 * with "sealeye-", which is what the Terraform deploy role reaches. The hash is
 * environmentName's, so two teams' apps of one name are two names here too.
 *
 * @returns {string} lowercase, starting with a letter, [a-z0-9-], at most 31 characters
 */
export function moduleName({ org = "default", team = "default", app, stage = FIRST_STAGE }) {
  // A module names its parts after this and its stage, so this needs no stage of its own
  // to be read; the hash is the stage's environment's, so a module that does not take a
  // stage still names its parts apart from another stage's.
  const full = environmentName({ org, team, app, stage });
  const hash = full.slice(-6);
  const readable = safeName(app).slice(0, 16).replace(/-+$/, "") || "app";
  return `sealeye-${readable}-${hash}`;
}

/** The file seaLeye.run writes into the developer's folder: the plan as submitted. */
export const CONFIG_FILE = "sealeye.yaml";

/** What that file was called before 2.17.0. Still read, never written. */
export const LEGACY_CONFIG_FILE = "deployme.yaml";
