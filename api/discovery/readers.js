// api/discovery/readers.js
// The model's part of a discovery run (PHASE4-PLAN Step 6, D5): a worker reads one module
// on the small route, a library reader reads the library's README and pipeline on the
// small route, and the supervisor writes the catalog's words on the frontier route.
//
// Each reads only what plain code gave it: a worker its own module's folder and the
// library-level documents, read-only, from a snapshot the scanners have already been
// over (api/discovery/library.js). The supervisor reads no files, only findings. None of
// them chooses what is read, and none can change anything.
//
// Every reply is priced by its route's model (core/model-prices.js) and charged to its
// worker; before each call the worker's own cap and the run's are checked, and a reader
// that has reached either stops with what it has.
import fs from "node:fs";
import path from "node:path";

import { addSpend, priceUsage } from "../../core/model-prices.js";
import { createWithOneRetry } from "../interview/model.js";
import { listFiles, readFile, ToolRefusal } from "../interview/tools.js";
import { routeModel } from "../model-routes.js";
import { traceDiscoveryCall, traceStep, traceTool } from "../../core/tracing.js";

const PROMPTS = path.join(import.meta.dirname, "..", "..", "prompts");
const MAX_READER_TURNS = 14;
const MAX_TOKENS = 8000;

/** A prompt file with {{name}} filled in. */
export function prompt(name, values = {}) {
  const text = fs.readFileSync(path.join(PROMPTS, name), "utf8");
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in values ? String(values[k]) : m));
}

/** The run stopped spending: a reader or the supervisor could not go on. */
export class SpendingLimit extends Error {
  constructor(scope) {
    super(scope === "run" ? "the run reached its spending limit" : "this reader reached its spending limit");
    this.name = "SpendingLimit";
    this.scope = scope;
  }
}

// What every question looks like, raised by a reader or the supervisor (DESIGN.md, "The
// discovery run"). Options are short; the guess is one of them.
const questionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "question", "options", "guess", "evidence"],
  properties: {
    kind: { type: "string", enum: ["overlap", "deprecated", "contradiction", "other"] },
    question: { type: "string", description: "The question, in a sentence a platform engineer can answer." },
    options: { type: "array", minItems: 2, maxItems: 4, items: { type: "string" }, description: "Short answers, your guess first." },
    guess: { type: "string", description: "Your best guess: one of the options." },
    touches: { type: "array", items: { type: "string" }, description: "Every module folder the answer changes, as written in the library (modules/x)." },
    evidence: { type: "array", minItems: 1, items: { $ref: "#/$defs/evidence" } }
  }
};
const evidenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["file", "shows"],
  properties: {
    file: { type: "string", description: "The file, as a path in the library." },
    line: { type: "integer", minimum: 1 },
    shows: { type: "string", description: "What in it says so, in a sentence." }
  }
};
const ruleSchema = {
  type: "object",
  additionalProperties: false,
  required: ["rule", "evidence"],
  properties: {
    rule: { type: "string" },
    stages: { type: "string", description: "Which stages it applies to, in the library's terms, or 'all'." },
    evidence: { $ref: "#/$defs/evidence" }
  }
};
const defs = { evidence: evidenceSchema, question: questionSchema, rule: ruleSchema };

export const submitFindingTool = {
  name: "submit_finding",
  description: "Hand in what you found about this module. Call once, when you have read enough.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    $defs: defs,
    required: ["line", "when", "signals", "role", "availability", "stages", "rules", "questions"],
    properties: {
      line: { type: "string", description: "One sentence: what it gives an app, in plain words." },
      when: { type: "string", description: "When an app should use it." },
      signals: { type: "array", items: { type: "string" }, description: "What in an app's code or configuration shows it needs this." },
      role: { type: "string", enum: ["core", "shared", "optional"] },
      availability: { type: "string", enum: ["available", "deprecated"], description: "deprecated only when the library says so." },
      stages: { type: "string", description: "Which stages it is for, in the library's terms, or 'all'." },
      rules: { type: "array", items: { $ref: "#/$defs/rule" } },
      input_lines: { type: "object", additionalProperties: { type: "string" }, description: "A plain line for any input whose description is missing or uses cloud terms, by input name." },
      questions: { type: "array", items: { $ref: "#/$defs/question" } }
    }
  }
};

