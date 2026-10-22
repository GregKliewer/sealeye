// The gap report (PHASE4-PLAN Step 10; DESIGN.md, "The gap report"): what developers
// asked for that the live catalog cannot build, by how often and which teams, judged
// against the live catalog by which needs its modules meet; an organization-wide
// token's only, on both surfaces.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import YAML from "yaml";

import { startApi, token } from "./helpers/api-with-aws.js";
import { gapReport } from "../api/gaps.js";
import { GAP_CHECKLIST, libraryWords, metWords, rankWords } from "../core/gap-words.js";
import { forbiddenWords } from "../core/developer-words.js";

const root = path.resolve(import.meta.dirname, "..");
const PLATFORM = token("p"), DEV = token("d"), STARTER = token("s");

/** Juniper's catalog 9, with what each module meets as the answer key says. */
function catalogWithMeets({ meets = true } = {}) {
  const doc = JSON.parse(fs.readFileSync(path.join(root, "test/fixtures/juniper-catalog-9.json"), "utf8"));
  if (!meets) return doc;
  const key = YAML.parse(fs.readFileSync(path.join(root, "test/fixtures/sample-platform/answer-key.yaml"), "utf8"));
  const bySource = new Map(key.catalog.modules.map(m => [m.source, m.meets]));
  for (const m of doc.modules) m.meets = bySource.get(m.source) || [];
  return doc;
}

const need = (kind, line) => ({ kind, line, evidence: [{ file: "index.js", shows: "it" }] });
const drafted = (id, org, team, app, needs, daysAgo) => ({
  deploymentId: id, status: "drafted", orgId: org, teamId: team, app: { name: app, type: "api" },
  startedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(), plan: { profile: "dev" }, needs
});

const RECORDS = [
  // An event stream: three apps on two teams.
  drafted("dep_ev1", "juniper", "payments", "ledger", [need("event_stream", "a stream of events")], 1),
  drafted("dep_ev2", "juniper", "payments", "fraud", [need("event_stream", "a stream of events")], 2),
  drafted("dep_ev3", "juniper", "lending", "loans", [need("event_stream", "a stream of events"), need("relational_database", "a relational database")], 3),
  // Sign-in and a scheduled task, two apps each: sign-in on two teams, the task on one.
  drafted("dep_si1", "juniper", "payments", "portal", [need("user_sign_in", "sign-in"), need("scheduled_task", "a task")], 4),
  drafted("dep_si2", "juniper", "lending", "apply", [need("user_sign_in", "sign-in"), need("scheduled_task", "a task")], 5),
  // A queue, which the live catalog builds now, from a plan drafted before it did.
  drafted("dep_wq1", "juniper", "lending", "batch", [need("work_queue", "a queue")], 30),
  // In the developer's own words.
  drafted("dep_un1", "juniper", "payments", "maps", [need("unlisted", "a map of branch locations")], 6),
  // Another organization's, never in Juniper's report.
  drafted("dep_oth", "default", "web", "shop", [need("event_stream", "a stream of events")], 1)
];

let api;
before(async () => {
  const at = new Date().toISOString();
  api = await startApi({
    tokens: [
      { token: PLATFORM, id: "platform", team: "platform", org: "juniper", scope: "org" },
      { token: DEV, id: "dev", team: "payments", org: "juniper" },
      { token: STARTER, id: "lead", team: "web", scope: "org" }
    ],
    records: RECORDS,
    aws: "",
    files: {
      "catalogs.json": [{ org: "juniper", version: 9, status: "live", document: catalogWithMeets(), createdBy: "p@example.com", createdAt: at, approvedBy: "p@example.com", approvedAt: at, madeLiveBy: "p@example.com", madeLiveAt: at }],
      // The permissions boundary, so the module that runs an app builds, and a queue beside it.
      "platform-values.json": [{ org: "juniper", stage: "dev", name: "permissions_boundary_arn", value: "arn:aws:iam::123456789012:policy/sealeye-function-boundary-terraform", setBy: "p@example.com", setAt: at }]
    }
  });
});
after(() => api?.stop());

