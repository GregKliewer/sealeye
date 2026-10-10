// api/db.js
// The API's Postgres, when DATABASE_URL is set (PHASE1-PLAN Step 10, D5). Without it the
// API keeps its records in ~/.sealeye/deployments.json and its interviews in memory, as
// before, which is what `npm start` on a laptop and `npm test` use.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

let pool = null;

/** The database address, or null when the API runs without one. */
export function databaseUrl() {
  return process.env.DATABASE_URL || null;
}

/** The shared connection pool. Throws when there is no database. */
export function db() {
  if (!pool) {
    const url = databaseUrl();
    if (!url) throw new Error("DATABASE_URL is not set");
    pool = new pg.Pool({ connectionString: url, max: 5 });
    // A connection that drops while idle is the pool's to replace, not the API's to die of.
    pool.on("error", err => console.error(`database connection lost: ${err.message}`));
  }
  return pool;
}

/**
 * Apply every migration in api/migrations/ that has not been applied, in name order,
 * each in its own transaction. Plain SQL, recorded in schema_migrations.
 *
 * @returns {Promise<string[]>} the migrations applied now
 */
export async function migrate(client = db()) {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map(r => r.name));
  const applied = [];

  for (const name of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql")).sort()) {
    if (done.has(name)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS, name), "utf8");
    const conn = await client.connect();
    try {
      await conn.query("BEGIN");
      await conn.query(sql);
      await conn.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      await conn.query("COMMIT");
      applied.push(name);
    } catch (err) {
      await conn.query("ROLLBACK").catch(() => {});
      throw new Error(`migration ${name} failed: ${err.message}`);
    } finally {
      conn.release();
    }
  }
  return applied;
}

/** Close the pool, for tests and shutdown. */
export async function closeDb() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}
