// api/interview/model.js
// Talking to the model: the client, the system prompt, one turn retried once, and
// reading what a turn said. The graph (graph.js) decides what happens between turns.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import Anthropic from "@anthropic-ai/sdk";

import { catalogForPrompt, interviewPassages, orgName, starterCatalog } from "../../core/catalog.js";
import { repoRoot, loadEnv, loadUserConfig, setting } from "../../core/config.js";
import { traceTurn } from "../../core/tracing.js";
import { spendingLimitWords } from "../../core/model-prices.js";

// The Sonnet id from the Day 1 curl test. Overridable, because the id is the one
// thing here that changes without the platform changing.
export const DEFAULT_MODEL = "claude-sonnet-5";

export const MAX_TOKENS = 16000;
// How long to wait for the model to start answering: 120 s, retried once. Its reply is
// streamed (`askModel`), so a long reply is not cut off by this: once it has started,
// what ends it is silence (IDLE_MS), not length (Greg, Oct 16, 2026, after a plan
// against Juniper Mutual's catalog took longer than two minutes to write, every time).
const TIMEOUT_MS = 120_000;
// How long the model may go quiet in the middle of a reply before the turn is given up
// and retried. A streamed reply sends something every few seconds while it is working.
export const IDLE_MS = 60_000;
// What the retry calls a long wait. A dropped connection comes back in well under a
// second, so a retry after this much silence is worth saying out loud.
const SLOW_MS = 30_000;

const COMMAND = "sealeye";

/**
 * Sampling parameters were removed on Sonnet 5 and the rest of the current
 * generation: sending temperature returns a 400. CLAUDE.md asks for temperature 0.2,
 * so it is still sent to any older id that accepts it.
 */
export function supportsTemperature(model) {
  return !/(sonnet-5|opus-5|opus-4-[78]|fable-5|mythos-5)/.test(model);
}

/** The API's ANTHROPIC_API_KEY, from the environment, the repo .env, or ~/.sealeye/config. */
export function resolveApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  loadEnv();
  loadUserConfig();
  return process.env.ANTHROPIC_API_KEY || null;
}

/** An Anthropic client that never resolves a credential of its own: the gateway holds it. */
class GatewayClient extends Anthropic {
  _shouldResolveDefaultCredentials() {
    return false;
  }
}

/** The header the platform's own gateway reads the API's key from (deploy/gateway.yaml). */
export const GATEWAY_KEY_HEADER = "x-sealeye-gateway-key";

/**
 * What the API calls the model with, or null when it has nothing to call it with.
 *
 * With SEALEYE_MODEL_URL and SEALEYE_GATEWAY_KEY both set, the API talks to the
 * platform's own gateway (deploy/gateway.yaml), which holds the model key: the API sends
 * only its key for the gateway, never a model key, even if it has one (DESIGN.md, "The
 * model gateway on the server"). Otherwise it uses ANTHROPIC_API_KEY, as before, sent
 * to SEALEYE_MODEL_URL when that is set (an organization's own gateway that takes one).
 *
 * @returns {{ gatewayKey: string } | { apiKey: string } | null}
 */
export function modelCredential() {
  const gatewayKey = setting("GATEWAY_KEY");
  if (gatewayKey && setting("MODEL_URL")) return { gatewayKey };
  const apiKey = resolveApiKey();
  return apiKey ? { apiKey } : null;
}

/**
 * The Anthropic client the interview talks to.
 *
 * SEALEYE_MODEL_URL, when set, is where every model call goes instead of Anthropic's
 * own address. An organization that sends model traffic through its own AI gateway
 * (often to Claude on Bedrock in its own AWS account) points this at the gateway, and
 * seaLeye needs no route of its own to api.anthropic.com. Unset changes nothing.
 * The SDK's own retries are off: one retry, announced, beats three silent ones.
 *
 * @param credential what `modelCredential()` returned, or an Anthropic key on its own
 */
