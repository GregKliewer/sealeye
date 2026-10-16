// The made-up organization's answer key and its grader (PHASE4-PLAN Step 4,
// scripts/eval-discovery.js). No network: the library itself is checked only when a
// clone of it is named in SEALEYE_SAMPLE_PLATFORM.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkLibrary, gradeCatalog, gradeLines, loadAnswerKey, moduleVariables } from "../scripts/eval-discovery.js";
import { catalogProblems, catalogForPrompt, isBuildable } from "../core/catalog.js";
import { loadSystemPrompt } from "../api/interview/model.js";
import { moduleIdSource, unlistedNeedProblems } from "../core/schema.js";
import { renderPlanMarkdown } from "../core/plan-files.js";

const key = loadAnswerKey();
const copy = () => structuredClone(key.catalog);
const bySource = (doc, source) => doc.modules.find(m => m.source === source);

test("the answer key is a catalog by seaLeye's own rules, and passes its own grading", () => {
  assert.deepEqual(catalogProblems(key.catalog), []);
  assert.equal(key.catalog.modules.length, 14);
  const graded = gradeCatalog(key.catalog, key);
  assert.equal(graded.correct, true, gradeLines(graded).join("\n"));
  assert.deepEqual(graded.pending.map(p => p.case), ["overlap", "unclear module asked", "gaps", "stages"], "what waits is listed, never counted as passed");
  assert.ok(key.catalog.modules.every(m => !isBuildable(m.id, key.catalog)), "nothing builds Terraform until Step 9");
});

test("a module discovery names in its own way is matched by where it is in the library", () => {
  const doc = copy();
  bySource(doc, "modules/postgres").id = "relational_small";
  assert.equal(gradeCatalog(doc, key).correct, true);
});

