// A discovery run end to end (PHASE4-PLAN Step 6), with a scripted model and no network:
// the library is read by the same rules a run on the server uses, a worker reads each
// module, the supervisor writes the draft, questions go out as they arise, and answers
// are used whether they come before the entries are written or after.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-discovery-home-"));
process.env.SEALEYE_HOME = home;
delete process.env.DATABASE_URL;

const { openCatalogs, catalogAt, catalogsOf } = await import("../api/catalogs.js");
const { createDiscoveryService, mayDiscover, RunGoing } = await import("../api/discovery/service.js");
const { readLibraryFolder } = await import("../api/discovery/library.js");
const { mayRead } = await import("../api/discovery/readers.js");
const { listModules, moduleInputs, idFor } = await import("../api/discovery/terraform.js");
const { catalogProblems } = await import("../core/catalog.js");
const { gradeCatalog, loadAnswerKey } = await import("../scripts/eval-discovery.js");
const { isRedactedLine } = await import("../core/scan.js");

before(async () => {
  await openCatalogs();
});

/** A small library: two databases that overlap by stage, a deprecated cache, a README and a pipeline. */
function library() {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-lib-")), "acme-platform");
  const put = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  };
  put("README.md", "# Acme platform\nApps go dev, then staging, then prod.\n");
  put(".github/workflows/promote.yml", "name: promote\non: workflow_call\n");
  put("modules/db/README.md", "A database for dev only. From staging up use db-cluster.\n");
  put("modules/db/variables.tf", 'variable "name" {\n  type        = string\n  description = "The app\'s name."\n}\n\nvariable "size" {\n  type    = string\n  default = "small"\n}\n');
  put("modules/db/main.tf", 'resource "x" "db" {\n  name = var.name\n}\n');
  put("modules/db/examples/restore/main.tf", 'module "db" {\n  source = "../.."\n  master_password = "Qv7r2Nx9Tb4Kw8Mz3Hc6Pd5"\n}\n');
  put("modules/db-cluster/README.md", "The database from staging up.\n");
  put("modules/db-cluster/variables.tf", 'variable "name" {\n  type = string\n}\n');
  put("modules/cache/README.md", "Deprecated: do not use for new apps.\n");
  put("modules/cache/variables.tf", 'variable "name" {\n  type = string\n}\n');
  return dir;
}

const usage = { input_tokens: 1000, output_tokens: 200 };
const text = c => (typeof c === "string" ? c : JSON.stringify(c));

/**
 * A scripted model that answers as each reader would. `hold` is a promise the
 * supervisor's first call waits on; `holdWorker` one the db-cluster worker waits on
 * before it hands in, so a test can answer a question at either moment.
 */