export function modelClient(credential) {
  const baseURL = setting("MODEL_URL");
  const options = { timeout: TIMEOUT_MS, maxRetries: 0, fetch: watchedFetch(), ...(baseURL ? { baseURL } : {}) };
  if (credential && typeof credential === "object" && credential.gatewayKey) {
    // No model credential at all. `apiKey: null` and `authToken: null` keep the SDK
    // from reading ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN; GatewayClient keeps it from
    // looking for any other credential (a profile, a config file, a token exchange);
    // the null headers tell it none is meant, and win over ANTHROPIC_CUSTOM_HEADERS.
    // The log level is fixed because the SDK's debug log masks the model's own key
    // headers, not the gateway's.
    return new GatewayClient({
      ...options,
      apiKey: null,
      authToken: null,
      logLevel: "warn",
      defaultHeaders: { [GATEWAY_KEY_HEADER]: credential.gatewayKey, "x-api-key": null, authorization: null }
    });
  }
  const apiKey = typeof credential === "string" ? credential : credential?.apiKey;
  return new Anthropic({ ...options, apiKey });
}

/**
 * The system prompt, read from the platform's own copy, never from the developer's
 * folder.
 *
 * The catalog is substituted in rather than written out twice: a module described in
 * two places eventually says two different things. Since PHASE4-PLAN Step 3 it is the
 * interview's catalog, the organization's live one when it started, with the passages
 * that speak of its modules (interviewPassages in core/catalog.js); the starter's are
 * the prompt exactly as it was before. The organization's name comes from
 * the platform's config, because whose platform library this is was never ours to hard
 * code.
 */
export function loadSystemPrompt(catalog, { starter = catalog === undefined } = {}) {
  const doc = catalog || starterCatalog();
  let text = fs.readFileSync(path.join(repoRoot, "prompts", "interview-system.md"), "utf8");
  // The passages that speak of the modules are the catalog's (PHASE4-PLAN Step 3). One
  // the catalog has nothing for goes, with its line, rather than leaving a gap.
  const org = orgName();
  const passages = interviewPassages(doc, { starter });
  for (const [name, value] of Object.entries(passages)) {
    if (value) continue;
    const mark = `{{${name}}}`;
    text = text.split(`${mark}\n\n`).join("").split(`${mark}\n`).join("").split(mark).join("");
  }
  // Every {{name}} filled in one pass over the template, so nothing put in is read again:
  // a {{name}} inside a catalog's own words is never filled, and never filled twice. A
  // passage may say {{org}} (catalogProblems allows that and no other), filled first.
  const values = {
    ...Object.fromEntries(Object.entries(passages).map(([k, v]) => [k, String(v).split("{{org}}").join(org)])),
    catalog: catalogForPrompt(doc),
    org
  };
  return text.replace(/\{\{([a-z_]+)\}\}/g, (mark, name) => (Object.hasOwn(values, name) ? values[name] : mark));
}

/**
 * A plan in the shape the model writes one: 0.4, with no catalog. A plan deployed since
 * Oct 15, 2026 is 0.5 and names its catalog, which the model's tool does not have and
 * the platform fills in itself; shown as it is, the model could copy them back and have
 * its plan refused.
 */
export function asTheModelWritesIt(plan) {
  if (!plan || typeof plan !== "object" || plan.planVersion !== "0.5") return plan;
  const { catalog, ...rest } = plan;
  return { ...rest, planVersion: "0.4" };
}

/** The plan the live environment was built from, for the first message. */
export function deployedContext(plan) {
  if (!plan) return "";
  return [
    "This app already has a live environment with this plan:",
    "",
    JSON.stringify(asTheModelWritesIt(plan), null, 2),
    "",
    "This run updates that environment rather than creating a second one."
  ].join("\n");
}