export const submitLibraryTool = {
  name: "submit_library",
  description: "Hand in what you found about the library as a whole. Call once.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    $defs: defs,
    required: ["stages", "rules", "questions"],
    properties: {
      stages: { type: "array", items: { type: "string" }, description: "The path to production, in order." },
      aside: { type: "array", items: { type: "string" }, description: "Stages built aside from that path, each with how." },
      gates: { type: "array", items: { type: "string" }, description: "What each gate asks for, one per line, naming the stage." },
      rules: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["rule", "applies_to", "evidence"],
          properties: {
            rule: { type: "string" },
            applies_to: { type: "array", items: { type: "string" }, description: "Module folders, or [\"all\"]." },
            stages: { type: "string" },
            evidence: { $ref: "#/$defs/evidence" }
          }
        }
      },
      questions: { type: "array", items: { $ref: "#/$defs/question" } }
    }
  }
};

export const writeCatalogTool = {
  name: "write_catalog",
  description: "Write the entries you were asked for, and any questions of your own. Call once.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    $defs: defs,
    required: ["entries", "questions"],
    properties: {
      entries: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["source", "line", "when", "signals", "role", "availability", "guidance", "open"],
          properties: {
            source: { type: "string", description: "The module's folder, exactly as given." },
            line: { type: "string" },
            when: { type: "string" },
            signals: { type: "array", items: { type: "string" } },
            role: { type: "string", enum: ["core", "shared", "optional"] },
            availability: { type: "string", enum: ["available", "deprecated"] },
            guidance: { type: "string" },
            input_lines: { type: "object", additionalProperties: { type: "string" } },
            open: { type: "array", items: { type: "string" }, description: "Ids of unanswered questions this entry rests on." }
          }
        }
      },
      questions: { type: "array", items: { $ref: "#/$defs/question" } },
      merges: {
        type: "array",
        description: "Questions so far that ask the same thing in different words: the one to keep, and the ids it covers.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["keep", "merged"],
          properties: {
            keep: { type: "string", description: "The id of the question to keep: the clearest." },
            merged: { type: "array", items: { type: "string" }, description: "The ids of the questions it covers." }
          }
        }
      }
    }
  }
};

const fileTools = [
  {
    name: "list_files",
    description: 'List the names in a folder of the library. "." is the library itself. Read-only; at most 40 entries, folders marked with a trailing slash.',
    input_schema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string" } } }
  },
  {
    name: "read_file",
    description: "Read a text file you may read: in your own folder, the library's README.md, or under .github/. Read-only; truncated at 20 KB.",
    input_schema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string" } } }
  }
];

/** Whether a reader of `scope` may read `rel` (a path inside the library). */
export function mayRead(scope, rel) {
  const clean = path.posix.normalize(String(rel || "").replace(/^\.\/+/, ""));
  if (clean.startsWith("..") || path.posix.isAbsolute(clean)) return false;
  if (clean === "README.md" || clean === ".github" || clean.startsWith(".github/")) return true;
  if (scope === "." || scope === null) return false;
  return clean === scope || clean.startsWith(`${scope}/`);
}

function runFileTool(snapshot, scope, use) {
  const result = fileToolResult(snapshot, scope, use);
  // Traced as its path and size, never its contents (core/tracing.js).
  traceTool({
    name: use.name,
    path: String(use.input?.path ?? "."),
    ...(use.name === "read_file" && !result.isError ? { bytes: Buffer.byteLength(result.content) } : {}),
    ...(use.name === "list_files" && !result.isError ? { entries: String(result.content).split("\n").filter(Boolean).length } : {}),
    ...(result.isError ? { refused: "yes" } : {})
  });
  return result;
}

function fileToolResult(snapshot, scope, use) {
  const p = String(use.input?.path ?? ".");
  try {
    if (use.name === "list_files") return { content: listFiles(snapshot.dir, p), isError: false };
    if (use.name === "read_file") {
      if (!mayRead(scope, p)) return { content: `refused: ${p} is not yours to read; read your own folder, README.md or .github/`, isError: true };
      const withheld = snapshot.findings.map(f => ({ ...f }));
      return { content: readFile(snapshot.dir, p, { withheld, unread: snapshot.unreadFiles || [] }), isError: false };
    }
    return { content: `no tool named ${use.name}`, isError: true };
  } catch (err) {
    if (err instanceof ToolRefusal) return { content: `refused: ${err.message}`, isError: true };
    return { content: `could not run ${use.name}: ${err.message}`, isError: true };
  }
}

