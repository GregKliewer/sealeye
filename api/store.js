// api/store.js
// Deployment records. The API reads them from a map in memory, so every function here
// stays synchronous and nothing that calls them had to change. What backs the map:
//
// - Postgres, when DATABASE_URL is set (PHASE1-PLAN Step 10, D5): every change is
//   written through to the deployments table, in order, and the map is filled from it
//   at start (openStore).
// - ~/.sealeye/deployments.json otherwise, mirrored on every change, as before. This is
//   the laptop API and `npm test`.
//
// The map is the one process's view: correct while the API is one process, which the
// pilot server is. ECS Express Mode (stage 3) runs more than one, and the store then
// has to read from Postgres instead (DESIGN.md, "Deployment records live in Postgres").
import fs from "node:fs";
import path from "node:path";

import { sealeyeHome, legacyHome } from "../core/config.js";
import { databaseUrl, db, migrate } from "./db.js";

const STORE_DIR = sealeyeHome();
const STORE_FILE = path.join(STORE_DIR, "deployments.json");

// Before 2.17.0 the store was ~/.deployme/deployments.json. The first time the API
// starts with no store of its own and an old one beside it, it copies the old one in,
// so nobody's environments disappear from `sealeye list`. A copy, not a move: the old
// file is left exactly as it was, and nothing ever writes to it again.
export function adoptLegacyStore(storeFile = STORE_FILE, legacyFile = path.join(legacyHome(), "deployments.json")) {
  if (fs.existsSync(storeFile) || !fs.existsSync(legacyFile)) return false;
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  fs.copyFileSync(legacyFile, storeFile);
  console.error(`deployment store: copied ${legacyFile} to ${storeFile}`);
  return true;
}

// A deployment that was in flight when the API stopped has nobody polling it any
// more, so its stored status is the last thing we actually knew, not the truth now.
// It is marked so until the executor picks it up again (executor/resume.js).
export const IN_FLIGHT = new Set(["queued", "packaging", "running", "destroying"]);

const markInterrupted = dep => (IN_FLIGHT.has(dep.status) ? { ...dep, interrupted: true } : dep);

/** Read a deployments.json, as an array of records. Never throws for a missing file. */
export function readStoreFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const records = JSON.parse(raw);
  if (!Array.isArray(records)) throw new Error("expected an array of deployments");
  return records.filter(dep => dep && dep.deploymentId);
}

function loadFile() {
  // Only for the default home: a SEALEYE_HOME set on purpose starts where it says.
  if (!process.env.SEALEYE_HOME && !process.env.DEPLOYME_HOME) {
    try {
      adoptLegacyStore();
    } catch (err) {
      console.error(`could not copy the old deployment store: ${err.message}`);
    }
  }

  try {
    return readStoreFile(STORE_FILE).map(dep => [dep.deploymentId, markInterrupted(dep)]);
  } catch (err) {
    // Never start by silently overwriting something we could not read.
    const backup = `${STORE_FILE}.corrupt`;
    try {
      fs.renameSync(STORE_FILE, backup);
      console.error(`deployment store unreadable (${err.message}); moved it to ${backup}`);
    } catch {
      console.error(`deployment store unreadable (${err.message})`);
    }
    return [];
  }
}

const usingDatabase = Boolean(databaseUrl());
const deployments = new Map(usingDatabase ? [] : loadFile());

// ---------------------------------------------------------------------------------
// Writing.

function persistFile() {
  const tmp = `${STORE_FILE}.tmp`;
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    // Write then rename, so a crash mid-write cannot leave a half-written store.
    fs.writeFileSync(tmp, JSON.stringify([...deployments.values()], null, 2));
    fs.renameSync(tmp, STORE_FILE);
  } catch (err) {
    // The deployment itself is unaffected; only the record of it failed to save.
    console.error(`could not write ${STORE_FILE}: ${err.message}`);
  }
}

