// A platform engineer editing a draft's words before approving it (Greg, Oct 16, 2026,
// after Juniper's first draft was refused for "outside Terraform" in one line). The real
// API, no AWS, no model; the rules themselves in core/catalog-edits.js.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { buildableView, starterCatalog } from "../core/catalog.js";
import { applyEdit, editableFieldsOf, keepEdits } from "../core/catalog-edits.js";
import { startApi, token } from "./helpers/api-with-aws.js";

const root = path.resolve(import.meta.dirname, "..");
const ANA = token("a");
const LEE = token("l");
let api;
const at = "2026-10-16T15:00:00.000Z";

const draft = () => ({
  catalogVersion: "d", discovery: { run: "dsc_1", library: [] },
  modules: [
    { id: "secrets", source: "modules/secrets", availability: "available", builds_with: "terraform", line: "Named places for the secrets an app reads, with the values put in by the team outside Terraform.", inputs: { secret_names: { required: true, line: "Names only: the values are never in Terraform." } } },
    { id: "postgres", source: "modules/postgres", availability: "available", builds_with: "terraform", line: "A relational database for your app.", inputs: {} }
  ],
  need_kinds: starterCatalog().need_kinds, profiles: starterCatalog().profiles
});
// A draft with a path past dev, Juniper's pipeline building every stage (Step 2b).
const staged = version => {
  const r = row(version, "draft");
  r.document.stages = { path: [
    { name: "dev", applies: "sealeye", gate: [] },
    { name: "sit", applies: "pipeline", pipeline: ".github/workflows/app-promote.yml", gate: [] },
    { name: "prod", applies: "pipeline", pipeline: ".github/workflows/app-promote.yml", gate: ["an approved change ticket"] }
  ] };
  // The words fixed already, so only the stage's change is in question.
  r.document.modules[0] = { ...r.document.modules[0], line: "Named places for the secrets your app reads.", inputs: { secret_names: { required: true, line: "The names of the secrets your app reads." } } };
  return r;
};
const row = (version, status) => ({ org: "default", version, status, document: draft(), createdBy: "discovery", createdAt: at, approvedBy: status === "draft" ? null : "x@example.com", approvedAt: status === "draft" ? null : at });

before(async () => {
  api = await startApi({
    tokens: [{ token: ANA, id: "ana", team: "default" }, { token: LEE, id: "lee", team: "platform", scope: "org" }],
    records: [], aws: "",
    files: { "catalogs.json": [row(1, "draft"), row(2, "approved"), row(3, "draft"), staged(4)] }
  });
});
after(() => api?.stop());

const edit = (v, body, tok = LEE) => api.call(`/catalogs/${v}/edits`, { token: tok, method: "POST", body });

test("a draft refused for one word is put right by hand, and then approved", async () => {
  assert.equal((await api.call("/catalogs/1/approve", { token: LEE, method: "POST", body: {} })).status, 422);
  const line = await edit(1, { module: "secrets", field: "line", text: "Named places for the secrets an app reads — its values put in by the team, never in its code." });
  assert.equal(line.status, 200, JSON.stringify(line.body));
  assert.match(line.body.selfTest.checks.find(c => c.id === "words").problems.join(" "), /secrets: input secret_names says "Terraform"/, "the self-test is run again, and says what is left");
  const input = await edit(1, { module: "secrets", field: "input:secret_names", text: "The names of the secrets your app reads. Names only, never the values." });
  assert.equal(input.body.selfTest.passed, true, JSON.stringify(input.body.selfTest));

  const doc = (await api.call("/catalogs/1/self-test", { token: LEE })).body;
  assert.equal(doc.selfTest.passed, true);
  const approved = await api.call("/catalogs/1/approve", { token: LEE, method: "POST", body: {} });
  assert.equal(approved.status, 200);
});

