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
  assert.deepEqual(forDev(draft).modules.filter(m => m.availability !== "not_for_dev").map(m => m.id).sort(), ["cache", "db"], "the interview is offered only what dev builds, and never what a stage adds");
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
  assert.match(notDev.discovery.stage_notes[0], /the library's first stage is development/);
  assert.equal(notDev.discovery.unproven, undefined, "nothing to hold back: a catalog with no path builds dev alone");
  assert.match(selfTest({ document: { ...notDev, need_kinds: doc.need_kinds, profiles: [] }, version: 1 }).notes.join(" "), /The path to production was not read/);
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

// The review of Step 2, Nov 1, 2026: each way a guess could have gone live.
const juniperish = () => ({
  modules: [
    { id: "db", source: "modules/db", availability: "available", line: "A database.", meets: ["relational_database"], inputs: { name: { required: true } } },
    { id: "db_cluster", source: "modules/db-cluster", availability: "available", line: "A clustered database.", meets: ["relational_database"], inputs: { name: { required: true }, vault: { required: true } } },
    { id: "backup", source: "modules/backup", availability: "available", line: "Daily copies.", meets: [] }
  ],
  need_kinds: [{ key: "relational_database", line: "a relational database" }],
  profiles: []
});
const reviewPath = { stages: [{ name: "dev", built_by: "not_said", gate: [] }, { name: "staging", built_by: "pipeline", pipeline: "p.yml", gate: [] }, { name: "prod", built_by: "pipeline", pipeline: "p.yml", gate: [] }] };
const stagesCheck = doc => selfTest({ document: doc, version: 1 }).checks.find(c => c.id === "stages");

test("a module whose `instead` names no module keeps its stages, and the catalog is held back", () => {
  const doc = juniperish();
  doc.modules[0].stages = ["dev"];
  doc.modules[0].instead = { from: "staging", source: "modules/nope" };
  const d = provenStageMap(withStageMap(doc, reviewPath));
  assert.deepEqual(byId(d, "db").stages, ["dev"], "never made for every stage by taking its stages away");
  assert.equal(byId(d, "db").instead, undefined);
  assert.equal(stagesCheck(d).passed, false);
});

test("a stage name off the path goes, the rest of the module's stages stay, and the catalog is held back", () => {
  const doc = juniperish();
  doc.modules[0].stages = ["dev", "qa"];
  const d = provenStageMap(withStageMap(doc, reviewPath));
  assert.deepEqual(byId(d, "db").stages, ["dev"]);
  assert.equal(stagesCheck(d).passed, false);
});

test("an `instead` that does not hold, on a module for every stage, is taken out and holds the catalog back", () => {
  const doc = juniperish();
  doc.modules[0].instead = { from: "staging", source: "modules/db-cluster" };
  const d = provenStageMap(withStageMap(doc, reviewPath));
  assert.equal(byId(d, "db").instead, undefined);
  const check = stagesCheck(d);
  assert.equal(check.passed, false, "the single database would otherwise be what prod builds");
  assert.match(check.problems.join(" "), /Not settled yet: db_cluster takes db's place from staging, but needs name and vault where db needs name\. Discovery asked about it/);
});

test("what a stage adds stays with its module through a second pass, or goes with a question, never quietly", () => {
  const doc = juniperish();
  doc.modules[2].added = { from: "staging", beside: "relational_database" };
  doc.modules[2].stages = ["dev", "qa"];
  const once = provenStageMap(withStageMap(doc, reviewPath));
  const twice = provenStageMap(withStageMap(once));
  assert.deepEqual(twice.stages.with, [{ from: "staging", module: "backup", beside: "relational_database" }]);
  assert.deepEqual(twice.stages, once.stages);
});

test("who builds a stage the library says nothing about is seaLeye, said to whoever approves", () => {
  const d = provenStageMap(withStageMap(juniperish(), { stages: [{ name: "dev", built_by: "not_said", gate: [] }, { name: "staging", built_by: "not_said", gate: [] }, { name: "prod", built_by: "pipeline", gate: [] }] }));
  assert.deepEqual(d.stages.path.map(s => s.applies || "dev"), ["dev", "sealeye", "pipeline"]);
  const notes = selfTest({ document: d, version: 1 }).notes.join(" ");
  assert.match(notes, /The library does not say who builds staging, so seaLeye would\./);
  assert.match(notes, /The library's pipeline builds prod, but no pipeline file was named\./);
});

test("the interview never hears of a module it cannot plan in dev, even in another module's words", async () => {
  const { namesUnbuilt } = await import("../core/catalog.js");
  const doc = provenStageMap(withStageMap({ ...juniperish(), modules: juniperish().modules.map(m => (m.id === "db" ? { ...m, stages: ["dev"], instead: { from: "staging", source: "modules/db-cluster" } } : m.id === "db_cluster" ? { ...m, inputs: { name: { required: true } }, stages: ["staging", "prod"] } : m.id === "backup" ? { ...m, added: { from: "staging", beside: "relational_database" } } : m)) }, reviewPath));
  const dev = forDev(doc);
  assert.equal(byId(dev, "db_cluster").availability, "not_for_dev");
  assert.equal(byId(dev, "backup").availability, "not_for_dev");
  assert.equal(namesUnbuilt(dev)("From staging, `db_cluster` takes its place."), "db_cluster");
});

test("a folder and a stage written the wrong way round are put right", async () => {
  const { draft } = await run({
    "modules/db": { stages: ["dev"], instead: { from: "modules/db-cluster", source: "staging" } },
    "modules/db-cluster": { stages: ["staging", "prod"] }
  });
  assert.deepEqual(byId(draft, "db").instead, { from: "staging", module: "db_cluster" });
  assert.equal(draft.discovery.unproven, undefined);
});

test("the supervisor's own names, module and stage, are read", async () => {
  const { draft } = await run({
    "modules/db": { stages: ["dev"], instead: { module: "modules/db-cluster", stage: "staging" } },
    "modules/db-cluster": { stages: ["staging", "prod"] },
    "modules/backup": { added: { stage: "staging", beside: "relational_database" } }
  });
  assert.deepEqual(byId(draft, "db").instead, { from: "staging", module: "db_cluster" });
  assert.deepEqual(draft.stages.with, [{ from: "staging", module: "backup", beside: "relational_database" }]);
});

test("a stage the path does not have is left out with a note, the rest of the module's stages kept, and nothing is held back", () => {
  const doc = juniperish();
  doc.modules[0].stages = ["dev"];
  doc.modules[0].instead = { from: "staging", source: "modules/db-cluster" };
  doc.modules[1].inputs = { name: { required: true } };
  doc.modules[1].stages = ["staging", "perf", "prod"];
  const d = provenStageMap(withStageMap(doc, reviewPath));
  assert.deepEqual(byId(d, "db_cluster").stages, ["staging", "prod"]);
  assert.equal(d.discovery.unproven, undefined);
  assert.match(d.discovery.stage_notes.join(" "), /db_cluster names perf, which the path to production as read does not have, so it is left out\./);
  assert.equal(stagesCheck(d).passed, true);
});

test("the supervisor's lists are each entry's own: a replacement and an addition, beside the entries", async () => {
  const { withStageLists } = await import("../api/discovery/readers.js");
  const out = withStageLists({
    entries: [{ source: "modules/db" }, { source: "modules/backup" }, { source: "modules/cache" }],
    replacements: [{ module: "modules/db", replaced_by: "modules/db-cluster", from_stage: "staging" }],
    additions: [{ module: "backup", from_stage: "staging", beside: "relational_database" }],
    questions: []
  });
  assert.deepEqual(out.entries[0].instead, { module: "modules/db-cluster", stage: "staging" });
  assert.deepEqual(out.entries[1].added, { stage: "staging", beside: "relational_database" });
  assert.equal(out.entries[2].instead, undefined);
  assert.equal(out.replacements, undefined);
});

test("a module named in its own place, or given way to from no later stage, says nothing; neither holds the catalog back", () => {
  const doc = juniperish();
  doc.modules[2].instead = { from: "na", source: "modules/backup" };
  doc.modules[0].instead = { from: "dev", source: "modules/db-cluster" };
  const d = provenStageMap(withStageMap(doc, reviewPath));
  assert.equal(byId(d, "backup").instead, undefined);
  assert.equal(byId(d, "db").instead, undefined);
  assert.equal(d.discovery.unproven, undefined);
  assert.match(d.discovery.stage_notes.join(" "), /db was said to give way to db_cluster from dev, which is not a stage past dev; it is left out\./);
});

test("a replacement written the wrong way round is put on the module used first", () => {
  const doc = juniperish();
  doc.modules[0].stages = ["dev"];
  doc.modules[1].stages = ["staging", "prod"];
  doc.modules[1].inputs = { name: { required: true } };
  doc.modules[1].instead = { from: "staging", source: "modules/db" };
  const d = provenStageMap(withStageMap(doc, reviewPath));
  assert.deepEqual(byId(d, "db").instead, { from: "staging", module: "db_cluster" });
  assert.equal(byId(d, "db_cluster").instead, undefined);
  assert.equal(stagesCheck(d).passed, true);
});

// Greg's fourth round of eval runs of Step 2, Nov 1, 2026.
const holding = () => {
  const doc = juniperish();
  doc.modules[1].inputs = { name: { required: true } };
  return doc;
};

test("a replacement says the stages of the two it names, when neither said, in a note", () => {
  const doc = holding();
  doc.modules[0].instead = { from: "staging", source: "modules/db-cluster" };
  const d = provenStageMap(withStageMap(doc, reviewPath));
  assert.deepEqual(byId(d, "db").stages, ["dev"]);
  assert.deepEqual(byId(d, "db_cluster").stages, ["staging", "prod"]);
  assert.equal(byId(d, "db").stages_read_from, undefined, "the mark is code's own and never kept");
  assert.match(d.discovery.stage_notes.join(" "), /db_cluster's stages were not said; as it takes db's place from staging, it is for staging, prod\./);
  assert.equal(stagesCheck(d).passed, true);
});

test("an aside goes with the stage it is set aside from", () => {
  const doc = holding();
  doc.modules[0].instead = { from: "staging", source: "modules/db-cluster" };
  const path = { ...reviewPath, aside: [{ name: "perf", from: "staging", built_by: "not_said" }] };
  const d = provenStageMap(withStageMap(doc, path));
  assert.deepEqual(byId(d, "db_cluster").stages, ["staging", "perf", "prod"], "in the order an app meets them");
  assert.deepEqual(byId(d, "db").stages, ["dev"]);
});

test("stages read from a replacement that does not hold go with it", () => {
  const doc = juniperish();
  doc.modules[0].instead = { from: "staging", source: "modules/db-cluster" };
  const d = provenStageMap(withStageMap(doc, reviewPath));
  assert.equal(byId(d, "db").instead, undefined);
  assert.equal(byId(d, "db").stages, undefined);
  assert.equal(byId(d, "db_cluster").stages, undefined);
  assert.doesNotMatch((d.discovery.stage_notes || []).join(" "), /stages were not said/);
});

test("a module a stage adds keeps no stages of its own, and does not meet the need it stands beside", () => {
  const doc = holding();
  doc.modules[2].added = { from: "staging", beside: "relational_database" };
  doc.modules[2].stages = ["staging", "prod"];
  doc.modules[2].meets = ["relational_database"];
  const d = provenStageMap(withStageMap(doc, reviewPath));
  assert.equal(byId(d, "backup").stages, undefined);
  assert.deepEqual(byId(d, "backup").meets, []);
  assert.deepEqual(d.stages.with, [{ from: "staging", module: "backup", beside: "relational_database" }]);
  assert.match(d.discovery.stage_notes.join(" "), /backup is added from staging beside every app that needs relational_database, so it is not one an app asks for itself\./);
  assert.equal(stagesCheck(d).passed, true);
});

test("a module some other gives way to keeps what it meets, and its addition is asked about", () => {
  const doc = holding();
  doc.modules[0].instead = { from: "staging", source: "modules/db-cluster" };
  doc.modules[1].added = { from: "staging", beside: "relational_database" };
  const d = provenStageMap(withStageMap(doc, reviewPath));
  assert.deepEqual(byId(d, "db_cluster").meets, ["relational_database"]);
  assert.equal(d.stages.with, undefined);
  assert.equal(stagesCheck(d).passed, false);
});

test("several stages written as one are those stages; words that are not stages stay a reading that does not fit", () => {
  const doc = holding();
  doc.modules[0].stages = ["dev-sit"];
  doc.modules[1].stages = ["staging-prod-allowed-but-not-needed"];
  const path = { stages: [{ name: "dev", built_by: "not_said", gate: [] }, { name: "sit", built_by: "not_said", gate: [] }, ...reviewPath.stages.slice(1)] };
  const d = provenStageMap(withStageMap(doc, path));
  assert.deepEqual(byId(d, "db").stages, ["dev", "sit"]);
  assert.equal(byId(d, "db_cluster").stages, undefined);
  assert.equal(stagesCheck(d).passed, false);
});

test("a module said to be for every stage there is is a module for every stage", () => {
  const doc = holding();
  doc.modules[2].stages = ["dev", "staging", "prod"];
  const d = provenStageMap(withStageMap(doc, reviewPath));
  assert.equal(byId(d, "backup").stages, undefined);
  assert.equal(d.discovery.unproven, undefined);
});

test("a module read as for later stages only, that nothing reaches, is for every stage, in a note", () => {
  const doc = holding();
  doc.modules.push({ id: "name", source: "modules/name", availability: "available", line: "A name of your own.", meets: ["custom_domain"] });
  doc.need_kinds.push({ key: "custom_domain", line: "a name of its own" });
  doc.modules[3].stages = ["staging", "prod"];
  const d = provenStageMap(withStageMap(doc, reviewPath));
  assert.equal(byId(d, "name").stages, undefined);
  assert.match(d.discovery.stage_notes.join(" "), /name was read as for staging, prod only, but nothing takes it in another's place or adds it at a stage, so no app could use it; it is for every stage\./);
  assert.equal(stagesCheck(d).passed, true);
});
