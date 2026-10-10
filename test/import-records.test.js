// Importing a laptop's deployments.json into the API's Postgres: added once, never
// twice, and anything that is not a deployment record left out. Needs a Postgres server
// (test/helpers/pg.js); skipped without one. No AWS.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { freshDatabase, pgAvailable } from "./helpers/pg.js";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");

test("a deployments.json imports once, and a second run adds nothing", { skip: !pgAvailable && "no SEALEYE_TEST_DATABASE_URL" }, async () => {
  const url = await freshDatabase();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-import-"));
  const file = path.join(home, "deployments.json");
  fs.writeFileSync(file, JSON.stringify([
    { deploymentId: "dep_111111111111", status: "succeeded", app: { name: "site" }, startedAt: "2026-10-01T10:00:00Z" },
    { deploymentId: "dep_222222222222", status: "destroyed", app: { name: "api" }, startedAt: "2026-10-02T10:00:00Z" },
    { not: "a record" }
  ]));
  const env = { ...process.env, DATABASE_URL: url, HOME: home, SEALEYE_HOME: home };

  const first = await run(process.execPath, ["scripts/import-records.js", file], { cwd: root, env });
  assert.match(first.stdout, /Read 2 records: added 2, already there 0\./);
  assert.match(first.stdout, /Left out 1/);

  const second = await run(process.execPath, ["scripts/import-records.js", file], { cwd: root, env });
  assert.match(second.stdout, /added 0, already there 2\./);

  const listed = await run(process.execPath, ["--input-type=module", "-e",
    `import { openStore, listDeployments } from "./api/store.js"; await openStore(); console.log(listDeployments().map(d => d.deploymentId).join(",")); process.exit(0);`],
    { cwd: root, env });
  assert.equal(listed.stdout.trim(), "dep_222222222222,dep_111111111111");
});
