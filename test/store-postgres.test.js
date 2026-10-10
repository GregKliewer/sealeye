// The deployment store on Postgres: records written by one API process are there for
// the next, with the columns the pilot needs beside them. Needs a Postgres server
// (test/helpers/pg.js); skipped without one. No AWS.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";

import { freshDatabase, pgAvailable } from "./helpers/pg.js";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");

async function inChild(databaseUrl, code) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-pgstore-"));
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", code], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: databaseUrl, SEALEYE_HOME: home, HOME: home }
  });
  return stdout.trim();
}

test("records outlive the process that wrote them, with their columns", { skip: !pgAvailable && "no SEALEYE_TEST_DATABASE_URL" }, async () => {
  const url = await freshDatabase();

  await inChild(url, `
    import { openStore, putDeployment, flushStore } from "./api/store.js";
    await openStore();
    putDeployment({ deploymentId: "dep_000000000001", status: "succeeded", app: { name: "site" }, startedAt: "2026-10-10T10:00:00Z",
      requestedBy: { user: "greg" }, origin: { traceId: "abc" } });
    putDeployment({ deploymentId: "dep_000000000002", status: "running", app: { name: "api" }, startedAt: "2026-10-10T11:00:00Z" });
    putDeployment({ deploymentId: "dep_000000000001", status: "destroyed", app: { name: "site" }, startedAt: "2026-10-10T10:00:00Z",
      requestedBy: { user: "greg" }, origin: { traceId: "abc" } });
    await flushStore();
    process.exit(0);
  `);

  const out = await inChild(url, `
    import { openStore, listDeployments } from "./api/store.js";
    const opened = await openStore();
    console.log(JSON.stringify({ opened, list: listDeployments().map(d => [d.deploymentId, d.status, Boolean(d.interrupted)]) }));
    process.exit(0);
  `);
  const { opened, list } = JSON.parse(out);
  assert.equal(opened.kind, "postgres");
  assert.deepEqual(opened.migrations, [], "already applied by the first process");
  assert.deepEqual(list, [
    ["dep_000000000002", "running", true],
    ["dep_000000000001", "destroyed", false]
  ]);

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const { rows } = await client.query("SELECT deployment_id, org_id, team_id, created_by, surface, trace_id, app, status FROM deployments ORDER BY deployment_id");
  await client.end();
  assert.deepEqual(rows[0], {
    deployment_id: "dep_000000000001", org_id: "default", team_id: "default", created_by: "greg",
    surface: "cli", trace_id: "abc", app: "site", status: "destroyed"
  });
});

test("the first start on a database brings in the API's old deployments.json, once", { skip: !pgAvailable && "no SEALEYE_TEST_DATABASE_URL" }, async () => {
  const url = await freshDatabase();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-pgadopt-"));
  fs.writeFileSync(path.join(home, "deployments.json"), JSON.stringify([
    { deploymentId: "dep_aaaaaaaaaaaa", status: "succeeded", startedAt: "2026-10-10T10:00:00Z" }
  ]));
  const go = async () => {
    const { stdout } = await run(process.execPath, ["--input-type=module", "-e", `
      import { openStore } from "./api/store.js";
      console.log(JSON.stringify(await openStore())); process.exit(0);`],
      { cwd: root, env: { ...process.env, DATABASE_URL: url, SEALEYE_HOME: home, HOME: home } });
    return JSON.parse(stdout.trim());
  };
  const first = await go();
  assert.equal(first.adopted, 1);
  assert.equal(first.records, 1);
  const second = await go();
  assert.equal(second.adopted, undefined);
  assert.equal(second.records, 1);
});

test("an old deployments.json that cannot all be brought in brings in nothing, and the next start tries again", { skip: !pgAvailable && "no SEALEYE_TEST_DATABASE_URL" }, async () => {
  const url = await freshDatabase();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-pgadopt-bad-"));
  const file = path.join(home, "deployments.json");
  const good = { deploymentId: "dep_aaaaaaaaaaaa", status: "succeeded", startedAt: "2026-10-10T10:00:00Z", app: { name: "a\u0000b" } };
  // A start time Postgres will not take makes the second record's insert fail.
  fs.writeFileSync(file, JSON.stringify([good, { deploymentId: "dep_bbbbbbbbbbbb", status: "failed", startedAt: "not a time" }]));
  const go = async () => {
    const { stdout } = await run(process.execPath, ["--input-type=module", "-e", `
      import { openStore, listDeployments } from "./api/store.js";
      const opened = await openStore();
      console.log(JSON.stringify({ opened, apps: listDeployments().map(d => d.app?.name) })); process.exit(0);`],
      { cwd: root, env: { ...process.env, DATABASE_URL: url, SEALEYE_HOME: home, HOME: home } });
    return JSON.parse(stdout.trim());
  };

  const first = await go();
  assert.equal(first.opened.adopted, undefined);
  assert.equal(first.opened.records, 0, "not half of it");

  fs.writeFileSync(file, JSON.stringify([good, { deploymentId: "dep_bbbbbbbbbbbb", status: "failed", startedAt: "2026-10-10T11:00:00Z" }]));
  const second = await go();
  assert.equal(second.opened.adopted, 2);
  assert.deepEqual(second.apps.sort(), ["ab", null], "a NUL in a string is dropped rather than refusing the record");
});

test("a change made while the database was away is saved once it is back", { skip: !pgAvailable && "no SEALEYE_TEST_DATABASE_URL" }, async () => {
  const url = await freshDatabase();
  const out = await inChild(url, `
    import pg from "pg";
    import { openStore, putDeployment, flushStore } from "./api/store.js";
    await openStore();
    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    // The table is out of reach, as it would be with the database down.
    await admin.query("ALTER TABLE deployments RENAME TO deployments_away");
    putDeployment({ deploymentId: "dep_000000000001", status: "running", startedAt: "2026-10-10T10:00:00Z" });
    const whileAway = await flushStore();
    await admin.query("ALTER TABLE deployments_away RENAME TO deployments");
    const afterwards = await flushStore();
    const { rows } = await admin.query("SELECT status FROM deployments");
    await admin.end();
    console.log(JSON.stringify({ whileAway, afterwards, rows }));
    process.exit(0);
  `);
  const { whileAway, afterwards, rows } = JSON.parse(out.split("\n").at(-1));
  assert.deepEqual(whileAway, ["dep_000000000001"], "reported as not saved");
  assert.deepEqual(afterwards, []);
  assert.deepEqual(rows, [{ status: "running" }]);
});