function scripted({ hold = null, holdWorker = null, deprecated = ["modules/cache"], libraryQuestion = false, looseTouches = false, rewriteQuestion = false, repeat = false, repeatWider = false } = {}) {
  const calls = [];
  const seen = { results: [] };
  const create = async params => {
    const tools = params.tools.map(t => t.name);
    const opening = text(params.messages[0].content);
    calls.push({ tools, model: params.model, opening, turns: params.messages.length });
    for (const m of params.messages) if (m.role === "user" && Array.isArray(m.content)) seen.results.push(...m.content.filter(c => c.type === "tool_result"));

    if (tools.includes("submit_finding")) {
      const source = opening.match(/Your module is (\S+)\./)[1];
      if (params.messages.length === 1) {
        // Read its own README, an example, and try another module's README.
        const reads = [`${source}/README.md`, `${source}/examples/restore/main.tf`, "modules/cache-not-mine/README.md", "modules/db-cluster/README.md"]
          .map((p, i) => ({ type: "tool_use", id: `t${i}`, name: "read_file", input: { path: p } }));
        return { content: reads, stop_reason: "tool_use", usage };
      }
      if (holdWorker && source === "modules/db-cluster") await holdWorker;
      const finding = {
        line: `Gives your app what ${source} provides.`,
        when: "When the app needs it.",
        signals: ["code that asks for it"],
        role: "core",
        availability: deprecated.includes(source) ? "deprecated" : "available",
        stages: source === "modules/db" ? "dev only" : source === "modules/db-cluster" ? "staging and up" : "all",
        rules: [{ rule: `Read from ${source}'s README.`, evidence: { file: `${source}/README.md`, shows: "says so" } }],
        questions: source === "modules/cache"
          ? [{ kind: "deprecated", question: "Is the cache still offered to anyone?", options: ["No", "Yes, to old apps"], guess: "No", evidence: [{ file: "modules/cache/README.md", shows: "says deprecated" }] }]
          : []
      };
      return { content: [{ type: "tool_use", id: "f", name: "submit_finding", input: finding }], stop_reason: "tool_use", usage };
    }
    if (tools.includes("submit_library")) {
      const questions = libraryQuestion
        ? [{ kind: "other", question: "Does perf come from staging?", options: ["Yes", "No"], guess: "Yes", evidence: [{ file: "README.md", shows: "says little" }] }]
        : [];
      return { content: [{ type: "tool_use", id: "l", name: "submit_library", input: { stages: ["dev", "staging", "prod"], rules: [], questions } }], stop_reason: "tool_use", usage };
    }
    if (tools.includes("write_catalog")) {
      if (hold && calls.filter(c => c.tools.includes("write_catalog")).length === 1) await hold;
      const sources = opening.match(/Write the entries for these modules: (.+)\./)[1].split(", ");
      const first = sources.length > 2;
      const asked = JSON.parse(opening.slice(opening.indexOf("Questions so far, with any answers:") + 35));
      const overlapAnswer = asked.find(q => q.kind === "overlap")?.answer;
      const entries = sources.map(source => ({
        source,
        line: `Gives your app what ${source} provides.`,
        when: "When the app needs it.",
        signals: ["code that asks for it"],
        role: "core",
        availability: source === "modules/cache" ? "deprecated" : "available",
        guidance: source === "modules/db" ? `Below staging only${overlapAnswer ? ` (${overlapAnswer})` : ""}.` : source === "modules/db-cluster" ? "From staging up." : "As the library says.",
        open: []
      }));
      const wider = repeatWider && first
        ? [{ kind: "other", question: "Is the cache still offered to anyone at all?", options: ["No", "Yes"], guess: "No", touches: ["modules/cache", "modules/db"], evidence: [{ file: "modules/cache/README.md", shows: "deprecated" }] }]
        : [];
      const repeated = repeat && first
        ? [
            { kind: "deprecated", question: "Is the cache module still offered to any apps at all?", options: ["No", "Yes"], guess: "No", touches: ["modules/cache"], evidence: [{ file: "modules/cache/README.md", shows: "deprecated" }] },
            { kind: "other", question: "Should the cache's own README name what replaces it?", options: ["Yes", "No"], guess: "Yes", touches: ["modules/cache"], evidence: [{ file: "modules/cache/README.md", shows: "no replacement named" }] }
          ]
        : [];
      const questions = [...wider, ...repeated, ...(first
        ? [{ kind: "overlap", question: "Which database is for which stage?", options: ["db below staging, db-cluster from staging up", "Either at any stage"], guess: "db below staging, db-cluster from staging up", touches: looseTouches ? ["db", "modules/db-cluster/"] : ["modules/db", "modules/db-cluster"], evidence: [{ file: "modules/db/README.md", shows: "says dev only" }] }]
        : rewriteQuestion
          ? [{ kind: "other", question: "Is the cluster's backup rule for prod only?", options: ["Yes", "No"], guess: "Yes", touches: ["modules/db-cluster"], evidence: [{ file: "modules/db-cluster/README.md", shows: "says staging up" }] }]
          : [])];
      return { content: [{ type: "tool_use", id: "w", name: "write_catalog", input: { entries, questions } }], stop_reason: "tool_use", usage };
    }
    throw new Error("unexpected call");
  };
  return { client: { messages: { create } }, calls, seen };
}

const caller = { email: "platform@acme.test", org: "acme", team: "platform", scope: "org" };
const readFolder = dir => async () => readLibraryFolder(dir, { repo: "acme/platform" });

test("plain code finds the modules and their inputs, leaving examples out", () => {
  const dir = library();
  assert.deepEqual(listModules(dir), ["modules/cache", "modules/db", "modules/db-cluster"]);
  assert.deepEqual(moduleInputs(path.join(dir, "modules/db")), { name: { required: true, line: "The app's name." }, size: { required: false, default: "small" } });
  assert.equal(idFor("modules/db-cluster"), "db_cluster");
});

test("a worker reads its own folder, README.md and .github, and nothing else", () => {
  assert.ok(mayRead("modules/db", "modules/db/main.tf"));
  assert.ok(mayRead("modules/db", "README.md"));
  assert.ok(mayRead("modules/db", ".github/workflows/promote.yml"));
  assert.ok(!mayRead("modules/db", "modules/db-cluster/README.md"));
  assert.ok(!mayRead("modules/db", "modules/dbx/main.tf"));
  assert.ok(!mayRead("modules/db", "../etc/passwd"));
  assert.ok(!mayRead(".", "modules/db/main.tf"), "the library reader reads only the library's own documents");
});

test("only an organization-wide token may run discovery", () => {
  assert.equal(mayDiscover({ ...caller, scope: "team" }), false);
  assert.equal(mayDiscover(caller), true);
});