/** Every text block in an assistant turn, joined. */
export function textOf(content) {
  return (content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n")
    .trim();
}

/**
 * A turn with a question mark in it is a question for the developer.
 *
 * Not "ends with ?": seen on Sept 21, the model asked "does your app read any other
 * settings from the environment? (Not counting the port, that one is handled
 * automatically.)" and a trailing-character test read that as the interview stopping.
 * Mistaking a stop for a question costs one odd looking prompt; mistaking a question
 * for a stop ends the interview in silence, which is worse.
 */
export function isQuestion(text) {
  return text.includes("?");
}

/**
 * Split an assistant turn into the line to ask and whatever it said first, so the
 * question can be shown as one prompt line with its context above it.
 *
 * A turn that came back as one paragraph used to go entirely into the prompt, because
 * there was no line to split on. So a paragraph is split at its question's sentence,
 * and the lead shows above it where it belongs.
 */
export function splitQuestion(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

  if (lines.length > 1) {
    // The question is the last line that has the question mark in it; anything above it
    // is what the platform found, and anything below is part of the same ask.
    const last = lines.reduce((found, line, index) => (line.includes("?") ? index : found), lines.length - 1);
    return { question: lines.slice(last).join(" ") || text, lead: lines.slice(0, last) };
  }

  const whole = lines[0] || text.trim();
  // The FIRST question mark, not the last. The prompt allows one per turn, and when
  // the model sends two anyway, splitting at the last one would leave a question
  // sitting in the lead. With one question mark the two choices are the same split.
  const mark = whole.indexOf("?");
  if (mark === -1) return { question: whole || text, lead: [] };

  // Where the sentence carrying that question mark begins. Anything after the mark
  // belongs to it too: "...from the environment? (Not counting the port.)" is one ask.
  const before = whole.slice(0, mark);
  const boundary = Math.max(before.lastIndexOf(". "), before.lastIndexOf("? "), before.lastIndexOf("! "));
  const start = boundary === -1 ? 0 : boundary + 2;
  const lead = whole.slice(0, start).trim();

  return { question: whole.slice(start).trim() || whole, lead: lead ? [lead] : [] };
}

/** An error a client can show as one sentence, with no stack and no JSON. */
export function userFacing(message, cause) {
  const err = new Error(message);
  err.userFacing = true;
  if (cause) err.cause = cause;
  return err;
}

/**
 * The platform's gateway refused the call because its money budget for the period is
 * spent (deploy/gateway.yaml). It answers 429 like a busy model, but waiting a moment
 * does not help, so it is never retried and never called busy.
 */
export function isBudgetSpent(err) {
  return err?.status === 429 && err?.error?.error?.code === "budget_exceeded";
}

/**
 * The platform's gateway refused the call because this run has used its tokens for the
 * day (deploy/gateway.yaml, the per-run limit). Waiting does not help this run, so it is
 * never retried. The gateway adds x-ratelimit-* headers to every reply it lets through,
 * Anthropic's own 429 included, so those alone do not tell them apart. Only the
 * gateway's own refusal is plain text (the SDK finds no error object in it) and carries
 * no Anthropic request id.
 */
export function isRunLimitReached(err) {
  return (
    err?.status === 429 &&
    !isBudgetSpent(err) &&
    !err?.error &&
    !err?.headers?.get?.("request-id") &&
    Boolean(err?.headers?.get?.("x-ratelimit-limit"))
  );
}

/** A timeout, a dropped connection, a rate limit or a server fault is worth one retry. */
function isRetryable(err) {
  if (isBudgetSpent(err) || isRunLimitReached(err)) return false;
  if (err instanceof Anthropic.APIConnectionError) return true;   // timeouts included
  const status = err?.status;
  return status === 408 || status === 429 || (typeof status === "number" && status >= 500);
}

/** Whatever the SDK threw, as one sentence a developer can act on. */
function asUserFacing(err) {
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return userFacing(`The model did not answer in time twice, so seaLeye.run stopped. Run ${COMMAND} run again.`, err);
  }

  if (err instanceof Anthropic.APIConnectionError) {
    return userFacing(
      `The seaLeye API could not reach the model that does the interview. Run ${COMMAND} run again, and if it keeps happening, tell whoever runs the API.`,
      err
    );
  }

  // The key is the platform's now, not the developer's, so the fix is theirs too.
  if (err?.status === 401 || err?.status === 403) {
    return userFacing("The seaLeye API's credentials for the model were refused. Tell whoever runs the API.", err);
  }

  if (isBudgetSpent(err)) {
    return userFacing(
      "seaLeye has used its model budget for this period, so the interview stopped. Nothing was written to your folder and nothing was built. Tell whoever runs the API.",
      err
    );
  }

  // The same words as the run's own cap: to the developer it is one limit. The reason
  // lets the graph end the run as the cap does, stopped rather than failed.
  if (isRunLimitReached(err)) {
    const stopped = userFacing(spendingLimitWords(COMMAND), err);
    stopped.reason = "spending_limit";
    return stopped;
  }

  if (err?.status === 429) {
    return userFacing(`The model is busy right now. Wait a moment, then run ${COMMAND} run again.`, err);
  }

  // An APIError's own message is the whole JSON body, which is not a sentence. The
  // body carries the human one, so use that when it is there.
  const reason = String(err?.error?.error?.message || err?.message || "no reason given").replace(/\s+/g, " ").trim();
  return userFacing(`seaLeye.run could not finish the interview: ${reason}`, err);
}

