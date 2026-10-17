// The self-test a catalog passes before it is approved and before it goes live
// (PHASE4-PLAN Step 7). Plain code: no AWS, no model.
import { test } from "node:test";
import assert from "node:assert/strict";

import { isBuildable, starterCatalog } from "../core/catalog.js";
import { developerWordProblems, forbiddenWord, forbiddenWords, plainWordsRule, shownWord } from "../core/developer-words.js";
import { draftCatalog } from "../api/discovery/draft.js";
import { planNaming, selfTest } from "../api/self-test.js";
import { checkAgainst } from "../api/validate.js";

const failed = result => Object.fromEntries(result.checks.filter(c => !c.passed).map(c => [c.id, c.problems]));

/** A discovered catalog, as a run writes it: Terraform modules, one of each standing. */
function discovered({ questions = [], lines = {} } = {}) {
  const mod = (source, extra = {}) => ({ source, id: source.split("/").pop().replace(/-/g, "_"), inputs: { name: { required: true, line: "What your app is called." } }, ...extra });
  const modules = [
    mod("modules/postgres"),
    mod("modules/cache-redis"),
    mod("modules/cache-valkey"),
    mod("modules/work-queue", { failed: "its folder could not be read" })
  ];
  const entries = modules.map(m => ({
    source: m.source,
    line: lines[m.source] || `A plain line about ${m.id}.`,
    role: "optional",
    ...(m.source === "modules/cache-redis" ? { availability: "deprecated" } : {})
  }));
  return draftCatalog({ run: { id: "dis_test", repos: [{ repo: "acme/library", commit: "abc1234" }] }, modules, entries, questions });
}

test("the starter passes its own self-test, building its four", () => {
  const result = selfTest({ document: starterCatalog(), version: "starter" });
  assert.equal(result.passed, true, JSON.stringify(failed(result)));
  assert.deepEqual(result.built, ["static_site_edge", "http_api_serverless", "observability_basic", "config_basic"]);
  assert.deepEqual(result.refused, []);
});

test("a discovered catalog passes while it builds nothing, and says so", () => {
  const result = selfTest({ document: discovered(), version: 3 });
  assert.equal(result.passed, true, JSON.stringify(failed(result)));
  assert.deepEqual(result.built, []);
  assert.deepEqual(Object.fromEntries(result.refused.map(r => [r.id, r.why])), {
    postgres: "its code has not been checked for commands it would run (discovery must read the library again)",
    cache_redis: "the library has deprecated it",
    cache_valkey: "its code has not been checked for commands it would run (discovery must read the library again)",
    work_queue: "it could not be read"
  });
  assert.match(result.notes.join(" "), /builds nothing yet/);
});

test("an entry resting on an open question is never built, though the catalog passes", () => {
  // As if an executor built every module of this catalog: only the open entry is held back.
  const doc = discovered({ questions: [{ id: "q1", touches: ["modules/cache-valkey", "modules/cache-redis"], kind: "standing" }] });
  for (const m of doc.modules) m.builds_with = "cloudformation";
  const ids = ["static_site_edge", "http_api_serverless", "observability_basic", "config_basic"];
  doc.modules.forEach((m, i) => { m.id = ids[i]; });
  // cache_valkey is now observability_basic, and rests on q1.
  assert.equal(isBuildable("static_site_edge", doc), true);
  assert.equal(isBuildable("observability_basic", doc), false, "open: never built");
  assert.equal(checkAgainst(planNaming("observability_basic", 3), doc).valid, false);
  const result = selfTest({ document: doc, version: 3 });
  assert.equal(result.passed, true, JSON.stringify(failed(result)));
  assert.deepEqual(result.built, ["static_site_edge"]);
  assert.equal(result.refused.find(r => r.id === "observability_basic").why, "it rests on a question not yet answered");
});

test("a question about the whole catalog holds it back, in its own words", () => {
  const doc = discovered({ questions: [{ id: "q9", touches: [], question: "Is uat part of the path to production?" }] });
  const result = selfTest({ document: doc, version: 3, questionText: id => (id === "q9" ? "Is uat part of the path to production?" : null) });
  assert.equal(result.passed, false);
  assert.deepEqual(failed(result), { questions: ["A question about the whole catalog is not answered yet: Is uat part of the path to production?"] });
});

test("a word a developer never reads fails the catalog, naming where", () => {
  const doc = discovered({ lines: { "modules/postgres": "Sends its logs to a CloudWatch log group." } });
  const result = selfTest({ document: doc, version: 3 });
  assert.equal(result.passed, false);
  assert.deepEqual(failed(result).words, ['postgres: line says "CloudWatch" and "log group", words a developer never reads; say what it does for their app']);
});

test("a deprecated module's words are not held against the catalog: nobody reads them", () => {
  const doc = discovered({ lines: { "modules/cache-redis": "An ElastiCache cluster of 3 nodes." } });
  assert.equal(selfTest({ document: doc, version: 3 }).passed, true);
});

test("a size or a count fails the catalog: capacity is set by a load test", () => {
  const doc = discovered({ lines: { "modules/postgres": "A database on a db.t3.medium with 100 GB of storage." } });
  assert.match(failed(selfTest({ document: doc, version: 3 })).words[0], /^postgres: line gives "100 GB" \(a size\) and "db\.t3\.medium" \(a machine size\); a developer reads "set by a load test" instead$/);
});

test("a module the catalog deprecates is refused by the same check a developer's plan meets", () => {
  // The refusal is the contract's own: the self-test asks validate, never decides itself.
  const doc = starterCatalog();
  doc.modules.find(m => m.id === "config_basic").availability = "deprecated";
  doc.modules.find(m => m.id === "config_basic").buildable = undefined;
  const result = selfTest({ document: doc, version: "starter" });
  assert.equal(result.passed, true);
  assert.equal(result.refused[0].id, "config_basic");
});

