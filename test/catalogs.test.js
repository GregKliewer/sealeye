// Each organization's catalogs (PHASE4-PLAN Step 1): the catalog is data, an
// organization with none has the starter catalog word for word, and the API plans and
// refuses against the organization's live one. Postgres tests run only with
// SEALEYE_TEST_DATABASE_URL (test/helpers/pg.js). No AWS, no model.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import YAML from "yaml";
import pg from "pg";

import { catalogProblems, loadCatalog, starterCatalog, STARTER_VERSION } from "../core/catalog.js";
import { rollupNeeds } from "../api/needs.js";
import { freePort } from "./helpers/free-port.js";
import { freshDatabase, pgAvailable } from "./helpers/pg.js";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const fromFile = () => YAML.parse(fs.readFileSync(path.join(root, "prompts", "module-catalog.yaml"), "utf8"));

/** Run module code in a child with its own home (and database, when given). */
async function inChild(home, code, databaseUrl = undefined) {
  const env = { ...process.env, SEALEYE_HOME: home, HOME: home };
  delete env.DATABASE_URL;
  if (databaseUrl) env.DATABASE_URL = databaseUrl;
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", code], { cwd: root, env });
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

/** The starter catalog with one need kind's line reworded: an organization's own. */
function ownCatalog(line = "a store for the files your app keeps, of this organization's own") {
  const doc = fromFile();
  doc.need_kinds.find(n => n.key === "file_storage").line = line;
  doc.modules = doc.modules.filter(m => m.id !== "static_site_edge");
  return doc;
}

test("the starter catalog is prompts/module-catalog.yaml, word for word, and a catalog by its own rules", () => {
  assert.deepEqual(starterCatalog(), fromFile());
  assert.deepEqual(loadCatalog(), fromFile(), "the name every caller used before still reads the starter");
  assert.deepEqual(catalogProblems(starterCatalog()), []);
  assert.equal(STARTER_VERSION, "starter");
});

test("a document that is not a catalog says what is wrong with it", () => {
  assert.deepEqual(catalogProblems(null), ["a catalog is a document of named parts"]);
  assert.deepEqual(catalogProblems({}), ["modules is a list", "need_kinds is a list"]);
  const doc = fromFile();
  doc.modules.push({ ...doc.modules[0] }, { id: "Bad Id", line: "x" }, { id: "no_line" });
  doc.need_kinds.push({ key: "file_storage", line: "again" }, { line: "no key" });
  assert.deepEqual(catalogProblems(doc), [
    "module static_site_edge is listed twice",
    "module Bad Id: an id is lowercase letters, digits and underscores",
    "module no_line has no line",
    "need kind file_storage is listed twice",
    `need kind ${fromFile().need_kinds.length + 2} has no key`
  ]);
});

const LIFECYCLE = `
  import { openCatalogs, liveCatalog, catalogsOf, addCatalog, approveCatalog, makeLive } from "./api/catalogs.js";
  const doc = JSON.parse(process.env.DOC);
  const out = {};
  await openCatalogs();
  out.before = liveCatalog("acme");
  const v1 = await addCatalog({ org: "acme", document: doc, by: "discovery" });
  out.draftServed = liveCatalog("acme").source;
  out.notDraft = await makeLive({ org: "acme", version: v1.version }).catch(e => e.code);
  out.noApprover = await approveCatalog({ org: "acme", version: v1.version }).catch(e => e.code);
  await approveCatalog({ org: "acme", version: v1.version, by: "pat@example.com" });
  await makeLive({ org: "acme", version: v1.version });
  out.v1 = liveCatalog("acme");
  const v2 = await addCatalog({ org: "acme", document: { ...doc, catalogVersion: "two" } });
  await approveCatalog({ org: "acme", version: v2.version, by: "pat@example.com" });
  await makeLive({ org: "acme", version: v2.version });
  out.v2 = liveCatalog("acme");
  out.list = catalogsOf("acme").map(c => [c.version, c.status, c.approvedBy]);
  out.other = liveCatalog("other").source;
  out.invalid = await addCatalog({ org: "acme", document: { modules: [] } }).catch(e => [e.code, e.problems]);
  out.unknown = await approveCatalog({ org: "acme", version: 9, by: "x" }).catch(e => e.code);
  console.log(JSON.stringify(out));
  process.exit(0);
`;
const AFTER = `
  import { openCatalogs, liveCatalog, catalogsOf } from "./api/catalogs.js";
  await openCatalogs();
  console.log(JSON.stringify({ live: liveCatalog("acme"), list: catalogsOf("acme").map(c => [c.version, c.status]) }));
  process.exit(0);
`;

function checkLifecycle(out, doc) {
  assert.equal(out.before.source, "starter");
  assert.equal(out.before.version, "starter");
  assert.deepEqual(out.before.document, fromFile(), "an organization with no catalog gets the starter, word for word");
  assert.equal(out.draftServed, "starter", "a draft is never what the API plans against");
  assert.equal(out.notDraft, "CATALOG_STATUS", "only an approved catalog goes live");
  assert.equal(out.noApprover, "CATALOG_APPROVER");
  assert.equal(out.v1.source, "organization");
  assert.equal(out.v1.version, 1);
  assert.equal(out.v1.approvedBy, "pat@example.com");
  assert.deepEqual(out.v1.document, doc);
  assert.equal(out.v2.version, 2);
  assert.equal(out.v2.document.catalogVersion, "two");
  assert.deepEqual(out.list, [[1, "retired", "pat@example.com"], [2, "live", "pat@example.com"]], "one live catalog: the one it replaced is retired");
  assert.equal(out.other, "starter", "one organization's catalog is never another's");
  assert.equal(out.invalid[0], "CATALOG_INVALID");
  assert.ok(out.invalid[1].includes("need_kinds is a list"));
  assert.equal(out.unknown, "CATALOG_NOT_FOUND");
}

test("a catalog is a draft, then approved, then live, and outlives the API in its file", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-catalogs-"));
  const doc = ownCatalog();
  process.env.DOC = JSON.stringify(doc);
  try {
    checkLifecycle(await inChild(home, LIFECYCLE), doc);
    const again = await inChild(home, AFTER);
    assert.equal(again.live.version, 2);
    assert.deepEqual(again.list, [[1, "retired"], [2, "live"]]);
    assert.equal(fs.statSync(path.join(home, "catalogs.json")).mode & 0o777, 0o600);
  } finally {
    delete process.env.DOC;
  }
});

