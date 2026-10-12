// api/setting-changes.js
// Who changed which of an app's settings, when, and from which surface (PHASE2-PLAN
// Step 8). Names, actions and people only: the values are in the organization's store
// (api/executor/cfn.js) and nowhere else. Postgres when the API has a database, a file
// beside a laptop API otherwise, as for tokens.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { sealeyeHome } from "../core/config.js";
import { databaseUrl, db } from "./db.js";

const changesFile = () => path.join(sealeyeHome(), "setting-changes.json");

function readFile() {
  try {
    const rows = JSON.parse(fs.readFileSync(changesFile(), "utf8"));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/** Record one change. Never throws: the change itself has already happened. */
export async function recordSettingChange({ org, team, app, name, action, caller, surface }) {
  const row = {
    org, team, app, name, action,
    byEmail: caller?.email ?? null,
    byName: caller?.name ?? null,
    surface: surface || "cli",
    at: new Date().toISOString()
  };
  try {
    if (databaseUrl()) {
      await db().query(
        `INSERT INTO setting_changes (org_id, team_id, app, name, action, by_email, by_name, surface, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [row.org, row.team, row.app, row.name, row.action, row.byEmail, row.byName, row.surface, row.at]
      );
      return;
    }
    fs.mkdirSync(path.dirname(changesFile()), { recursive: true });
    const tmp = `${changesFile()}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...readFile(), row], null, 2), { mode: 0o600 });
    fs.renameSync(tmp, changesFile());
  } catch (err) {
    console.error(`could not record a setting change (${app} ${name} ${action}): ${err.message}`);
  }
}

/** The newest change to each setting of one team's app, by name. */
export async function lastChanges({ org, team, app }) {
  let rows;
  if (databaseUrl()) {
    const r = await db().query(
      `SELECT DISTINCT ON (name) name, action, by_email, by_name, surface, at
         FROM setting_changes WHERE org_id = $1 AND team_id = $2 AND app = $3
        ORDER BY name, at DESC, id DESC`,
      [org, team, app]
    );
    rows = r.rows.map(x => ({ name: x.name, action: x.action, byEmail: x.by_email, byName: x.by_name, surface: x.surface, at: new Date(x.at).toISOString() }));
  } else {
    rows = readFile().filter(x => x.org === org && x.team === team && x.app === app);
  }
  const latest = new Map();
  for (const x of rows) {
    const seen = latest.get(x.name);
    if (!seen || x.at >= seen.at) latest.set(x.name, x);
  }
  return latest;
}
