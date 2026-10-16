// `sealeye catalog versions | test | approve | live` (PHASE4-PLAN Step 7) against a real
// API: the self-test printed as the Discovery page shows it, approving the newest draft,
// making a catalog live only when named, and the API's refusals in its own words.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { startApi, token } from "./helpers/api-with-aws.js";
import { starterCatalog } from "../core/catalog.js";

const root = path.resolve(import.meta.dirname, "..");
const ANA = token("a");
const LEE = token("l");
let api;
const at = new Date().toISOString();

const discovered = line => ({
  catalogVersion: "d", discovery: { run: "dsc_1", library: [] },
  modules: [
    { id: "db", source: "modules/db", availability: "available", builds_with: "terraform", line },
    { id: "old_cache", source: "modules/old-cache", availability: "deprecated", builds_with: "terraform", line: "An old cache." }
  ],
  need_kinds: starterCatalog().need_kinds, profiles: starterCatalog().profiles
});
const draft = (version, document) => ({ org: "default", version, status: "draft", createdBy: "lee@example.com", createdAt: at, approvedBy: null, approvedAt: null, document });

before(async () => {
  api = await startApi({
    tokens: [
      { token: ANA, id: "ana", team: "default" },
      { token: LEE, id: "lee", team: "platform", scope: "org" }
    ],
    records: [],
    aws: "",
    files: { "catalogs.json": [draft(1, discovered("A relational database for your app.")), draft(2, discovered("A database on RDS in a private subnet."))] }
  });
});

after(() => api?.stop());

const sealeye = (args, tok) => promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), ...args, "--api", api.api], {
  env: { ...process.env, NO_COLOR: "1", SEALEYE_TOKEN: tok, SEALEYE_HOME: api.home }
}).catch(err => err);

test("sealeye catalog versions: which is live, and each catalog with the next step", async () => {
  const { stdout } = await sealeye(["catalog", "versions"], LEE);
  assert.match(stdout, /plans against the starter catalog/);
  assert.match(stdout, /  2  Draft\s+from run dsc_1 · 2 modules/);
  assert.match(stdout, /sealeye catalog test 2 runs its self-test; sealeye catalog approve 2 approves it/);
});

test("a team's token is refused in the API's words", async () => {
  const out = await sealeye(["catalog", "versions"], ANA);
  assert.match(out.stdout + out.stderr, /needs an organization-wide token/);
});

test("sealeye catalog test: each check, what is never built and why", async () => {
  const out = await sealeye(["catalog", "test", "2"], LEE);
  assert.equal(out.code, 1, "a failed self-test fails the command");
  assert.match(out.stdout, /✗ Nothing a developer reads uses a word they never should/);
  assert.match(out.stdout, /db: line says RDS and subnet, words a developer never reads/);
  assert.match(out.stdout, /old_cache: the library has deprecated it/);
  assert.match(out.stdout, /The self-test found 1 problem in catalog 2/);
  const json = await sealeye(["catalog", "test", "1", "--json"], LEE);
  assert.equal(JSON.parse(json.stdout.slice(json.stdout.indexOf("{"))).passed, true);
});

test("sealeye catalog approve: a failing draft is refused with its self-test; the named one is approved", async () => {
  const refused = await sealeye(["catalog", "approve"], LEE);   // the newest draft, catalog 2
  assert.match(refused.stdout, /db: line says RDS and subnet/);
  assert.match(refused.stdout + refused.stderr, /Catalog 2 cannot be approved/);
  const ok = await sealeye(["catalog", "approve", "1"], LEE);
  assert.match(ok.stdout, /Catalog 1 is approved\. Nothing changes for developers until it is made live\./);
  assert.match(ok.stdout, /sealeye catalog live 1 makes it live/);
});

test("sealeye catalog live: only when named, and then the organization plans against it", async () => {
  const unnamed = await sealeye(["catalog", "live"], LEE);
  assert.match(unnamed.stdout + unnamed.stderr, /Name the catalog to make live: sealeye catalog live <number>/);
  const ok = await sealeye(["catalog", "live", "1"], LEE);
  assert.match(ok.stdout, /Catalog 1 is live: your organization's developers plan against it now\./);
  const { stdout } = await sealeye(["catalog", "versions"], LEE);
  assert.match(stdout, /plans against catalog 1/);
  assert.match(stdout, /  1  Live\s+from run dsc_1 · 2 modules · approved by lee@example.com · made live by lee@example.com/);
});