test("on Postgres, the same, with one live catalog per organization held by the database", { skip: !pgAvailable && "no SEALEYE_TEST_DATABASE_URL" }, async () => {
  const url = await freshDatabase();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-catalogs-pg-"));
  const doc = ownCatalog();
  process.env.DOC = JSON.stringify(doc);
  try {
    // The migrations are the store's to run, before the catalogs are read.
    await inChild(home, `import { openStore } from "./api/store.js"; await openStore(); console.log("{}"); process.exit(0);`, url);
    checkLifecycle(await inChild(home, LIFECYCLE, url), doc);
    const again = await inChild(home, AFTER, url);
    assert.equal(again.live.version, 2);
    assert.deepEqual(again.live.document, { ...doc, catalogVersion: "two" });
    assert.ok(!fs.existsSync(path.join(home, "catalogs.json")), "with a database, no file");

    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await assert.rejects(client.query("UPDATE catalogs SET status = 'live' WHERE org_id = 'acme' AND version = 1"), /catalogs_one_live/);
      await assert.rejects(client.query("INSERT INTO catalogs (org_id, version, status, document) VALUES ('acme', 3, 'approved', '{}')"), /check/i);
    } finally {
      await client.end();
    }
  } finally {
    delete process.env.DOC;
  }
});

test("the needs ledger reads each need in the line of the catalog it is handed", () => {
  const records = [{
    deploymentId: "dep_000000000001", status: "drafted", app: { name: "files" }, startedAt: "2026-10-14T10:00:00Z",
    plan: { profile: "dev" }, needs: [{ kind: "file_storage", line: "what the model wrote", evidence: [] }]
  }];
  assert.equal(rollupNeeds(records, { catalog: ownCatalog("a place for files, in this organization's words") }).needs[0].line,
    "a place for files, in this organization's words");
  assert.equal(rollupNeeds(records, { catalog: starterCatalog() }).needs[0].line,
    starterCatalog().need_kinds.find(n => n.key === "file_storage").line);
});

