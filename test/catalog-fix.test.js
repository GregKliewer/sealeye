// Fixing what blocks a draft's approval (DESIGN.md, "What blocks approval is fixed in one
// walk", Greg, Oct 16, 2026): the self-test names each field to change by module and
// field, `sealeye catalog fix` walks them one at a time, and a refused approval offers
// the walk. The real API, no AWS, no model; the walk in a real terminal through `script`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { starterCatalog } from "../core/catalog.js";
import { fixableByEditing, fixedWords, notFixedByEditing, wordFixesOf } from "../core/discovery-words.js";
import { selfTest } from "../api/self-test.js";
import { startApi, token } from "./helpers/api-with-aws.js";

const root = path.resolve(import.meta.dirname, "..");
const LEE = token("l");
const at = "2026-10-16T15:00:00.000Z";

const draft = () => ({
  catalogVersion: "d", discovery: { run: "dsc_1", library: [] },
  modules: [
    { id: "secrets", source: "modules/secrets", availability: "available", builds_with: "terraform", line: "Named places for the secrets an app reads, put in by the team outside Terraform.", inputs: { secret_names: { required: true, line: "Names only: the values are never in Terraform or a log group." } } },
    { id: "postgres", source: "modules/postgres", availability: "available", builds_with: "terraform", line: "A relational database for your app.", inputs: {} }
  ],
  need_kinds: starterCatalog().need_kinds, profiles: starterCatalog().profiles
});
const row = version => ({ org: "default", version, status: "draft", document: draft(), createdBy: "discovery", createdAt: at, approvedBy: null, approvedAt: null });

let api;
before(async () => {
  api = await startApi({
    tokens: [{ token: LEE, id: "lee", team: "platform", scope: "org" }],
    records: [], aws: "",
    files: { "catalogs.json": [1, 2, 3, 4, 5].map(row) }
  });
});
after(() => api?.stop());

const env = { ...process.env, NO_COLOR: "1", SEALEYE_TOKEN: LEE };
const cli = args => promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), ...args, "--api", api.api], { env: { ...env, SEALEYE_HOME: api.home } })
  .then(r => ({ ...r, code: 0 }), err => ({ stdout: err.stdout, stderr: err.stderr, code: err.code }));

/**
 * The command in a terminal of its own (`script`), typing each reply once the screen
 * shows what it waits for (a null reply only waits). Ctrl-U clears the words the walk
 * put on the line first.
 */
function inTerminal(args, replies) {
  const line = [process.execPath, path.join(root, "cli/bin/sealeye"), ...args, "--api", api.api].map(a => `'${a}'`).join(" ");
  const child = spawn("script", ["-qec", line, "/dev/null"], { env: { ...env, SEALEYE_HOME: api.home, TERM: "dumb" } });
  let out = "";
  let next = 0;
  let seen = 0;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`stuck after:\n${out}`)); }, 20_000);
    child.stdout.on("data", d => {
      out += d;
      while (next < replies.length) {
        const [waitFor, reply] = replies[next];
        const i = out.indexOf(waitFor, seen);
        if (i === -1) break;
        seen = i + waitFor.length;
        next += 1;
        if (reply !== null) child.stdin.write(reply);
      }
    });
    child.on("close", code => { clearTimeout(timer); resolve({ out, code, typed: next }); });
  });
}
const CLEAR = "\u0015";

