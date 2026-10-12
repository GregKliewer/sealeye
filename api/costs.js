// api/costs.js
// What each app has cost (PHASE2-PLAN Step 20), from Cost Explorer by the sealeye:app
// and sealeye:team tags every environment carries from its next deploy. A team's token
// sees its team's apps; an organization-wide token every team's. Read from AWS when
// asked, kept for an hour (each call to Cost Explorer is charged), and about a day
// behind, which every answer says. Only what carries the tags is counted.
import { costsByTag } from "./executor/cfn.js";

export const COST_WINDOWS = { "7d": 7, "30d": 30 };
const KEEP_MS = 60 * 60 * 1000;
const kept = new Map();

const NOTE = "Costs are about a day behind. Only what carries seaLeye's tags is counted: each API's function, logs and address, and each site's storage. An environment gets its tags the next time it is deployed, and your platform team turns them on for billing once.";

const day = ms => new Date(ms).toISOString().slice(0, 10);
const tagValue = key => String(key || "").split("$").slice(1).join("$");

export async function readCosts(caller, { window = "30d", now = Date.now() } = {}) {
  const days = COST_WINDOWS[window];
  if (!days) return { status: 400, body: { error: { code: "INVALID_WINDOW", message: `since must be one of ${Object.keys(COST_WINDOWS).join(", ")}` } } };
  const everyTeam = !caller || caller.scope === "org";
  const team = everyTeam ? null : caller.team;
  const key = `${caller?.org || "default"}|${team || "*"}|${window}|${day(now)}`;
  const hit = kept.get(key);
  if (hit && now - hit.at < KEEP_MS) return { status: 200, body: { ...hit.body, readAt: new Date(hit.at).toISOString() } };

  const end = day(now + 86_400_000);              // through today; the end is exclusive
  const start = day(now - (days - 1) * 86_400_000);
  const read = await costsByTag({ start, end, team });
  if (!read.ok) {
    return { status: 502, body: { error: { code: "COSTS_UNAVAILABLE", message: `The platform could not read costs just now (${read.error}). ${/AccessDenied|not authorized/i.test(read.error) ? "The platform's role may not be allowed to read costs yet." : ""}`.trim() } } };
  }

  const apps = new Map();
  let unit = "USD";
  for (const g of read.groups) {
    const [teamKey, appKey] = everyTeam ? g.keys : [`sealeye:team$${team}`, g.keys[0]];
    const app = tagValue(appKey);
    if (!app) continue;                            // not one of seaLeye's
    const t = tagValue(teamKey) || "default";
    const id = `${t}/${app}`;
    const row = apps.get(id) || { app, team: t, amount: 0 };
    row.amount += g.amount;
    unit = g.unit || unit;
    apps.set(id, row);
  }
  const rows = [...apps.values()].map(r => ({ ...r, amount: Number(r.amount.toFixed(2)) })).sort((a, b) => b.amount - a.amount || a.app.localeCompare(b.app));
  const body = {
    since: window, from: start, to: day(now), unit, everyTeam, team,
    total: Number(rows.reduce((a, r) => a + r.amount, 0).toFixed(2)),
    apps: rows,
    note: NOTE
  };
  kept.set(key, { at: now, body });
  return { status: 200, body: { ...body, readAt: new Date(now).toISOString() } };
}
