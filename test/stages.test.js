// The path to production a catalog describes, and a plan resolved for a stage on it
// (PHASE5-PLAN Step 1; DESIGN.md, "A module per stage, in the catalog").
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import YAML from "yaml";

import { catalogProblems, starterCatalog } from "../core/catalog.js";
import { hasStagesPastDev, moduleAtStage, moduleStageView, moduleStageWords, nextStage, resolveForStage, stageMapGaps, stageMapProblems, stageMapView, stageMapWords, stageNames, stageOrder, stagePath } from "../core/stages.js";
import { developerWordProblems } from "../core/developer-words.js";
import { selfTest } from "../api/self-test.js";

const key = YAML.parse(fs.readFileSync(new URL("./fixtures/sample-platform/answer-key.yaml", import.meta.url), "utf8"));
const juniper = () => ({ ...structuredClone(key.catalog), need_kinds: starterCatalog().need_kinds, profiles: starterCatalog().profiles });
const byId = (doc, id) => doc.modules.find(m => m.id === id);
const plan = { planVersion: "0.6", catalog: "9", modules: [{ id: "http_api", enabled: true }, { id: "postgres", enabled: true, connect: { address: "DB_HOST" } }] };

test("a catalog that says nothing of stages has dev alone, applied by seaLeye, as before", () => {
  const starter = starterCatalog();
  assert.deepEqual(stagePath(starter), { path: [{ name: "dev", applies: "sealeye", gate: [] }], aside: [], with: [] });
  assert.equal(hasStagesPastDev(starter), false);
  assert.equal(nextStage(starter, "dev"), null);
  assert.deepEqual(stageMapProblems(starter), []);
  assert.deepEqual(stageMapGaps(starter), []);
  const r = resolveForStage({ modules: [{ id: "http_api_serverless", enabled: true }] }, starter, "dev");
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.changes, []);
});

test("Juniper's path: dev to prod, perf aside with staging, each stage's gate and who applies it", () => {
  const doc = juniper();
  assert.deepEqual(catalogProblems(doc), []);
  assert.deepEqual(stageNames(doc), ["dev", "sit", "uat", "staging", "prod", "perf"]);
  assert.equal(stageOrder(doc, "perf"), stageOrder(doc, "staging"));
  assert.equal(nextStage(doc, "uat"), "staging");
  assert.equal(nextStage(doc, "prod"), null);
  assert.equal(nextStage(doc, "perf"), null, "nothing is promoted from a stage set aside");
  const { path } = stagePath(doc);
  assert.equal(path[0].applies, "sealeye", "dev is always seaLeye's");
  assert.deepEqual(path.find(s => s.name === "prod").gate, ["a platform team approval", "an approved change ticket"]);
});

test("the plan at a stage: the same below staging; from staging the cluster takes the database's place, a backup plan beside it", () => {
  const doc = juniper();
  for (const stage of ["dev", "sit", "uat"]) {
    const r = resolveForStage(plan, doc, stage);
    assert.deepEqual(r.plan.modules.map(m => m.id), ["http_api", "postgres"], stage);
    assert.deepEqual(r.changes, []);
  }
  for (const stage of ["staging", "perf", "prod"]) {
    const r = resolveForStage(plan, doc, stage);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.plan.modules.map(m => m.id), ["http_api", "postgres_cluster", "backup_plan"], stage);
    assert.deepEqual(r.plan.modules[1].connect, { address: "DB_HOST" }, "what the plan connects is carried over");
    assert.deepEqual(r.changes, [{ kind: "instead", from: "postgres", to: "postgres_cluster" }, { kind: "with", module: "backup_plan", beside: "postgres_cluster" }]);
  }
  assert.deepEqual(plan.modules.map(m => m.id), ["http_api", "postgres"], "the approved plan itself is never changed");
});

test("a stage adds nothing beside what the plan does not use", () => {
  const r = resolveForStage({ modules: [{ id: "http_api", enabled: true }] }, juniper(), "prod");
  assert.deepEqual(r.plan.modules.map(m => m.id), ["http_api"]);
});

