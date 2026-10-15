// planVersion 0.5 (PHASE4-PLAN Step 2): a plan names the catalog it was written against,
// and its modules and need kinds are checked against that catalog. Older plans name the
// starter. The interview still writes 0.4, and what it is given is unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";

import { checkPlan } from "../api/validate.js";
import { submitPlanInputSchema } from "../api/interview/schema.js";
import { loadSystemPrompt } from "../api/interview/model.js";
import {
  buildableModules, buildableView, catalogForPrompt, isBuildable, schemaFor, starterCatalog
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
