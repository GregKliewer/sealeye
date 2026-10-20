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
  doc.modules.find(m => m.id === "http_api_serverless").line = "Runs your API on acme's own serverless platform.";
  // One of acme's own, which nothing in the platform builds yet (a Terraform executor is
  // PHASE4-PLAN Step 9): never named to a developer, and never in a plan.
  doc.modules.push({ id: "acme_queue", availability: "available", builds_with: "terraform", role: "optional", line: "Acme's own queue." });
  doc.patterns.dev.modules.acme_queue = "Acme's queue pattern.";
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
  // A gate that refuses changes nothing; a retired catalog goes back, and then forward.
  out.gated = await makeLive({ org: "acme", version: v1.version, by: "lee@example.com", gate: () => { throw Object.assign(new Error("no"), { code: "GATED" }); } }).catch(e => e.code);
  out.afterGate = liveCatalog("acme").version;
  await makeLive({ org: "acme", version: v1.version, by: "lee@example.com" });
  out.back = catalogsOf("acme").map(c => [c.version, c.status, c.madeLiveBy]);
  await makeLive({ org: "acme", version: v2.version, by: "pat@example.com" });
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
  assert.equal(out.gated, "GATED");
  assert.equal(out.afterGate, 2, "a refused change leaves the live catalog as it was");
  assert.deepEqual(out.back, [[1, "live", "lee@example.com"], [2, "retired", null]], "a retired catalog goes live again, with who made it so");
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
      // A newer draft, and an approved one, that must never be what the API serves.
      await addCatalog({ org: "acme", document: { ...JSON.parse(process.env.DOC), catalogVersion: "draft" } });
      const { version: v3 } = await addCatalog({ org: "acme", document: { ...JSON.parse(process.env.DOC), catalogVersion: "approved" } });
      await approveCatalog({ org: "acme", version: v3, by: "pat@acme.example" });
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
  assert.deepEqual(mine.body.catalog, { version: "starter", source: "starter", approvedBy: null, approvedAt: null, live: true });
  assert.equal(mine.body.catalogVersion, starter.catalogVersion);
  assert.deepEqual(mine.body.modules.map(m => [m.id, m.line]), starter.modules.map(m => [m.id, String(m.line).trim()]));
  assert.deepEqual(mine.body.needs, starter.need_kinds.map(n => ({ kind: n.key, line: String(n.line).trim() })));

  const acme = await call("/catalog", theirs);
  assert.equal(acme.body.catalog.version, 1, "a draft or an approved catalog is never served; only the live one");
  assert.equal(acme.body.catalogVersion, fromFile().catalogVersion);
  assert.equal(acme.body.catalog.source, "organization");
  assert.equal(acme.body.catalog.approvedBy, "pat@acme.example");
  assert.ok(!acme.body.modules.some(m => m.id === "static_site_edge"));
  assert.equal(acme.body.needs.find(n => n.kind === "file_storage").line, ownLine);
});

test("POST /plans/validate reads each need in the words of the catalog the plan names", async () => {
  const plan = {
    planVersion: "0.4", app: { name: "files", type: "api" }, profile: "dev",
    modules: [{ id: "http_api_serverless", inputs: { runtime: "nodejs", entry_point: "index.js", trigger: "http" } }],
    outputs: ["public_url"],
    needs: [{ kind: "file_storage", line: "a place to keep files", evidence: [{ file: "index.js", shows: "an upload handler" }] }]
  };
  const starterLine = String(fromFile().need_kinds.find(n => n.key === "file_storage").line).trim();
  assert.equal((await call("/plans/validate", ours, plan)).body.needs[0].line, starterLine);
  // A 0.4 plan was written against the starter, whoever sends it.
  assert.equal((await call("/plans/validate", theirs, plan)).body.needs[0].line, starterLine);
  // A 0.5 plan naming acme's live catalog reads in acme's words.
  const named = { ...plan, planVersion: "0.5", catalog: 1 };
  assert.equal((await call("/plans/validate", theirs, named)).body.needs[0].line, ownLine);
  // Another organization's catalog is not one a plan can name.
  const elsewhere = await call("/plans/validate", ours, named);
  assert.equal(elsewhere.body.valid, false);
  assert.equal(elsewhere.body.errors[0].code, "CATALOG_UNKNOWN");
});

