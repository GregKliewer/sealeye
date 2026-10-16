// api/catalog-use.js
// Which environments a catalog would stop building, were it made live (PHASE4-PLAN Step
// 7, DESIGN.md "A catalog goes live through a self-test, approved and made live apart").
// An environment running on a module the new live catalog does not build could not be
// deployed again (CATALOG_CHANGED) and would be refused at its next plan, so making that
// catalog live is refused, naming each one, until they are torn down or the catalog
// builds what they use.
import { isBuildable } from "../core/catalog.js";
import { IN_FLIGHT } from "./store.js";
import { replacements } from "./replaced.js";

/** The modules a record's environment runs: its plan's, or for an older record, what it resolved. */
const modulesOf = record =>
  Array.isArray(record.plan?.modules)
    ? record.plan.modules.filter(m => m && m.enabled !== false).map(m => m.id)
    : (record.resolvedModules || []).map(m => m?.id).filter(Boolean);

/**
 * Each of an organization's environments that runs, or is being built with, a module
 * `document` does not build: its newest successful deploy, or one under way. A failed
 * deploy left the environment as it was, so the success before it is the one counted.
 *
 * @returns {{ environment: string, app: string | null, team: string, deploymentId: string, modules: string[] }[]}
 */
export function environmentsDropped({ org, document, records }) {
  const ours = records.filter(r => (r.orgId || "default") === org);
  const replaced = replacements(ours);
  const found = new Map();
  for (const r of ours) {
    const running = r.status === "succeeded" && !replaced.has(r.deploymentId);
    const underWay = IN_FLIGHT.has(r.status) && r.status !== "destroying";
    if (!running && !underWay) continue;
    const dropped = modulesOf(r).filter(id => !isBuildable(id, document));
    if (!dropped.length) continue;
    const key = r.stackName || r.environment || r.deploymentId;
    const seen = found.get(key);
    const modules = [...new Set([...(seen?.modules || []), ...dropped])];
    found.set(key, { environment: key, app: r.app?.name || null, team: r.teamId || "default", deploymentId: r.deploymentId, modules });
  }
  return [...found.values()];
}
