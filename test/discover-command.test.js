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
// A later run that found nothing changed since run 1's catalog: no questions or draft of
// its own, so both surfaces answer and show run 1's.
const later = new Date(Date.now() + 60_000).toISOString();
const unchanged = {
  id: "dsc_0000000000000002", org: "default", orgName: "Acme", status: "finished", startedBy: "lee@example.com", surface: "cli",
  repos: run.repos, modules: run.modules.map(m => ({ ...m, status: "kept" })), spend: {}, catalogVersion: null,
  unchangedSince: 1, questionsIn: run.id, createdAt: later, finishedAt: later
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
      "discoveries.json": { runs: [run, unchanged], questions: [question("q_open", "Is db for dev only?"), question("q_done", "Is db encrypted?", "Yes")] },
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
  assert.match(stdout, /The latest run: Nothing had changed since catalog 1, so no draft was written\. Its questions are on this one:\n.*dsc_0000000000000001  Finished, draft catalog 1/);
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
  chosen = pick(["Yes", "No", SOMETHING_ELSE, LATER], { input, output });
  input.write("\u001b[B\u001b[B\u001b[B\r");
  assert.equal(await chosen, LATER, "keys that arrive together are each taken");

  input = keyboard();
  chosen = pick(["Yes", "No"], { input, output });
  input.write("\u0003");
  // Ctrl+C is a sentence and exit 130, never a stack trace: it says where to answer.
  await assert.rejects(chosen, err => err.interrupted && err.userFacing && /sealeye discover answers/.test(err.message));
});

