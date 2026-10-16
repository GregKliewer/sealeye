// core/tracing.js
// Tracing the interview with LangFuse, and the one place that decides what a trace may
// contain (DESIGN.md, "Tracing the interview with LangFuse", D1 to D3).
//
// Three rules hold everywhere in this file:
//
// 1. Off unless configured. With no LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY, every
//    export is a no-op and the wrapped work runs exactly as it would without tracing.
// 2. Tracing never changes a run. A failure inside tracing is swallowed (and printed only
//    with SEALEYE_DEBUG); a failure inside the work is rethrown unchanged.
// 3. File contents never reach a trace (D2). The helpers take only fields seaLeye chose,
//    and a mask runs over everything exported as a backstop. LangFuse masks only input,
//    output and metadata, so span names, status messages, session and user ids are set
//    here from seaLeye's own values and never from model or developer text.
//
// It lives in core/ because the interview moves from cli/ to api/ in Phase 1, and the
// rules about what a trace may hold should not have to move with it.
import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { configureGlobalLogger, LANGFUSE_SDK_EXPERIMENT_ENVIRONMENT, LangfuseOtelSpanAttributes, LogLevel } from "@langfuse/core";
import {
  getActiveTraceId,
  propagateAttributes,
  setLangfuseTracerProvider,
  startActiveObservation,
  startObservation
} from "@langfuse/tracing";
import { loadEnv, loadUserConfig, repoRoot, setting } from "./config.js";

const REDACTED = "[value redacted]";     // the wording the evidence files use
const MAX_EVENT_STRING = 2000;
// The interview's tools, and discovery's (PHASE4-PLAN Step 7): a name outside the list is
// recorded as unknown_tool, since a model could otherwise put words in a span's name.
const TOOL_NAMES = new Set(["list_files", "read_file", "submit_plan", "submit_finding", "submit_library", "write_catalog"]);

let provider = null;

// A run that asked for no tracing, in a process where tracing is on: the hosted API
// serves many interviews, and one developer's --no-trace must not turn it off for the
// rest, nor leave that interview's turns as stray traces of their own.
const untraced = new AsyncLocalStorage();

/** Run `fn` with every helper in this file a no-op for it and anything it awaits. */
export function withoutTracing(fn) {
  return untraced.run(true, fn);
}

/** Tracing is on for the code running now. */
function live() {
  return provider !== null && untraced.getStore() !== true;
}

// ---------------------------------------------------------------------------------
// Masking: the backstop.

const SECRET_PATTERNS = [
  // Private key blocks, including one cut off by the 20 KB read limit.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, () => REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, () => REDACTED],              // AWS access key ids
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, () => REDACTED],                   // Anthropic keys
  [/sk-lf-[A-Za-z0-9_-]{8,}/g, () => REDACTED],                    // LangFuse secret keys
  [/\bsl_[A-Za-z0-9_-]{40,}/g, () => REDACTED],                    // seaLeye tokens
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g, () => `Bearer ${REDACTED}`],
  // NAME=value where the name says it is a secret. The name stays; the value goes.
  [
    /\b((?:export\s+)?[A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Za-z0-9_]*\s*=\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;]+)/gi,
    (match, name, value) => (value.startsWith("[value") ? match : `${name}${REDACTED}`)
  ]
];

/** The same patterns over plain text, as it is, never parsed (for an app's log lines). */
export function maskSecretText(text) {
  return maskText(String(text));
}

function maskText(text) {
  let out = text;
  for (const [pattern, replace] of SECRET_PATTERNS) out = out.replace(pattern, replace);
  return out;
}

function maskDeep(value) {
  if (typeof value === "string") return maskText(value);
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v)]));
  }
  return value;
}

/**
 * Redact anything that looks like a secret. LangFuse hands the mask a serialized JSON
 * string; it is parsed, masked string by string and serialized again, so a redaction
 * can never break the JSON. Anything else is masked as it is.
 */
export function maskSecrets(data) {
  if (typeof data === "string") {
    try {
      return JSON.stringify(maskDeep(JSON.parse(data)));
    } catch {
      return maskText(data);
    }
  }
  return maskDeep(data);
}

// ---------------------------------------------------------------------------------
// Shapes: what each helper is allowed to record, by construction.

/**
 * The conversation sent to the model, as roles, block types, tool names, file paths and
 * lengths. Never block contents: earlier file reads are inside the input of every turn.
 */
