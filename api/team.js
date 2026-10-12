// api/team.js
// The people on your team (PHASE2-PLAN Step 19): from the tokens the administrator has
// issued, the ones still in use, by person. Names, emails, when each was first given a
// token and last used one; never a token or its hash. A team's token sees its own team;
// an organization-wide token sees every team in its organization, each saying whose.
// Issuing and revoking stay with the administrator (deploy/server.sh token).
import { listTokens } from "./tokens.js";

export async function peopleOf(caller) {
  if (!caller) return { team: null, people: [], note: "This platform does not ask who is calling, so it has no team to show." };
  const active = (await listTokens()).filter(t => !t.revokedAt && (t.org || "default") === caller.org);
  const visible = caller.scope === "org" ? active : active.filter(t => (t.team || "default") === caller.team);

  // One row per person and team: the earliest token they were given, the latest use of any.
  const people = new Map();
  for (const t of visible) {
    const key = `${t.team || "default"} ${String(t.email).toLowerCase()}`;
    const seen = people.get(key);
    const row = seen || { name: t.name || null, email: t.email, team: t.team || "default", scope: "team", issuedAt: t.createdAt || null, lastUsedAt: null };
    if (t.scope === "org") row.scope = "org";
    if (t.createdAt && (!row.issuedAt || t.createdAt < row.issuedAt)) row.issuedAt = t.createdAt;
    if (t.lastUsedAt && (!row.lastUsedAt || t.lastUsedAt > row.lastUsedAt)) row.lastUsedAt = t.lastUsedAt;
    people.set(key, row);
  }
  const rows = [...people.values()].sort((a, b) => a.team.localeCompare(b.team) || String(a.name || a.email).localeCompare(String(b.name || b.email)));
  return { team: caller.scope === "org" ? null : caller.team, everyTeam: caller.scope === "org", people: rows };
}
