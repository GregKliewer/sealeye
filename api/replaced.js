// api/replaced.js
// Which successful deploys are no longer what an environment is running (DESIGN.md,
// "A replaced deploy says so"). Every record keeps its own true result: a deploy that
// succeeded stays succeeded. But only the newest successful deploy of an environment is
// live, so each older one is marked as replaced by the next successful deploy after it.
// A failed deploy replaces nothing: the stack rolled back to what was there before.

/**
 * @param {object[]} records  every record, any order
 * @returns {Map<string, string>}  deploymentId -> the deploymentId that replaced it
 */
export function replacements(records) {
  const byTime = [...records].sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
  const newer = new Map();     // stackName -> the nearest newer successful deploy seen
  const replaced = new Map();
  for (const r of byTime) {
    if (r.status !== "succeeded" || !r.stackName) continue;
    const next = newer.get(r.stackName);
    if (next) replaced.set(r.deploymentId, next.deploymentId);
    newer.set(r.stackName, r);
  }
  return replaced;
}
