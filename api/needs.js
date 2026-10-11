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
 * @returns {{org: string, generatedAt: string, apps: number, needs: object[]}}
 */
export function rollupNeeds(records = listDeployments()) {
  const catalog = loadCatalog();
  const lineFor = Object.fromEntries(needKinds(catalog).map(n => [n.key, n.line]));

  // Newest drafted record per app, so a rerun does not count twice.
  const newestByApp = new Map();
  for (const dep of records) {           // newest first
    if (dep.status !== "drafted") continue;
    const name = dep.app?.name;
    if (!name || newestByApp.has(name)) continue;
    newestByApp.set(name, dep);
  }

  const byKind = new Map();
  for (const dep of newestByApp.values()) {
    const profile = normalizeProfile(dep.plan?.profile) || null;
    const when = dep.startedAt || dep.finishedAt || null;

    for (const need of dep.needs || dep.plan?.needs || []) {
      const kind = need.kind;
      if (!kind) continue;
      const entry = byKind.get(kind) || { kind, line: lineFor[kind] || need.line, apps: [], count: 0, firstSeen: null, lastSeen: null };

      entry.apps.push({
        name: dep.app.name,
        deploymentId: dep.deploymentId,
        when,
        profile,
        evidence: need.evidence || [],
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
