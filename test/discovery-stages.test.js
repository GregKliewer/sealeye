// Discovery writes the stage map (PHASE5-PLAN Step 2; DESIGN.md, "A module per stage, in
// the catalog"): the library reader's path, each module's stages, what takes its place
// and what a stage adds, as data; code keeps only what it can prove, and asks about the
// rest with the guess, so a guess never goes live.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-discovery-stages-"));
process.env.SEALEYE_HOME = home;
delete process.env.DATABASE_URL;

const { openCatalogs, catalogAt } = await import("../api/catalogs.js");
const { createDiscoveryService } = await import("../api/discovery/service.js");
const { readLibraryFolder } = await import("../api/discovery/library.js");
const { withStageMap, provenStageMap, openFor } = await import("../api/discovery/draft.js");
const { selfTest } = await import("../api/self-test.js");
const { catalogProblems, isBuildable } = await import("../core/catalog.js");
const { forDev, resolveForStage } = await import("../core/stages.js");

before(async () => {
  await openCatalogs();
});

/** Two databases that change by stage, a backup plan a stage adds, and a pipeline. */
function library() {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-lib-")), "acme-platform");
  const put = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  };
  put("README.md", "# Acme platform\nApps go dev, then staging, then prod. From staging up every database has a backup plan.\n");
  put(".github/workflows/promote.yml", "name: promote\non: workflow_call\n");
  for (const m of ["db", "db-cluster", "backup", "cache"]) {
    put(`modules/${m}/README.md`, `The ${m} module.\n`);
    put(`modules/${m}/variables.tf`, 'variable "name" {\n  type        = string\n  description = "The app\'s name."\n}\n');
  }
  return dir;
}

const usage = { input_tokens: 1000, output_tokens: 200 };
const caller = { email: "platform@acme.test", org: "acme", team: "platform", scope: "org" };
const libraryPath = [
  { name: "dev", built_by: "not_said", gate: [] },
  { name: "staging", built_by: "pipeline", pipeline: ".github/workflows/promote.yml", gate: ["a platform team approval"] },
  { name: "Prod", built_by: "pipeline", pipeline: ".github/workflows/promote.yml", gate: ["a platform team approval", "an approved change ticket"] }
];

/** A model that reads the stage map as `stageFields` says, by folder. */
function model(stageFields) {
  const create = async params => {
    const tools = params.tools.map(t => t.name);
    const opening = typeof params.messages[0].content === "string" ? params.messages[0].content : JSON.stringify(params.messages[0].content);
    if (tools.includes("submit_finding")) {
      const source = opening.match(/Your module is (\S+)\./)[1];
      return { content: [{ type: "tool_use", id: "f", name: "submit_finding", input: { line: `What ${source} gives your app.`, when: "When it needs it.", signals: [], role: "optional", availability: source === "modules/cache" ? "deprecated" : "available", stages: "all", rules: [], questions: [] } }], usage };
    }
    if (tools.includes("submit_library")) return { content: [{ type: "tool_use", id: "l", name: "submit_library", input: { stages: libraryPath, rules: [], questions: [] } }], usage };
    const sources = opening.match(/Write the entries for these modules: (.+)\./)[1].split(", ");
    const entries = sources.map(source => ({
      source, line: `What ${source} gives your app.`, when: "When it needs it.", signals: [], role: "optional",
      availability: source === "modules/cache" ? "deprecated" : "available", guidance: "", open: [],
      meets: source.startsWith("modules/db") ? ["relational_database"] : [],
      ...(stageFields[source] || {})
    }));
    return { content: [{ type: "tool_use", id: "w", name: "write_catalog", input: { entries, questions: [] } }], usage };
  };
  return { messages: { create } };
}

async function run(stageFields) {
  const dir = library();
  const service = createDiscoveryService({ client: model(stageFields), readLibrary: async () => readLibraryFolder(dir, { repo: "acme/platform" }) });
  const { discoveryId } = await service.start({ caller, repos: [{ owner: "acme", repo: "platform" }] });
  await service.settled(discoveryId);
  const record = service.record(discoveryId);
  return { draft: catalogAt("acme", record.catalogVersion), questions: service.questions(discoveryId) };
}

const byId = (doc, id) => doc.modules.find(m => m.id === id);

