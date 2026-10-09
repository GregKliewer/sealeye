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
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { configureGlobalLogger, LogLevel } from "@langfuse/core";
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
const TOOL_NAMES = new Set(["list_files", "read_file", "submit_plan"]);

let provider = null;

// ---------------------------------------------------------------------------------
// Masking: the backstop.

const SECRET_PATTERNS = [
  // Private key blocks, including one cut off by the 20 KB read limit.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, () => REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, () => REDACTED],              // AWS access key ids
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, () => REDACTED],                   // Anthropic keys
  [/sk-lf-[A-Za-z0-9_-]{8,}/g, () => REDACTED],                    // LangFuse secret keys
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g, () => `Bearer ${REDACTED}`],
  // NAME=value where the name says it is a secret. The name stays; the value goes.
  [
    /\b((?:export\s+)?[A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Za-z0-9_]*\s*=\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;]+)/gi,
    (match, name, value) => (value.startsWith("[value") ? match : `${name}${REDACTED}`)
  ]
];

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

/** A short, stable id for a prompt file's content: which prompt a run used. */
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

/** True once startTracing has succeeded. */
export function tracingActive() {
  return provider !== null;
}

/**
 * Start tracing for this process, if LangFuse is configured. Safe to call more than
 * once. `exporter` replaces the network exporter, for tests.
 *
 * @returns {boolean} whether tracing is on
 */
export function startTracing({ exporter } = {}) {
  if (provider) return true;
  try {
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
  if (!provider) return undefined;
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
export function traceRun({ app, mode, model, promptSha, user }, fn) {
  const noop = { set() {}, traceId: undefined };
  if (!provider) return fn(noop);

  const outcome = {};
  return guarded(wrapped =>
    startActiveObservation("sealeye run", async span => {
      span.update({ metadata: eventAttributes({ app, mode, model, promptSha }) });
      const handle = {
        traceId: currentTraceId(),
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
    }, { asType: "agent" }), fn, noop);
}

/**
 * One model call, as a generation. `fn(turn)` makes the call and returns the response;
 * `turn.retried(err)` records a retry on the same turn. The input recorded is the shape
 * of `messages`, never their contents.
 */
export function traceTurn({ turn, model, messages }, fn) {
  const noop = { retried() {} };
  if (!provider) return fn(noop);

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

/** One list_files or read_file call: its path and size, never its contents. */
export function traceTool(fields) {
  if (!provider) return;
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
  if (!provider) return;
  quietly(() => {
    startObservation(safeId(name), { input: eventAttributes(attrs) }, { asType: "event" });
  });
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
