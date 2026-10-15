// `sealeye discover` (PHASE4-PLAN Step 6b) against a real API holding a finished run: its
// state, its open questions, and the refusal a team's token gets, in the API's words.
// Starting and following a run is the service's (discovery-run.test.js); the picker that
// answers a question is tested here with a stand-in keyboard.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { PassThrough } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { startApi, token } from "./helpers/api-with-aws.js";
import { starterCatalog } from "../core/catalog.js";
import { choicesFor, discoveryEventLine, discoveryStateWords, LATER, SOMETHING_ELSE } from "../core/discovery-words.js";

const root = path.resolve(import.meta.dirname, "..");
const ANA = token("a");
const LEE = token("l");
let api;

const at = new Date().toISOString();
const run = {
  id: "dsc_0000000000000001", org: "default", orgName: "Acme", status: "finished", startedBy: "lee@example.com", surface: "cli",
  repos: [{ repo: "acme/platform", commit: "5e63aa5".padEnd(40, "0"), via: "app" }],
  modules: [
    { source: "modules/db", id: "db", repo: 0, hash: "0", status: "read", inputs: {}, finding: { line: "A database." } },
    { source: "modules/cache", id: "cache", repo: 0, hash: "0", status: "not_read", inputs: {}, failed: "this module reached its spending limit" }
  ],
  spend: { supervisor: { cost: 0.12 } }, catalogVersion: 1, createdAt: at, finishedAt: at
};
const question = (id, text, answer = null) => ({
  id, seq: 1, discovery: run.id, org: "default", kind: "other", question: text, options: ["Yes", "No"], guess: "No",
  touches: ["modules/db"], evidence: [{ file: "modules/db/README.md", shows: "says so" }], answer, createdAt: at
});

before(async () => {
  api = await startApi({
    tokens: [
      { token: ANA, id: "ana", team: "default", name: "Ana Pereira" },
      { token: LEE, id: "lee", team: "platform", scope: "org", name: "Lee Admin" }
    ],
    records: [],
    aws: "",
    env: { SEALEYE_LIBRARY_REPOS: "" },
    files: {
      "discoveries.json": { runs: [run], questions: [question("q_open", "Is db for dev only?"), question("q_done", "Is db encrypted?", "Yes")] },
      "catalogs.json": [{ org: "default", version: 1, status: "draft", createdBy: "lee@example.com", createdAt: at, approvedBy: null, approvedAt: null,
        document: { catalogVersion: "d", modules: [{ id: "db", source: "modules/db", availability: "available", builds_with: "terraform", line: "A database." }], need_kinds: starterCatalog().need_kinds, profiles: starterCatalog().profiles } }]
    }
  });
});

after(() => api?.stop());

const sealeye = (args, tok) => promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), ...args, "--api", api.api], {
  env: { ...process.env, NO_COLOR: "1", SEALEYE_TOKEN: tok, SEALEYE_HOME: api.home }
}).catch(err => err);

test("sealeye discover status: the latest run, what was read, and what is open", async () => {
  const { stdout } = await sealeye(["discover", "status"], LEE);
  assert.match(stdout, /dsc_0000000000000001  Finished, draft catalog 1/);
  assert.match(stdout, /library acme\/platform at 5e63aa5/);
  assert.match(stdout, /1 of 2 modules read; not read: modules\/cache/);
  assert.match(stdout, /2 questions, 1 open; spent US\$0\.12/);
  const json = await sealeye(["discover", "status", "--json"], LEE);
  assert.equal(JSON.parse(json.stdout.slice(json.stdout.indexOf("{"))).discoveryId, run.id);
});

test("sealeye discover answers, without a terminal: the open questions, and where to answer them", async () => {
  const { stdout } = await sealeye(["discover", "answers"], LEE);
  assert.match(stdout, /\? Is db for dev only\?  \(guess: No\)/);
  assert.doesNotMatch(stdout, /Is db encrypted/);
  assert.match(stdout, /Answering needs a terminal/);
});

test("a team's token is refused in the API's own words", async () => {
  const out = await sealeye(["discover", "status"], ANA);
  assert.match(`${out.stdout}${out.stderr}`, /Discovery is for your platform team: it needs an organization-wide token/);
});

test("with no library named, a run is refused in words", async () => {
  const out = await sealeye(["discover"], LEE);
  assert.match(`${out.stdout}${out.stderr}`, /No platform library is named for discovery yet/);
});

test("the picker: arrow keys move, Enter chooses, Ctrl+C stops", async () => {
  const { pick } = await import("../cli/discover.js");
  const keyboard = () => {
    const input = new PassThrough();
    input.setRawMode = () => {};
    return input;
  };
  const output = new PassThrough();
  output.resume();
  let input = keyboard();
  let chosen = pick(["Yes", "No", SOMETHING_ELSE, LATER], { input, output });
  input.write("\u001b[B");
  input.write("\u001b[B");
  input.write("\r");
  assert.equal(await chosen, SOMETHING_ELSE);

  input = keyboard();
  chosen = pick(["Yes", "No"], { input, output });
  input.write("\u001b[A");
  input.write("\r");
  assert.equal(await chosen, "No", "up from the first is the last");

  input = keyboard();
  chosen = pick(["Yes", "No"], { input, output });
  input.write("\u0003");
  // Ctrl+C is a sentence and exit 130, never a stack trace: it says where to answer.
  await assert.rejects(chosen, err => err.interrupted && err.userFacing && /sealeye discover answers/.test(err.message));
});

test("both surfaces say the same things about a run", () => {
  assert.deepEqual(choicesFor({ options: ["a", "b", "c"], guess: "b" }), ["b", "a", "c"]);
  assert.equal(discoveryStateWords({ status: "stopped", reason: "spending_limit" }), "Stopped at its spending limit");
  assert.equal(discoveryEventLine({ type: "library", repo: "acme/platform", commit: "5e63aa5abc", replaced: 1 }), "Read acme/platform at 5e63aa5, with 1 line that looked like secrets replaced");
  assert.equal(discoveryEventLine({ type: "finished", catalog: { version: 2 }, open: 0 }), "Finished: draft catalog 2, with every question answered");
  for (const line of [discoveryEventLine({ type: "draft", catalog: { version: 1 }, open: 3 }), discoveryEventLine({ type: "not_read", source: "modules/x", why: "y" })]) {
    assert.doesNotMatch(line, /[–—]/, "no dashes in what anyone reads");
  }
});