export function conversationShape(messages = []) {
  return messages.map(m => ({
    role: m.role,
    blocks: typeof m.content === "string"
      ? [{ type: "text", chars: m.content.length }]
      : (m.content || []).map(blockShape)
  }));
}

function blockShape(block) {
  if (block.type === "text") return { type: "text", chars: (block.text || "").length };
  if (block.type === "tool_use") {
    const shape = { type: "tool_use", name: safeToolName(block.name) };
    if (typeof block.input?.path === "string") shape.path = block.input.path;
    return shape;
  }
  if (block.type === "tool_result") {
    return { type: "tool_result", chars: contentLength(block.content), isError: Boolean(block.is_error) };
  }
  return { type: String(block.type) };
}

function contentLength(content) {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) return content.reduce((n, b) => n + (b.text || "").length, 0);
  return 0;
}

/**
 * What the model said in one turn: its text, and its tool calls. A submit_plan call is
 * recorded whole, because a plan holds no secrets by contract; any other tool call is
 * recorded as its name and path.
 */
export function turnOutput(response) {
  return (response?.content || []).map(block => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "tool_use") {
      const name = safeToolName(block.name);
      if (name === "submit_plan") return { type: "tool_use", name, input: block.input };
      const shape = { type: "tool_use", name };
      if (typeof block.input?.path === "string") shape.path = block.input.path;
      return shape;
    }
    return { type: String(block.type) };
  });
}

/** Anthropic's usage numbers under the names LangFuse prices by. */
export function usageDetails(usage = {}) {
  const out = {};
  const pairs = [
    ["input", usage.input_tokens],
    ["output", usage.output_tokens],
    ["cache_read_input_tokens", usage.cache_read_input_tokens],
    ["cache_creation_input_tokens", usage.cache_creation_input_tokens]
  ];
  for (const [key, value] of pairs) if (Number.isFinite(value)) out[key] = value;
  return out;
}

/**
 * The only fields a tool record may carry. Anything else, a `content` field above all,
 * is dropped here rather than trusted to the caller.
 */
export function toolAttributes({ name, path: filePath, bytes, entries, truncated, refused } = {}) {
  const out = { name: safeToolName(name) };
  if (typeof filePath === "string") out.path = filePath;
  if (Number.isFinite(bytes)) out.bytes = bytes;
  if (Number.isFinite(entries)) out.entries = entries;
  if (typeof truncated === "boolean") out.truncated = truncated;
  if (typeof refused === "string" && refused) out.refused = refused;
  return out;
}

/**
 * The fields an event may carry: primitives and lists of primitives, strings capped and
 * masked, and nothing called content.
 */
export function eventAttributes(attrs = {}) {
  const out = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (/content/i.test(key)) continue;
    const clean = cleanValue(value);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

function cleanValue(value) {
  if (typeof value === "string") return maskText(value.slice(0, MAX_EVENT_STRING));
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items = value.map(cleanValue).filter(v => v !== undefined && typeof v !== "object");
    return items;
  }
  return undefined;
}

function safeToolName(name) {
  return TOOL_NAMES.has(name) ? name : "unknown_tool";
}

/**
 * A short, stable id for a prompt as the model reads it: which prompt a run used. Since
 * PHASE4-PLAN Step 3 the interview's prompt is filled in from its catalog, so the id is
 * of the text the model was given, not of the template file.
 */
export function promptVersionOf(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex").slice(0, 12);
}

/** A short, stable id for a prompt file's content (the template, before it is filled in). */
export function promptVersion(file = path.join(repoRoot, "prompts", "interview-system.md")) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 12);
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------------
// Starting and flushing.

/** True when LangFuse keys are set in the environment, .env or ~/.sealeye/config. */
export function tracingConfigured() {
  loadEnv();
  loadUserConfig();
  return Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);
}

const TRACING_ON_VALUES = new Set(["on", "true", "1", "yes"]);

/**
 * True when SEALEYE_TRACING turns tracing off, from the environment, .env or
 * ~/.sealeye/config. Unset leaves tracing to the keys. Any value other than on, true,
 * 1 or yes means off, so a typo in the switch never sends a trace someone meant to
 * stop (DESIGN.md, "Turning tracing off for a run").
 */
export function tracingSwitchedOff() {
  loadEnv();
  loadUserConfig();
  const value = setting("TRACING");
  if (value === undefined) return false;
  return !TRACING_ON_VALUES.has(value.trim().toLowerCase());
}