test("each way a catalog can be wrong is caught, and says how", () => {
  const cases = [
    [doc => { doc.modules = doc.modules.filter(m => m.source !== "modules/work-queue"); }, /modules\/work-queue: missing/],
    [doc => { bySource(doc, "modules/cache-redis").availability = "available"; }, /deprecated: offered/],
    [doc => { bySource(doc, "modules/logs-and-alarms").guidance = "Alarms go to the team."; }, /readme_rule: guidance does not say oncall-pager, staging/],
    [doc => { bySource(doc, "modules/http-api").builds_with = "cloudformation"; }, /builds_with is cloudformation, not terraform/],
    [doc => { delete bySource(doc, "modules/secrets").inputs.secret_names; }, /inputs missing: secret_names/],
    [doc => { bySource(doc, "modules/secrets").inputs.kms_key = { line: "x" }; }, /inputs it does not have: kms_key/],
    [doc => { bySource(doc, "modules/http-api").inputs.package_path.required = false; }, /not marked required: package_path/],
    [doc => { doc.modules.push({ id: "made_up", source: "modules/made-up", line: "x" }); }, /modules\/made-up: not in the library/],
    [doc => { bySource(doc, "modules/postgres").guidance = "A database."; }, /overlap \(part\): a database's guidance does not say which stages/],
    // "postgres" inside "postgres-cluster" is not naming postgres.
    [doc => { bySource(doc, "modules/postgres-cluster").guidance = "Always from staging up, as postgres-cluster."; }, /overlap: each names the other: postgres_cluster's entry does not name postgres/]
  ];
  for (const [spoil, says] of cases) {
    const doc = copy();
    spoil(doc);
    const graded = gradeCatalog(doc, key);
    assert.equal(graded.correct, false, String(says));
    assert.match(gradeLines(graded).join("\n"), says);
  }
});

test("the key is checked against a library as discovery reads it: folders, variables, the planted secret", async () => {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-library-"));
  const put = (file, text) => { fs.mkdirSync(path.dirname(path.join(lib, file)), { recursive: true }); fs.writeFileSync(path.join(lib, file), text); };
  put("modules/one/variables.tf", 'variable "name" {\n  type = string\n}\n\nvariable "size" {\n  type    = number\n  default = 1\n}\n');
  put("modules/two/variables.tf", 'variable "name" {\n  type = string\n}\n');
  put("modules/one/examples/x/terraform.tfvars", "a = 1\n");
  // Made up, in the shape Juniper's is: the scanner must stop it.
  put("modules/one/main.tf", 'resource "x" "y" {\n  name = var.name\n  master_password = "Qv7r2Nx9Tb4Kw8Mz3Hc6Pd5"\n}\n');
  put(".github/workflows/build.yml", "on: push\n");
  const small = {
    catalog: { modules: [
      { id: "one", source: "modules/one", inputs: { name: { required: true }, size: { default: 1 } } },
      { id: "gone", source: "modules/gone", inputs: {} }
    ] },
    hard_cases: {
      planted_secret: { file: "modules/one/main.tf", line: 3, rule: "assigned-secret" },
      secret_file: { file: "modules/one/examples/x/terraform.tfvars" }
    }
  };
  assert.deepEqual(moduleVariables(path.join(lib, "modules/one")), { name: { required: true }, size: { required: false } });
  const { problems } = await checkLibrary(lib, small);
  assert.deepEqual(problems, ["modules/two is in the library and not in the key", "modules/gone is in the key and not in the library"]);

  small.catalog.modules[0].inputs.size.required = true;
  small.hard_cases.planted_secret.line = 2;
  fs.rmSync(path.join(lib, ".github"), { recursive: true });
  const again = await checkLibrary(lib, small);
  assert.ok(again.problems.includes("modules/one: size is not required in the library"));
  assert.ok(again.problems.includes("the scanner did not stop modules/one/main.tf:2"));
  assert.ok(again.problems.includes("the scanner found what the key does not plant: modules/one/main.tf:3"));
  assert.ok(again.problems.includes("discovery's reading left out the library's pipeline"));
});

test("Juniper's catalog in the interview: no module named, and every need still there", () => {
  const prompt = loadSystemPrompt(key.catalog);
  // Found as seaLeye looks for a module's name: an ordinary word only written as code.
  for (const m of key.catalog.modules) assert.doesNotMatch(prompt, new RegExp(moduleIdSource(m.id)), m.id);
  assert.match(prompt, /seaLeye\.run builds no modules here yet\./);
  // Its `secrets` module is an ordinary word: the need about secrets must not be taken
  // for naming it, or dropped with it.
  assert.match(catalogForPrompt(key.catalog), /\*\*runtime_secrets\*\*  "secrets it reads while it runs"/);
  assert.doesNotMatch(prompt, /\{\{/);
});

test("with a clone of the library, the key matches it and the scanner stops the planted secret", { skip: !process.env.SEALEYE_SAMPLE_PLATFORM && "set SEALEYE_SAMPLE_PLATFORM to a clone of the library" }, async () => {
  const { problems } = await checkLibrary(process.env.SEALEYE_SAMPLE_PLATFORM, key);
  assert.deepEqual(problems, []);
});

test("an id that is an ordinary word is a module's name only when written as code", () => {
  assert.equal(new RegExp(moduleIdSource("secrets")).test("secrets it reads while it runs"), false);
  assert.equal(new RegExp(moduleIdSource("secrets")).test("put them in `secrets`"), true);
  assert.equal(new RegExp(moduleIdSource("http_api")).test("an http_api for it"), true, "an id that looks like one is found anywhere");
  assert.equal(new RegExp(moduleIdSource("http_api")).test("an http_api_serverless"), false);

  // The three places it is used, with Juniper's catalog.
  const plan = { planVersion: "0.5", catalog: 1, app: { name: "rates", type: "api" }, profile: "dev", modules: [], outputs: [] };
  const unlisted = line => ({ ...plan, needs: [{ kind: "unlisted", line, evidence: [{ file: "a.js", shows: "x" }] }] });
  const ids = key.catalog.modules.map(m => m.id);
  assert.deepEqual(unlistedNeedProblems(unlisted("a store for secrets"), ids), []);
  assert.ok(unlistedNeedProblems(unlisted("a store for `secrets`"), ids).some(p => p.message.includes("names a module")));
  assert.ok(unlistedNeedProblems(unlisted("a work_queue for it"), ids).some(p => p.message.includes("names a module")));
  const md = renderPlanMarkdown({ plan, summary: "It reads secrets while it runs.", assumptions: ["Kept the secrets out of the plan."] }, { catalog: key.catalog });
  assert.match(md, /It reads secrets while it runs\./, "a plan file that says the word is still written");
  assert.throws(() => renderPlanMarkdown({ plan, summary: "It uses work_queue.", assumptions: [] }, { catalog: key.catalog }), /names work_queue/);
});

test("with a run's questions: the unclear module must be asked, and its entry rest on the question", () => {
  const doc = copy();
  const q = { id: "q_1", touches: ["modules/cache-valkey", "modules/cache-redis"], question: "Does cache-valkey replace cache-redis for new apps?", answer: null };
  bySource(doc, "modules/cache-valkey").open = ["q_1"];
  assert.equal(gradeCatalog(doc, key, { questions: [q] }).correct, true);

  const notAsked = gradeCatalog(copy(), key, { questions: [] });
  assert.match(gradeLines(notAsked).join("\n"), /unclear module asked: no question touches modules\/cache-valkey and modules\/cache-redis/);

  // A question about the module alone is about something else (the third measured run).
  const aside = copy();
  bySource(aside, "modules/cache-valkey").open = ["q_2"];
  const other = { id: "q_2", touches: ["modules/cache-valkey"], question: "Does it add backups from staging up?", answer: null };
  assert.equal(gradeCatalog(aside, key, { questions: [other] }).correct, false);

  const notResting = gradeCatalog(copy(), key, { questions: [q] });
  assert.match(gradeLines(notResting).join("\n"), /asked, but its entry does not rest on the question/);

  // Whatever availability the run guessed for it, only the question is graded.
  const guessed = copy();
  bySource(guessed, "modules/cache-valkey").availability = "deprecated";
  bySource(guessed, "modules/cache-valkey").open = ["q_1"];
  assert.equal(gradeCatalog(guessed, key, { questions: [q] }).correct, true);
});

test("the answer key's own catalog passes the self-test a draft must pass to be approved", async () => {
  const { selfTest } = await import("../api/self-test.js");
  const result = selfTest({ document: key.catalog, version: 1 });
  assert.equal(result.passed, true, JSON.stringify(result.checks.filter(c => !c.passed)));
  assert.equal(result.refused.find(r => r.id === "cache_redis").why, "the library has deprecated it");
});

test("graded twice: no answers, then the key's answers at fixed points; each pass as the key expects", { skip: !process.env.SEALEYE_SAMPLE_PLATFORM && "set SEALEYE_SAMPLE_PLATFORM to a clone of the library" }, async () => {
  process.env.SEALEYE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-eval-twice-"));
  delete process.env.DATABASE_URL;
  const { openCatalogs } = await import("../api/catalogs.js");
  const { runDiscovery, scriptedAnswer } = await import("../scripts/eval-discovery.js");
  await openCatalogs();
  const words = new Map(key.catalog.modules.map(m => [m.source, m]));
  const usage = { input_tokens: 1000, output_tokens: 200 };
  const entryFor = (source, asked) => {
    const k = words.get(source);
    // The unclear cache is offered as the answer says, once it has one.
    const valkey = asked.find(q => (q.touches || []).includes("modules/cache-valkey"));
    const availability = k.availability === "available" ? "available" : "deprecated";
    return { source, line: k.line, when: k.when || "", signals: k.signals || [], role: k.role || "optional", availability: source === "modules/cache-valkey" && valkey?.answer?.startsWith("No") ? "deprecated" : availability, guidance: k.guidance || "", open: [] };
  };
  // A model with the key's words that asks what a careful engineer asks: the unclear
  // cache (the supervisor, naming both), and one question of a reader's own.
  const client = {
    messages: {
      create: async params => {
        const tools = params.tools.map(t => t.name);
        const opening = typeof params.messages[0].content === "string" ? params.messages[0].content : JSON.stringify(params.messages[0].content);
        if (tools.includes("submit_finding")) {
          const source = opening.match(/Your module is (\S+)\./)[1];
          const k = words.get(source);
          const questions = source === "modules/work-queue"
            ? [{ kind: "other", question: "Are failed messages kept in every stage?", options: ["Yes", "Only from staging up"], guess: "Yes", evidence: [{ file: "modules/work-queue/README.md", shows: "a dead-letter queue" }] }]
            : [];
          // No input lines of its own: the library's variable descriptions stand, and
          // some say "subnet" or "Terraform", so the fix-up has to put them right.
          return { content: [{ type: "tool_use", id: "f", name: "submit_finding", input: { line: k.line, when: k.when || "", signals: k.signals || [], role: k.role || "optional", availability: k.availability === "available" ? "available" : "deprecated", stages: "all", rules: [], questions } }], usage };
        }
        if (tools.includes("submit_library")) return { content: [{ type: "tool_use", id: "l", name: "submit_library", input: { stages: ["dev", "sit", "uat", "staging", "prod"], rules: [], questions: [] } }], usage };
        const sources = opening.match(/Write the entries for these modules: (.+)\./)[1].split(", ");
        const asked = JSON.parse(opening.slice(opening.indexOf("Questions so far, with any answers:") + 35));
        const first = sources.length > 2;
        const questions = first
          ? [{ kind: "deprecated", question: "Is cache-valkey the replacement for cache-redis for new apps?", options: ["No, not yet", "Yes"], guess: "No, not yet", touches: ["modules/cache-valkey", "modules/cache-redis"], evidence: [{ file: "modules/cache-redis/README.md", shows: "no cache for new apps until replaced" }] }]
          : [];
        // Asked to write entries again in plain words: the key's own lines for every input.
        const plain = opening.includes("words a developer never reads");
        if (plain) fixUps += 1;
        const entries = sources.map(s => ({
          ...entryFor(s, asked),
          ...(plain ? { input_lines: Object.fromEntries(Object.entries(words.get(s).inputs || {}).filter(([, v]) => v?.line).map(([n, v]) => [n, v.line])) } : {})
        }));
        return { content: [{ type: "tool_use", id: "w", name: "write_catalog", input: { entries, questions: plain ? [] : questions } }], usage };
      }
    }
  };
  let fixUps = 0;
  const out = dir => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-eval-out-")), `${dir}.yaml`);

  const none = await runDiscovery(process.env.SEALEYE_SAMPLE_PLATFORM, key, out("none"), { client });
  assert.ok(none.graded.correct, gradeLines(none.graded).join("\n"));
  assert.equal(fixUps, 1, "the library's own descriptions were written again once, and then the self-test passed");
  assert.deepEqual(none.graded.hardCases.filter(h => h.case.startsWith("must refuse") || h.case === "self-test").map(h => [h.case, h.ok]),
    [["self-test", true], ["must refuse: deprecated", true], ["must refuse: resting on a question", true]]);

  const scripted = await runDiscovery(process.env.SEALEYE_SAMPLE_PLATFORM, key, out("scripted"), { client, scripted: true });
  assert.ok(scripted.graded.correct, gradeLines(scripted.graded).join("\n"));
  const answered = Object.fromEntries(scripted.questions.map(q => [q.question, q.answer]));
  assert.equal(answered["Is cache-valkey the replacement for cache-redis for new apps?"], key.answers.ambiguous.answer, "answered as it went out");
  assert.equal(answered["Are failed messages kept in every stage?"], "Yes", "answered with its guess, after the draft");
  assert.ok(scripted.graded.hardCases.some(h => h.case === "answers written in" && h.ok));
  assert.equal(scriptedAnswer({ touches: ["modules/postgres"], guess: "A" }, key, "as_asked"), null, "only the unclear one is answered as it goes out");
});
