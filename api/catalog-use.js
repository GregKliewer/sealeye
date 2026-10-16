// api/catalog-use.js
// Which environments a catalog would stop building, were it made live (PHASE4-PLAN Step
// 7, DESIGN.md "A catalog goes live through a self-test, approved and made live apart").
// An environment running on a module the new live catalog does not build could not be
// deployed again (CATALOG_CHANGED) and would be refused at its next plan, so making that
// catalog live is refused, naming each one, until they are torn down or the catalog
// builds what they use.
import { isBuildable } from "../core/catalog.js";

/** The modules a record's environment runs: its plan's, or for an older record, what it resolved. */
const modulesOf = record =>
  Array.isArray(record.plan?.modules)
    ? record.plan.modules.filter(m => m && m.enabled !== false).map(m => m.id)
    : (record.resolvedModules || []).map(m => m?.id).filter(Boolean);

/**
 * Each of an organization's environments that may still run, or be built with, a module
 * `document` does not build. Erring toward naming one: an environment counts unless its
 * newest record says it is gone (`destroyed`), and every record since it was last torn
 * down counts, whatever its status. A failed deploy left what was there before, and a
 * failed tear-down left the stack standing with its record marked failed (the review of
 * Oct 16, 2026), so neither is taken to mean the environment is gone. A drafted plan
 * built nothing. One wrongly named is cleared by tearing it down, which marks it gone.
 *
 * @returns {{ environment: string, app: string | null, team: string, deploymentId: string, modules: string[] }[]}
 */
export function environmentsDropped({ org, document, records }) {
  const byEnvironment = new Map();
  for (const r of records.filter(r => (r.orgId || "default") === org && r.status !== "drafted")) {
    const key = r.stackName || r.environment || r.deploymentId;
    if (!byEnvironment.has(key)) byEnvironment.set(key, []);
    byEnvironment.get(key).push(r);
  }
  const found = [];
  for (const [environment, list] of byEnvironment) {
    list.sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || "")));
    const lastGone = list.map(r => r.status).lastIndexOf("destroyed");
    const since = list.slice(lastGone + 1);
    if (!since.length) continue;
    const modules = [...new Set(since.flatMap(modulesOf).filter(id => !isBuildable(id, document)))];
    if (!modules.length) continue;
    const newest = since.at(-1);
    found.push({ environment, app: newest.app?.name || null, team: newest.teamId || "default", deploymentId: newest.deploymentId, modules });
  }
  return found;
}