/** What a worker spent, for its span: dollars and tokens, never what it read. */
const spentBy = (budget, worker) => {
  const w = budget.spend()[worker] || {};
  return { cost: Number((w.cost || 0).toFixed(6)), inputTokens: w.input || 0, outputTokens: w.output || 0 };
};

/**
 * A budget shared by a run's readers: each worker's spend, and the run's; a reader
 * ("worker:...") stops at the cap per worker, the supervisor only at the run's. `charge`
 * prices a reply and adds it; `check` throws SpendingLimit before a call that should not
 * be made. A reader can go past its cap by one reply, as an interview can.
 */
export function createBudget({ workerCap, runCap, spend = {} }) {
  const totals = structuredClone(spend);
  const total = () => Object.values(totals).reduce((s, w) => s + (w?.cost || 0), 0);
  return {
    check(worker) {
      if (total() >= runCap) throw new SpendingLimit("run");
      // The cap per worker is the readers' (one module each). The supervisor writes the
      // whole catalog, and again for each late answer, so only the run's cap bounds it:
      // with the readers' cap it was refused every late answer once its first write had
      // spent more than a reader may (found Oct 15, 2026, before release).
      if (String(worker).startsWith("worker:") && (totals[worker]?.cost || 0) >= workerCap) throw new SpendingLimit("worker");
    },
    charge(worker, model, usage) {
      totals[worker] = addSpend(totals[worker], priceUsage(model, usage));
    },
    spend: () => structuredClone(totals),
    total
  };
}

/**
 * One reader's conversation: read with the file tools until it calls `finalTool`, or
 * runs out of turns or money. Returns the final tool's input, or throws.
 */
function readUntil(options) {
  const { worker, budget } = options;
  return traceStep(worker, async step => {
    try {
      const found = await readUntilTraced(options);
      step.set({ worker, handedIn: true, ...spentBy(budget, worker) });
      return found;
    } catch (err) {
      step.set({ worker, handedIn: false, why: err instanceof SpendingLimit ? "spending_limit" : "error", ...spentBy(budget, worker) });
      throw err;
    }
  });
}

async function readUntilTraced({ clientFor, route, credentialIsGateway, worker, system, opening, tools, finalTool, snapshot, scope, budget, onStep = () => {} }) {
  const model = routeModel(route);
  const requestModel = credentialIsGateway ? route : model;
  const client = clientFor(worker);
  const messages = [{ role: "user", content: opening }];
  for (let turn = 0; turn < MAX_READER_TURNS; turn++) {
    budget.check(worker);
    const last = turn === MAX_READER_TURNS - 1;
    const response = await traceDiscoveryCall({ worker, turn, model, messages }, () => createWithOneRetry(
      client,
      {
        model: requestModel,
        max_tokens: MAX_TOKENS,
        system,
        tools: [...tools, finalTool],
        // The last turn may only hand in what it has.
        ...(last ? { tool_choice: { type: "tool", name: finalTool.name } } : {}),
        messages
      },
      onStep,
      turn,
      { traceAs: "discovery" }
    ));
    budget.charge(worker, model, response.usage || {});
    messages.push({ role: "assistant", content: response.content });
    const uses = (response.content || []).filter(b => b.type === "tool_use");
    const final = uses.find(u => u.name === finalTool.name);
    if (final) return final.input;
    if (!uses.length) {
      messages.push({ role: "user", content: `Call ${finalTool.name} with what you have found.` });
      continue;
    }
    messages.push({
      role: "user",
      content: uses.map(use => {
        const { content, isError } = runFileTool(snapshot, scope, use);
        return { type: "tool_result", tool_use_id: use.id, content, ...(isError ? { is_error: true } : {}) };
      })
    });
  }
  throw new Error(`${worker} did not hand in a finding`);
}

