// api/module-use.js
// Which apps use each module now, and at which release (Greg, Oct 23, 2026; DESIGN.md,
// "The Catalog page says which apps use each module"). Read from the store only. Shown
// as the needs ledger shows its apps: every app in the organization by name and team,
// and the page to open only for an app the viewer may open (its team's, or every team's
// for an organization-wide token).
import { environmentKey, environmentPath } from "../core/environments.js";

/** The modules a record built: its plan's enabled modules, or for an older record, what it resolved. */
const modulesOf = record =>
  Array.isArray(record.plan?.modules)
    ? record.plan.modules.filter(m => m && m.enabled !== false).map(m => m.id)
    : (record.resolvedModules || []).map(m => m?.id).filter(Boolean);

/** The release a record built a module at, where its library releases one; null for the starter's. */
function versionOf(record, id) {
  const tf = record.terraform;
  if (!tf) return null;
  if (tf.module?.id === id) return tf.module.version || null;
  return (tf.parts || []).find(p => p.id === id)?.version || null;
}

/**
 * Each module's standing apps. An environment counts when a deploy has succeeded since it
 * was last torn down; the newest such deploy says which modules it runs and at which
 * release. A failed deploy after it left it as it was, and a drafted plan built nothing.
 *
 * @param {object[]} records the organization's records
 * @param {{ viewer?: { team: string, scope: string } | null }} [options]
 * @returns {Record<string, { app: string, team: string, version: string | null, path: string | null }[]>}
 */
export function modulesInUse(records, { viewer = null } = {}) {
  const sees = dep => !viewer || viewer.scope === "org" || (dep.teamId || "default") === viewer.team;
  const byEnvironment = new Map();
  for (const r of records) {
    if (r.status === "drafted") continue;
    const key = environmentKey(r);
    if (!byEnvironment.has(key)) byEnvironment.set(key, []);
    byEnvironment.get(key).push(r);
  }
  const used = {};
  for (const list of byEnvironment.values()) {
    list.sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || "")));
    const lastGone = list.map(r => r.status).lastIndexOf("destroyed");
    const standing = list.slice(lastGone + 1).filter(r => r.status === "succeeded").at(-1);
    if (!standing) continue;
    for (const id of new Set(modulesOf(standing))) {
      (used[id] ||= []).push({
        app: standing.app?.name || standing.deploymentId,
        team: standing.teamId || "default",
        version: versionOf(standing, id),
        path: sees(standing) ? environmentPath(standing) : null
      });
    }
  }
  for (const apps of Object.values(used)) apps.sort((a, b) => a.app.localeCompare(b.app) || a.team.localeCompare(b.team));
  return used;
}