test("a malformed catalog fails on its shape and nothing else is tried", () => {
  const result = selfTest({ document: { modules: "no" }, version: 2 });
  assert.equal(result.passed, false);
  assert.deepEqual(result.checks.map(c => c.id), ["shape"]);
});

test("product names, one cloud's nouns and sizes are found; words every cloud uses are not (Q21)", () => {
  for (const [text, term] of [
    ["Runs on Lambda.", "Lambda"],
    ["Keeps files in an S3 bucket.", "S3"],
    ["Alarms go to an SNS topic.", "SNS"],
    ["Built with Terraform.", "Terraform"],
    ["Built with OpenTofu.", "OpenTofu"],
    ["Only in ca-central-1.", "a region's name"],
    ["Sends logs to a log group.", "log group"],
    ["Behind a security group.", "security group"],
    ["Runs 3 replicas.", "a count of machines"],
    ["Holds 20 GiB.", "a size"],
    ["A cache.r6g.large node.", "a machine size"]
  ]) assert.equal(forbiddenWord(text)?.term, term, text);
  for (const text of [
    "Runs your code on demand behind an HTTPS endpoint.",
    "A queue your app puts work on, and a worker takes it from.",
    "A relational database for your app, below staging.",
    "Keeps logs for as long as your organization requires.",
    "Lives in a private subnet, in one region.",
    "Keeps files in a bucket, behind a load balancer.",
    "Spread across each availability zone.",
    "Runs in a Virtual Private Cloud (VPC).",
    "Runs on Kubernetes, from a Docker image."
  ]) assert.equal(forbiddenWord(text), null, text);
});

test("an acronym is spelled out in the same line, and a setting is said as what it does (Q21)", () => {
  const said = t => forbiddenWords(t).map(w => [w.kind, w.found, w.instead]);
  assert.deepEqual(said("Runs in a VPC."), [["acronym", "VPC", "Virtual Private Cloud (VPC)"]]);
  assert.deepEqual(said("One per AZ."), [["acronym", "AZ", "Availability Zone (AZ)"]]);
  assert.deepEqual(said("A multi-AZ database."), [["setting", "multi-AZ", "keeps running if one data centre fails"]]);
  assert.deepEqual(said("Spread over two availability zones."), [["setting", "two availability zones", "keeps running if one data centre fails"]]);
  assert.deepEqual(said("Multi-region, with read replicas."), [
    ["setting", "Multi-region", "must survive a regional disaster"],
    ["setting", "read replicas", "handles heavy reading"]
  ]);
  assert.deepEqual(said("Pick the instance class."), [["setting", "instance class", "set by a load test"]]);
  // A number with it is a capacity number, not a setting.
  assert.deepEqual(said("3000 IOPS."), [["size", "3000 IOPS", undefined]]);
  assert.equal(shownWord(forbiddenWord("A multi-AZ database.")), '"multi-AZ" (write "keeps running if one data centre fails")');
  assert.equal(shownWord(forbiddenWord("Runs in a VPC.")), '"VPC" (write "Virtual Private Cloud (VPC)")');
  // The rule the models are told is the one the check holds.
  assert.match(plainWordsRule(), /"Virtual Private Cloud \(VPC\)"/);
  assert.match(plainWordsRule(), /multi-AZ: "keeps running if one data centre fails"/);
});

test("the word check reads every place a developer reads, and nothing else", () => {
  const doc = starterCatalog();
  const http = doc.modules.find(m => m.id === "http_api_serverless");
  http.signals = ["a serverless.yml naming Lambda"];
  http.rules = [{ rule: "Never more than 2 instances in dev." }];
  assert.deepEqual(developerWordProblems(doc), [], "signals and rules are not a developer's words");
  http.inputs.entry_point.line = "The handler Lambda calls.";
  assert.deepEqual(developerWordProblems(doc), [{ where: "http_api_serverless: input entry_point", module: "http_api_serverless", term: "Lambda", kind: "cloud", found: "Lambda" }]);
});

test("the guard counts every environment not known to be gone: a failed tear-down left it standing", async () => {
  const { environmentsDropped } = await import("../api/catalog-use.js");
  const doc = starterCatalog();
  doc.modules = doc.modules.filter(m => m.id !== "config_basic");
  const rec = (id, status, startedAt, modules = ["http_api_serverless", "config_basic"]) => ({
    deploymentId: id, status, startedAt, orgId: "default", teamId: "default", stackName: "sealeye-default-shop-1", app: { name: "shop" },
    plan: { modules: modules.map(m => ({ id: m })) }
  });
  const named = records => environmentsDropped({ org: "default", document: doc, records }).map(e => e.modules);
  assert.deepEqual(named([rec("d1", "succeeded", "1")]), [["config_basic"]], "running");
  assert.deepEqual(named([rec("d1", "failed", "1")]), [["config_basic"]], "its tear-down failed, so the stack is still there");
  assert.deepEqual(named([rec("d1", "succeeded", "1"), rec("d2", "failed", "2", ["http_api_serverless"])]), [["config_basic"]], "a failed deploy left the one before");
  assert.deepEqual(named([rec("d1", "succeeded", "1"), rec("d1b", "destroyed", "2")]), [], "torn down");
  assert.deepEqual(named([rec("d1", "destroyed", "1"), rec("d2", "queued", "2")]), [["config_basic"]], "built again since");
  assert.deepEqual(named([{ ...rec("d1", "drafted", "1"), stackName: undefined }]), [], "a drafted plan built nothing");
  assert.deepEqual(environmentsDropped({ org: "juniper", document: doc, records: [rec("d1", "succeeded", "1")] }), [], "another organization's");
});