test("a run reads every module in parallel, raises questions as they come, and writes a draft that rests on them", async () => {
  const model = scripted();
  const service = createDiscoveryService({ client: model.client, readLibrary: readFolder(library()) });
  const events = [];
  const started = await service.start({ caller, repos: [{ owner: "acme", repo: "platform" }] });
  service.subscribe(started.discoveryId, 0, e => e && events.push(e));
  await service.settled(started.discoveryId);

  const run = service.get(started.discoveryId);
  assert.equal(run.status, "finished");
  assert.deepEqual(run.modules.map(m => [m.source, m.status]), [["modules/cache", "read"], ["modules/db", "read"], ["modules/db-cluster", "read"]]);
  assert.ok(run.spent > 0);

  // Workers on the small route, the supervisor on the frontier one; no model named by a caller.
  assert.ok(model.calls.filter(c => c.tools.includes("submit_finding")).every(c => c.model === "claude-haiku-5-5"));
  assert.ok(model.calls.filter(c => c.tools.includes("write_catalog")).every(c => c.model === "claude-sonnet-5"));

  // What the workers were shown: the flagged line replaced, another module's README refused.
  const results = model.seen.results.map(r => text(r.content));
  assert.ok(results.some(r => r.split("\n").some(isRedactedLine)), "the planted password's line arrives replaced");
  assert.ok(!results.some(r => r.includes("Qv7r2Nx9")));
  assert.ok(results.some(r => /refused: modules\/db-cluster\/README\.md is not yours to read/.test(r)));

  // The draft: a catalog, every input from the variables, the deprecated module not offered.
  const draft = catalogAt("acme", run.catalog.version);
  assert.deepEqual(catalogProblems(draft), []);
  assert.equal(catalogsOf("acme").find(c => c.version === run.catalog.version).status, "draft");
  const byId = Object.fromEntries(draft.modules.map(m => [m.id, m]));
  assert.deepEqual(Object.keys(byId), ["cache", "db", "db_cluster"]);
  assert.deepEqual(byId.db.inputs, { name: { required: true, line: "The app's name." }, size: { required: false, default: "small" } });
  assert.equal(byId.db.builds_with, "terraform");
  assert.equal(byId.cache.availability, "deprecated");
  assert.equal(draft.discovery.library[0].repo, "acme/platform");

  // Questions went out as events, and the entries resting on them say so.
  const questions = service.questions(started.discoveryId);
  const overlap = questions.find(q => q.kind === "overlap");
  const deprecated = questions.find(q => q.kind === "deprecated");
  assert.deepEqual(overlap.touches, ["modules/db", "modules/db-cluster"]);
  assert.deepEqual(deprecated.touches, ["modules/cache"]);
  assert.ok(events.filter(e => e.type === "question").length === 2);
  assert.deepEqual(byId.db.open, [overlap.id]);
  assert.deepEqual(byId.db_cluster.open, [overlap.id]);
  assert.deepEqual(byId.cache.open, [deprecated.id]);
  assert.equal(events.at(-1).type, "finished");
});

test("a late answer re-writes only the entries it touches, in the same draft", async () => {
  const model = scripted();
  const service = createDiscoveryService({ client: model.client, readLibrary: readFolder(library()) });
  const { discoveryId } = await service.start({ caller, repos: [{ owner: "acme", repo: "platform" }] });
  await service.settled(discoveryId);
  const version = service.get(discoveryId).catalog.version;
  const overlap = service.questions(discoveryId).find(q => q.kind === "overlap");
  const before = model.calls.length;

  const saved = await service.answer({ id: discoveryId, questionId: overlap.id, answer: "db below staging, db-cluster from staging up", by: "lead@acme.test" });
  assert.equal(saved.answeredBy, "lead@acme.test");
  await service.settled(discoveryId);

  const again = model.calls.slice(before);
  assert.equal(again.length, 1, "one supervisor call, nothing read again");
  assert.match(again[0].opening, /Write the entries for these modules: modules\/db, modules\/db-cluster\./);

  const run = service.get(discoveryId);
  assert.equal(run.catalog.version, version, "the draft is changed in place");
  const draft = catalogAt("acme", version);
  const byId = Object.fromEntries(draft.modules.map(m => [m.id, m]));
  assert.equal(byId.db.open, undefined);
  assert.match(byId.db.guidance, /db below staging/);
  assert.ok(byId.cache.open, "the cache still rests on its own question");
  assert.ok(service.questions(discoveryId).find(q => q.id === overlap.id).usedAt);
});