/**
 * The columns written beside each record. Until sign-in (Step 13) there is one
 * organization and one team; the record's own fields, when it has them, win.
 */
export function recordColumns(dep) {
  return {
    org_id: dep.orgId || "default",
    team_id: dep.teamId || "default",
    created_by: dep.requestedBy?.user || null,
    surface: dep.surface || dep.origin?.surface || "cli",
    trace_id: dep.origin?.traceId || null,
    app: dep.app?.name || (typeof dep.app === "string" ? dep.app : null),
    status: String(dep.status || "unknown"),
    started_at: dep.startedAt || null
  };
}

// Writes go out one after another, so the table always ends with the last thing the
// map said. A failed write is logged and the next write of that record repairs it.
let writes = Promise.resolve();

function persistRow(dep) {
  const snapshot = JSON.parse(JSON.stringify(dep));
  const c = recordColumns(snapshot);
  writes = writes
    .then(() =>
      db().query(
        `INSERT INTO deployments (deployment_id, org_id, team_id, created_by, surface, trace_id, app, status, started_at, record, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
         ON CONFLICT (deployment_id) DO UPDATE SET
           org_id = EXCLUDED.org_id, team_id = EXCLUDED.team_id, created_by = EXCLUDED.created_by,
           surface = EXCLUDED.surface, trace_id = EXCLUDED.trace_id, app = EXCLUDED.app,
           status = EXCLUDED.status, started_at = EXCLUDED.started_at, record = EXCLUDED.record,
           updated_at = now()`,
        [snapshot.deploymentId, c.org_id, c.team_id, c.created_by, c.surface, c.trace_id, c.app, c.status, c.started_at, snapshot]
      )
    )
    .catch(err => console.error(`could not save deployment ${snapshot.deploymentId}: ${err.message}`));
  return writes;
}

/** Wait until every change so far is in the database. For shutdown and tests. */
export function flushStore() {
  return usingDatabase ? writes : Promise.resolve();
}

// ---------------------------------------------------------------------------------
// The functions everything else uses.

/**
 * Get the store ready. With a database: apply migrations and load every record. With a
 * file: nothing to do, it was read at import. Call once, before serving.
 */
export async function openStore() {
  if (!usingDatabase) return { kind: "file", records: deployments.size };
  const applied = await migrate();

  // The first start on a database, where this API kept a deployments.json before: its
  // records come with it, so an API moving to Postgres loses nothing it knew. Only into
  // an empty table, so it happens once. The file is left as it was.
  let adopted = 0;
  const existing = Number((await db().query("SELECT count(*) AS n FROM deployments")).rows[0].n);
  if (existing === 0 && fs.existsSync(STORE_FILE)) {
    try {
      for (const dep of readStoreFile(STORE_FILE)) {
        putDeployment(dep);
        adopted++;
      }
      await flushStore();
      deployments.clear();
    } catch (err) {
      console.error(`could not bring ${STORE_FILE} into the database: ${err.message}`);
    }
  }

  const { rows } = await db().query("SELECT record FROM deployments");
  deployments.clear();
  for (const { record } of rows) deployments.set(record.deploymentId, markInterrupted(record));
  return { kind: "postgres", records: deployments.size, migrations: applied, ...(adopted ? { adopted, from: STORE_FILE } : {}) };
}

export function putDeployment(dep) {
  deployments.set(dep.deploymentId, dep);
  if (usingDatabase) persistRow(dep);
  else persistFile();
  return dep;
}

export function getDeployment(id) {
  return deployments.get(id);
}

/** Every known deployment, newest first. */
export function listDeployments() {
  return [...deployments.values()].sort((a, b) =>
    String(b.startedAt || "").localeCompare(String(a.startedAt || ""))
  );
}

/** How many deployments the store is holding. Reading it is what /health checks. */
export function count() {
  return deployments.size;
}

/** Where records live, for the start-up line. */
export const storeFile = usingDatabase ? "Postgres (DATABASE_URL)" : STORE_FILE;
