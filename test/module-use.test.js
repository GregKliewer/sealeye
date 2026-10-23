// Which apps use each module now, and at which release (api/module-use.js; DESIGN.md,
// "The Catalog page says which apps use each module").
import { test } from "node:test";
import assert from "node:assert/strict";
import { modulesInUse } from "../api/module-use.js";
import { usedByWords } from "../core/discovery-words.js";

const plan = (...ids) => ({ modules: ids.map(id => ({ id })) });
const at = h => new Date(Date.UTC(2026, 9, 23, h)).toISOString();
const rec = extra => ({ orgId: "default", teamId: "payments", stackName: "s-orders", app: { name: "orders-api" }, ...extra });

test("an app counts with the release its newest standing build used, and not once torn down", () => {
  const records = [
    rec({ deploymentId: "d1", status: "succeeded", startedAt: at(1), plan: plan("http_api", "document_table"),
      terraform: { module: { id: "http_api", version: "1.1.0" }, parts: [{ id: "document_table", version: "1.0.0" }] } }),
    rec({ deploymentId: "d2", status: "succeeded", startedAt: at(2), plan: plan("http_api", "document_table"),
      terraform: { module: { id: "http_api", version: "1.3.0" }, parts: [{ id: "document_table", version: "1.1.0" }] } }),
    // A failed deploy after it left it as it was.
    rec({ deploymentId: "d3", status: "failed", startedAt: at(3), plan: plan("http_api"), terraform: { module: { id: "http_api", version: "2.0.0" } } }),
    // The starter's modules have no release.
    { orgId: "default", teamId: "lending", stackName: "s-site", app: { name: "site" }, deploymentId: "d4", status: "succeeded", startedAt: at(1), plan: plan("static_site_edge") },
    // Torn down, and a draft: neither uses anything.
    { orgId: "default", teamId: "lending", stackName: "s-old", app: { name: "old" }, deploymentId: "d5", status: "destroyed", startedAt: at(1), plan: plan("static_site_edge") },
    { orgId: "default", teamId: "lending", app: { name: "drafty" }, deploymentId: "d6", status: "drafted", startedAt: at(1), plan: plan("http_api") }
  ];
  const used = modulesInUse(records, { viewer: { team: "lending", scope: "team" } });
  assert.deepEqual(used.http_api, [{ app: "orders-api", team: "payments", version: "1.3.0", path: null }]);
  assert.deepEqual(used.document_table, [{ app: "orders-api", team: "payments", version: "1.1.0", path: null }]);
  assert.deepEqual(used.static_site_edge, [{ app: "site", team: "lending", version: null, path: "/environments/s-site" }]);
  // An organization-wide viewer may open every app's page.
  assert.equal(modulesInUse(records, { viewer: { team: "platform", scope: "org" } }).http_api[0].path, "/environments/s-orders");
});

test("both surfaces say who uses a module in the same words", () => {
  assert.equal(usedByWords([]), "used by no app yet");
  assert.equal(usedByWords([{ app: "orders-api", team: "payments", version: "1.3.0" }, { app: "site", team: "lending", version: null }]),
    "used by orders-api at 1.3.0 (team payments), site (team lending)");
});

test("GET /catalog and sealeye catalog say who uses each module; GET /needs links only your team's apps", async () => {
  const { startApi, token } = await import("./helpers/api-with-aws.js");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const path = await import("node:path");
  const ANA = token("a");
  const site = { orgId: "default", teamId: "default", stackName: "sealeye-site", app: { name: "site" }, kind: "static", deploymentId: "dep_site00000001",
    status: "succeeded", startedAt: at(1), plan: { planVersion: "0.4", app: { name: "site", type: "static" }, profile: "dev", modules: [{ id: "static_site_edge", inputs: {} }] }, outputs: {} };
  const theirs = { ...site, teamId: "lending", stackName: "sealeye-lending-site", deploymentId: "dep_site00000002" };
  const draft = { orgId: "default", teamId: "lending", app: { name: "ledger" }, deploymentId: "dep_draft0000001", status: "drafted", startedAt: at(2),
    plan: { profile: "dev" }, needs: [{ kind: "relational_database", evidence: [{ file: "db.js", shows: "connects to a database" }] }], outputs: {} };
  const api = await startApi({ tokens: [{ token: ANA, id: "ana", team: "default" }], records: [site, theirs, draft], aws: "" });
  try {
    const get = async p => (await fetch(`${api.api}${p}`, { headers: { authorization: `Bearer ${ANA}` } })).json();
    const catalog = await get("/catalog");
    assert.deepEqual(catalog.modules.find(m => m.id === "static_site_edge").usedBy, [
      { app: "site", team: "default", version: null, path: "/environments/sealeye-site" },
      { app: "site", team: "lending", version: null, path: null }
    ]);
    assert.deepEqual(catalog.modules.find(m => m.id === "http_api_serverless").usedBy, []);
    const needs = await get("/needs");
    assert.equal(needs.needs[0].apps[0].path, null, "another team's app is named, never linked");

    const root = path.resolve(import.meta.dirname, "..");
    const { stdout } = await promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), "catalog", "--api", api.api], {
      env: { ...process.env, NO_COLOR: "1", SEALEYE_TOKEN: ANA, SEALEYE_HOME: api.home }
    });
    assert.match(stdout, /static_site_edge .*\n {6}used by site \(team default\), site \(team lending\)/);
    assert.match(stdout, /http_api_serverless .*\n {6}used by no app yet/);
  } finally {
    api.stop();
  }
});
