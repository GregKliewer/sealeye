// A platform engineer editing a draft's words before approving it (Greg, Oct 16, 2026,
// after Juniper's first draft was refused for "outside Terraform" in one line). The real
// API, no AWS, no model; the rules themselves in core/catalog-edits.js.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { starterCatalog } from "../core/catalog.js";
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
const row = (version, status) => ({ org: "default", version, status, document: draft(), createdBy: "discovery", createdAt: at, approvedBy: status === "draft" ? null : "x@example.com", approvedAt: status === "draft" ? null : at });

before(async () => {
  api = await startApi({
    tokens: [{ token: ANA, id: "ana", team: "default" }, { token: LEE, id: "lee", team: "platform", scope: "org" }],
    records: [], aws: "",
    files: { "catalogs.json": [row(1, "draft"), row(2, "approved"), row(3, "draft")] }
  });
});
after(() => api?.stop());

const edit = (v, body, tok = LEE) => api.call(`/catalogs/${v}/edits`, { token: tok, method: "POST", body });

test("a draft refused for one word is put right by hand, and then approved", async () => {
  assert.equal((await api.call("/catalogs/1/approve", { token: LEE, method: "POST", body: {} })).status, 422);
  const line = await edit(1, { module: "secrets", field: "line", text: "Named places for the secrets an app reads — its values put in by the team, never in its code." });
  assert.equal(line.status, 200, JSON.stringify(line.body));
  assert.match(line.body.selfTest.checks.find(c => c.id === "words").problems.join(" "), /secrets: input secret_names says Terraform/, "the self-test is run again, and says what is left");
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
  assert.equal(secrets.id, "secrets");
  assert.equal(secrets.availability, "available", "nothing but words changes");
});

test("only a draft's words, only by an organization-wide token, only the fields that are words", async () => {
  assert.equal((await edit(3, { module: "postgres", field: "line", text: "A database." }, ANA)).status, 403);
  const approved = await edit(2, { module: "postgres", field: "line", text: "A database." });
  assert.equal(approved.status, 409);
  assert.match(approved.body.error.message, /only a draft's words are changed/);
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

test("sealeye catalog edit changes the words and prints the self-test", async () => {
  const run = args => promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), ...args, "--api", api.api], {
    env: { ...process.env, NO_COLOR: "1", SEALEYE_TOKEN: LEE, SEALEYE_HOME: api.home }
  }).catch(err => err);
  const out = await run(["catalog", "edit", "3", "secrets", "line", "Named places for the secrets your app reads."]);
  assert.match(out.stdout, /secrets: What it gives an app is now: Named places for the secrets your app reads\./);
  assert.match(out.stdout, /secrets: input secret_names says Terraform/);
  const shown = await run(["catalog", "edit", "3", "secrets"]);
  assert.match(shown.stdout, /line\s+What it gives an app\s+Named places for the secrets your app reads\./);
  assert.match(shown.stdout, /input:secret_names\s+Input secret_names\s+Names only: the values are never in Terraform\./);
  const bad = await run(["catalog", "edit", "3", "secrets", "availability", "x"]);
  assert.match(bad.stdout + bad.stderr, /is not something whose words can be changed/);
});