test("a run writes the map: the path from the pipeline, each database's stages, the cluster in its place, the backup plan beside it", async () => {
  const { draft, questions } = await run({
    "modules/db": { stages: ["dev"], instead: { from: "staging", source: "modules/db-cluster" } },
    "modules/db-cluster": { stages: ["staging", "prod"] },
    "modules/backup": { added: { from: "staging", beside: "relational_database" } }
  });
  assert.deepEqual(catalogProblems(draft), []);
  assert.deepEqual(draft.stages.path, [
    { name: "dev" },
    { name: "staging", applies: "pipeline", pipeline: ".github/workflows/promote.yml", gate: ["a platform team approval"] },
    { name: "prod", applies: "pipeline", pipeline: ".github/workflows/promote.yml", gate: ["a platform team approval", "an approved change ticket"] }
  ], "a stage named as the library names it, lowercased");
  assert.deepEqual(byId(draft, "db").instead, { from: "staging", module: "db_cluster" }, "by the module's id, not its folder");
  assert.deepEqual(draft.stages.with, [{ from: "staging", module: "backup", beside: "relational_database" }]);
  assert.equal(draft.discovery.unproven, undefined);
  assert.ok(!questions.some(q => q.stageMap), "nothing to ask");
  const stages = selfTest({ document: draft, version: 1 }).checks.find(c => c.id === "stages");
  assert.equal(stages.passed, true, stages.problems.join("; "));
  const plan = { modules: [{ id: "db", enabled: true }] };
  assert.deepEqual(resolveForStage(plan, draft, "prod").plan.modules.map(m => m.id), ["db_cluster", "backup"]);
  assert.deepEqual(forDev(draft).modules.map(m => m.id).sort(), ["backup", "cache", "db"], "the interview is offered only what dev builds");
});

test("what code cannot prove is left out and asked about, with the guess; the module stays buildable in dev meanwhile", async () => {
  const { draft, questions } = await run({
    // The cache meets no database need, so it cannot take the database's place.
    "modules/db": { stages: ["dev"], instead: { from: "staging", source: "modules/cache" } },
    "modules/db-cluster": { stages: ["staging", "prod"] },
    // An addition beside a need no module meets.
    "modules/backup": { added: { from: "staging", beside: "event_stream" } }
  });
  assert.equal(byId(draft, "db").instead, undefined, "a guess never goes live");
  assert.equal(draft.stages.with, undefined);
  assert.deepEqual(draft.discovery.unproven.map(u => u.kind).sort(), ["coverage", "instead", "with"]);
  const asked = questions.filter(q => q.stageMap);
  assert.equal(asked.length, 3);
  assert.ok(asked.every(q => q.guess === q.options[0]), "the reading is the guess");
  const instead = asked.find(q => q.kind === "overlap");
  assert.deepEqual(instead.touches.sort(), ["modules/cache", "modules/db"]);
  assert.match(instead.question, /^Does cache take db's place from staging\? The draft leaves it out until it holds: cache takes db's place from staging, but does not meet relational_database\.$/);
  assert.match(asked.find(q => q.touches.includes("modules/db") && q.kind === "other").question, /^What serves db at staging, prod\?/);
  // No entry rests on a question about the map, and nor does the catalog: db is still
  // built in dev, and the self-test holds the catalog back until the map holds.
  assert.equal(byId(draft, "db").open, undefined);
  assert.equal(draft.discovery.open, undefined);
  assert.deepEqual(openFor("modules/db", questions), []);
  assert.equal(selfTest({ document: draft, version: 2 }).checks.find(c => c.id === "stages").passed, false);
});

test("a path seaLeye cannot use is left out, with why, and the rest of the draft is as before", () => {
  const doc = { modules: [{ id: "db", source: "modules/db", availability: "available", line: "A database.", stages: ["development"] }], need_kinds: [{ key: "relational_database", line: "a relational database" }] };
  const notDev = provenStageMap(withStageMap(doc, { stages: [{ name: "development", built_by: "not_said", gate: [] }, { name: "prod", built_by: "pipeline", gate: [] }] }));
  assert.equal(notDev.stages, undefined);
  assert.equal(byId(notDev, "db").stages, undefined, "stage fields go with the path");
  assert.match(notDev.discovery.unproven[0].words, /the library's first stage is development/);
  // A run read before Phase 5 kept the path as words: no map, and nothing to ask.
  const old = provenStageMap(withStageMap(doc, { stages: ["dev", "staging"] }));
  assert.equal(old.stages, undefined);
  assert.equal(old.discovery.unproven, undefined);
});

test("a database is built in dev whatever its later stages say", async () => {
  const { draft } = await run({ "modules/db": { stages: ["dev"], instead: { from: "staging", source: "modules/db-cluster" } }, "modules/db-cluster": { stages: ["staging", "prod"] } });
  // Nothing builds these made-up modules; what matters is that no question holds db back.
  assert.equal(byId(draft, "db").open, undefined);
  assert.equal(isBuildable("db", draft), false, "the made-up module takes no app and has no executor, as before");
});