test("an answer that comes before the entries are written is used, with no second pass", async () => {
  let release;
  const holdWorker = new Promise(r => (release = r));
  const model = scripted({ holdWorker });
  const service = createDiscoveryService({ client: model.client, readLibrary: readFolder(library()) });
  const { discoveryId } = await service.start({ caller, repos: [{ owner: "acme", repo: "platform" }] });
  // Wait for the cache worker's question, then answer it while the supervisor is held.
  let q;
  for (let i = 0; i < 200 && !q; i++) {
    await new Promise(r => setTimeout(r, 10));
    q = service.questions(discoveryId).find(x => x.kind === "deprecated");
  }
  await service.answer({ id: discoveryId, questionId: q.id, answer: "No", by: "lead@acme.test" });
  release();
  await service.settled(discoveryId);

  const writes = model.calls.filter(c => c.tools.includes("write_catalog"));
  assert.equal(writes.length, 1, "no second pass");
  assert.match(writes[0].opening, /"answer": "No"/, "the supervisor saw the answer");
  const draft = catalogAt("acme", service.get(discoveryId).catalog.version);
  assert.equal(draft.modules.find(m => m.id === "cache").open, undefined);
  assert.ok(service.questions(discoveryId).find(x => x.id === q.id).usedAt);
});

test("a worker that reaches its cap leaves its module not read; a run that reaches its own stops with nothing written", async () => {
  process.env.SEALEYE_DISCOVERY_WORKER_CAP = "0.0001";
  try {
    const model = scripted();
    const service = createDiscoveryService({ client: model.client, readLibrary: readFolder(library()) });
    const { discoveryId } = await service.start({ caller, repos: [{ owner: "acme", repo: "platform" }] });
    await service.settled(discoveryId);
    const run = service.get(discoveryId);
    assert.equal(run.status, "finished");
    assert.ok(run.modules.every(m => m.status === "not_read"));
    const draft = catalogAt("acme", run.catalog.version);
    assert.ok(draft.modules.every(m => m.not_read), "each says it was not read");
    assert.ok(draft.modules.every(m => m.availability !== "available"), "and none is offered, whatever the supervisor wrote");
  } finally {
    delete process.env.SEALEYE_DISCOVERY_WORKER_CAP;
  }

  process.env.SEALEYE_DISCOVERY_RUN_CAP = "0.0001";
  try {
    const model = scripted();
    const service = createDiscoveryService({ client: model.client, readLibrary: readFolder(library()) });
    const { discoveryId } = await service.start({ caller, repos: [{ owner: "acme", repo: "platform" }] });
    await service.settled(discoveryId);
    const run = service.get(discoveryId);
    assert.equal(run.status, "stopped");
    assert.equal(run.reason, "spending_limit");
    assert.equal(run.catalog, null);
  } finally {
    delete process.env.SEALEYE_DISCOVERY_RUN_CAP;
  }
});

test("a run cut off by a restart is marked stopped when the API starts again", async () => {
  const store = await import("../api/discovery/store.js");
  await store.saveRun({ id: "dsc_cutoff", org: "acme", status: "running", repos: [], modules: [], spend: {}, createdAt: new Date().toISOString() });
  const service = createDiscoveryService({ client: scripted().client });
  await service.open();
  const run = service.get("dsc_cutoff");
  assert.equal(run.status, "stopped");
  assert.equal(run.reason, "restarted");
});

test("Juniper Mutual: given good words, the draft passes the answer key's checks", { skip: !process.env.SEALEYE_SAMPLE_PLATFORM && "set SEALEYE_SAMPLE_PLATFORM to a clone of the library" }, async () => {
  const key = loadAnswerKey();
  const words = new Map(key.catalog.modules.map(m => [m.source, m]));
  // A model that writes the key's own words: what is graded here is everything code does.
  const client = {
    messages: {
      create: async params => {
        const tools = params.tools.map(t => t.name);
        const opening = text(params.messages[0].content);
        if (tools.includes("submit_finding")) {
          const source = opening.match(/Your module is (\S+)\./)[1];
          const k = words.get(source);
          return { content: [{ type: "tool_use", id: "f", name: "submit_finding", input: { line: k.line, when: k.when || "", signals: k.signals || [], role: k.role || "optional", availability: k.availability === "available" ? "available" : "deprecated", stages: "all", rules: [], questions: [] } }], usage };
        }
        if (tools.includes("submit_library")) return { content: [{ type: "tool_use", id: "l", name: "submit_library", input: { stages: ["dev", "sit", "uat", "staging", "prod"], rules: [], questions: [] } }], usage };
        const sources = opening.match(/Write the entries for these modules: (.+)\./)[1].split(", ");
        const entries = sources.map(source => {
          const k = words.get(source);
          return { source, line: k.line, when: k.when || "", signals: k.signals || [], role: k.role || "optional", availability: k.availability === "available" ? "available" : "deprecated", guidance: k.guidance || "", open: [] };
        });
        return { content: [{ type: "tool_use", id: "w", name: "write_catalog", input: { entries, questions: [] } }], usage };
      }
    }
  };
  const service = createDiscoveryService({ client, readLibrary: async () => readLibraryFolder(process.env.SEALEYE_SAMPLE_PLATFORM, { repo: key.library }) });
  const { discoveryId } = await service.start({ caller, repos: [{ owner: "GregKliewer", repo: "sealeye-sample-platform" }] });
  await service.settled(discoveryId);
  const draft = catalogAt("acme", service.get(discoveryId).catalog.version);
  const graded = gradeCatalog(draft, key);
  assert.deepEqual(graded.modules.filter(m => !m.ok), []);
  assert.deepEqual(graded.extra, []);
  assert.deepEqual(graded.problems, []);
  assert.ok(graded.hardCases.every(h => h.ok), JSON.stringify(graded.hardCases));
});