test("the self-test names each field to change by module and field, and what no edit reaches", () => {
  const doc = draft();
  doc.need_kinds = [...doc.need_kinds, { key: "lambda_thing", line: "A Lambda your app calls." }];
  const result = selfTest({ document: doc, version: 1 });
  assert.deepEqual(wordFixesOf(result).map(f => [f.module, f.field, f.words]), [
    ["secrets", "line", ['"Terraform"']],
    ["secrets", "input:secret_names", ['"log group"', '"Terraform"']]
  ]);
  assert.equal(wordFixesOf(result)[0].label, "What it gives an app");
  assert.equal(wordFixesOf(result)[0].text, draft().modules[0].line);
  assert.equal(fixableByEditing(result), false, "a need kind's words are not a module's: no edit reaches them");
  assert.match(notFixedByEditing(result).join(" "), /need lambda_thing is not one of a module's words, so no edit reaches it/);
  assert.equal(fixableByEditing(selfTest({ document: draft(), version: 1 })), true);
  assert.deepEqual(notFixedByEditing(selfTest({ document: draft(), version: 1 })), []);
});

test("an edit cannot fix an open question about the whole catalog, and the words say what does", () => {
  const doc = { ...draft(), discovery: { run: "dsc_1", library: [], open: ["q1"] } };
  const result = selfTest({ document: doc, version: 1, questionText: () => "Which cache?" });
  assert.equal(fixableByEditing(result), false);
  assert.match(notFixedByEditing(result).join(" "), /answering it writes a new draft/);
  assert.equal(fixedWords({ changed: 2, kept: 1 }), "Changed 2 fields, left 1 field as it was.");
  assert.equal(fixedWords({ changed: 0, kept: 2 }), "Left 2 fields as they were.");
  assert.equal(fixedWords({ changed: 0, kept: 0 }), "Nothing to change.");
});

test("with no terminal, catalog fix lists each field and the command that changes it", async () => {
  const r = await cli(["catalog", "fix", "1"]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /Catalog 1: 2 fields say words a developer never reads/);
  assert.match(r.stdout, /sealeye catalog edit 1 secrets line "<words>"/);
  assert.match(r.stdout, /sealeye catalog edit 1 secrets input:secret_names "<words>"/);
  assert.match(r.stdout, /Not: "log group", "Terraform"/);
  const json = JSON.parse((await cli(["catalog", "fix", "1", "--json"])).stdout);
  assert.equal(json.fixes.length, 2);
});

test("catalog test and catalog edit point to the walk, and edit marks the fields that fail", async () => {
  const tested = await cli(["catalog", "test", "1"]);
  assert.match(tested.stdout, /sealeye catalog fix 1 goes through each field to change/);
  const shown = await cli(["catalog", "edit", "1", "secrets"]);
  assert.match(shown.stdout, /✗ line\s+What it gives an app/);
  assert.match(shown.stdout, /✗ input:secret_names/);
  assert.match(shown.stdout, /Not: "log group", "Terraform"/);
  assert.doesNotMatch(shown.stdout, /✗ when/);
});

test("refused for words with no terminal, approve says which command fixes them", async () => {
  const r = await cli(["catalog", "approve", "1"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stdout + r.stderr, /sealeye catalog fix 1 goes through each field to change/);
});

test("the walk: each field in turn, a word still there is caught, Enter leaves one, and approval is offered", async () => {
  const r = await inTerminal(["catalog", "fix", "2"], [
    ["1 of 2", null], ["New words (Enter leaves them):", `${CLEAR}Named places for the secrets your app reads, outside Terraform.\r`],
    ['That still says "Terraform"', `${CLEAR}Named places for the secrets your app reads, put in by your team.\r`],
    ["2 of 2", null], ["New words (Enter leaves them):", "\r"]
  ]);
  assert.equal(r.typed, 5, r.out);
  assert.match(r.out, /1 of 2\s+secrets\s+What it gives an app/);
  assert.match(r.out, /secrets: What it gives an app is changed/);
  assert.match(r.out, /2 of 2\s+secrets\s+Input secret_names/);
  assert.match(r.out, /Changed 1 field, left 1 field as it was\./);
  assert.match(r.out, /sealeye catalog fix 2 goes through what is left/);
  // The walk ends on the self-test: one field still fails, so nothing is offered.
  assert.doesNotMatch(r.out, /Approve catalog 2 now/);
  const list = await cli(["catalog", "versions", "--json"]);
  assert.equal(JSON.parse(list.stdout).catalogs.find(c => c.version === 2).status, "draft");
});

test("a fixed walk offers approval, and yes approves", async () => {
  const r = await inTerminal(["catalog", "fix", "3"], [
    ["1 of 2", null], ["New words (Enter leaves them):", `${CLEAR}Named places for the secrets your app reads.\r`],
    ["2 of 2", null], ["New words (Enter leaves them):", `${CLEAR}The names of the secrets your app reads, never their values.\r`],
    ["Approve catalog 3 now? [y/N]", "y\r"]
  ]);
  assert.equal(r.typed, 5, r.out);
  assert.match(r.out, /Catalog 3 passed its self-test\./);
  assert.match(r.out, /Catalog 3 is approved\./);
  assert.equal(r.code, 0);
});

test("a refused approval offers the walk, and approves once it passes", async () => {
  const r = await inTerminal(["catalog", "approve", "4"], [
    ["Fix these now? [y/N]", "y\r"],
    ["1 of 2", null], ["New words (Enter leaves them):", `${CLEAR}Named places for the secrets your app reads.\r`],
    ["2 of 2", null], ["New words (Enter leaves them):", `${CLEAR}The names of the secrets your app reads, never their values.\r`]
  ]);
  assert.equal(r.typed, 5, r.out);
  assert.match(r.out, /Catalog 4 is approved\./);
  assert.equal(r.code, 0);
});

test("no to the offer leaves the draft refused, and says how to fix it later", async () => {
  const r = await inTerminal(["catalog", "approve", "5"], [["Fix these now? [y/N]", "\r"]]);
  assert.match(r.out, /Not approved\. sealeye catalog fix 5 goes through them when you are ready/);
  assert.notEqual(r.code, 0);
  const list = await cli(["catalog", "versions", "--json"]);
  assert.equal(JSON.parse(list.stdout).catalogs.find(c => c.version === 5).status, "draft");
});

test("a size or a count is named by its own words, so a person can see which to change (Greg, Oct 16)", async () => {
  const doc = draft();
  doc.modules[1].when = "When your app keeps data in a general-purpose store or 2 replicas.";
  const result = selfTest({ document: doc, version: 1 });
  const fix = wordFixesOf(result).find(f => f.module === "postgres");
  assert.deepEqual(fix.words, ['"2 replicas" (a count of machines)']);
  assert.match(result.checks.find(c => c.id === "words").problems.join(" "), /postgres: when gives "2 replicas" \(a count of machines\)/);
  const { stillSaysWords } = await import("../core/discovery-words.js");
  const { forbiddenWords } = await import("../core/developer-words.js");
  assert.equal(stillSaysWords(forbiddenWords("Holds data, in 2 replicas.")),
    'That still says "2 replicas" (a count of machines). A developer reads "set by a load test" in place of a size or a count. Change it, or press Enter to keep it as written.');
});

test("in quotes, the words to change; after them, what they are, only when that says more", async () => {
  const { forbiddenWords, shownWord } = await import("../core/developer-words.js");
  const shown = t => forbiddenWords(t).map(shownWord);
  assert.deepEqual(shown("Built with Terraform, in ca-central-1."), ['"ca-central-1" (a region\'s name)', '"Terraform"']);
  assert.deepEqual(shown("Behind an ALB, with logs in log groups."), ['"ALB" (load balancer)', '"log groups"']);
  assert.deepEqual(shown("Holds 20 GiB."), ['"20 GiB" (a size)']);
});

test("a setting and an unspelled acronym block approval, saying what to write instead (Q21)", () => {
  const doc = draft();
  doc.modules[1].when = "When your app needs a multi-AZ database in a VPC.";
  const result = selfTest({ document: doc, version: 1 });
  const words = result.checks.find(c => c.id === "words");
  assert.equal(words.passed, false);
  assert.match(words.problems.join(" "), /postgres: when says "multi-AZ" \(write "keeps running if one data centre fails"\) and "VPC" \(write "Virtual Private Cloud \(VPC\)"\)/);
  assert.deepEqual(wordFixesOf(result).find(f => f.module === "postgres").words,
    ['"multi-AZ" (write "keeps running if one data centre fails")', '"VPC" (write "Virtual Private Cloud (VPC)")']);
});