/** A worker: one module, on the small route. */
export function readModule({ module, snapshot, org, ...common }) {
  const inputs = Object.entries(module.inputs).map(([name, v]) =>
    `- ${name}: ${v.required ? "required" : "optional"}${v.line ? `. ${v.line}` : ""}`).join("\n") || "(none)";
  return readUntil({
    ...common,
    route: "small",
    worker: `worker:${module.source}`,
    system: prompt("discovery-worker.md", { org, source: module.source }),
    opening: `Your module is ${module.source}. Its inputs, read from its variables:\n${inputs}\n\nRead it, then call submit_finding.`,
    tools: fileTools,
    finalTool: submitFindingTool,
    snapshot,
    scope: module.source
  });
}

/** The library reader: README and pipeline, on the small route. */
export function readLibraryLevel({ snapshot, org, modules, ...common }) {
  return readUntil({
    ...common,
    route: "small",
    worker: "worker:library",
    system: prompt("discovery-library.md", { org }),
    opening: `The library's modules are in these folders:\n${modules.map(m => `- ${m.source}`).join("\n")}\n\nRead its README.md and .github/, then call submit_library.`,
    tools: fileTools,
    finalTool: submitLibraryTool,
    snapshot,
    scope: "."
  });
}

/**
 * The supervisor: the catalog's words for `sources` (every module, or those an answer
 * touched), from the findings and the questions so far, on the frontier route. One call;
 * a reply with no write_catalog is asked once more.
 */
export function superviseEntries(options) {
  const { budget, sources } = options;
  return traceStep("supervisor", async step => {
    try {
      const written = await superviseTraced(options);
      step.set({ worker: "supervisor", entries: sources.length, questions: (written.questions || []).length, ...spentBy(budget, "supervisor") });
      return written;
    } catch (err) {
      step.set({ worker: "supervisor", why: err instanceof SpendingLimit ? "spending_limit" : "error", ...spentBy(budget, "supervisor") });
      throw err;
    }
  });
}

async function superviseTraced({ clientFor, credentialIsGateway, budget, org, modules, library, questions, sources, plainWords = null, onStep = () => {} }) {
  const model = routeModel("frontier");
  const client = clientFor("supervisor");
  const findings = modules.map(m => ({
    source: m.source,
    inputs: Object.fromEntries(Object.entries(m.inputs).map(([k, v]) => [k, { required: v.required, ...(v.line ? { line: v.line } : {}) }])),
    finding: m.finding || null,
    ...(m.failed ? { not_read: m.failed } : {})
  }));
  const asked = questions.map(q => ({
    id: q.id,
    kind: q.kind,
    touches: q.touches,
    question: q.question,
    options: q.options,
    guess: q.guess,
    ...(q.answer !== undefined && q.answer !== null ? { answer: q.answer } : {})
  }));
  const opening = [
    `Write the entries for these modules: ${sources.join(", ")}.`,
    "",
    // Once, when the draft's words failed the check a catalog must pass to be approved
    // (Greg, Oct 16, 2026): the same entries, the same meaning, in plain words.
    ...(plainWords ? [
      "These entries were written with words a developer never reads. Write each again with the same meaning in plain words, saying what it does for the developer's app, and give a plain line in input_lines for every input named here:",
      ...plainWords.map(line => `- ${line}`),
      ""
    ] : []),
    "What the readers found, each module:",
    JSON.stringify(findings, null, 1),
    "",
    "What the library reader found:",
    JSON.stringify(library || null, null, 1),
    "",
    "Questions so far, with any answers:",
    JSON.stringify(asked, null, 1)
  ].join("\n");
  const messages = [{ role: "user", content: opening }];
  for (let turn = 0; turn < 2; turn++) {
    budget.check("supervisor");
    const response = await traceDiscoveryCall({ worker: "supervisor", turn, model, messages }, () => createWithOneRetry(
      client,
      {
        model: credentialIsGateway ? "frontier" : model,
        max_tokens: 16000,
        system: prompt("discovery-supervisor.md", { org }),
        tools: [writeCatalogTool],
        tool_choice: { type: "tool", name: writeCatalogTool.name },
        messages
      },
      onStep,
      turn,
      { traceAs: "discovery" }
    ));
    budget.charge("supervisor", model, response.usage || {});
    const use = (response.content || []).find(b => b.type === "tool_use" && b.name === writeCatalogTool.name);
    if (use) return use.input;
    messages.push({ role: "assistant", content: response.content }, { role: "user", content: "Call write_catalog." });
  }
  throw new Error("the supervisor did not write the catalog");
}