test("an answer that comes while the entries are being written is a late answer: one more pass", async () => {
  let release;
  const hold = new Promise(r => (release = r));
  const model = scripted({ hold });
  const service = createDiscoveryService({ client: model.client, readLibrary: readFolder(library()) });
  const { discoveryId } = await service.start({ caller, repos: [{ owner: "acme", repo: "platform" }] });
  let writing = false;
  for (let i = 0; i < 300 && !writing; i++) {
    await new Promise(r => setTimeout(r, 10));
    writing = model.calls.some(c => c.tools.includes("write_catalog"));
  }
  const q = service.questions(discoveryId).find(x => x.kind === "deprecated");
  await service.answer({ id: discoveryId, questionId: q.id, answer: "No", by: "lead@acme.test" });
  release();
  await service.settled(discoveryId);

  const writes = model.calls.filter(c => c.tools.includes("write_catalog"));
  assert.equal(writes.length, 2);
  assert.doesNotMatch(writes[0].opening, /"answer": "No"/, "the first pass had read the questions already");
  assert.match(writes[1].opening, /Write the entries for these modules: modules\/cache\./);
  const draft = catalogAt("acme", service.get(discoveryId).catalog.version);
  assert.equal(draft.modules.find(m => m.id === "cache").open, undefined);
});

test("on Postgres, a run and its questions are kept, and an answer outlives a restart", { skip: !process.env.SEALEYE_TEST_DATABASE_URL && "no SEALEYE_TEST_DATABASE_URL" }, async () => {
  const { freshDatabase } = await import("./helpers/pg.js");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const url = await freshDatabase();
  const childHome = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-discovery-pg-"));
  const root = path.resolve(import.meta.dirname, "..");
  const inChild = async code => {
    const env = { ...process.env, SEALEYE_HOME: childHome, HOME: childHome, DATABASE_URL: url };
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code], { cwd: root, env });
    return JSON.parse(stdout.trim().split("\n").at(-1));
  };
  await inChild(`import { openStore } from "./api/store.js"; await openStore(); console.log("{}"); process.exit(0);`);
  const kept = await inChild(`
    import * as s from "./api/discovery/store.js";
    await s.openDiscoveries();
    await s.saveRun({ id: "dsc_pg", org: "acme", status: "running", repos: [], modules: [], spend: {}, createdAt: "2026-10-15T18:00:00.000Z" });
    await s.saveQuestion({ id: "q_pg", seq: 0, discovery: "dsc_pg", org: "acme", kind: "overlap", question: "Which?", options: ["a", "b"], guess: "a", touches: [], evidence: [], answer: null, createdAt: "2026-10-15T18:00:01.000Z" });
    await s.saveQuestion({ ...s.getQuestion("q_pg"), answer: "b", answeredBy: "lead@acme.test", answeredAt: "2026-10-15T18:05:00.000Z" });
    console.log("{}"); process.exit(0);`);
  assert.deepEqual(kept, {});
  const after = await inChild(`
    import { createDiscoveryService } from "./api/discovery/service.js";
    const svc = createDiscoveryService({ client: { messages: { create: async () => ({}) } } });
    await svc.open();
    console.log(JSON.stringify({ run: svc.get("dsc_pg"), questions: svc.questions("dsc_pg") }));
    process.exit(0);`);
  assert.equal(after.run.status, "stopped", "a run left running when the API stopped");
  assert.equal(after.run.reason, "restarted");
  assert.equal(after.questions[0].answer, "b");
  assert.equal(after.questions[0].answeredBy, "lead@acme.test");
  assert.ok(!fs.existsSync(path.join(childHome, "discoveries.json")), "with a database, no file");
});

