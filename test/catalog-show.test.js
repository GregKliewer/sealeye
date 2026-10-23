// `sealeye catalog show [v]` (Greg, Oct 23, 2026): one catalog, titled by its status,
// its entries, and the questions its run asked with each answer under its question, as
// the Discovery page shows a catalog chosen from its Catalogs card.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { startApi, token } from "./helpers/api-with-aws.js";
import { starterCatalog } from "../core/catalog.js";
import { answerStateWords, catalogTitleWords } from "../core/discovery-words.js";

const root = path.resolve(import.meta.dirname, "..");
const LEE = token("l");
let api;
const at = new Date().toISOString();

const document = run => ({
  catalogVersion: "d", discovery: { run, library: [] },
  modules: [
    { id: "db", source: "modules/db", availability: "available", builds_with: "terraform", line: "A relational database for your app." },
    { id: "old_cache", source: "modules/old-cache", availability: "deprecated", builds_with: "terraform", line: "An old cache." }
  ],
  need_kinds: starterCatalog().need_kinds, profiles: starterCatalog().profiles
});
const catalog = (version, status, run) => ({
  org: "default", version, status, createdBy: "lee@example.com", createdAt: at,
  approvedBy: status === "draft" ? null : "lee@example.com", approvedAt: status === "draft" ? null : at,
  madeLiveBy: status === "live" ? "lee@example.com" : null, madeLiveAt: status === "live" ? at : null, document: document(run)
});
const run = (id, version) => ({
  id, org: "default", status: "finished", startedBy: "lee@example.com", caller: { email: "lee@example.com", org: "default", team: "platform" },
  surface: "cli", repos: [{ repo: "northwind/library", commit: "a".repeat(40) }], modules: [], library: { stages: [], rules: [] },
  cap: { worker: 0.1, run: 3 }, spend: {}, catalogVersion: version, createdAt: at, finishedAt: at
});
const question = (id, discovery, text, extra) => ({
  id, seq: 1, discovery, org: "default", kind: "other", question: text, options: ["Yes", "No"], guess: "Yes",
  touches: ["modules/db"], evidence: [], raisedBy: "supervisor", answer: null, createdAt: at, ...extra
});

before(async () => {
  api = await startApi({
    tokens: [{ token: LEE, id: "lee", team: "platform", scope: "org" }],
    records: [],
    aws: "",
    files: {
      "catalogs.json": [catalog(1, "live", "dsc_1"), catalog(2, "draft", "dsc_2")],
      "discoveries.json": {
        runs: [run("dsc_1", 2), run("dsc_2", 2)],
        questions: [
          question("q_a", "dsc_1", "Is db for every stage?", { answer: "Only dev", answeredBy: "lee@example.com", answeredAt: at, usedAt: at, usedIn: 1 }),
          question("q_b", "dsc_1", "Is old_cache still used?", { answer: "No", answeredBy: "lee@example.com", answeredAt: at, usedAt: at, usedIn: 2 }),
          question("q_c", "dsc_2", "Who owns db?")
        ]
      }
    }
  });
});

after(() => api?.stop());

const sealeye = (args, tok) => promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), ...args, "--api", api.api], {
  env: { ...process.env, NO_COLOR: "1", SEALEYE_TOKEN: tok, SEALEYE_HOME: api.home }
}).catch(err => err);

test("a catalog is titled by its status: a draft is a draft, a live one never is", () => {
  assert.equal(catalogTitleWords(9, "draft"), "Draft catalog 9");
  assert.equal(catalogTitleWords(8, "live"), "Catalog 8, live");
  assert.equal(catalogTitleWords(7, "approved"), "Catalog 7, approved, not live");
  assert.equal(catalogTitleWords(3, "retired"), "Catalog 3, retired");
  assert.equal(catalogTitleWords(3, null), "Catalog 3", "never a guess before its status is read");
});

test("an answer read against a chosen catalog says where it went", () => {
  const used = { usedAt: at, usedIn: 4 };
  assert.equal(answerStateWords(used, {}, { version: 3, status: "live" }).words, "written into catalog 4, after this one");
  assert.equal(answerStateWords({ ...used, usedIn: 3 }, {}, { version: 3, status: "live" }).words, "in catalog 3");
  assert.equal(answerStateWords({ ...used, usedIn: 3 }, {}, { version: 3, status: "draft" }).words, "in the draft");
  assert.equal(answerStateWords({ usedAt: null }, {}, { version: 3, status: "retired" }).words, "waiting to be written into a new draft");
  // Without a chosen catalog, the words are as they were.
  assert.equal(answerStateWords({ usedAt: at }, {}).words, "in the draft");
});

test("sealeye catalog show: the live one by default, its entries, and each answer under its question", async () => {
  const { stdout } = await sealeye(["catalog", "show"], LEE);
  assert.match(stdout, /Catalog 1, live/);
  assert.doesNotMatch(stdout, /Draft catalog 1/);
  assert.match(stdout, /db\s+Offered\s+A relational database for your app\./);
  assert.match(stdout, /old_cache\s+Deprecated/);
  assert.match(stdout, /Asked in run dsc_1:/);
  assert.match(stdout, /Is db for every stage\?\n {4}│ Only dev\n {6}lee@example\.com · \d{4}-\d\d-\d\d · in catalog 1/);
  assert.match(stdout, /Is old_cache still used\?\n {4}│ No\n.*written into catalog 2, after this one/);
});

test("sealeye catalog show <v>: a draft, its open question, and how to answer it", async () => {
  const { stdout } = await sealeye(["catalog", "show", "2"], LEE);
  assert.match(stdout, /Draft catalog 2/);
  assert.match(stdout, /Who owns db\?\n {4}waiting on an answer; the guess is Yes/);
  assert.match(stdout, /sealeye discover answers dsc_2 answers them here; an answer goes into this draft\./);
  const json = await sealeye(["catalog", "show", "2", "--json"], LEE);
  const out = JSON.parse(json.stdout.slice(json.stdout.indexOf("{")));
  assert.equal(out.catalog.version, 2);
  assert.equal(out.questions.length, 1);
});
