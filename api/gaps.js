// api/gaps.js
// The gap report (PHASE4-PLAN Step 10; DESIGN.md, "The gap report"): what developers
// asked for that the live catalog cannot build, by how often and which teams, and what
// the library has for each. Read-only, from the needs ledger and the live catalog; it
// talks to nothing. An organization-wide token's only (Greg, Oct 22, 2026).
//
// A need is met when an offered module the platform builds says it meets it (`meets`,
// which discovery writes: DESIGN.md, "Discovery records which needs each module
// meets"). Every drafted plan is judged against the live catalog, whatever catalog it
// was drafted against, so a need a newer catalog builds is not a gap: it is listed apart,
// with the apps that can be planned again.
import { isBuildable } from "../core/catalog.js";
import { checklistPlace } from "../core/gap-words.js";
import { terraformBuilds } from "../core/terraform-modules.js";
import { rollupNeeds } from "./needs.js";

/** Why the platform does not build a module that meets a need, in the platform team's words. */
export function whyNotBuilt(module, catalog) {
  if (module.availability !== "available") return "it is deprecated";
  if (Array.isArray(module.open) && module.open.length) return "it rests on a question not yet answered";
  if (module.builds_with === "terraform") {
    const why = terraformBuilds(module, catalog?.platform || {}).why;
    if (why) return why;
  }
  return "the platform has no way to build it";
}

/**
 * @param {object[]} records  the organization's deployments, newest first
 * @param {{ catalog: object, version: number|string, source: string }} live
 *        the organization's live catalog (with its platform values beside it), and which
 * @returns {object}
 */
export function gapReport(records, { catalog, version, source }) {
  const ledger = rollupNeeds(records, { viewer: null, catalog });
  const modules = Array.isArray(catalog?.modules) ? catalog.modules.filter(Boolean) : [];
  // The starter's modules meet no need: every need is, by its definition, beyond them.
  // An organization's catalog says, once discovery has written `meets`.
  const mapped = source === "starter" || modules.some(m => Array.isArray(m.meets));

  const gaps = [];
  const met = [];
  for (const need of ledger.needs) {
    const apps = need.apps.map(a => ({ name: a.name, team: a.team, deploymentId: a.deploymentId, when: a.when }));
    const teams = [...new Set(apps.map(a => a.team))].sort().map(team => ({ team, apps: apps.filter(a => a.team === team).map(a => a.name) }));
    const base = { kind: need.kind, listed: need.listed, line: need.line, count: need.count, teams, apps, firstSeen: need.firstSeen, lastSeen: need.lastSeen };
    if (!need.listed) {
      gaps.push({ ...base, library: { status: "unlisted", modules: [] } });
      continue;
    }
    const meeting = modules.filter(m => Array.isArray(m.meets) && m.meets.includes(need.kind));
    const built = meeting.filter(m => isBuildable(m.id, catalog));
    if (built.length) {
      met.push({ kind: need.kind, line: need.line, count: need.count, modules: built.map(m => m.id), apps });
      continue;
    }
    gaps.push({
      ...base,
      library: !mapped
        ? { status: "unknown", modules: [] }
        : meeting.length
          ? { status: "not_built", modules: meeting.map(m => ({ id: m.id, why: whyNotBuilt(m, catalog) })) }
          : { status: "nothing", modules: [] }
    });
  }

  // An app the live catalog meets one need of may still wait on others: planning it again
  // drafts it again until those are met too (the first report on the pilot, Oct 22, 2026:
  // a database built now, for an app still waiting on a service that runs continuously).
  const gapsOf = new Map();
  for (const g of gaps) for (const a of g.apps) {
    const key = `${a.team}/${a.name}`;
    gapsOf.set(key, [...(gapsOf.get(key) || []), g.line]);
  }
  for (const m of met) for (const a of m.apps) {
    const waiting = gapsOf.get(`${a.team}/${a.name}`) || [];
    if (waiting.length) a.stillWaiting = waiting;
  }

  // Demand first: how many apps, then how many teams, then the checklist.
  gaps.sort((a, b) =>
    b.count - a.count ||
    b.teams.length - a.teams.length ||
    checklistPlace(a.kind) - checklistPlace(b.kind) ||
    String(a.kind).localeCompare(String(b.kind))
  );
  // What put a gap ahead of the one after it, when the apps alone did not.
  gaps.forEach((g, i) => {
    const next = gaps[i + 1];
    g.rank = i + 1;
    g.tieBrokenBy = !next || next.count !== g.count ? null : next.teams.length !== g.teams.length ? "teams" : checklistPlace(next.kind) !== checklistPlace(g.kind) ? "checklist" : null;
  });

  return {
    catalog: { version, source, mapped },
    generatedAt: new Date().toISOString(),
    apps: ledger.apps,
    gaps,
    met
  };
}