test("an answer taken as the draft is kept leaves the run finished, and is used", async () => {
  const model = scripted();
  const service = createDiscoveryService({ client: model.client, readLibrary: readFolder(library()) });
  const { discoveryId } = await service.start({ caller, repos: [{ owner: "acme", repo: "platform" }] });
  let answered = null;
  service.subscribe(discoveryId, 0, e => {
    // The moment the draft is kept, before the run is marked finished.
    if (e?.type === "draft" && !answered) {
      const q = service.questions(discoveryId).find(x => x.kind === "overlap");
      answered = service.answer({ id: discoveryId, questionId: q.id, answer: "Either at any stage", by: "lead@acme.test" });
    }
  });
  await service.settled(discoveryId);
  await answered;
  await service.settled(discoveryId);
  const run = service.get(discoveryId);
  assert.equal(run.status, "finished");
  assert.ok(run.finishedAt);
  assert.ok(service.questions(discoveryId).find(q => q.kind === "overlap").usedAt);
});

test("an answer changed while the entries are written is not lost: the new one is used", async () => {
  let releaseWorker;
  let releaseWriter;
  const holdWorker = new Promise(r => (releaseWorker = r));
  const hold = new Promise(r => (releaseWriter = r));
  const model = scripted({ holdWorker, hold });
  const service = createDiscoveryService({ client: model.client, readLibrary: readFolder(library()) });
  const { discoveryId } = await service.start({ caller, repos: [{ owner: "acme", repo: "platform" }] });
  let q;
  for (let i = 0; i < 300 && !q; i++) {
    await new Promise(r => setTimeout(r, 10));
    q = service.questions(discoveryId).find(x => x.kind === "deprecated");
  }
  await service.answer({ id: discoveryId, questionId: q.id, answer: "No", by: "lead@acme.test" });
  releaseWorker();
  for (let i = 0; i < 300 && !model.calls.some(c => c.tools.includes("write_catalog")); i++) await new Promise(r => setTimeout(r, 10));
  await service.answer({ id: discoveryId, questionId: q.id, answer: "Yes, to old apps", by: "lead@acme.test" });
  releaseWriter();
  await service.settled(discoveryId);

  const writes = model.calls.filter(c => c.tools.includes("write_catalog"));
  assert.equal(writes.length, 2, "the changed answer gets a pass of its own");
  assert.match(writes[1].opening, /"answer": "Yes, to old apps"/);
  const now = service.questions(discoveryId).find(x => x.id === q.id);
  assert.equal(now.answer, "Yes, to old apps");
  assert.ok(now.usedAt);
});

test("a question names modules loosely or none at all: the entries, or the catalog, say they rest on it", async () => {
  const model = scripted({ libraryQuestion: true, looseTouches: true });
  const service = createDiscoveryService({ client: model.client, readLibrary: readFolder(library()) });
  const { discoveryId } = await service.start({ caller, repos: [{ owner: "acme", repo: "platform" }] });
  await service.settled(discoveryId);
  const questions = service.questions(discoveryId);
  const overlap = questions.find(q => q.kind === "overlap");
  const perf = questions.find(q => /perf/.test(q.question));
  assert.deepEqual(overlap.touches, ["modules/db", "modules/db-cluster"], "an id and a folder with a slash both match");
  assert.deepEqual(perf.touches, []);
  const draft = catalogAt("acme", service.get(discoveryId).catalog.version);
  assert.deepEqual(draft.discovery.open, [perf.id], "the catalog as a whole rests on it");
  assert.ok(draft.modules.find(m => m.id === "db").open.includes(overlap.id));

  await service.answer({ id: discoveryId, questionId: perf.id, answer: "Yes", by: "lead@acme.test" });
  await service.settled(discoveryId);
  assert.equal(catalogAt("acme", service.get(discoveryId).catalog.version).discovery.open, undefined);
});

test("a question the supervisor raises while re-writing goes out, and its entry rests on it", async () => {
  const model = scripted({ rewriteQuestion: true });
  const service = createDiscoveryService({ client: model.client, readLibrary: readFolder(library()) });
  const { discoveryId } = await service.start({ caller, repos: [{ owner: "acme", repo: "platform" }] });
  await service.settled(discoveryId);
  const overlap = service.questions(discoveryId).find(q => q.kind === "overlap");
  await service.answer({ id: discoveryId, questionId: overlap.id, answer: "Either at any stage", by: "lead@acme.test" });
  await service.settled(discoveryId);
  const raised = service.questions(discoveryId).find(q => /backup rule/.test(q.question));
  assert.ok(raised, "kept and sent");
  const draft = catalogAt("acme", service.get(discoveryId).catalog.version);
  assert.deepEqual(draft.modules.find(m => m.id === "db_cluster").open, [raised.id]);
});

