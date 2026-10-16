// Approving a catalog and making it live (PHASE4-PLAN Step 7): an organization-wide
// token's, the self-test at each step, a retired catalog going back, and the guard for
// environments a new catalog would stop building. The real API, no AWS, no model.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { starterCatalog } from "../core/catalog.js";
import { draftCatalog } from "../api/discovery/draft.js";
import { startApi, token } from "./helpers/api-with-aws.js";

const ANA = token("a");     // a developer in default
const LEE = token("l");     // default's platform engineer
const JUN = token("j");     // juniper's platform engineer
const JUNDEV = token("d");  // a developer in juniper
let api;

const at = "2026-10-16T09:00:00.000Z";
const row = (org, version, status, document, extra = {}) => ({
  org, version, status, document, createdBy: "discovery", createdAt: at,
  approvedBy: status === "draft" ? null : "earlier@example.com", approvedAt: status === "draft" ? null : at, ...extra
});

/** Juniper's library as discovery writes it: Terraform modules, one resting on a question. */
function juniper({ catalogQuestion = false } = {}) {
  const mod = source => ({ source, id: source.split("/").pop().replace(/-/g, "_"), inputs: {} });
  const modules = [mod("modules/postgres"), mod("modules/cache-redis"), mod("modules/cache-valkey")];
  const questions = [
    { id: "q_standing", touches: ["modules/cache-valkey", "modules/cache-redis"], question: "Is cache-valkey the replacement for cache-redis?" },
    ...(catalogQuestion ? [{ id: "q_path", touches: [], question: "Is uat part of the path to production?" }] : [])
  ];
  return draftCatalog({
    run: { id: "dis_j", repos: [{ repo: "GregKliewer/sealeye-sample-platform", commit: "5e63aa5" }] },
    modules,
    entries: modules.map(m => ({ source: m.source, line: `A plain line about ${m.id}.`, ...(m.id === "cache_redis" ? { availability: "deprecated" } : {}) })),
    questions
  });
}

/** The starter without config_basic: a catalog that stops building what shop uses. */
function withoutConfig() {
  const doc = starterCatalog();
  doc.modules = doc.modules.filter(m => m.id !== "config_basic");
  return doc;
}

function cloudWords() {
  const doc = starterCatalog();
  doc.modules.find(m => m.id === "http_api_serverless").line = "Runs your code on Lambda behind API Gateway.";
  return doc;
}

before(async () => {
  api = await startApi({
    tokens: [
      { token: ANA, id: "ana", team: "default" },
      { token: LEE, id: "lee", team: "platform", scope: "org" },
      { token: JUN, id: "jun", team: "platform", scope: "org", org: "juniper" },
      { token: JUNDEV, id: "dev", team: "payments", org: "juniper" }
    ],
    records: [{
      deploymentId: "dep_shop1", status: "succeeded", backend: "cloudformation", stackName: "sealeye-default-shop-abc123",
      environment: "sealeye-default-shop-abc123", orgId: "default", teamId: "default", app: { name: "shop", type: "api" },
      plan: { planVersion: "0.5", catalog: "starter", app: { name: "shop", type: "api" }, profile: "dev", outputs: [],
        modules: [{ id: "http_api_serverless" }, { id: "observability_basic" }, { id: "config_basic" }] },
      startedAt: at, finishedAt: at, outputs: {}
    }],
    aws: "",
    files: {
      "catalogs.json": [
        row("default", 1, "draft", withoutConfig()),
        row("default", 2, "draft", cloudWords()),
        row("juniper", 1, "draft", juniper()),
        row("juniper", 2, "draft", juniper({ catalogQuestion: true })),
        row("juniper", 3, "draft", juniper())
      ]
    }
  });
});

after(() => api?.stop());

const post = (route, tok) => api.call(route, { token: tok, method: "POST", body: {} });

test("approving and making live are an organization-wide token's only", async () => {
  for (const [method, route] of [["GET", "/catalogs"], ["GET", "/catalogs/1/self-test"], ["POST", "/catalogs/1/approve"], ["POST", "/catalogs/1/live"]]) {
    const r = await api.call(route, { token: ANA, method, ...(method === "POST" ? { body: {} } : {}) });
    assert.equal(r.status, 403, `${method} ${route}`);
    assert.equal(r.body.error.code, "ORG_WIDE_ONLY");
  }
});

