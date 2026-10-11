// src/needs.js
// The platform team's ledger: what the drafted plans across the organization are
// waiting on. Read from the store only; nothing here talks to AWS. An app that
// drafted three times counts once, and a need reads the way the catalog says it
// reads, so the same need reads one way everywhere.
import { listDeployments } from "./store.js";
import { loadCatalog, needKinds, profileExpectsFor, orgName } from "../core/catalog.js";
import { normalizeProfile } from "../core/schema.js";

/**
 * Roll the drafted plans up by need kind.
 *
 * Everyone in the organization sees every app and its needs. The evidence (file names
 * and lines from the app's code) and the deployment id are the app's team's: a viewer
 * on another team sees the app, its team and its needs, with no evidence and no id. An
 * organization-wide viewer, or none (a laptop API), sees all of it (DESIGN.md, "Each
 * team sees its own environments").
 *
 * @param {object[]} [records] newest first
 * @param {{viewer?: {org: string, team: string, scope: string} | null}} [options]
 * @returns {{org: string, generatedAt: string, apps: number, needs: object[]}}
 */
export function rollupNeeds(records = listDeployments(), { viewer = null } = {}) {
  const sees = dep => !viewer || viewer.scope === "org" || (dep.teamId || "default") === viewer.team;
  const catalog = loadCatalog();
  const lineFor = Object.fromEntries(needKinds(catalog).map(n => [n.key, n.line]));

  // Newest drafted record per app, so a rerun does not count twice. An app is a team's:
  // two teams' apps of the same name are two apps (DESIGN.md, "Each team's environments
  // have names of their own").
  const newestByApp = new Map();
  for (const dep of records) {           // newest first
    if (dep.status !== "drafted") continue;
    const name = dep.app?.name;
    const key = `${dep.orgId || "default"}/${dep.teamId || "default"}/${name}`;
    if (!name || newestByApp.has(key)) continue;
    newestByApp.set(key, dep);
  }

  const byKind = new Map();
  for (const dep of newestByApp.values()) {
    const profile = normalizeProfile(dep.plan?.profile) || null;
    const when = dep.startedAt || dep.finishedAt || null;

    for (const need of dep.needs || dep.plan?.needs || []) {
      const kind = need.kind;
      if (!kind) continue;
      const entry = byKind.get(kind) || { kind, line: lineFor[kind] || need.line, apps: [], count: 0, firstSeen: null, lastSeen: null };

      const own = sees(dep);
      entry.apps.push({
        name: dep.app.name,
        team: dep.teamId || "default",
        deploymentId: own ? dep.deploymentId : null,
        when,
        profile,
        evidence: own ? (need.evidence || []) : [],
        profile_expects: need.profile_expects || (profile ? profileExpectsFor(kind, profile, catalog) : null)
      });
      entry.count = entry.apps.length;
      if (when) {
        if (!entry.firstSeen || when < entry.firstSeen) entry.firstSeen = when;
        if (!entry.lastSeen || when > entry.lastSeen) entry.lastSeen = when;
      }
      byKind.set(kind, entry);
    }
  }

  const needs = [...byKind.values()].sort((a, b) =>
    b.count - a.count || String(a.firstSeen || "").localeCompare(String(b.firstSeen || ""))
  );

  return { org: orgName(), generatedAt: new Date().toISOString(), apps: newestByApp.size, needs };
}
