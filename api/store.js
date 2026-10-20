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

/**
 * A record as Postgres will take it: a deep copy with every NUL character removed from
 * its strings. jsonb refuses "\u0000", which can arrive in a stack event's reason or an
 * app's name, and one refused record must not stop the rest from being saved.
 */
export function forDatabase(record) {
  return JSON.parse(JSON.stringify(record, (_key, value) =>
    typeof value === "string" ? value.replace(/\u0000/g, "") : value));
}

const UPSERT = `INSERT INTO deployments (deployment_id, org_id, team_id, created_by, surface, trace_id, app, status, started_at, record, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
  ON CONFLICT (deployment_id) DO UPDATE SET
    org_id = EXCLUDED.org_id, team_id = EXCLUDED.team_id, created_by = EXCLUDED.created_by,
    surface = EXCLUDED.surface, trace_id = EXCLUDED.trace_id, app = EXCLUDED.app,
    status = EXCLUDED.status, started_at = EXCLUDED.started_at, record = EXCLUDED.record,
    updated_at = now()`;

function upsertArgs(dep) {
  const snapshot = forDatabase(dep);
  const c = recordColumns(snapshot);
  return [snapshot.deploymentId, c.org_id, c.team_id, c.created_by, c.surface, c.trace_id, c.app, c.status, c.started_at, snapshot];
}

// Writes go out one after another, so the table always ends with the last thing the
// map said. A record whose write failed stays in `unsaved` and is written again, from the
// map, with the next write of anything and at shutdown, so a database that was away for
// a moment ends up with every change rather than only the ones that happened to retry.
let writes = Promise.resolve();
// Each record waiting to be written, with the number of its latest change. A write marks
// its record saved only if no change came while it was under way: one that did is
// written again by the next pass. Without the number, a save made during a write was
// marked saved by that write and never reached the database, which a restart then lost
// (a Terraform build's report, saved a moment after its success; Oct 17, 2026).
const unsaved = new Map();
const failing = new Set();
let changes = 0;

async function writeOne(id) {
  const dep = deployments.get(id);
  if (!dep) return unsaved.delete(id);
  const change = unsaved.get(id);
  try {
    await db().query(UPSERT, upsertArgs(dep));
    if (unsaved.get(id) === change) unsaved.delete(id);
    failing.delete(id);
  } catch (err) {
    // Said once, not on every retry while the database is away.
    if (!failing.has(id)) console.error(`could not save deployment ${id}: ${err.message}`);
    failing.add(id);
  }
}

function persistRow(dep) {
  unsaved.set(dep.deploymentId, ++changes);
  writes = writes.then(async () => {
    for (const id of [...unsaved.keys()]) await writeOne(id);
  });
  return writes;
}

/**
 * Wait until every change so far is in the database, trying once more any that failed.
 * For shutdown and tests.
 *
 * @returns {Promise<string[]>} ids of records whose latest change could not be saved
 */
export async function flushStore() {
  if (!usingDatabase) return [];
  if (unsaved.size) {
    writes = writes.then(async () => {
      for (const id of [...unsaved.keys()]) await writeOne(id);
    });
  }
  await writes;
  return [...unsaved.keys()];
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
    // All or nothing, in one transaction: a record that cannot be written leaves the
    // table empty, so the next start tries again, rather than half the file arriving and
    // the rest never being looked at again.
    const conn = await db().connect();
    try {
      const records = readStoreFile(STORE_FILE);
      await conn.query("BEGIN");
      for (const dep of records) await conn.query(UPSERT, upsertArgs(dep));
      await conn.query("COMMIT");
      adopted = records.length;
    } catch (err) {
      await conn.query("ROLLBACK").catch(() => {});
      console.error(`could not bring ${STORE_FILE} into the database, so nothing from it was brought in; the next start tries again: ${err.message}`);
    } finally {
      conn.release();
    }
  }

  const { rows } = await db().query("SELECT record FROM deployments");
  deployments.clear();
  for (const { record } of rows) deployments.set(record.deploymentId, markInterrupted(record));
  return { kind: "postgres", records: deployments.size, migrations: applied, ...(adopted ? { adopted, from: STORE_FILE } : {}) };
}

// Whoever wants to know each time a record is saved (GET /deployments/events). This
// process's own saves only, as the store itself is one process's (DESIGN.md, "The
// portal follows changes as they happen").
const watchers = new Set();

/** Call `listener(record)` after each record is saved. Returns the function that stops it. */
export function onDeploymentSaved(listener) {
  watchers.add(listener);
  return () => watchers.delete(listener);
}

export function putDeployment(dep) {
  deployments.set(dep.deploymentId, dep);
  if (usingDatabase) persistRow(dep);
  else persistFile();
  // A listener that throws must not stop the save, or the others hearing of it.
  for (const listener of watchers) {
    try { listener(dep); } catch {}
  }
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