test("each organization sees only its own catalogs", async () => {
  const mine = await api.call("/catalogs", { token: JUN });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.catalogs.map(c => c.version), [3, 2, 1]);
  assert.deepEqual(mine.body.live, { version: "starter", source: "starter" });
  assert.equal(mine.body.catalogs[2].discovery, "dis_j");
  assert.equal(mine.body.catalogs[2].open, 2, "the entries resting on its question");
  assert.equal(mine.body.catalogs[2].document, undefined, "a listing never carries a document");
  assert.equal((await api.call("/catalogs/9/self-test", { token: JUN })).status, 404);
});

test("the self-test is there to read before approving", async () => {
  const r = await api.call("/catalogs/2/self-test", { token: LEE });
  assert.equal(r.status, 200);
  assert.equal(r.body.selfTest.passed, false);
  assert.match(r.body.selfTest.checks.find(c => c.id === "words").problems[0], /^http_api_serverless: line says Lambda and API Gateway, words a developer never reads/);
});

test("a catalog with a word a developer never reads is not approved, and stays a draft", async () => {
  const r = await post("/catalogs/2/approve", LEE);
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, "SELF_TEST_FAILED");
  assert.equal(r.body.error.message, "Catalog 2 cannot be approved. The self-test found 1 problem in catalog 2.");
  const list = await api.call("/catalogs", { token: LEE });
  assert.equal(list.body.catalogs.find(c => c.version === 2).status, "draft");
});

test("a question about the whole catalog holds up approval, in its own words", async () => {
  const r = await post("/catalogs/2/approve", JUN);
  assert.equal(r.status, 422);
  assert.deepEqual(r.body.error.details.selfTest.checks.find(c => c.id === "questions").problems, ["A question about the whole catalog is not answered yet (q_path)"]);
});

test("Juniper's catalog is approved with a module's question open, made live, and builds nothing yet", async () => {
  const approved = await post("/catalogs/1/approve", JUN);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.catalog.approvedBy, "jun@example.com");
  assert.deepEqual(approved.body.selfTest.built, []);
  assert.equal(approved.body.selfTest.refused.find(r => r.id === "cache_valkey").why, "it rests on a question not yet answered");

  assert.equal((await post("/catalogs/1/approve", JUN)).body.error.code, "CATALOG_STATUS", "approved once");

  const live = await post("/catalogs/1/live", JUN);
  assert.equal(live.status, 200, JSON.stringify(live.body));
  assert.equal(live.body.catalog.madeLiveBy, "jun@example.com");

  // Juniper's developers plan against it now; default's are untouched.
  const theirs = await api.call("/catalog", { token: JUNDEV });
  assert.equal(theirs.body.catalog.version, 1);
  assert.deepEqual(theirs.body.modules, [], "nothing builds a Terraform module until Step 9");
  const ours = await api.call("/catalog", { token: ANA });
  assert.equal(ours.body.catalog.source, "starter");
});

test("a retired catalog goes live again: the way back", async () => {
  assert.equal((await post("/catalogs/3/approve", JUN)).status, 200);
  assert.equal((await post("/catalogs/3/live", JUN)).status, 200);
  let list = await api.call("/catalogs", { token: JUN });
  assert.equal(list.body.catalogs.find(c => c.version === 1).status, "retired");
  const back = await post("/catalogs/1/live", JUN);
  assert.equal(back.status, 200, JSON.stringify(back.body));
  list = await api.call("/catalogs", { token: JUN });
  assert.deepEqual(list.body.catalogs.map(c => [c.version, c.status]), [[3, "retired"], [2, "draft"], [1, "live"]]);
  assert.equal((await post("/catalogs/2/live", JUN)).body.error.code, "CATALOG_STATUS", "a draft never goes live");
});

test("a catalog that stops building what an environment runs is not made live, naming it", async () => {
  assert.equal((await post("/catalogs/1/approve", LEE)).status, 200);
  const r = await post("/catalogs/1/live", LEE);
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "CATALOG_IN_USE");
  assert.equal(r.body.error.message, "Catalog 1 cannot be made live: it does not build what an environment runs. shop (team default) uses config_basic. Tear it down first, or keep a catalog that builds it.");
  assert.deepEqual(r.body.error.details.environments, [{ environment: "sealeye-default-shop-abc123", app: "shop", team: "default", deploymentId: "dep_shop1", modules: ["config_basic"] }]);
  const ours = await api.call("/catalog", { token: ANA });
  assert.equal(ours.body.catalog.source, "starter", "nothing changed");
});
