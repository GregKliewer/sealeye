// scripts/import-records.js
// Copy deployment records from a deployments.json (the laptop API's store, or the old
// ~/.deployme one) into the API's Postgres. Records already there are left alone, so it
// is safe to run twice. Runs where DATABASE_URL reaches the database: on the server,
// `deploy/server.sh import <file>` does it. The API reads records at start, so restart
// it afterwards; that also picks up any imported deployment that was still in flight.
//
//   node scripts/import-records.js <file | ->
import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { closeDb, db, migrate } from "../api/db.js";
import { recordColumns } from "../api/store.js";

/** @returns {Promise<{ read: number, added: number, skipped: number }>} */
export async function importRecords(records) {
  await migrate();
  let added = 0;
  for (const dep of records) {
    const c = recordColumns(dep);
    const { rowCount } = await db().query(
      `INSERT INTO deployments (deployment_id, org_id, team_id, created_by, surface, trace_id, app, status, started_at, record)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (deployment_id) DO NOTHING`,
      [dep.deploymentId, c.org_id, c.team_id, c.created_by, c.surface, c.trace_id, c.app, c.status, c.started_at, dep]
    );
    added += rowCount;
  }
  return { read: records.length, added, skipped: records.length - added };
}

async function main() {
  const source = process.argv[2];
  if (!source) {
    console.error("usage: node scripts/import-records.js <deployments.json | ->");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set, so there is no database to import into.");
    process.exit(1);
  }
  const text = source === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(source, "utf8");
  const records = JSON.parse(text);
  if (!Array.isArray(records)) throw new Error("expected an array of deployment records");
  const valid = records.filter(dep => dep && typeof dep.deploymentId === "string" && /^dep_[0-9a-f]+$/.test(dep.deploymentId));

  const result = await importRecords(valid);
  console.log(`Read ${result.read} records: added ${result.added}, already there ${result.skipped}.`);
  if (records.length !== valid.length) console.log(`Left out ${records.length - valid.length} that were not deployment records.`);
  await closeDb();
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch(async err => {
    console.error(`Could not import: ${err.message}`);
    await closeDb().catch(() => {});
    process.exit(1);
  });
}