/**
 * One model turn, retried once. Anything the retry does not fix comes back as a
 * sentence rather than a stack. One generation in the trace per turn, retry included;
 * the trace sees the shape of the conversation, never its contents (core/tracing.js).
 */
/**
 * One model call, its reply streamed and returned whole, as `messages.create` would
 * return it. Streamed so a long reply is never cut off by a limit on the whole call: it
 * is given up only when the model goes quiet for IDLE_MS, as a timeout, which is
 * retried like any other. A client without `messages.stream` (a test's stand-in) is
 * called the old way.
 */
export async function askModel(client, params, { idleMs = IDLE_MS, startMs = TIMEOUT_MS } = {}) {
  if (typeof client?.messages?.stream !== "function") return client.messages.create(params);
  const controller = new AbortController();
  let quiet = null;
  let timer;
  const wait = (ms = idleMs) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      quiet = ms;
      controller.abort();
    }, ms);
  };
  // Until the reply starts, the longer wait; after that, silence.
  wait(startMs);
  const id = crypto.randomUUID();
  watchers.set(id, () => wait());
  try {
    const stream = client.messages.stream(params, { signal: controller.signal, headers: { [WATCH_HEADER]: id } });
    // A client without watchedFetch (a test's own) is watched by the SDK's events only.
    stream.on("streamEvent", () => wait());
    return await stream.finalMessage();
  } catch (err) {
    if (quiet !== null) throw new Anthropic.APIConnectionTimeoutError({ message: `the model sent nothing for ${Math.round(quiet / 1000)} s` });
    throw err;
  } finally {
    clearTimeout(timer);
    watchers.delete(id);
  }
}

// What counts as the model still answering is every byte that arrives, not only the
// events the SDK passes on. While the model thinks before it writes, the model API
// keeps the connection alive with ping events, which the SDK drops without a word, so a
// model thinking for a minute looked silent and was given up (Greg's run, Oct 16, 2026,
// Juniper's payment events processor: "the model sent nothing for 60 s", twice).
const WATCH_HEADER = "x-sealeye-watch";
const watchers = new Map();

/**
 * The fetch the model client uses: a call askModel marks (WATCH_HEADER, never sent on)
 * tells it each time bytes arrive. Any other call is fetched as it is.
 */