test("demand first: by apps, then teams, then the checklist; what the library has for each", async () => {
  const { status, body } = await api.call("/gaps", { token: PLATFORM });
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.catalog, { version: 9, source: "organization", mapped: true });
  assert.deepEqual(body.gaps.map(g => g.kind), ["event_stream", "user_sign_in", "scheduled_task", "relational_database", `unlisted:a-map-of-branch-locations`]);
  const [events, signIn, task, database, unlisted] = body.gaps;

  assert.equal(events.count, 3);
  assert.deepEqual(events.teams, [{ team: "lending", apps: ["loans"] }, { team: "payments", apps: ["ledger", "fraud"] }]);
  assert.equal(events.library.status, "nothing");
  assert.equal(events.tieBrokenBy, null);
  // Two apps each; sign-in asked by two teams, the task by two as well: the checklist decides.
  assert.equal(signIn.tieBrokenBy, "checklist");
  assert.ok(GAP_CHECKLIST.indexOf("user_sign_in") < GAP_CHECKLIST.indexOf("scheduled_task"));
  assert.equal(task.library.status, "nothing");
  // The library has databases, which the platform cannot build yet, each with why.
  assert.equal(database.library.status, "not_built");
  assert.deepEqual(database.library.modules.map(m => m.id), ["postgres", "postgres_cluster"]);
  assert.match(database.library.modules[0].why, /no subnet_ids and security_group_ids value/);
  assert.equal(unlisted.library.status, "unlisted");

  // A queue the live catalog builds now is not a gap: the app that asked can plan again.
  assert.deepEqual(body.met.map(m => [m.kind, m.modules, m.apps.map(a => a.name)]), [["work_queue", ["work_queue"], ["batch"]]]);
  // Only Juniper's own.
  assert.ok(!JSON.stringify(body).includes("shop"));
});

test("the words both surfaces say", () => {
  assert.equal(libraryWords({ library: { status: "nothing" } }), "Nothing in your library meets this.");
  assert.equal(libraryWords({ library: { status: "not_built", modules: [{ id: "postgres", why: "it is deprecated" }] } }), "Your library has postgres (it is deprecated), which the platform cannot build yet.");
  assert.match(libraryWords({ library: { status: "unknown" } }), /discovered before discovery said which needs each module meets/);
  assert.match(rankWords({ tieBrokenBy: "teams" }), /more teams asked for this one/);
  assert.equal(rankWords({ tieBrokenBy: null }), null);
  assert.equal(metWords({ modules: ["work_queue"], apps: [{ name: "batch", team: "lending" }] }), "Your live catalog builds this now, with work_queue. The app that asked for it can be planned again with `sealeye run`: batch (lending).");
  // A sentence about the need itself is still in plain words, for a platform team that pastes it.
  for (const w of ["Nothing in your library meets this.", metWords({ modules: [], apps: [] })]) assert.deepEqual(forbiddenWords(w), [], w);
});

test("only an organization-wide token sees it", async () => {
  const r = await api.call("/gaps", { token: DEV });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, "ORG_WIDE_ONLY");
});

test("against the starter every need is a gap with nothing to meet it; against a catalog from before meets, not known", async () => {
  const starter = await api.call("/gaps", { token: STARTER });
  assert.equal(starter.status, 200);
  assert.equal(starter.body.catalog.source, "starter");
  assert.deepEqual(starter.body.gaps.map(g => [g.kind, g.library.status]), [["event_stream", "nothing"]]);

  const old = gapReport(RECORDS.filter(r => r.orgId === "juniper"), { catalog: catalogWithMeets({ meets: false }), version: 9, source: "organization" });
  assert.equal(old.catalog.mapped, false);
  assert.ok(old.gaps.filter(g => g.listed).every(g => g.library.status === "unknown"));
  assert.equal(old.met.length, 0, "nothing is said to be met when nothing says what meets it");
});

test("sealeye gaps prints the report in the same words, and refuses a team's token in words", async () => {
  const run = (tok, args = []) => promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), "gaps", ...args, "--api", api.api], {
    cwd: api.home, env: { ...process.env, HOME: api.home, SEALEYE_HOME: api.home, SEALEYE_TOKEN: tok, NO_COLOR: "1" }
  });
  const { stdout } = await run(PLATFORM);
  assert.match(stdout, /What developers asked for that catalog 9 cannot build/);
  assert.match(stdout, / 1\. a stream of events it publishes or reads {2}\(event_stream\)\n {4}3 apps on 2 teams \(lending, payments\), last asked \d{4}-\d\d-\d\d\n {4}Nothing in your library meets this\./);
  assert.match(stdout, /Ahead of a gap as many apps and teams asked for: it comes first on the checklist/);
  assert.match(stdout, /Your library has postgres \(/);
  assert.match(stdout, /Asked for, and built now\n {2}a queue between it and the work it hands off: Your live catalog builds this now, with work_queue\./);
  const json = JSON.parse((await run(PLATFORM, ["--json"])).stdout);
  assert.equal(json.gaps.length, 5);
  const refused = await run(DEV).catch(err => err);
  assert.match(String(refused.stdout) + String(refused.stderr), /The gap report is for your platform team: it needs an organization-wide token\./);
});
