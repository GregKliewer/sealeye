// The interview reads the organization's live catalog (PHASE4-PLAN Step 3): its prompt
// and its plan tool are built from it, it keeps the one it started with, and its plan is
// stamped with it by the platform. The starter's prompt and tool are word for word the
// ones evaluated on Oct 15, 2026. A scripted model, no network.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { zipSync } from "fflate";
import { MemorySaver } from "@langchain/langgraph";

const root = path.resolve(import.meta.dirname, "..");
// Catalogs beside a laptop API, in a home of this test's own.
process.env.SEALEYE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-interview-catalog-"));
delete process.env.DATABASE_URL;

const { openCatalogs, addCatalog, approveCatalog, makeLive } = await import("../api/catalogs.js");
const { createInterviewService } = await import("../api/interview/service.js");
const { asTheModelWritesIt, deployedContext, loadSystemPrompt } = await import("../api/interview/model.js");
const { stampCatalog } = await import("../api/interview/graph.js");
const { submitPlanToolFor, submitPlanTool } = await import("../api/interview/schema.js");
const { interviewPassages, starterCatalog, catalogProblems } = await import("../core/catalog.js");
const { promptVersionOf } = await import("../core/tracing.js");
const { planSchema04 } = await import("../core/schema.js");

// The prompt and the tool the interview was evaluated with on Oct 15, 2026 (prompt
// ba7017345af5 by its template file). A change to either is a change to the interview:
// run `npm run eval:interview` before and after, then update these.
const EVALUATED_PROMPT = "d3ab331a0a17";
const EVALUATED_TOOL = "993d07645554";

const LINE_V1 = "Runs your API on acme's own serverless platform.";
const LINE_V2 = "Runs your API on acme's newer serverless platform.";

// acme builds two of the four, rewords one, and lists a module of its own nothing builds
// yet. It began as a copy of the starter, so it still carries the starter's passages.
function acme(line) {
  const doc = YAML.parse(fs.readFileSync(path.join(root, "prompts", "module-catalog.yaml"), "utf8"));
  doc.modules = doc.modules.filter(m => m.id === "http_api_serverless" || m.id === "observability_basic");
  doc.modules[0].line = line;
  doc.modules[0].guidance = "Enable it for anything at acme that listens for HTTP.";
  doc.modules.push({ id: "acme_queue", availability: "available", builds_with: "terraform", role: "optional", line: "Acme's own queue." });
  doc.patterns.dev.modules.acme_queue = "Acme's queue pattern.";
  return doc;
}

async function goLive(document) {
  const { version } = await addCatalog({ org: "acme", document });
  await approveCatalog({ org: "acme", version, by: "pat@acme.example" });
  await makeLive({ org: "acme", version });
  return version;
}

before(async () => {
  await openCatalogs();
  await goLive(acme(LINE_V1));
});

const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });
const apiPlan = {
  planVersion: "0.4", app: { name: "orders-api", type: "api" }, profile: "poc",
  // A catalog the model has no business naming: the platform stamps its own.
  catalog: 7,
  modules: [
    { id: "http_api_serverless", inputs: { runtime: "nodejs", entry_point: "index.js", trigger: "http" } },
    { id: "observability_basic", inputs: { target: "auto", metrics: ["requests", "errors", "latency"], retention_days: 30 } }
  ],
  outputs: ["public_url", "logs", "metrics"],
  status: "ready"
};

/** A scripted model that keeps what it was sent each turn. */
function model(...turns) {
  const sent = [];
  let i = 0;
  return {
    sent,
    messages: {
      create: async params => {
        sent.push({ system: params.system.map(b => b.text).join(""), tools: params.tools });
        return { usage: { input_tokens: 10, output_tokens: 10 }, ...turns[Math.min(i++, turns.length - 1)] };
      }
    }
  };
}

async function interview(client, caller) {
  const service = createInterviewService({
    client,
    scratchBase: fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-int-cat-")),
    checkpointer: new MemorySaver()
  });
  const zip = zipSync({ "index.js": new TextEncoder().encode("require('http').createServer().listen(3000)\n") });
  const { interviewId } = await service.startFromUpload({ zip, app: "orders-api", caller, trace: false });
  await service.settled(interviewId);
  const events = [];
  service.subscribe(interviewId, 0, e => events.push(e));
  return { service, interviewId, events };
}

