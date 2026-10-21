// planVersion 0.5 (PHASE4-PLAN Step 2): a plan names the catalog it was written against,
// and its modules and need kinds are checked against that catalog. Older plans name the
// starter. The interview still writes 0.4, and what it is given is unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import YAML from "yaml";

import { catalogForPlan } from "../cli/client.js";
import { decisionCard } from "../cli/interview/render.js";
import { catalogSentence, plainValidationError } from "../core/plan-words.js";

import { checkPlan } from "../api/validate.js";
import { submitPlanInputSchema } from "../api/interview/schema.js";
import { loadSystemPrompt } from "../api/interview/model.js";
import {
  buildableModules, buildableView, catalogForPrompt, catalogProblems, isBuildable, schemaFor, starterCatalog
} from "../core/catalog.js";
import { renderPlanMarkdown } from "../core/plan-files.js";
import { EXECUTORS, MODULE_IDS, PLAN_VERSION, planSchema, planSchema04, upgradePlan } from "../core/schema.js";

const apiPlan = (extra = {}) => ({
  planVersion: "0.4", app: { name: "orders-api", type: "api" }, profile: "dev",
  modules: [
    { id: "http_api_serverless", inputs: { runtime: "nodejs", entry_point: "index.js", trigger: "http" } },
    { id: "observability_basic" }
  ],
  outputs: ["public_url", "logs"],
  ...extra
});

// A catalog with one module the platform cannot build yet, and one marked unavailable.
function withOwnModules() {
  const doc = starterCatalog();
  doc.modules.push(
    { id: "acme_queue", availability: "available", builds_with: "terraform", role: "optional", line: "Acme's own queue." },
    { id: "acme_cache", availability: "withdrawn", builds_with: "cloudformation", role: "optional", line: "Acme's own cache." }
  );
  doc.patterns.dev.modules.acme_queue = "Acme's queue pattern.";
  return doc;
}

test("every plan before 0.5 is read as 0.5 against the starter, and a 0.5 plan is left as written", () => {
  assert.equal(PLAN_VERSION, "0.5");
  const upgraded = upgradePlan(apiPlan());
  assert.equal(upgraded.planVersion, "0.5");
  assert.equal(upgraded.catalog, "starter");
  assert.deepEqual(upgraded.modules, apiPlan().modules, "nothing else about a 0.4 plan changes");

  const old = upgradePlan({ ...apiPlan(), planVersion: "0.3", modules: [...apiPlan().modules, { id: "data_relational" }] });
  assert.equal(old.planVersion, "0.5");
  assert.equal(old.catalog, "starter");
  assert.equal(old.needs[0].kind, "relational_database", "a 0.3 module the platform never built is still the need it described");
  assert.equal(old.status, "drafted");

  const named = { ...apiPlan(), planVersion: "0.5", catalog: 4 };
  assert.equal(upgradePlan(named), named, "a 0.5 plan names the catalog it was written against");
});

test("a module is buildable when its catalog marks it available and an executor builds it", () => {
  const doc = withOwnModules();
  assert.deepEqual(EXECUTORS.cloudformation, MODULE_IDS);
  for (const id of MODULE_IDS) assert.equal(isBuildable(id, starterCatalog()), true, id);
  assert.equal(isBuildable("acme_queue", doc), false, "no Terraform executor yet (Step 9)");
  assert.equal(isBuildable("acme_cache", doc), false, "not available, whatever builds it");
  assert.equal(isBuildable("nonexistent", doc), false);
  const noBuilder = starterCatalog();
  delete noBuilder.modules[0].builds_with;
  assert.equal(isBuildable(noBuilder.modules[0].id, noBuilder), false, "a module that says nothing about what builds it is not built");
  assert.deepEqual(buildableModules(doc).map(m => m.id), MODULE_IDS);
});