test("one run at a time for an organization, and one library a run", async () => {
  let release;
  const holdWorker = new Promise(r => (release = r));
  const model = scripted({ holdWorker });
  const service = createDiscoveryService({ client: model.client, readLibrary: readFolder(library()) });
  const other = { ...caller, org: "solo" };
  const { discoveryId } = await service.start({ caller: other, repos: [{ owner: "acme", repo: "platform" }] });
  await assert.rejects(service.start({ caller: other, repos: [{ owner: "acme", repo: "platform" }] }), RunGoing);
  release();
  await service.settled(discoveryId);
  await assert.rejects(service.start({ caller: other, repos: [{ owner: "acme", repo: "one" }, { owner: "acme", repo: "two" }] }), err => err.code === "ONE_LIBRARY");
});

test("every rule a reader found reaches its entry, whatever the supervisor wrote", async () => {
  const { draftCatalog } = await import("../api/discovery/draft.js");
  const modules = [
    { source: "modules/logs", id: "logs", inputs: {}, finding: { line: "Logs.", availability: "available", stages: "all", rules: [
      { rule: "From staging up, alarms go to oncall-pager and nowhere else", stages: "staging and up", evidence: { file: "modules/logs/README.md", line: 12, shows: "says so" } },
      { rule: "Keep logs a year in prod.", evidence: { file: "modules/logs/main.tf", shows: "retention" } }
    ] } },
    { source: "modules/db", id: "db", inputs: {}, finding: { line: "A database.", availability: "available", stages: "all", rules: [] } }
  ];
  const library = { stages: ["dev", "prod"], rules: [
    { rule: "Prod needs a change ticket", applies_to: ["all"], evidence: { file: "README.md", shows: "says so" } },
    { rule: "Databases are backed up nightly", applies_to: ["db/"], evidence: { file: "README.md", shows: "says so" } }
  ] };
  const entries = [
    // The supervisor kept one rule in its own words and dropped the other.
    { source: "modules/logs", line: "Logs.", guidance: "Alarms go to the on-call team from staging up. Keep logs a year in prod.", availability: "available" },
    { source: "modules/db", line: "A database.", guidance: "Use it for relational data.", availability: "available" }
  ];
  const doc = draftCatalog({ run: { id: "dsc_r", repos: [] }, modules, library, entries, questions: [] });
  const logs = doc.modules.find(m => m.id === "logs");
  assert.match(logs.guidance, /oncall-pager/, "the dropped rule is added in the reader's words");
  assert.equal(logs.guidance.match(/Keep logs a year in prod/g).length, 1, "a rule already there is not repeated");
  assert.match(logs.guidance, /Prod needs a change ticket/);
  assert.deepEqual(logs.rules[0], { rule: "From staging up, alarms go to oncall-pager and nowhere else", stages: "staging and up", evidence: { file: "modules/logs/README.md", line: 12 } });
  const db = doc.modules.find(m => m.id === "db");
  assert.match(db.guidance, /^Use it for relational data\. .*Databases are backed up nightly/);
  assert.ok(!/oncall-pager/.test(db.guidance), "a module's rule stays with its module");
});

test("a question the supervisor asks again in its own words is dropped; a new one on the same module is kept", async () => {
  const model = scripted({ repeat: true });
  const service = createDiscoveryService({ client: model.client, readLibrary: readFolder(library()) });
  const { discoveryId } = await service.start({ caller, repos: [{ owner: "acme", repo: "platform" }] });
  await service.settled(discoveryId);
  const onCache = service.questions(discoveryId).filter(q => q.touches.includes("modules/cache"));
  assert.deepEqual(onCache.map(q => q.question), ["Is the cache still offered to anyone?", "Should the cache's own README name what replaces it?"]);
});

test("a question asked again in nearly the same words is dropped, even naming one more module", async () => {
  const model = scripted({ repeatWider: true });
  const service = createDiscoveryService({ client: model.client, readLibrary: readFolder(library()) });
  const { discoveryId } = await service.start({ caller, repos: [{ owner: "acme", repo: "platform" }] });
  await service.settled(discoveryId);
  const onCache = service.questions(discoveryId).filter(q => q.touches.includes("modules/cache"));
  assert.deepEqual(onCache.map(q => q.question), ["Is the cache still offered to anyone?"]);
});