// The API end to end: two organizations, one with a live catalog of its own.
const port = await freePort();
const api = `http://localhost:${port}`;
const apiHome = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-catalogs-api-"));
const ownLine = "a store for the files your app keeps, in acme's words";
let server, ours, theirs;

const apiEnv = () => {
  const env = { ...process.env, SEALEYE_HOME: apiHome, HOME: apiHome, SEALEYE_AUTH: "" };
  delete env.DATABASE_URL;
  return env;
};
const issue = (email, ...flags) =>
  execFileSync(process.execPath, ["scripts/tokens.js", "add", email, "Some One", ...flags], { cwd: root, env: apiEnv(), encoding: "utf8" })
    .match(/sl_[A-Za-z0-9_-]{43}/)[0];
const call = (route, token, body) => fetch(`${api}${route}`, {
  method: body ? "POST" : "GET",
  headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
  body: body ? JSON.stringify(body) : undefined
}).then(async r => ({ status: r.status, body: await r.json() }));

before(async () => {
  ours = issue("dev@example.com");
  theirs = issue("dev@acme.example", "--org", "acme");
  process.env.DOC = JSON.stringify(ownCatalog(ownLine));
  try {
    await inChild(apiHome, `
      import { openCatalogs, addCatalog, approveCatalog, makeLive } from "./api/catalogs.js";
      await openCatalogs();
      const { version } = await addCatalog({ org: "acme", document: JSON.parse(process.env.DOC) });
      await approveCatalog({ org: "acme", version, by: "pat@acme.example" });
      await makeLive({ org: "acme", version });
      console.log("{}"); process.exit(0);
    `);
  } finally {
    delete process.env.DOC;
  }
  server = spawn(process.execPath, ["api/server.js"], { cwd: root, env: { ...apiEnv(), PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout.on("data", d => (log += d));
  server.stderr.on("data", d => (log += d));
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${api}/health`)).ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`API did not start:\n${log}`);
});

after(() => server?.kill());

test("GET /catalog: the starter for an organization with none, word for word, and its own for one with a live catalog", async () => {
  const starter = fromFile();
  const mine = await call("/catalog", ours);
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.catalog, { version: "starter", source: "starter", approvedBy: null, approvedAt: null });
  assert.equal(mine.body.catalogVersion, starter.catalogVersion);
  assert.deepEqual(mine.body.modules.map(m => [m.id, m.line]), starter.modules.map(m => [m.id, String(m.line).trim()]));
  assert.deepEqual(mine.body.needs, starter.need_kinds.map(n => ({ kind: n.key, line: String(n.line).trim() })));

  const acme = await call("/catalog", theirs);
  assert.equal(acme.body.catalog.version, 1);
  assert.equal(acme.body.catalog.source, "organization");
  assert.equal(acme.body.catalog.approvedBy, "pat@acme.example");
  assert.ok(!acme.body.modules.some(m => m.id === "static_site_edge"));
  assert.equal(acme.body.needs.find(n => n.kind === "file_storage").line, ownLine);
});

test("POST /plans/validate reads each need in the caller's organization's words", async () => {
  const plan = {
    planVersion: "0.4", app: { name: "files", type: "api" }, profile: "dev",
    modules: [{ id: "http_api_serverless", inputs: { runtime: "nodejs", entry_point: "index.js", trigger: "http" } }],
    outputs: ["public_url"],
    needs: [{ kind: "file_storage", line: "a place to keep files", evidence: [{ file: "index.js", shows: "an upload handler" }] }]
  };
  const starterLine = String(fromFile().need_kinds.find(n => n.key === "file_storage").line).trim();
  assert.equal((await call("/plans/validate", ours, plan)).body.needs[0].line, starterLine);
  assert.equal((await call("/plans/validate", theirs, plan)).body.needs[0].line, ownLine);
});
