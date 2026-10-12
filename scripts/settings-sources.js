// scripts/settings-sources.js
// The environments still live whose settings came from a developer's .env rather than
// the organization's store (PHASE2-PLAN Step 11, D5), for the administrator to follow
// up: each one's app, team, who last deployed it, and the setting names. Names only;
// a record never holds a value. `deploy/server.sh settings-sources` runs it on the server.
//
//   node scripts/settings-sources.js
import { pathToFileURL } from "node:url";

import { closeDb, databaseUrl, db } from "../api/db.js";
import { readStoreFile, storeFile } from "../api/store.js";

const LIVE = new Set(["succeeded", "running", "queued", "packaging"]);
const FROM_ENV = new Set(["sent", ".env"]);

/** Newest first, the latest record of each environment, and those still on .env values. */
export function stillOnEnv(records) {
  const latest = new Map();
  for (const r of [...records].sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")))) {
    if (r.stackName && !latest.has(r.stackName)) latest.set(r.stackName, r);
  }
  return [...latest.values()]
    .filter(r => LIVE.has(r.status))
    .map(r => ({ r, names: (r.settings || []).filter(s => FROM_ENV.has(s.source)).map(s => s.name) }))
    .filter(x => x.names.length)
    .map(({ r, names }) => ({
      app: r.app?.name || r.stackName,
      team: r.teamId || "default",
      deployedBy: r.requestedBy?.name || r.requestedBy?.user || "not recorded",
      deployedAt: r.startedAt || null,
      names
    }));
}

export async function main() {
  const records = databaseUrl()
    ? (await db().query("SELECT record FROM deployments")).rows.map(x => x.record)
    : readStoreFile(storeFile);
  const rows = stillOnEnv(records);
  if (!rows.length) return console.log("Every live environment reads its settings from the store, or has none.");
  console.log(`${rows.length} live environment${rows.length === 1 ? "" : "s"} still take settings from a developer's .env:`);
  for (const x of rows) {
    console.log(`  ${x.app} (team ${x.team}), last deployed by ${x.deployedBy} ${String(x.deployedAt || "").slice(0, 10)}: ${x.names.join(", ")}`);
  }
  console.log("Their next sealeye run offers to store them; or sealeye settings set NAME in the app's folder.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => closeDb())
    .catch(async err => { console.error(err.message); await closeDb(); process.exit(1); });
}