test("the window above a question moves on its own, and what is done with stays above it", async () => {
  const { createScreen, pick, typeLine } = await import("../cli/discover-screen.js");
  const input = new PassThrough();
  input.setRawMode = () => {};
  let written = "";
  const output = { write: t => { written += t; }, columns: 80 };
  let read = 1;
  const screen = createScreen({ output, animate: false, top: () => [`${read} of 3 modules read`] }).start();
  const chosen = pick(["Yes", "No"], { input, screen, header: ["? Is it offered?"] });
  assert.match(written, /1 of 3 modules read[\s\S]*Is it offered\?[\s\S]*Yes/, "the window, then the question under it");
  read = 2;
  screen.render();
  assert.match(written.slice(written.lastIndexOf("1 of 3")), /2 of 3 modules read/, "drawn again while the question is open");
  input.write("\r");
  assert.equal(await chosen, "Yes");
  // Words of one's own are typed under the window too: backspace, and nothing past the limit.
  const own = typeLine({ input, screen, limit: 5 });
  input.write("abcx\u007fdefgh\r");
  assert.equal(await own, "abcde");
  written = "";
  screen.close(["done"]);
  assert.match(written, /done/);
  assert.match(written, /\x1b\[\d+A/, "the window is taken off the screen it was drawn on");
});

test("the window is a box: every edge the same width, whatever is inside it", async () => {
  const { boxed } = await import("../cli/discover-screen.js");
  const colour = t => `\x1b[38;2;1;2;3m${t}\x1b[0m`;
  const box = boxed({ width: 60, title: colour("Discovery"), right: colour("3m 12s so far"), rows: [colour("⠋ Reading modules/a"), "", "Read modules/b"], footer: "6 of 6 modules read" });
  const plain = box.map(l => l.replace(/\x1b\[[0-9;]*m/g, ""));
  for (const line of plain) assert.equal([...line].length, 60, `"${line}" is the box's width`);
  assert.match(plain[0], /^╭─ Discovery ─+ 3m 12s so far ─╮$/);
  assert.match(plain[1], /^│ ⠋ Reading modules\/a +│$/);
  assert.match(plain.at(-1), /^╰─ 6 of 6 modules read ─+╯$/);
  assert.match(boxed({ width: 30 }).at(-1), /^╰─+╯$/, "an edge with nothing in it is a plain line");
});

test("both surfaces count a run's progress from its events, not a module's own status", async () => {
  const { nextProgress, activityWords, elapsedWords, progressSummary, modulesDone } = await import("../core/discovery-words.js");
  let p = nextProgress(null, null);
  assert.equal(activityWords(p), "Reading your platform library");
  p = nextProgress(p, { type: "modules", modules: [{}, {}, {}], at: "2026-10-15T20:00:00Z" });
  p = nextProgress(p, { type: "reading", source: "modules/a", at: "2026-10-15T20:00:01Z" });
  p = nextProgress(p, { type: "reading", source: "modules/b", at: "2026-10-15T20:00:01Z" });
  assert.equal(activityWords(p), "Reading modules/a and modules/b");
  assert.equal(p.since, "2026-10-15T20:00:01Z", "how long, from when the step began");
  for (const e of [{ type: "read", source: "." }, { type: "read", source: "modules/a" }, { type: "not_read", source: "modules/b", why: "x" }]) p = nextProgress(p, e);
  assert.equal(progressSummary(p, 2), "2 of 3 modules read, 2 questions waiting for you", "the library's own README is not a module");
  p = nextProgress(p, { type: "writing", at: "2026-10-15T20:01:00Z" });
  assert.equal(activityWords(p), "Writing the draft catalog");
  assert.equal(p.since, "2026-10-15T20:01:00Z");
  p = nextProgress(p, { type: "draft", catalog: { version: 1 } });
  assert.equal(activityWords(p), "Finishing the draft catalog", "not reading anything once the draft is written");
  p = nextProgress(p, { type: "finished" });
  assert.equal(activityWords(p), "The run has finished");
  assert.equal(progressSummary(p, 0), "2 of 3 modules read");
  assert.deepEqual([elapsedWords(8200), elapsedWords(125000), elapsedWords(3720000)], ["8s", "2m 05s", "1h 02m"]);
  assert.equal(modulesDone({ modules: [{ status: "reading" }, { status: "read" }, { status: "not_read" }] }), 2, "a module still being read is not done");
});

test("both surfaces say where an answer stands: in the draft, being written in, or why not", async () => {
  const { answerStateWords } = await import("../core/discovery-words.js");
  const q = { answer: "No", usedAt: null };
  assert.deepEqual(answerStateWords({ ...q, usedAt: "2026-10-15T20:00:00Z" }, { rewriting: true }), { words: "in the draft", moving: false });
  assert.deepEqual(answerStateWords(q, { rewriting: true }), { words: "being written into the draft", moving: true });
  assert.match(answerStateWords(q, { answerProblem: "the run reached its spending limit" }).words, /^not written into the draft yet: the run reached its spending limit\. The answer is kept\.$/);
  assert.equal(answerStateWords(q, {}).words, "waiting to be written into the draft");
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

// Step 6c: a run reads only what changed since the live catalog, unless asked to read every
// module again, which both surfaces offer and the API takes as { full: true }.
test("sealeye discover --all asks for every module to be read again; without it, nothing is asked", async () => {
  const http = await import("node:http");
  const bodies = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/discoveries") bodies.push(JSON.parse(body || "{}"));
      res.writeHead(req.url === "/discoveries" && req.method === "POST" ? 409 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/whoami" ? { org: "default", team: "platform", scope: "org", email: "lee@example.com", name: "Lee" } : { error: { code: "NO_LIBRARY", message: "No platform library is named for discovery yet." } }));
    });
  });
  await new Promise(r => server.listen(0, r));
  const at = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, HOME: api.home, SEALEYE_HOME: api.home, SEALEYE_TOKEN: LEE, SEALEYE_API: at, NO_COLOR: "1" };
  const run = args => promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), "discover", ...args, "--api", at], { cwd: api.home, env }).catch(e => e);
  try {
    await run(["--all"]);
    await run([]);
  } finally {
    server.close();
  }
  assert.deepEqual(bodies, [{ full: true }, {}]);
  const { comparedWords, READ_ALL } = await import("../core/discovery-words.js");
  assert.equal(READ_ALL, "Read every module again");
  assert.equal(comparedWords({ full: true }), "Read every module again, as asked.");
  assert.equal(comparedWords({ unchangedSince: 12 }), "Nothing had changed since catalog 12, so no draft was written.");
  assert.equal(comparedWords({ comparedWith: { catalog: 12, kept: 13, written: 1, gone: ["modules/old"] } }), "Compared with catalog 12: 13 modules unchanged and kept, 1 entry written; no longer in the library: modules/old.");
  assert.equal(comparedWords({}), null);
});