test("a drafted plan is written down, and counted, in the words of the catalog it was planned against", async () => {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-catalogs-app-"));
  const plan = {
    planVersion: "0.4", app: { name: "files", type: "api" }, profile: "dev",
    modules: [{ id: "http_api_serverless", inputs: { runtime: "nodejs", entry_point: "index.js", trigger: "http" } }],
    outputs: ["public_url"],
    needs: [{ kind: "file_storage", line: "a place to keep files", evidence: [{ file: "index.js", shows: "an upload handler" }] }]
  };
  for (const [token, words, version] of [[theirs, ownLine, 1], [ours, String(fromFile().need_kinds.find(n => n.key === "file_storage").line).trim(), "starter"]]) {
    const named = version === 1 ? { ...plan, planVersion: "0.5", catalog: 1 } : plan;
    const made = await call("/deployments", token, { plan: named, appPath, backend: "cloudformation" });
    assert.equal(made.status, 422, JSON.stringify(made.body).slice(0, 600));
    const id = made.body.error?.details?.deploymentId;
    assert.ok(id, JSON.stringify(made.body));

    const record = await call(`/deployments/${id}`, token);
    assert.deepEqual(record.body.catalog, version === 1 ? { version: 1, source: "organization" } : { version: "starter", source: "starter" }, "the record keeps the catalog the plan names");
    assert.equal(record.body.plan.planVersion, "0.5");

    const shown = await call(`/deployments/${id}/plan`, token);
    const markdown = shown.body.files["DEPLOYMENT_PLAN.md"];
    const ownModuleLine = "Runs your API on acme's own serverless platform.";
    assert.equal(markdown.includes(ownModuleLine), version === 1, "the plan file reads the module in its organization's words");

    const needs = await call("/needs", token);
    assert.equal(needs.body.needs.find(n => n.kind === "file_storage").line.trim(), words);
  }
});

test("GET /catalog?version= serves the catalog a plan names, and only what the platform builds", async () => {
  const one = await call("/catalog?version=1", theirs);
  assert.equal(one.status, 200);
  assert.deepEqual(one.body.catalog, { version: 1, source: "organization", approvedBy: "pat@acme.example", approvedAt: one.body.catalog.approvedAt, live: true });
  assert.ok(!one.body.modules.some(m => m.id === "acme_queue"), "a module nothing builds is never named");
  assert.ok(!one.body.document.modules.some(m => m.id === "acme_queue"));
  assert.ok(!("acme_queue" in one.body.document.patterns.dev.modules), "nor anything a pattern says about it");
  assert.ok(!JSON.stringify(one.body).includes("acme_queue"));
  assert.doesNotMatch(JSON.stringify(one.body), /builds_with|cloudformation|terraform/i, "what builds a module is the platform's to know");
  assert.equal(one.body.document.modules.find(m => m.id === "http_api_serverless").line, "Runs your API on acme's own serverless platform.");

  const starter = await call("/catalog?version=starter", theirs);
  assert.equal(starter.status, 200);
  assert.equal(starter.body.catalog.source, "starter");
  assert.equal(starter.body.catalog.live, false, "acme's live catalog is its own");
  assert.deepEqual(starter.body.document.modules.map(m => m.id), fromFile().modules.map(m => m.id));
  assert.deepEqual(starter.body.document.need_kinds, fromFile().need_kinds);

  for (const [version, code] of [["2", "CATALOG_NOT_LIVE"], ["3", "CATALOG_NOT_LIVE"], ["9", "CATALOG_UNKNOWN"]]) {
    const got = await call(`/catalog?version=${version}`, theirs);
    assert.equal(got.status, 404, version);
    assert.equal(got.body.error.code, code, version);
  }
  assert.equal((await call("/catalog?version=1", ours)).body.error.code, "CATALOG_UNKNOWN", "never another organization's");
  assert.equal((await call("/catalog?version=one", ours)).status, 400);
});

test("a plan may name only what its catalog builds, and only a catalog that is or was live", async () => {
  const plan = {
    planVersion: "0.5", catalog: 1, app: { name: "files", type: "api" }, profile: "dev",
    modules: [{ id: "http_api_serverless", inputs: { runtime: "nodejs", entry_point: "index.js", trigger: "http" } }],
    outputs: ["public_url"]
  };
  assert.equal((await call("/plans/validate", theirs, plan)).body.status, "ready");

  const unbuilt = await call("/plans/validate", theirs, { ...plan, modules: [...plan.modules, { id: "acme_queue" }] });
  assert.equal(unbuilt.body.valid, false, "a module the catalog lists and nothing builds is a need, never a module");
  const gone = await call("/plans/validate", theirs, { ...plan, modules: [{ id: "static_site_edge", inputs: {} }], app: { name: "site", type: "static-site" } });
  assert.equal(gone.body.valid, false, "acme's catalog does not have the starter's static site");

  const draft = await call("/plans/validate", theirs, { ...plan, catalog: 2 });
  assert.equal(draft.body.errors[0].code, "CATALOG_NOT_LIVE");
  assert.equal((await call("/plans/validate", theirs, { ...plan, catalog: "latest" })).body.valid, false);
  const unversioned = { ...plan };
  delete unversioned.catalog;
  assert.equal((await call("/plans/validate", theirs, unversioned)).body.valid, false, "a 0.5 plan names its catalog");

  const unlisted = await call("/plans/validate", theirs, {
    ...plan, needs: [{ kind: "unlisted", line: "an acme_queue for its jobs", evidence: [{ file: "index.js", shows: "a job queue" }] }]
  });
  assert.equal(unlisted.body.valid, false, "an unlisted need may not name one of the catalog's modules either");
});

