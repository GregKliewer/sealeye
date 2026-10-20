// Needs: the known kinds, and the rest in the model's own words (DESIGN.md). A need none
// of the kinds fits is `unlisted`, with a line of its own in the same form; it still
// drafts the plan, and the ledger counts it by its words, apart from the known kinds.
import { test } from "node:test";
import assert from "node:assert/strict";

import { checkPlan } from "../api/validate.js";
import { rollupNeeds } from "../api/needs.js";
import { catalogForPrompt } from "../core/catalog.js";
import { isDrafted, NEED_KINDS } from "../core/schema.js";

const plan = needs => ({
  planVersion: "0.4", app: { name: "orders-api", type: "api" }, profile: "dev",
  modules: [{ id: "http_api_serverless", inputs: { runtime: "nodejs", entry_point: "index.js", trigger: "http" } }],
  outputs: ["public_url"],
  needs
});
const evidence = [{ file: "package.json", shows: "an elasticsearch client" }];
const unlisted = line => ({ kind: "unlisted", line, evidence });

test("a document database is a known kind now, and the interview is told of it", () => {
  assert.ok(NEED_KINDS.includes("document_database"));
  assert.equal(checkPlan(plan([{ kind: "document_database", line: "a document database", evidence: [{ file: "package.json", shows: "mongoose" }] }])).valid, true);
  const prompt = catalogForPrompt();
  assert.match(prompt, /\*\*document_database\*\*  "a document database"/);
  assert.match(prompt, /\*\*unlisted\*\*  your own line/);
  assert.match(prompt, /Never a product or a vendor \(the technology goes in the evidence\)/);
});

test("an unlisted need in the known kinds' form is valid, and drafts the plan", () => {
  const p = plan([unlisted("a search index over its documents")]);
  assert.deepEqual(checkPlan(p), { valid: true, errors: [] });
  assert.equal(isDrafted(p), true, "refuse, never shrink: an unlisted need still refuses");
});

test("an unlisted line that names a module, an address or a promise, or is not in form, is refused", () => {
  for (const [line, why] of [
    ["Search index over documents", /must read like the known kinds' lines/],
    ["a http_api_serverless for search", /names a module/],
    ["a search index like https://example.org", /holds an address/],
    ["a search index, coming soon", /makes a promise/],
    [`a ${"very ".repeat(30)}long need`, /must NOT have more than 90 characters/]
  ]) {
    const out = checkPlan(plan([unlisted(line)]));
    assert.equal(out.valid, false, line);
    assert.match(out.errors.map(e => e.message).join(" "), why, line);
  }
});

test("the ledger counts unlisted needs by their words, apart from the known kinds", () => {
  const at = n => new Date(Date.UTC(2026, 9, 14, n)).toISOString();
  const draft = (app, needs, n) => ({ deploymentId: `dep_${String(n).padStart(12, "0")}`, status: "drafted", app: { name: app }, plan: { profile: "dev" }, needs, startedAt: at(n) });
  const ledger = rollupNeeds([
    draft("search-api", [unlisted("A search index over its documents")], 3),
    draft("catalog-api", [unlisted("a search index over its documents"), { kind: "relational_database", line: "a relational database", evidence }], 2),
    draft("files-api", [unlisted("a virus scanner for uploads")], 1)
  ]);
  const rows = Object.fromEntries(ledger.needs.map(n => [n.line, n]));
  assert.equal(rows["a search index over its documents"].count, 2, "the same words, however cased, are one row");
  assert.equal(rows["a search index over its documents"].listed, false);
  assert.equal(rows["a virus scanner for uploads"].listed, false);
  assert.equal(rows["a relational database"].listed, true);
  assert.equal(new Set(ledger.needs.map(n => n.kind)).size, 3, "each row has a key of its own");
});

test("sealeye needs shows an unlisted need apart, as seaLeye.online does", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const path = await import("node:path");
  const { startApi, token } = await import("./helpers/api-with-aws.js");
  const ANA = token("n");
  const records = [{
    deploymentId: "dep_aaaaaaaaaaab", status: "drafted", backend: "cloudformation", orgId: "default", teamId: "default", surface: "cli",
    app: { name: "search-api" }, plan: { profile: "dev" }, outputs: {}, startedAt: new Date().toISOString(),
    needs: [unlisted("a search index over its documents"), { kind: "document_database", line: "a document database", evidence: [{ file: "package.json", shows: "mongoose" }] }]
  }];
  const api = await startApi({ tokens: [{ token: ANA, id: "ana", team: "default" }], records, aws: "" });
  try {
    const root = path.resolve(import.meta.dirname, "..");
    const { stdout } = await promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), "needs", "--api", api.api], {
      cwd: api.home, env: { ...process.env, HOME: api.home, SEALEYE_TOKEN: ANA, NO_COLOR: "1" }
    });
    assert.match(stdout, /a search index over its documents \[not in the list yet\]/);
    assert.match(stdout, /a document database \[document_database\]/);
  } finally {
    api.stop();
  }
});