test("the starter's prompt and tool are the ones the interview was evaluated with", () => {
  assert.equal(promptVersionOf(loadSystemPrompt()), EVALUATED_PROMPT);
  assert.equal(promptVersionOf(JSON.stringify(submitPlanTool)), EVALUATED_TOOL);
  assert.deepEqual(JSON.stringify(submitPlanToolFor(starterCatalog())), JSON.stringify(submitPlanTool));
  const { description, ...plan } = submitPlanTool.input_schema.properties.plan;
  assert.deepEqual(plan, planSchema04);
  assert.doesNotMatch(loadSystemPrompt(), /\{\{/, "every passage filled in");
  assert.deepEqual(catalogProblems(starterCatalog()), []);
});

test("an organization's interview hears only of what its catalog builds, in its own words", async () => {
  const client = model({ content: [toolUse("t1", "submit_plan", { plan: apiPlan, summary: "An API.", assumptions: ["poc"] })], stop_reason: "tool_use" });
  const { service, interviewId, events } = await interview(client, { email: "dev@acme.example", org: "acme", team: "default" });

  const { system, tools } = client.sent[0];
  assert.doesNotMatch(system, /static_site_edge|config_basic|acme_queue|\{\{/, "no module it cannot build, and no gap");
  assert.match(system, /seaLeye\.run builds two modules here and no others: `http_api_serverless` and `observability_basic`\./);
  assert.ok(system.includes(LINE_V1), "the module in acme's words");
  assert.match(system, /### http_api_serverless\nEnable it for anything at acme that listens for HTTP\./, "its own guidance, not the starter's");
  assert.doesNotMatch(system, /generated from `prompts\/module-catalog\.yaml`/, "acme's catalog is acme's");
  assert.match(system, /13\. One way of running the app, never two\.\n/);
  assert.doesNotMatch(system, /none of those four provides/);
  assert.match(system, /none of those two provides/);

  const tool = tools.find(t => t.name === "submit_plan");
  assert.deepEqual(tool.input_schema.properties.plan.properties.modules.items.properties.id.enum, ["http_api_serverless", "observability_basic"]);
  assert.doesNotMatch(JSON.stringify(tools), /static_site_edge|config_basic|acme_queue/);

  const result = service.get(interviewId).result;
  assert.equal(result.status, "submitted");
  assert.equal(result.plan.planVersion, "0.5");
  assert.equal(result.plan.catalog, 1, "stamped by the platform with the interview's catalog, never the model's");
  const plan = events.find(e => e.type === "plan");
  assert.ok(plan.files["DEPLOYMENT_PLAN.md"].includes(LINE_V1), "the plan file reads acme's words");
  service.close();
});

test("an interview keeps the catalog it started with, though another goes live meanwhile", async () => {
  const asks = { content: [{ type: "text", text: "I see a server.\nWhat does your app do when it runs?" }], stop_reason: "end_turn" };
  const submits = { content: [toolUse("t1", "submit_plan", { plan: apiPlan, summary: "An API.", assumptions: ["poc"] })], stop_reason: "tool_use" };
  const client = model(asks, submits);
  const { service, interviewId } = await interview(client, { email: "dev@acme.example", org: "acme", team: "default" });
  assert.equal(service.get(interviewId).waitingFor, "question");

  const v2 = await goLive(acme(LINE_V2));
  service.answer(interviewId, "It serves orders.");
  await service.settled(interviewId);

  assert.ok(client.sent[1].system.includes(LINE_V1) && !client.sent[1].system.includes(LINE_V2), "the second turn reads the first catalog");
  assert.equal(service.get(interviewId).result.plan.catalog, 1);

  // A new interview starts with the catalog live now.
  const next = model(submits);
  const later = await interview(next, { email: "dev@acme.example", org: "acme", team: "default" });
  assert.equal(later.service.get(later.interviewId).result.plan.catalog, v2);
  assert.ok(next.sent[0].system.includes(LINE_V2));
  service.close();
  later.service.close();
});

test("an organization with no catalog of its own interviews against the starter, as before", async () => {
  const client = model({ content: [toolUse("t1", "submit_plan", { plan: apiPlan, summary: "An API.", assumptions: ["poc"] })], stop_reason: "tool_use" });
  const { service, interviewId } = await interview(client, { email: "dev@example.com", org: "default", team: "default" });
  assert.equal(promptVersionOf(client.sent[0].system), EVALUATED_PROMPT);
  assert.equal(promptVersionOf(JSON.stringify(client.sent[0].tools.find(t => t.name === "submit_plan"))), EVALUATED_TOOL);
  const plan = service.get(interviewId).result.plan;
  assert.equal(plan.planVersion, "0.5");
  assert.equal(plan.catalog, "starter");
  service.close();
});

test("the platform names the plan's catalog, and the model is shown a deployed plan as it writes one", () => {
  assert.deepEqual(stampCatalog({ ...apiPlan }, { org: "acme", version: 3 }), { ...apiPlan, planVersion: "0.5", catalog: 3 });
  assert.deepEqual(stampCatalog({ ...apiPlan }, null), { ...apiPlan, planVersion: "0.5", catalog: "starter" });
  const old = stampCatalog({ ...apiPlan, planVersion: "0.3", modules: [...apiPlan.modules, { id: "data_relational" }] }, { version: "starter" });
  assert.equal(old.needs[0].kind, "relational_database", "against the starter, an older plan reads as it always did");

  const deployed = { ...apiPlan, planVersion: "0.5", catalog: 2 };
  const { catalog: _named, ...written } = deployed;
  assert.deepEqual(asTheModelWritesIt(deployed), { ...written, planVersion: "0.4" });
  assert.equal(asTheModelWritesIt(apiPlan), apiPlan, "a plan already in the model's shape is shown as it is");
  assert.doesNotMatch(deployedContext(deployed), /"catalog"|"0\.5"/);
  assert.match(deployedContext(deployed), /"planVersion": "0\.4"/);
});

test("a catalog's passage that names a module it does not build is set aside", () => {
  const doc = acme(LINE_V1);
  const passages = interviewPassages(doc);
  assert.doesNotMatch(Object.values(passages).join("\n"), /static_site_edge|config_basic|acme_queue/);
  assert.equal(passages.module_count, "two");
  assert.equal(passages.settings_question, "", "the starter's question about config_basic is gone");

  const own = { ...doc, interview: { ...doc.interview, redeploy_example: "\"your app now reads a setting, which the plan records\"" } };
  assert.equal(interviewPassages(own).redeploy_example, "\"your app now reads a setting, which the plan records\"", "its own passage, when it names nothing it cannot build");
  assert.deepEqual(catalogProblems({ ...doc, interview: { nonsense: "x" } }), ["interview.nonsense is not a passage the interview has"]);
});