test("the contract for a catalog names only what it builds, and its need kinds", () => {
  const doc = withOwnModules();
  doc.need_kinds = doc.need_kinds.filter(n => n.key !== "cache");
  const schema = schemaFor(doc);
  assert.deepEqual(schema.properties.modules.items.properties.id.enum, MODULE_IDS);
  assert.ok(!schema.properties.needs.items.properties.kind.enum.includes("cache"));
  assert.ok(schema.properties.needs.items.properties.kind.enum.includes("unlisted"));
  assert.deepEqual(schema.properties.planVersion.enum, ["0.5"]);
  assert.ok(schema.required.includes("catalog"));
  assert.deepEqual(JSON.stringify(schemaFor(starterCatalog())), JSON.stringify(planSchema));

  const nothing = { ...doc, modules: [] };
  assert.deepEqual(schemaFor(nothing).properties.modules.items.properties.id, { type: "string", not: {} }, "a catalog that builds nothing accepts no module");
});

test("the view the clients read leaves out what the platform cannot build", () => {
  const view = buildableView(withOwnModules());
  assert.deepEqual(view.modules.map(m => m.id), MODULE_IDS);
  assert.ok(!JSON.stringify(view).includes("acme_"), "never named, not even in a pattern");
  assert.deepEqual(view.need_kinds, starterCatalog().need_kinds);
  assert.deepEqual(Object.keys(view.patterns), Object.keys(starterCatalog().patterns));
});

test("checkPlan reads a plan against the starter, and refuses a catalog it does not know", () => {
  assert.deepEqual(checkPlan(apiPlan()), { valid: true, errors: [] });
  assert.deepEqual(checkPlan({ ...apiPlan(), planVersion: "0.5", catalog: "starter" }), { valid: true, errors: [] });
  const unknown = checkPlan({ ...apiPlan(), planVersion: "0.5", catalog: 7 });
  assert.equal(unknown.valid, false);
  assert.equal(unknown.errors[0].code, "CATALOG_UNKNOWN");
  assert.equal(checkPlan({ ...apiPlan(), planVersion: "0.5", catalog: "newest" }).valid, false);
  assert.equal(checkPlan({ ...apiPlan(), planVersion: "0.5", catalog: 0 }).valid, false);
  assert.equal(checkPlan({ ...apiPlan(), planVersion: "0.6", catalog: "starter" }).valid, false);
});

test("a plan file never names a module its catalog does not build", () => {
  const doc = withOwnModules();
  const plan = upgradePlan(apiPlan());
  const text = renderPlanMarkdown({ plan, summary: "An API.", assumptions: ["it is small"] }, { catalog: doc });
  assert.match(text, /http_api_serverless/);
  assert.throws(
    () => renderPlanMarkdown({ plan, summary: "An API that uses acme_queue.", assumptions: [] }, { catalog: doc }),
    /names acme_queue, which seaLeye.run does not build/
  );
  assert.throws(
    () => renderPlanMarkdown({ plan, summary: "Once a data_relational plan.", assumptions: [] }, { catalog: doc }),
    /names data_relational/,
    "nor a module from a plan before 0.4"
  );
});

test("the interview is given exactly what it was before: the 0.4 contract and the same prompt", () => {
  const { description, ...plan } = submitPlanInputSchema.properties.plan;
  assert.deepEqual(plan, planSchema04);
  assert.deepEqual(planSchema04.properties.planVersion.enum, ["0.2", "0.3", "0.4"]);
  assert.ok(!("catalog" in planSchema04.properties));
  assert.doesNotMatch(catalogForPrompt(), /builds_with|cloudformation/i, "what builds a module is the platform's to know");
  assert.doesNotMatch(loadSystemPrompt(), /builds_with/);
});

// ---------------------------------------------------------------------------
// The clients: the command draws a plan from the catalog the API serves for it.
// ---------------------------------------------------------------------------

const root = path.resolve(import.meta.dirname, "..");

