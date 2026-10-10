// A fresh Postgres database for one test file, or null when none is available.
//
// Tests that need Postgres run only when SEALEYE_TEST_DATABASE_URL points at a server
// they may create databases on (CI sets it; on a laptop, set it to a local Postgres).
// Without it they are skipped, so `npm test` still needs nothing but Node.
import crypto from "node:crypto";
import pg from "pg";

export const pgAvailable = Boolean(process.env.SEALEYE_TEST_DATABASE_URL);

export async function freshDatabase() {
  const admin = process.env.SEALEYE_TEST_DATABASE_URL;
  if (!admin) return null;
  const name = `sealeye_test_${crypto.randomBytes(6).toString("hex")}`;
  const client = new pg.Client({ connectionString: admin });
  await client.connect();
  await client.query(`CREATE DATABASE ${name}`);
  await client.end();
  const url = new URL(admin);
  url.pathname = `/${name}`;
  return url.toString();
}
