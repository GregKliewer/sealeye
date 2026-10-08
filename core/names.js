// core/names.js
// The one rule for turning an app name into something AWS will accept. The CLI uses it
// to say which environment a folder belongs to, the API uses it to name the stack, and
// they have to agree, so it lives in core rather than in either of them.

/** Lowercase, [a-z0-9-] only: safe for a stack name, a function name and an S3 prefix. */
export function safeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The file seaLeye.run writes into the developer's folder: the plan as submitted. */
export const CONFIG_FILE = "sealeye.yaml";

/** What that file was called before 2.17.0. Still read, never written. */
export const LEGACY_CONFIG_FILE = "deployme.yaml";