/** True once startTracing has succeeded. */
export function tracingActive() {
  return provider !== null;
}

/**
 * Start tracing for this process, if LangFuse is configured and nothing has turned it
 * off. Safe to call more than once. `off` is the CLI's --no-trace; `exporter` replaces
 * the network exporter, for tests.
 *
 * @returns {boolean} whether tracing is on
 */
export function startTracing({ exporter, off = false } = {}) {
  if (provider) return true;
  try {
    if (off || tracingSwitchedOff()) return false;
    if (!tracingConfigured()) return false;

    // LangFuse's own logger writes to the terminal; the CLI's terminal is the
    // developer's, so it stays quiet unless debugging.
    configureGlobalLogger({ level: setting("DEBUG") ? LogLevel.WARN : LogLevel.NONE });

    const processor = new LangfuseSpanProcessor({
      ...(exporter ? { exporter } : {}),
      mask: ({ data }) => maskSecrets(data),
      // The CLI is short-lived: send each span as it ends, so an interrupted run still
      // leaves what it did. flushTracing() waits for the last of them.
      exportMode: "immediate",
      release: packageVersion()
    });

    // A provider of seaLeye's own, handed to LangFuse rather than registered globally,
    // so nothing else in the process is traced. Nested spans need a context manager.
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    const tracerProvider = new NodeTracerProvider({ spanProcessors: [processor] });
    setLangfuseTracerProvider(tracerProvider);
    provider = tracerProvider;
    return true;
  } catch (err) {
    debug("could not start tracing", err);
    provider = null;
    return false;
  }
}

/**
 * Send whatever has not been sent yet, waiting at most `timeoutMs`. Call on every exit
 * path. Never throws.
 */
export async function flushTracing(timeoutMs = 3000) {
  if (!provider) return;
  let timer;
  try {
    await Promise.race([
      provider.forceFlush(),
      new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })
    ]);
  } catch (err) {
    debug("could not send traces", err);
  } finally {
    clearTimeout(timer);
  }
}