test("a question asked again after it was answered is dropped: the answer stands (Greg's run, Oct 15)", async () => {
  let release;
  const hold = new Promise(r => (release = r));
  const model = scripted({ repeat: true, hold });
  const service = createDiscoveryService({ client: model.client, readLibrary: readFolder(library()) });
  const { discoveryId } = await service.start({ caller, repos: [{ owner: "acme", repo: "platform" }] });
  for (let i = 0; i < 300 && !model.calls.some(c => c.tools.includes("write_catalog")); i++) await new Promise(r => setTimeout(r, 10));
  const q = service.questions(discoveryId).find(x => x.kind === "deprecated");
  await service.answer({ id: discoveryId, questionId: q.id, answer: "No", by: "lead@acme.test" });
  release();
  await service.settled(discoveryId);
  const onCache = service.questions(discoveryId).filter(x => x.touches.includes("modules/cache"));
  assert.deepEqual(onCache.map(x => x.question), ["Is the cache still offered to anyone?", "Should the cache's own README name what replaces it?"]);
  assert.equal(onCache.find(x => x.kind === "deprecated").answer, "No");
});

test("a late answer says on the run that it is being written in, and when it is", async () => {
  const model = scripted({});
  const service = createDiscoveryService({ client: model.client, readLibrary: readFolder(library()) });
  const { discoveryId } = await service.start({ caller, repos: [{ owner: "acme", repo: "platform" }] });
  await service.settled(discoveryId);
  assert.equal(service.get(discoveryId).rewriting, false);
  const q = service.questions(discoveryId).find(x => x.kind === "deprecated");
  await service.answer({ id: discoveryId, questionId: q.id, answer: "No", by: "lead@acme.test" });
  assert.equal(service.get(discoveryId).rewriting, true, "the stream has ended, so the run itself says so");
  await service.settled(discoveryId);
  assert.equal(service.get(discoveryId).rewriting, false);
  assert.equal(service.get(discoveryId).answerProblem, undefined);
  assert.ok(service.questions(discoveryId).find(x => x.id === q.id).usedAt, "written into the draft");
});

test("the supervisor is bounded by the run's cap, not a reader's, so a late answer is written after a costly first draft", async () => {
  const { createBudget, SpendingLimit } = await import("../api/discovery/readers.js");
  const budget = createBudget({ workerCap: 0.1, runCap: 3, spend: { supervisor: { cost: 0.15 }, "worker:modules/db": { cost: 0.1 } } });
  assert.doesNotThrow(() => budget.check("supervisor"));
  assert.throws(() => budget.check("worker:modules/db"), SpendingLimit);
  const full = createBudget({ workerCap: 0.1, runCap: 3, spend: { supervisor: { cost: 3 } } });
  assert.throws(() => full.check("supervisor"), err => err.scope === "run");
});

test("questions the supervisor says ask the same thing are merged: one kept, touching what each did, with who asked each", async () => {
  const model = scripted({ libraryQuestion: true });
  const create = model.client.messages.create;
  // The supervisor's first write merges the library reader's question into the cache's.
  model.client.messages.create = async params => {
    const reply = await create(params);
    if (!params.tools.some(t => t.name === "write_catalog") || model.calls.filter(c => c.tools.includes("write_catalog")).length > 1) return reply;
    const opening = text(params.messages[0].content);
    const asked = JSON.parse(opening.slice(opening.indexOf("Questions so far, with any answers:") + 35));
    const keep = asked.find(q => q.kind === "deprecated");
    const other = asked.find(q => q.question.startsWith("Does perf"));
    reply.content[0].input.merges = [{ keep: keep.id, merged: [other.id, "q_not_this_runs"] }];
    return reply;
  };
  const service = createDiscoveryService({ client: model.client, readLibrary: readFolder(library()) });
  const events = [];
  const started = await service.start({ caller, repos: [{ owner: "acme", repo: "platform" }] });
  service.subscribe(started.discoveryId, 0, e => e && events.push(e));
  await service.settled(started.discoveryId);

  const questions = service.questions(started.discoveryId);
  assert.ok(!questions.some(q => q.question.startsWith("Does perf")), "the merged one is not asked again");
  const kept = questions.find(q => q.kind === "deprecated");
  assert.deepEqual(kept.merged, [{ question: "Does perf come from staging?", raisedBy: "supervisor" }]);
  assert.deepEqual(kept.touches, ["modules/cache"]);
  const merged = events.find(e => e.type === "merged");
  assert.equal(merged.questions.length, 1);

  // The draft rests on the one kept, and the catalog no longer on the merged one.
  const run = service.get(started.discoveryId);
  const draft = catalogAt("acme", run.catalog.version);
  assert.equal(draft.discovery.open, undefined);
  assert.deepEqual(draft.modules.find(m => m.id === "cache").open, [kept.id]);

  // An answer to the merged question, still on someone's screen, answers the one kept.
  const answered = await service.answer({ id: started.discoveryId, questionId: merged.questions[0], answer: "No", by: "lee@acme.test" });
  assert.equal(answered.id, kept.id);
  await service.settled(started.discoveryId);
  assert.equal(service.questions(started.discoveryId).find(q => q.id === kept.id).answer, "No");
});