test("a stage the catalog lacks, or a module with nothing at a stage, says why in words", () => {
  const doc = juniper();
  assert.match(resolveForStage(plan, doc, "qa").problems[0], /qa is not a stage on this catalog's path/);
  delete byId(doc, "postgres").instead;
  assert.match(moduleAtStage(doc, "postgres", "staging").why, /postgres is not for staging, and nothing takes its place there/);
});

test("the shape: dev first and ungated, every later stage applied by someone, every name known", () => {
  const doc = juniper();
  doc.stages.path[1].applies = "someone";
  doc.stages.path[3].applies = "pipeline"; delete doc.stages.path[3].pipeline;
  doc.stages.with[0].beside = "a_database";
  byId(doc, "postgres").stages = ["dev", "qa"];
  byId(doc, "postgres").instead.module = "postgres_big";
  const problems = catalogProblems(doc).join("\n");
  assert.match(problems, /stage sit: applies is sealeye or pipeline/);
  assert.match(problems, /stage staging: a stage the pipeline applies names the pipeline/);
  assert.match(problems, /beside a_database, which is not one of the catalog's need kinds/);
  assert.match(problems, /module postgres: stages names qa, which is not on the catalog's path/);
  assert.match(problems, /module postgres: instead names postgres_big, which is not in the catalog/);
  const notDev = juniper();
  notDev.stages.path = notDev.stages.path.slice(1);
  assert.match(catalogProblems(notDev).join("\n"), /stages.path starts with dev/);
});

test("the self-test proves the map: the module that takes over takes the same inputs, offers as much, meets the same needs", () => {
  const doc = juniper();
  byId(doc, "postgres").offers = { access: "access_policy_arn", values: ["address", "port", "database_name"] };
  byId(doc, "postgres_cluster").offers = { access: null, values: ["address", "reader_address"] };
  byId(doc, "postgres_cluster").inputs.vault = { required: true };
  byId(doc, "postgres_cluster").meets = [];
  const gaps = stageMapGaps(doc).join("\n");
  assert.match(gaps, /postgres_cluster takes postgres's place from staging, but needs name, security_group_ids, stage, subnet_group_name and vault/);
  assert.match(gaps, /does not offer access, port and database_name, which a plan may connect/);
  assert.match(gaps, /does not meet relational_database/);
  // The live catalog 9 read postgres-cluster 1.0.0, which offers no access: the map is
  // refused against it, as PHASE5-PLAN Step 0 says.
});

test("a module that ends with nothing after it, and a stage that adds what an app asks for, are refused", () => {
  const doc = juniper();
  delete byId(doc, "postgres").instead;
  byId(doc, "backup_plan").meets = ["file_storage"];
  const gaps = stageMapGaps(doc).join("\n");
  assert.match(gaps, /postgres has no module at staging, prod and perf: say what takes its place \(instead\), or that it is for those stages too/);
  assert.match(gaps, /staging adds backup_plan, which meets what an app asks for \(file_storage\)/);
});

test("the self-test has a stages check: Juniper's map passes; a broken one fails it, naming why", () => {
  const ok = selfTest({ document: juniper(), version: "key" });
  const stages = ok.checks.find(c => c.id === "stages");
  assert.equal(stages.passed, true, stages.problems.join("; "));
  assert.equal(stages.title, "Every stage on the path has a module for each one an app uses");
  const doc = juniper();
  delete byId(doc, "postgres").instead;
  const bad = selfTest({ document: doc, version: "key" }).checks.find(c => c.id === "stages");
  assert.equal(bad.passed, false);
  assert.match(bad.problems[0], /postgres has no module at staging/);
});

test("what a stage waits on is read by developers, so its words are checked", () => {
  const doc = juniper();
  doc.stages.path[4].gate = ["a reviewed Terraform plan"];
  const found = developerWordProblems(doc).filter(p => p.where.startsWith("stage "));
  assert.equal(found[0]?.where, "stage prod: gate 1");
});

test("both surfaces say a module's stages and the path in the same words, naming no module id", () => {
  const doc = juniper();
  const view = stageMapView(doc);
  assert.deepEqual(stageMapWords(view), [
    "dev: you build it yourself, whenever you like.",
    "sit: built by your platform team's pipeline, when your team asks.",
    "uat: built by your platform team's pipeline, when your team asks.",
    "staging: built by your platform team's pipeline, after a platform team approval.",
    "prod: built by your platform team's pipeline, after a platform team approval and an approved change ticket.",
    "perf: built from staging for a load test, and nothing is promoted from it.",
    "From staging, beside a relational database, the platform adds: keeps a copy of everything your app stores, once a day, apart from your app."
  ]);
  assert.equal(moduleStageWords(moduleStageView(byId(doc, "postgres"), doc)),
    "For dev, sit and uat. From staging, the platform uses another in its place: a relational database for your app that survives losing a zone, from staging up.");
  assert.equal(moduleStageWords(moduleStageView(byId(doc, "http_api"), doc)), "");
  assert.ok(!JSON.stringify(view).includes("backup_plan") && !JSON.stringify(view).includes("app-promote"), "no id, no pipeline file");
  assert.equal(stageMapView(starterCatalog()), null);
  assert.deepEqual(moduleStageView(starterCatalog().modules[0], starterCatalog()), {});
});