/** A stand-in API: `answer(url)` returns [status, body]. */
async function fakeApi(answer) {
  const asked = [];
  const server = http.createServer((req, res) => {
    asked.push(req.url);
    const [status, body] = answer(req.url);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, asked, close: () => server.close() };
}

test("the command reads the plan's catalog from the API, and its own copy only for an older API", async () => {
  const own = { ...buildableView(starterCatalog()), modules: [{ id: "http_api_serverless", line: "In acme's words." }] };
  const api = await fakeApi(url => (url === "/catalog?version=3" ? [200, { document: own }] : [200, { modules: [] }]));
  try {
    assert.deepEqual(await catalogForPlan({ apiBaseUrl: api.url, plan: { catalog: 3 } }), own);
    assert.deepEqual(await catalogForPlan({ apiBaseUrl: api.url, plan: { planVersion: "0.4" } }), starterCatalog(), "an API that sends no document only ever had the starter");
    await assert.rejects(catalogForPlan({ apiBaseUrl: api.url, plan: { catalog: 5 } }), /did not send catalog 5/);
    assert.deepEqual(api.asked, ["/catalog?version=3", "/catalog?version=starter", "/catalog?version=5"]);
  } finally {
    api.close();
  }
});

test("sealeye catalog says which catalog, in the Catalog page's words", async () => {
  const ref = { version: 2, source: "organization", approvedBy: "pat@acme.example", approvedAt: null, live: true };
  const api = await fakeApi(() => [200, { catalog: ref, modules: [{ id: "http_api_serverless", line: "Runs your API." }], needs: [] }]);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-catalog-cmd-"));
  try {
    const env = { ...process.env, HOME: home, SEALEYE_HOME: path.join(home, ".sealeye"), NO_COLOR: "1", SEALEYE_TOKEN: "" };
    const { stdout } = await promisify(execFile)(process.execPath, ["cli/bin/sealeye", "catalog", "--api", api.url], { cwd: root, env });
    assert.match(stdout, /Your organization's catalog, version 2, approved by pat@acme\.example\./);
    assert.equal(catalogSentence(ref), "Your organization's catalog, version 2, approved by pat@acme.example.");
    assert.match(catalogSentence({ version: "starter", source: "starter" }), /^The starter catalog/);
    assert.match(catalogSentence(undefined), /^The starter catalog/, "an API from before Oct 14, 2026 had only the starter");
    assert.match(catalogSentence({ ...ref, live: false }), /It has since been replaced\.$/);
  } finally {
    api.close();
  }
});

test("a contract error names the values of the plan's catalog, sent with it", () => {
  const bad = checkPlan({ ...apiPlan(), modules: [{ id: "a_queue" }] });
  const idError = bad.errors.find(e => e.path === "/modules/0/id");
  assert.deepEqual(idError.allowed, MODULE_IDS);
  assert.equal(
    plainValidationError({ ...idError, allowed: ["acme_api", "acme_site"] }),
    "modules item 1, id is not one of the values the contract allows: acme_api, acme_site."
  );
  assert.match(plainValidationError({ ...idError, allowed: undefined }), /static_site_edge, http_api_serverless/, "without them, the starter's");
});

test("the card and DEPLOYMENT_PLAN.md read the same from the API's document as from the starter file", () => {
  const plans = fs.readdirSync(path.join(root, "plans")).filter(f => f.endsWith(".yaml"));
  assert.ok(plans.length > 0);
  const view = JSON.parse(JSON.stringify(buildableView(starterCatalog())));   // as it arrives over the wire
  const date = new Date("2026-10-15T12:00:00Z");
  for (const file of plans) {
    const plan = upgradePlan(YAML.parse(fs.readFileSync(path.join(root, "plans", file), "utf8")));
    if (!checkPlan(plan).valid) continue;
    const submission = { plan, summary: "An app.", assumptions: ["one"] };
    assert.equal(renderPlanMarkdown(submission, { catalog: view, date }), renderPlanMarkdown(submission, { catalog: starterCatalog(), date }), file);
    assert.equal(decisionCard(plan, { catalog: view, width: 80 }), decisionCard(plan, { catalog: starterCatalog(), width: 80 }), file);
  }
});

test("what builds a module is the platform's to know, and a strange name never crashes the check", () => {
  const doc = starterCatalog();
  assert.doesNotMatch(JSON.stringify(buildableView(doc)), /builds_with|cloudformation/i, "never sent to a client: it is an AWS term");
  for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
    const odd = starterCatalog();
    odd.modules[0].builds_with = name;
    assert.equal(isBuildable(odd.modules[0].id, odd), false, name);
    assert.doesNotThrow(() => schemaFor(odd), name);
  }
  const notAName = starterCatalog();
  notAName.modules[0].builds_with = "Cloud Formation!";
  assert.deepEqual(catalogProblems(notAName), [`module ${notAName.modules[0].id}: builds_with is a lowercase name`]);
  const later = starterCatalog();
  later.modules[0].builds_with = "terraform";
  assert.deepEqual(catalogProblems(later), [], "an executor the platform has not built yet is not a mistake");
  const claims = starterCatalog();
  claims.modules[0].buildable = true;
  assert.deepEqual(catalogProblems(claims), [`module ${claims.modules[0].id}: whether it is buildable is the platform's to say, not the catalog's`]);
  const view = buildableView(starterCatalog());
  assert.ok(view.modules.every(m => m.buildable === true && isBuildable(m.id, view)), "a client reads the view as the platform built it");
});

test("sealeye deploy says CATALOG_CHANGED in the platform's words, as the portal does", async () => {
  const message = "This plan was written against an earlier version of your organization's catalog, and the catalog no longer builds everything it uses. Serves your files. Run sealeye run again to plan against the catalog as it is now. Nothing was deployed.";
  const api = await fakeApi(url => (url === "/deployments"
    ? [409, { error: { code: "CATALOG_CHANGED", message, details: { noLongerBuilt: ["Serves your files."] } } }]
    : [200, { valid: true, errors: [], status: "ready", needs: [], deployments: [], settings: [] }]));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-catalog-changed-"));
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-catalog-changed-app-"));
  fs.writeFileSync(path.join(app, "index.html"), "<p>hi</p>");
  const file = path.join(app, "sealeye.yaml");
  fs.copyFileSync(path.join(root, "plans", "static-plan.yaml"), file);
  try {
    const env = { ...process.env, HOME: home, SEALEYE_HOME: path.join(home, ".sealeye"), NO_COLOR: "1", SEALEYE_TOKEN: "" };
    const out = await promisify(execFile)(process.execPath, ["cli/bin/sealeye", "deploy", "--file", file, "--app", app, "--api", api.url], { cwd: root, env })
      .then(r => ({ code: 0, text: r.stdout + r.stderr }), e => ({ code: e.code, text: `${e.stdout}${e.stderr}` }));
    assert.equal(out.code, 1, out.text);
    assert.ok(out.text.includes(message), out.text);
    assert.doesNotMatch(out.text, /noLongerBuilt|"code"/, "the platform's sentence, never its JSON");
  } finally {
    api.close();
  }
});

test("against a catalog the platform builds nothing from, a plan names no module and is drafted with what the app needs", async () => {
  const { checkAgainst } = await import("../api/validate.js");
  const nothing = { modules: [{ id: "web", availability: "available", builds_with: "terraform", line: "A site." }], need_kinds: [{ key: "file_storage", line: "somewhere to keep files" }] };
  const base = { planVersion: "0.5", catalog: 3, app: { name: "x", type: "api" }, profile: "dev", modules: [], outputs: [] };
  const need = { kind: "file_storage", line: "somewhere to keep files", evidence: [{ file: "index.js", shows: "writes uploads" }] };
  assert.equal(checkAgainst({ ...base, needs: [need], status: "drafted" }, nothing).valid, true);
  assert.equal(checkAgainst(base, nothing).valid, false, "with nothing to build and nothing needed, there is no plan");
  assert.equal(checkAgainst({ ...base, modules: [{ id: "web" }], needs: [need] }, nothing).valid, false, "never a module it cannot build");
  // A catalog that builds something still wants one module, as before.
  const something = { ...nothing, modules: [{ id: "static_site_edge", availability: "available", builds_with: "cloudformation", line: "A site." }] };
  assert.equal(checkAgainst({ ...base, needs: [need] }, something).valid, false);
});

test("the card ends a connected module's sentence before the settings the app finds it through", async () => {
  const { decisionCard } = await import("../cli/interview/render.js");
  const catalog = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "juniper-catalog-9.json"), "utf8"));
  const plan = {
    planVersion: "0.6", catalog: 9, app: { name: "account-notes-api", type: "api" }, profile: "dev", outputs: ["logs"],
    modules: [{ id: "http_api", enabled: true }, { id: "postgres", enabled: true, connect: { address: "DATABASE_HOST", port: "DATABASE_PORT" } }]
  };
  const card = decisionCard(plan, { catalog, width: 400 }).replace(/\s+/g, " ");
  assert.match(card, /, which your app finds through DATABASE_HOST and DATABASE_PORT\./);
  assert.doesNotMatch(card, /\., which/, "no full stop before the settings (Oct 21, 2026)");
});