/** The id of the trace the current code is running inside, if any. */
export function currentTraceId() {
  if (!live()) return undefined;
  try {
    return getActiveTraceId();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------
// The four helpers, shaped like the interview.

/**
 * The root of one `sealeye run`. The session id is the app name, so every run of one app
 * lines up in LangFuse.
 *
 * `fn(run)` gets a handle: `run.set({ status, questions })` records the outcome, and
 * `run.traceId` is the trace's id (undefined when tracing is off).
 */
export function traceRun({ app, mode, model, promptSha, catalog, user, continueFrom }, fn) {
  const noop = { set() {}, traceId: undefined, spanId: undefined };
  if (!live()) return fn(noop);

  // A hosted interview pauses for the developer between requests, and each stretch of
  // work after a pause runs here again. `continueFrom` is the first stretch's root
  // ({ traceId, spanId }, kept in the interview's saved state), so every stretch joins
  // the same trace under it instead of starting a new one.
  const parent = continueFrom && /^[0-9a-f]{32}$/.test(continueFrom.traceId) && /^[0-9a-f]{16}$/.test(continueFrom.spanId)
    ? { traceId: continueFrom.traceId, spanId: continueFrom.spanId, traceFlags: 1, isRemote: true }
    : null;

  const outcome = {};
  return guarded(wrapped =>
    startActiveObservation(parent ? "interview resumed" : "sealeye run", async span => {
      // catalog: which catalog the interview planned against ("starter", or a version).
      span.update({ metadata: eventAttributes({ app, mode, model, promptSha, ...(catalog ? { catalog } : {}) }) });
      const handle = {
        traceId: currentTraceId(),
        spanId: span.id,
        set(fields) {
          Object.assign(outcome, eventAttributes(fields));
          quietly(() => span.update({ output: outcome }));
        }
      };
      return propagateAttributes(
        {
          traceName: "sealeye run",
          sessionId: safeId(app),
          ...(user ? { userId: safeId(user) } : {}),
          ...(mode ? { tags: [safeId(mode)] } : {})
        },
        () => wrapped(span, handle)
      );
    }, { asType: "agent", ...(parent ? { parentSpanContext: parent } : {}) }), fn, noop);
}

/**
 * One model call, as a generation. `fn(turn)` makes the call and returns the response;
 * `turn.retried(err)` records a retry on the same turn. The input recorded is the shape
 * of `messages`, never their contents.
 */
export function traceTurn({ turn, model, messages }, fn) {
  const noop = { retried() {} };
  if (!live()) return fn(noop);

  const meta = { turn };
  return guarded(wrapped =>
    startActiveObservation(`turn ${Number(turn) + 1}`, async generation => {
      generation.update({ model, input: conversationShape(messages), metadata: meta });
      const handle = {
        retried(err) {
          meta.retried = true;
          meta.retryError = [err?.name, err?.status].filter(Boolean).join(" ") || "error";
          quietly(() => generation.update({ metadata: meta }));
        }
      };
      const response = await wrapped(generation, handle);
      quietly(() => generation.update({
        output: turnOutput(response),
        usageDetails: usageDetails(response?.usage),
        metadata: { ...meta, stopReason: response?.stop_reason }
      }));
      return response;
    }, { asType: "generation" }), fn, noop);
}

/**
 * A timed step of seaLeye's own, such as checking a plan against the contract.
 * `fn(step)` does the work; `step.set(attrs)` records what came of it, cleaned and
 * masked like an event.
 */
export function traceStep(name, fn) {
  const noop = { set() {} };
  if (!live()) return fn(noop);

  const recorded = {};
  return guarded(wrapped =>
    startActiveObservation(safeId(name), async span => {
      const handle = {
        set(attrs) {
          Object.assign(recorded, eventAttributes(attrs));
          quietly(() => span.update({ output: recorded }));
        }
      };
      return wrapped(span, handle);
    }), fn, noop);
}

/** A new experiment id: one per regression run, shared by its items. */
export function newExperimentId() {
  return crypto.randomBytes(8).toString("hex");
}

/**
 * One dataset item's run, for the interview regression set, recorded the way LangFuse's
 * own experiment runner records it so it shows under the dataset's Experiments: a root
 * span linked to the dataset run, and every span under it marked with the experiment.
 * `fn(item)` does the work and returns what to show as the item's output;
 * `item.traceId` is this trace. Throws if tracing is off, because an experiment with
 * no trace is nothing to look at.
 */
export async function traceExperimentItem({ experimentId, runName, description, datasetId, itemId, input, expectedOutput }, fn) {
  if (!provider) throw new Error("tracing is not on, so there is nothing to record the run in");

  return startActiveObservation("experiment-item-run", async span => {
    const traceId = span.traceId;

    // The older dataset-run link. LangFuse organizations created from September 16,
    // 2026 build experiments from the marks below alone, so a failed link is not a
    // failed run, and without a run id from it the experiment's own id is used, as
    // LangFuse's runner does.
    let run = null;
    try {
      run = await langfuseRequest("POST", "/api/public/dataset-run-items", {
        runName,
        runDescription: description,
        datasetItemId: itemId,
        traceId,
        observationId: span.id
      }, 10_000);
    } catch (err) {
      debug("could not link the dataset run item", err);
    }

    span.otelSpan.setAttributes({
      [LangfuseOtelSpanAttributes.ENVIRONMENT]: LANGFUSE_SDK_EXPERIMENT_ENVIRONMENT,
      [LangfuseOtelSpanAttributes.EXPERIMENT_DESCRIPTION]: description,
      [LangfuseOtelSpanAttributes.EXPERIMENT_ITEM_EXPECTED_OUTPUT]: JSON.stringify(expectedOutput)
    });

    const output = await propagateAttributes(
      {
        _internalExperiment: {
          experimentId: run?.datasetRunId || experimentId,
          experimentName: runName,
          experimentDatasetId: datasetId,
          experimentItemId: itemId,
          experimentItemRootObservationId: span.id
        }
      },
      () => fn({ traceId })
    );

    quietly(() => span.update({ input, output }));
    return output;
  });
}

// ---------------------------------------------------------------------------------
// Discovery (PHASE4-PLAN Step 7; DESIGN.md, "A catalog goes live through a self-test,
// approved and made live apart"): the shape of a run, never its content. A discovery
// run reads a platform team's library, so unlike the interview's, no model reply is
// recorded at all, not even its text: only which tools it called, on which paths, and
// what it cost. A question is recorded as its kind and who raised it, never its words.

/** What the model did in one discovery turn: its tool calls by name and path, never its words or a tool's input. */
export function discoveryTurnShape(response) {
  return (response?.content || []).map(block => {
    if (block.type === "text") return { type: "text", chars: (block.text || "").length };
    if (block.type === "tool_use") {
      const shape = { type: "tool_use", name: safeToolName(block.name) };
      if (typeof block.input?.path === "string") shape.path = block.input.path;
      return shape;
    }
    return { type: String(block.type) };
  });
}

/**
 * The root of one discovery run, or of the late answers written into its draft
 * (`kind: "answers"`). The session is the organization, so its runs line up.
 * `fn(run)` gets a handle: `run.set(fields)` records the outcome, cleaned as an event's.
 */
export function traceDiscovery({ runId, org, repo, commit, user, kind = "run" }, fn) {
  const noop = { set() {}, traceId: undefined };
  if (!live()) return fn(noop);
  const name = kind === "answers" ? "sealeye discover answers" : "sealeye discover";
  const outcome = {};
  return guarded(wrapped =>
    startActiveObservation(name, async span => {
      span.update({ metadata: eventAttributes({ run: runId, repo, commit }) });
      const handle = {
        traceId: currentTraceId(),
        set(fields) {
          Object.assign(outcome, eventAttributes(fields));
          quietly(() => span.update({ output: outcome }));
        }
      };
      return propagateAttributes(
        { traceName: name, sessionId: safeId(org), ...(user ? { userId: safeId(user) } : {}), tags: ["discovery"] },
        () => wrapped(span, handle)
      );
    }, { asType: "agent" }), fn, noop);
}

/**
 * One discovery model call, as a generation: the conversation's shape in, the tool calls'
 * names and paths out, and the tokens. Never a prompt, a file or a reply.
 */
export function traceDiscoveryCall({ worker, turn, model, messages }, fn) {
  if (!live()) return fn();
  const meta = { worker: safeId(worker), turn };
  return guarded(wrapped =>
    startActiveObservation(`${safeId(worker)} turn ${Number(turn) + 1}`, async generation => {
      generation.update({ model, input: conversationShape(messages), metadata: meta });
      const response = await wrapped(generation, undefined);
      quietly(() => generation.update({
        output: discoveryTurnShape(response),
        usageDetails: usageDetails(response?.usage),
        metadata: { ...meta, stopReason: response?.stop_reason }
      }));
      return response;
    }, { asType: "generation" }), () => fn(), undefined);
}

/** One list_files or read_file call: its path and size, never its contents. */
export function traceTool(fields) {
  if (!live()) return;
  quietly(() => {
    const attrs = toolAttributes(fields);
    const { name, ...rest } = attrs;
    startObservation(name, { input: { path: rest.path }, output: rest }, { asType: "tool" }).end();
  });
}

/**
 * Something that happened: a question asked, an answer given, a validation failure, a
 * nudge, the final status. `name` is seaLeye's own label; attributes are cleaned and
 * masked.
 */
export function traceEvent(name, attrs = {}) {
  if (!live()) return;
  quietly(() => {
    startObservation(safeId(name), { input: eventAttributes(attrs) }, { asType: "event" });
  });
}

// ---------------------------------------------------------------------------------
// Scores: how a run turned out, posted against its trace.
//
// Scores are numbers and yes-or-no values only, from a fixed list, so nothing a model
// or a developer wrote can reach LangFuse this way. Each has a fixed id per trace, so
// reading the same outcome twice on the same day (running `status` again, say)
// replaces the score; LangFuse keys the replacement on id, name and date, so a re-read
// on a later day adds a copy with the same value.

const SCORES = {
  plan_valid_first_try: "BOOLEAN",
  validation_retries: "NUMERIC",
  questions_asked: "NUMERIC",
  developer_said_yes: "BOOLEAN",
  needs_refused: "BOOLEAN",
  // The run stopped at its spending cap (PHASE3-PLAN Step 3) rather than ending itself.
  spending_limit_reached: "BOOLEAN",
  deployment_succeeded: "BOOLEAN",
  // Only the interview regression set (scripts/eval-interview.js) posts these: they
  // compare a run's plan with what the sample app is known to need.
  outcome_correct: "BOOLEAN",
  modules_correct: "BOOLEAN",
  needs_correct: "BOOLEAN",
  // Only discovery's graded runs (scripts/eval-discovery.js, PHASE4-PLAN Step 7) post
  // these: a draft against Juniper Mutual's answer key.
  catalog_correct: "BOOLEAN",
  hard_cases_caught: "NUMERIC",
  self_test_passed: "BOOLEAN",
  must_refuse_refused: "BOOLEAN"
};

// Scores are sent one request each to LangFuse's public scores endpoint, with a hard
// time limit and no retries. LangFuse's own client retries with growing delays, which
// kept a finished `sealeye status` alive for a minute when LangFuse could not be
// reached; a command line tool should give up on a score rather than hang.
const pending = [];
let transport = null;

/**
 * Replace how requests reach LangFuse, for tests: `fn(method, path, body)` gets each
 * request and returns its parsed answer.
 */
export function useLangfuseTransport(fn) {
  transport = fn;
}

/**
 * One request to LangFuse's public API, given at most `timeoutMs`, with no retries.
 * Throws on any failure; callers that must never fail catch it.
 */
export async function langfuseRequest(method, apiPath, body, timeoutMs = 3000) {
  if (transport) return transport(method, apiPath, body);
  loadEnv();
  loadUserConfig();
  const base = (process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_BASEURL || "https://cloud.langfuse.com").replace(/\/+$/, "");
  const auth = Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString("base64");
  const res = await fetch(`${base}${apiPath}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`LangFuse answered ${res.status} to ${method} ${apiPath}`);
    err.status = res.status;
    throw err;
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

/**
 * Score a trace. Unknown names, malformed trace ids and values of the wrong kind are
 * dropped, not sent. Never throws.
 *
 * @returns {boolean} whether a score was queued
 */
export function scoreTrace(traceId, name, value) {
  const dataType = SCORES[name];
  if (!dataType || typeof traceId !== "string" || !/^[0-9a-f]{32}$/.test(traceId)) return false;

  let numeric;
  if (dataType === "BOOLEAN") {
    if (typeof value !== "boolean") return false;
    numeric = value ? 1 : 0;
  } else {
    if (!Number.isFinite(value)) return false;
    numeric = value;
  }

  if (!transport && !tracingConfigured()) return false;

  pending.push({ id: `${traceId}-${name}`, traceId, name, value: numeric, dataType });
  return true;
}

/**
 * Score a deployment's outcome against the interview that produced it, if it came from
 * one. Status is real here as everywhere: only a final status the platform read from
 * AWS is scored. Anything else, including a deployment nobody has looked at since, gets
 * no score rather than a guess.
 */
export function scoreDeploymentOutcome(deployment) {
  const traceId = deployment?.origin?.traceId;
  if (deployment?.status === "succeeded") return scoreTrace(traceId, "deployment_succeeded", true);
  if (deployment?.status === "failed") return scoreTrace(traceId, "deployment_succeeded", false);
  return false;
}

/** Send queued scores, each given at most `timeoutMs`. Never throws. */
export async function flushScores(timeoutMs = 3000) {
  const batch = pending.splice(0);
  if (!batch.length) return;
  const results = await Promise.allSettled(batch.map(body => langfuseRequest("POST", "/api/public/scores", body, timeoutMs)));
  for (const r of results) if (r.status === "rejected") debug("could not send a score", r.reason);
}

// ---------------------------------------------------------------------------------
// Keeping tracing out of the way.

/**
 * Run `fn` inside a traced wrapper so that the wrapper can never change the outcome:
 * if tracing fails before `fn` starts, `fn` runs untraced; if it fails after `fn`
 * finished, `fn`'s result stands; if `fn` throws, that error is what the caller gets.
 */
async function guarded(runTraced, fn, noop) {
  let started = false;
  let finished = false;
  let failed = false;
  let value;
  let error;

  const wrapped = async (span, handle) => {
    started = true;
    try {
      value = await fn(handle);
      return value;
    } catch (err) {
      failed = true;
      error = err;
      quietly(() => span.update({ level: "ERROR", statusMessage: err?.name || "Error" }));
      throw err;
    } finally {
      finished = true;
    }
  };

  try {
    await runTraced(wrapped);
  } catch (err) {
    if (failed) throw error;
    if (!started) {
      debug("tracing failed before the work started; running it untraced", err);
      return fn(noop);
    }
    if (finished) {
      debug("tracing failed after the work finished", err);
      return value;
    }
    throw err;
  }
  return value;
}

function quietly(action) {
  try {
    action();
  } catch (err) {
    debug("tracing call failed", err);
  }
}

/** Ids and names LangFuse does not mask, kept to a safe alphabet. */
function safeId(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9._@ -]/g, "-").slice(0, 100);
}

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
}

function debug(what, err) {
  if (setting("DEBUG")) console.error(`  [debug] ${what}: ${err?.message || err}`);
}