export function watchedFetch(base = globalThis.fetch) {
  return async (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    const id = headers.get(WATCH_HEADER);
    if (!id) return base(url, init);
    headers.delete(WATCH_HEADER);
    const res = await base(url, { ...init, headers });
    const tick = watchers.get(id);
    if (!tick || !res.body) return res;
    tick();
    const reader = res.body.getReader();
    const body = new ReadableStream({
      async pull(out) {
        const { done, value } = await reader.read();
        if (done) return out.close();
        tick();
        out.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      }
    });
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

export async function createWithOneRetry(client, params, onStep, turn = 0, { traceAs = "interview", idleMs = IDLE_MS } = {}) {
  // Discovery records its own generation, with no reply in it (core/tracing.js,
  // traceDiscoveryCall), so the interview's, which records the model's text, is not made.
  const traced = traceAs === "interview"
    ? fn => traceTurn({ turn, model: params.model, messages: params.messages }, fn)
    : fn => fn({ retried() {} });
  return traced(async traced => {
    const startedAt = Date.now();
    try {
      return await askModel(client, params, { idleMs });
    } catch (err) {
      if (!isRetryable(err)) throw asUserFacing(err);
      traced.retried(err);

      // A rate limit or a dropped connection comes back in well under a second. Saying
      // that is taking longer than it should while it plainly has not is how a platform
      // loses the room, so the alarming sentence waits until it is true.
      onStep(
        Date.now() - startedAt >= SLOW_MS
          ? "That is taking longer than it should, trying once more"
          : "Still waiting on an answer, asking again"
      );
      if (setting("DEBUG")) {
        console.error(`  [debug] retrying after ${err?.name || "error"}${err?.status ? ` ${err.status}` : ""}: ${err?.message || ""}`);
      }

      try {
        return await askModel(client, params, { idleMs });
      } catch (retryErr) {
        throw asUserFacing(retryErr);
      }
    }
  });
}

/**
 * One line per model turn, on the API's stderr, only with SEALEYE_DEBUG set: "why did
 * that take 45 seconds" is a question to answer with the turn's own numbers.
 */
export function debugTurn({ turn, endedIn, ms, usage, textChars }) {
  if (!setting("DEBUG")) return;

  const u = usage || {};
  const parts = [
    `turn ${String(turn + 1).padStart(2)}`,
    String(endedIn).padEnd(14),
    `${(ms / 1000).toFixed(1)}s`.padStart(6),
    `in ${String(u.input_tokens ?? 0).padStart(6)}`,
    `out ${String(u.output_tokens ?? 0).padStart(5)}`
  ];
  if (textChars) parts.push(`text ${textChars}c`);
  if (u.cache_creation_input_tokens) parts.push(`cache write ${u.cache_creation_input_tokens}`);
  if (u.cache_read_input_tokens) parts.push(`cache read ${u.cache_read_input_tokens}`);

  console.error(`  [debug] ${parts.join("  ")}`);
}

/** What a turn turned out to be, for the debug line. */
export function turnEndedIn(response) {
  const toolUses = response.content.filter(b => b.type === "tool_use");
  if (toolUses.some(u => u.name === "submit_plan")) return "submit_plan";
  if (toolUses.length) return toolUses.map(u => u.name).join("+");
  const text = textOf(response.content);
  return text && isQuestion(text) ? "question" : "stop";
}

/**
 * What the trace records about one list_files or read_file call: the path, the size
 * of what came back and any refusal, never the contents themselves.
 */
export function toolRecord(use, content, isError) {
  const text = String(content ?? "");
  const record = { name: use.name, path: typeof use.input?.path === "string" ? use.input.path : "." };
  if (isError) return { ...record, refused: text.replace(/^refused: /, "") };
  if (use.name === "list_files") return { ...record, entries: text ? text.split("\n").length : 0 };
  return { ...record, bytes: Buffer.byteLength(text), truncated: /\(truncated at \d+ KB\)$/.test(text) };
}