test("an edit is recorded on the entry, in plain words, with who and when", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    import fs from "node:fs";
    const rows = JSON.parse(fs.readFileSync(process.env.SEALEYE_HOME + "/catalogs.json", "utf8"));
    console.log(JSON.stringify(rows.find(r => r.version === 1).document.modules.find(m => m.id === "secrets")));
  `], { env: { ...process.env, SEALEYE_HOME: api.home } });
  const secrets = JSON.parse(stdout);
  assert.equal(secrets.line, "Named places for the secrets an app reads, its values put in by the team, never in its code.", "an em dash becomes a comma");
  assert.equal(secrets.edited.line.by, "lee@example.com");
  assert.ok(secrets.edited["input:secret_names"].at);
  const original = draft().modules.find(m => m.id === "secrets");
  for (const key of ["id", "source", "availability", "builds_with"]) assert.equal(secrets[key], original[key], `${key} is not words, and does not change`);
  assert.deepEqual(Object.keys(secrets.inputs), Object.keys(original.inputs));
  assert.equal(secrets.inputs.secret_names.required, true);
  assert.equal(secrets.open, undefined);
});

test("only a draft's words, only by an organization-wide token, only the fields that are words", async () => {
  assert.equal((await edit(3, { module: "postgres", field: "line", text: "A database." }, ANA)).status, 403);
  const approved = await edit(2, { module: "postgres", field: "line", text: "A database." });
  assert.equal(approved.status, 409);
  assert.match(approved.body.error.message, /only a draft's words are changed/);
  const two = await api.call("/catalogs/2", { token: LEE });
  assert.equal(two.body.document.modules.find(m => m.id === "postgres").line, "A relational database for your app.", "and catalog 2 is as it was");
  assert.equal(two.body.document.modules.find(m => m.id === "postgres").edited, undefined);
  for (const [body, words] of [
    [{ module: "postgres", field: "availability", text: "available" }, /is not something whose words can be changed/],
    [{ module: "nope", field: "line", text: "x" }, /has no module nope/],
    [{ module: "postgres", field: "input:size", text: "x" }, /has no input size/],
    [{ module: "postgres", field: "line", text: "  " }, /cannot be empty/],
    [{ module: "postgres" }, /names the module, the field and its new words/]
  ]) {
    const r = await edit(3, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error.message, words);
  }
  assert.equal((await edit(9, { module: "postgres", field: "line", text: "x" })).status, 404);
});

test("a rewrite keeps what a person wrote, and writes the rest", () => {
  const before = applyEdit(draft(), { module: "postgres", field: "when", text: "Below staging only.", by: "lee@example.com", at });
  const old = before.modules.find(m => m.id === "postgres");
  const rewritten = { ...old, line: "Rewritten by the supervisor.", when: "Rewritten too.", edited: undefined };
  const kept = keepEdits(old, rewritten);
  assert.equal(kept.when, "Below staging only.");
  assert.equal(kept.line, "Rewritten by the supervisor.");
  assert.deepEqual(Object.keys(kept.edited), ["when"]);
  assert.deepEqual(editableFieldsOf(old).map(f => f.field), ["line", "short-line", "when", "skip-line", "guidance"]);
});

test("a rewrite keeps an edited input line and a cleared field; an input the library renamed loses its mark", () => {
  let doc = applyEdit(draft(), { module: "secrets", field: "input:secret_names", text: "The names your app reads.", by: "lee@example.com", at });
  doc = applyEdit(doc, { module: "secrets", field: "guidance", text: "", by: "lee@example.com", at });
  const old = doc.modules.find(m => m.id === "secrets");
  const rewritten = { ...draft().modules.find(m => m.id === "secrets"), guidance: "The model's guidance." };
  const kept = keepEdits(old, rewritten);
  assert.equal(kept.inputs.secret_names.line, "The names your app reads.");
  assert.equal(kept.guidance, undefined, "cleared by a person, and kept cleared");
  const renamed = keepEdits(old, { ...rewritten, inputs: { names: { required: true, line: "From the library." } } });
  assert.deepEqual(Object.keys(renamed.edited), ["guidance"], "the input it was written for is gone");
  assert.equal(renamed.inputs.names.line, "From the library.");
});

test("who edited an entry never reaches a developer: GET /catalog's document leaves it out", () => {
  const doc = applyEdit(starterCatalog(), { module: "http_api_serverless", field: "line", text: "Runs your code when a request comes in.", by: "lee@example.com", at });
  const view = buildableView(doc).modules.find(m => m.id === "http_api_serverless");
  assert.equal(view.line, "Runs your code when a request comes in.");
  assert.equal(view.edited, undefined);
});

test("sealeye catalog edit changes the words and prints the self-test", async () => {
  const run = args => promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), ...args, "--api", api.api], {
    env: { ...process.env, NO_COLOR: "1", SEALEYE_TOKEN: LEE, SEALEYE_HOME: api.home }
  }).catch(err => err);
  const out = await run(["catalog", "edit", "3", "secrets", "line", "Named places for the secrets your app reads."]);
  assert.match(out.stdout, /secrets: What it gives an app is now: Named places for the secrets your app reads\./);
  assert.match(out.stdout, /secrets: input secret_names says "Terraform"/);
  const shown = await run(["catalog", "edit", "3", "secrets"]);
  assert.match(shown.stdout, /line\s+What it gives an app\s+Named places for the secrets your app reads\./);
  assert.match(shown.stdout, /input:secret_names\s+Input secret_names\s+Names only: the values are never in Terraform\./);
  const cleared = await run(["catalog", "edit", "3", "postgres", "when", "--clear"]);
  assert.match(cleared.stdout, /postgres: When an app uses it is cleared/);
  const bad = await run(["catalog", "edit", "3", "secrets", "availability", "x"]);
  assert.match(bad.stdout + bad.stderr, /is not something whose words can be changed/);
});

test("who builds a stage is changed on a draft, on both surfaces, and said on the self-test", async () => {
  const done = await edit(4, { stage: "sit", field: "applies", text: "sealeye" });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.ok(done.body.selfTest.notes.some(n => /^sit: built by seaLeye, as lee@example\.com chose on .* UTC; the library says the pipeline \.github\/workflows\/app-promote\.yml builds it\.$/.test(n)), JSON.stringify(done.body.selfTest.notes));
  const four = (await api.call("/catalogs/4", { token: LEE })).body.document;
  assert.equal(four.stages.path[1].applies, "sealeye");
  assert.equal(four.stages.path[1].edited.by, "lee@example.com");
  // dev, a stage it does not have, a team's token, an approved catalog.
  assert.match((await edit(4, { stage: "dev", field: "applies", text: "pipeline", pipeline: "x.yml" })).body.error.message, /dev is always built by seaLeye/);
  assert.equal((await edit(4, { stage: "qa", field: "applies", text: "sealeye" })).status, 400);
  assert.equal((await edit(4, { stage: "sit", field: "line", text: "sealeye" })).status, 400);
  assert.equal((await edit(4, { stage: "sit", field: "applies", text: "sealeye" }, ANA)).status, 403);
  assert.equal((await edit(2, { stage: "sit", field: "applies", text: "sealeye" })).status, 409);

  const run = args => promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), ...args, "--api", api.api], {
    env: { ...process.env, NO_COLOR: "1", SEALEYE_TOKEN: LEE, SEALEYE_HOME: api.home }
  }).catch(err => err);
  const shown = await run(["catalog", "edit", "4", "--stage", "sit"]);
  assert.match(shown.stdout, /sit\s+seaLeye\s+\(chosen by lee@example\.com; the library says the pipeline \.github\/workflows\/app-promote\.yml\)/);
  assert.match(shown.stdout, /prod\s+the pipeline \.github\/workflows\/app-promote\.yml\n/);
  const back = await run(["catalog", "edit", "4", "--stage", "prod", "sealeye"]);
  assert.match(back.stdout, /prod: built by seaLeye/);
  const pipe = await run(["catalog", "edit", "4", "--stage", "sit", "pipeline", ".github/workflows/app-promote.yml"]);
  assert.match(pipe.stdout, /sit: built by the pipeline \.github\/workflows\/app-promote\.yml/);
  const after = (await api.call("/catalogs/4", { token: LEE })).body.document.stages.path;
  assert.equal(after[1].edited, undefined, "back to what the library said: no edit left");
  assert.equal(after[2].applies, "sealeye");
  const wrong = await run(["catalog", "edit", "4", "--stage", "sit", "someone"]);
  assert.match(wrong.stdout + wrong.stderr, /sealeye or pipeline <name>, not someone/);
});
