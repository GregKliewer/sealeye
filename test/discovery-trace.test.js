// What a discovery run sends to LangFuse (PHASE4-PLAN Step 7): its shape, never its
// content. A scripted model, a small library with words worth looking for, and LangFuse's
// own span processor writing to memory. No network, no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-discovery-trace-"));
process.env.SEALEYE_HOME = home;
delete process.env.DATABASE_URL;
process.env.LANGFUSE_PUBLIC_KEY ||= "pk-lf-test";
process.env.LANGFUSE_SECRET_KEY ||= "sk-lf-test-only";

const { startTracing, flushTracing } = await import("../core/tracing.js");
const { openCatalogs } = await import("../api/catalogs.js");
const { createDiscoveryService } = await import("../api/discovery/service.js");
const { readLibraryFolder } = await import("../api/discovery/library.js");

const README = "Billing ledger for the Lyra programme. Alarms escalate to the Halcyon on-call rota.";
const QUESTION = "Does the Lyra ledger replace the Orion journal for new apps?";
const LINE = "Keeps the ledger of every Lyra transaction for your app.";

function library() {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-trace-lib-")), "acme-platform");
  const put = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  };
  put("README.md", "# Acme platform\n");
  put("modules/ledger/README.md", `${README}\n`);
  put("modules/ledger/variables.tf", 'variable "name" {\n  type = string\n}\n');
  return dir;
}

const usage = { input_tokens: 1200, output_tokens: 300 };
function scripted() {
  const create = async params => {
    const tools = params.tools.map(t => t.name);
    if (tools.includes("submit_finding")) {
      if (params.messages.length === 1) {
        return { content: [{ type: "text", text: `Reading. ${README}` }, { type: "tool_use", id: "r", name: "read_file", input: { path: "modules/ledger/README.md" } }], stop_reason: "tool_use", usage };
      }
      const finding = {
        line: LINE, role: "core", availability: "available", stages: "all", rules: [],
        questions: [{ kind: "replacement", question: QUESTION, options: ["Yes", "No"], guess: "Yes", evidence: [{ file: "modules/ledger/README.md", shows: README }] }]
      };
      return { content: [{ type: "tool_use", id: "f", name: "submit_finding", input: finding }], stop_reason: "tool_use", usage };
    }
    if (tools.includes("submit_library")) {
      return { content: [{ type: "tool_use", id: "l", name: "submit_library", input: { stages: ["dev", "prod"], rules: [], questions: [] } }], stop_reason: "tool_use", usage };
    }
    if (tools.includes("write_catalog")) {
      return { content: [{ type: "tool_use", id: "w", name: "write_catalog", input: { entries: [{ source: "modules/ledger", line: LINE, role: "core", availability: "available", guidance: README }], questions: [] } }], stop_reason: "tool_use", usage };
    }
    throw new Error("unexpected call");
  };
  return { messages: { create } };
}

test("a discovery run is traced as its shape: workers, files by path and size, tokens, cost and questions by kind; never a word of the library", async () => {
  await openCatalogs();
  const exporter = new InMemorySpanExporter();
  assert.equal(startTracing({ exporter }), true);
  const dir = library();
  const service = createDiscoveryService({ client: scripted(), readLibrary: async () => readLibraryFolder(dir, { repo: "acme/platform" }) });
  const started = await service.start({ caller: { email: "lee@acme.test", org: "acme", team: "platform", scope: "org" }, repos: [{ owner: "acme", repo: "platform" }] });
  await service.settled(started.discoveryId);
  await flushTracing();

  assert.equal(service.get(started.discoveryId).status, "finished");
  const spans = exporter.getFinishedSpans();
  const names = spans.map(s => s.name);
  assert.ok(names.includes("sealeye discover"), names.join(", "));
  assert.ok(names.includes("worker-modules-ledger"), "a span for each worker");
  assert.ok(names.includes("worker-library"));
  assert.ok(names.includes("supervisor"));
  assert.ok(names.includes("worker-modules-ledger turn 1"), "a generation for each model call");
  assert.ok(names.includes("read_file"), "each file read");
  assert.ok(names.includes("question"), "each question, as an event");
  assert.equal(new Set(spans.map(s => s.spanContext().traceId)).size, 1, "one trace a run");
  assert.ok(!names.some(n => /^turn \d/.test(n)), "no interview generation, which would record the reply's text");

  const attrs = spans.flatMap(s => Object.values(s.attributes).map(String)).join("\n");
  for (const words of ["Lyra", "Halcyon", "Orion", "Keeps the ledger"]) assert.ok(!attrs.includes(words), `${words} must not reach a trace`);
  assert.match(attrs, /modules\/ledger\/README\.md/, "the path read");
  assert.match(attrs, /"bytes":\d+/, "and its size");
  assert.match(attrs, /"kind":"other"/, "a question's kind, one of the schema's: a model's own word for it is not kept");
  assert.ok(!attrs.includes("replacement"));
  assert.match(attrs, /"questions_other":1/, "and the count by kind at the end");
  assert.match(attrs, /"cost":0\.\d+/, "what a worker spent");

  // A late answer is written in under a trace of its own, with nothing of the answer in it.
  exporter.reset();
  const [q] = service.questions(started.discoveryId);
  await service.answer({ id: started.discoveryId, questionId: q.id, answer: "Only for the Lyra trial teams", by: "lee@acme.test" });
  await service.settled(started.discoveryId);
  await flushTracing();
  const later = exporter.getFinishedSpans();
  assert.ok(later.some(s => s.name === "sealeye discover answers"), later.map(s => s.name).join(", "));
  assert.ok(later.some(s => s.name === "supervisor"));
  const laterAttrs = later.flatMap(s => Object.values(s.attributes).map(String)).join("\n");
  for (const words of ["Lyra", "Halcyon", "Orion"]) assert.ok(!laterAttrs.includes(words), `${words} must not reach a trace`);
});
