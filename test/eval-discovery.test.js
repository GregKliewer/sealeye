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
  assert.equal(key.catalog.modules.length, 13);
  const graded = gradeCatalog(key.catalog, key);
  assert.equal(graded.correct, true, gradeLines(graded).join("\n"));
  assert.deepEqual(graded.pending.map(p => p.case), ["overlap", "gaps", "stages"], "what waits is listed, never counted as passed");
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
    [doc => { bySource(doc, "modules/postgres").guidance = "A database."; }, /overlap \(part\): a database's guidance does not say which stages/]
  ];
  for (const [spoil, says] of cases) {
    const doc = copy();
    spoil(doc);
    const graded = gradeCatalog(doc, key);
    assert.equal(graded.correct, false, String(says));
    assert.match(gradeLines(graded).join("\n"), says);
  }
});

test("the key is checked against a library: folders, variables, and the planted secret", async () => {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-library-"));
  const put = (file, text) => { fs.mkdirSync(path.dirname(path.join(lib, file)), { recursive: true }); fs.writeFileSync(path.join(lib, file), text); };
  put("modules/one/variables.tf", 'variable "name" {\n  type = string\n}\n\nvariable "size" {\n  type    = number\n  default = 1\n}\n');
  put("modules/two/variables.tf", 'variable "name" {\n  type = string\n}\n');
  put("modules/one/examples/x/terraform.tfvars", "a = 1\n");
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
  const scan = async () => ({ found: [{ file: "modules/one/main.tf", line: 3, rule: "assigned-secret" }] });
  const { problems } = await checkLibrary(lib, small, { scan });
  assert.deepEqual(problems, ["modules/two is in the library and not in the key", "modules/gone is in the key and not in the library"]);

  small.catalog.modules[0].inputs.size.required = true;
  const missed = async () => ({ found: [{ file: "modules/one/other.tf", line: 1, rule: "assigned-secret" }] });
  const again = await checkLibrary(lib, small, { scan: missed });
  assert.ok(again.problems.includes("modules/one: size is not required in the library"));
  assert.ok(again.problems.includes("the scanner did not stop modules/one/main.tf:3"));
  assert.ok(again.problems.includes("the scanner found what the key does not plant: modules/one/other.tf:1"));
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