test("a deploy is refused when the plan's catalog was replaced and no longer builds what it uses", async () => {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-catalogs-changed-"));
  fs.writeFileSync(path.join(appPath, "index.html"), "<p>hi</p>");
  // Written against the starter, which builds a static site; acme's live catalog does not.
  const plan = {
    planVersion: "0.4", app: { name: "site", type: "static-site" }, profile: "dev",
    modules: [{ id: "static_site_edge", inputs: { site_root: ".", entry_point: "index.html" } }, { id: "observability_basic" }],
    outputs: ["public_url"]
  };
  const made = await call("/deployments", theirs, { plan, appPath, backend: "cloudformation" });
  assert.equal(made.status, 409, JSON.stringify(made.body).slice(0, 400));
  assert.equal(made.body.error.code, "CATALOG_CHANGED");
  assert.match(made.body.error.message, /Run sealeye run again/);
  assert.equal(made.body.error.details.noLongerBuilt.length, 1);
  assert.doesNotMatch(made.body.error.message, /static_site_edge|\u2014/, "in the module's words, never its id, and no em dash");
  const listed = await call("/deployments", theirs);
  assert.ok(Array.isArray(listed.body.deployments), JSON.stringify(listed.body).slice(0, 200));
  assert.ok(!listed.body.deployments.some(d => d.app?.name === "site"), "nothing was recorded or queued");
});

test("a record is read against the catalog it names, and an old record against the starter", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-catalogs-record-"));
  process.env.DOC = JSON.stringify(ownCatalog());
  try {
    const out = await inChild(home, `
      import { openCatalogs, addCatalog, approveCatalog, makeLive, catalogOfRecord, catalogRef } from "./api/catalogs.js";
      await openCatalogs();
      const doc = JSON.parse(process.env.DOC);
      for (const tag of ["one", "two"]) {
        const { version } = await addCatalog({ org: "acme", document: { ...doc, catalogVersion: tag } });
        await approveCatalog({ org: "acme", version, by: "pat" });
        await makeLive({ org: "acme", version });
      }
      console.log(JSON.stringify({
        ref: catalogRef("acme"),
        planned: catalogOfRecord({ orgId: "acme", catalog: { version: 1, source: "organization" } }).catalogVersion,
        old: catalogOfRecord({ orgId: "acme" }).catalogVersion,
        missing: catalogOfRecord({ orgId: "acme", catalog: { version: 9 } }),
        other: catalogOfRecord({ orgId: "other", catalog: { version: 1 } })
      }));
      process.exit(0);
    `);
    assert.deepEqual(out.ref, { version: 2, source: "organization" }, "a record keeps which catalog, never the document");
    assert.equal(out.planned, "one", "a retired catalog still reads for the records planned against it");
    assert.equal(out.old, fromFile().catalogVersion, "a record from before catalogs were kept was planned against the starter");
    assert.equal(out.missing, null);
    assert.equal(out.other, null, "another organization's catalog is never read for a record");
  } finally {
    delete process.env.DOC;
  }
});

test("changes made together all land, in memory and in the file", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-catalogs-together-"));
  process.env.DOC = JSON.stringify(ownCatalog());
  try {
    const out = await inChild(home, `
      import { openCatalogs, addCatalog, approveCatalog, catalogsOf } from "./api/catalogs.js";
      await openCatalogs();
      const doc = JSON.parse(process.env.DOC);
      await addCatalog({ org: "acme", document: doc });
      await Promise.all([
        addCatalog({ org: "acme", document: doc }),
        approveCatalog({ org: "acme", version: 1, by: "pat" }),
        addCatalog({ org: "acme", document: doc }),
        addCatalog({ org: "beta", document: doc })
      ]);
      const inMemory = catalogsOf("acme").map(c => [c.version, c.status]);
      await openCatalogs();
      console.log(JSON.stringify({ inMemory, reread: catalogsOf("acme").map(c => [c.version, c.status]), beta: catalogsOf("beta").length }));
      process.exit(0);
    `);
    const expected = [[1, "approved"], [2, "draft"], [3, "draft"]];
    assert.deepEqual(out.inMemory, expected);
    assert.deepEqual(out.reread, expected);
    assert.equal(out.beta, 1);
  } finally {
    delete process.env.DOC;
  }
});
