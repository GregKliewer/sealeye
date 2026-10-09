// src/interview/loop.js
// The `sealeye run` interview: the model looks at the developer's folder, asks at
// most four questions, and submits a planVersion 0.4 plan.
//
// The loop is written by hand rather than handed to the SDK tool runner because two
// of the three tools are not code: a question goes to a human at a terminal, and
// submit_plan ends the conversation only if the platform API says the plan is valid.
import fs from "node:fs";
import path from "node:path";

import Anthropic from "@anthropic-ai/sdk";

import { validatePlan } from "../client.js";
import { product, spinner } from "../brand.js";
import { catalogForPrompt, orgName } from "../../core/catalog.js";
import { repoRoot, loadEnv, loadUserConfig, setting, USER_CONFIG_HINT } from "../../core/config.js";
import { promptVersion, scoreTrace, traceEvent, traceRun, traceStep, traceTool, traceTurn } from "../../core/tracing.js";
import { submitPlanTool, splitSubmission } from "./schema.js";
import { listFilesTool, readFileTool, runTool, folderDigest } from "./tools.js";

// The Sonnet id from the Day 1 curl test. Overridable, because the id is the one
// thing here that changes without the platform changing.
export const DEFAULT_MODEL = "claude-sonnet-5";

const MAX_QUESTIONS = 4;       // the interview rule
const MAX_VALIDATION_RETRIES = 2;
const MAX_TURNS = 24;          // a stuck conversation stops instead of spending
const MAX_TOKENS = 16000;
// The SDK's default is ten minutes, which is not a demo. A turn that writes a whole
// plan after a correction is the slowest one, so leave room for it: 120 s, retried
// once, is still inside the five minute budget.
const TIMEOUT_MS = 120_000;
// What the retry calls a long wait. A dropped connection comes back in well under a
// second, so a retry after this much silence is worth saying out loud.
const SLOW_MS = 30_000;

// What the spinner calls a long wait, which is a different question. A plan-writing
// turn measured 25 to 45 seconds on healthy runs, so warning at 30 fired on runs where
// nothing was wrong and told the room the product was slow. This is past every healthy
// turn measured and still well inside the 120 second timeout.
const SPINNER_WARN_MS = 75_000;
const STILL_WORKING = "Still working on it";

// A line naming a file is true while the file is being read and stops being true a
// moment later: the model has the contents and is thinking about them. After this
// long, the spinner says what is happening now instead of what has already finished.
const THINKING_AFTER_MS = 3_000;
const NAMES_A_FILE = /^(Reading |Looking at |Nothing to read at )/;

/**
 * Sampling parameters were removed on Sonnet 5 and the rest of the current
 * generation: sending temperature returns a 400. CLAUDE.md asks for temperature 0.2,
 * so it is still sent to any older id that accepts it.
 */
function supportsTemperature(model) {
  return !/(sonnet-5|opus-5|opus-4-[78]|fable-5|mythos-5)/.test(model);
}

/** ANTHROPIC_API_KEY from the environment, the repo .env, or ~/.sealeye/config. */
export function resolveApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  loadEnv();
  loadUserConfig();
  return process.env.ANTHROPIC_API_KEY || null;
}

/**
 * The system prompt, read relative to the CLI, never to the developer's folder.
 *
 * The catalog is substituted in rather than written out twice: a module described in
 * two places eventually says two different things, and the one the developer hears
 * would be the copy nobody updated. The organization's name comes from the developer's
 * own config, because whose platform library this is was never ours to hard code.
 */
export function loadSystemPrompt() {
  const text = fs.readFileSync(path.join(repoRoot, "prompts", "interview-system.md"), "utf8");

  return text.split("{{catalog}}").join(catalogForPrompt()).split("{{org}}").join(orgName());
}

/** The plan the live environment was built from, for the first message. */
function deployedContext(plan) {
  if (!plan) return "";

  return [
    "This app already has a live environment with this plan:",
    "",
    JSON.stringify(plan, null, 2),
    "",
    "This run updates that environment rather than creating a second one."
  ].join("\n");
}

/** Every text block in an assistant turn, joined. */
function textOf(content) {
  return content
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
function isQuestion(text) {
  return text.includes("?");
}

/**
 * Split an assistant turn into the line to ask and whatever it said first, so the
 * question can be printed as one amber prompt line with its context above it.
 *
 * A turn that came back as one paragraph used to go entirely into the amber, because
 * there was no line to split on: seven lines of prompt colour, most of it not a
 * question. So a paragraph is split at its last sentence instead, and the lead prints
 * in grey where it belongs.
 */
function splitQuestion(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

  if (lines.length > 1) {
    // The question is the last line that has the question mark in it; anything above it
    // is what the platform found, and anything below is part of the same ask.
    const last = lines.reduce((found, line, index) => (line.includes("?") ? index : found), lines.length - 1);

    return {
      question: lines.slice(last).join(" ") || text,
      lead: lines.slice(0, last)
    };
  }

  const whole = lines[0] || text.trim();
  // The FIRST question mark, not the last. The prompt allows one per turn, and when
  // the model sends two anyway, splitting at the last one would leave a question
  // sitting in the grey lead, which is the thing this is here to prevent. With one
  // question mark the two choices are the same split.
  const mark = whole.indexOf("?");
  if (mark === -1) return { question: whole || text, lead: [] };

  // Where the sentence carrying that question mark begins. Anything after the mark
  // belongs to it too: "...from the environment? (Not counting the port.)" is one ask.
  const before = whole.slice(0, mark);
  const boundary = Math.max(before.lastIndexOf(". "), before.lastIndexOf("? "), before.lastIndexOf("! "));
  const start = boundary === -1 ? 0 : boundary + 2;

  const lead = whole.slice(0, start).trim();

  return {
    question: whole.slice(start).trim() || whole,
    lead: lead ? [lead] : []
  };
}

/** An error the CLI can print as one sentence, with no stack and no JSON. */
function userFacing(message, cause) {
  const err = new Error(message);
  err.userFacing = true;
  if (cause) err.cause = cause;
  return err;
}

/** A timeout, a dropped connection, a rate limit or a server fault is worth one retry. */
function isRetryable(err) {
  if (err instanceof Anthropic.APIConnectionError) return true;   // timeouts included
  const status = err?.status;
  return status === 408 || status === 429 || (typeof status === "number" && status >= 500);
}

/** Whatever the SDK threw, as one sentence the developer can act on. */
function asUserFacing(err) {
  // A timeout and a refused connection need different advice, so they get different
  // sentences.
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return userFacing(
      `The model did not answer in time twice, so seaLeye.run stopped. Run ${product.command} run again.`,
      err
    );
  }

  if (err instanceof Anthropic.APIConnectionError) {
    return userFacing(
      `seaLeye.run could not reach the model that does the interview. Check your connection, then run ${product.command} run again.`,
      err
    );
  }

  if (err?.status === 401 || err?.status === 403) {
    return userFacing("The ANTHROPIC_API_KEY seaLeye.run is using was refused.", err);
  }

  if (err?.status === 429) {
    return userFacing(`That account is being rate limited. Wait a moment, then run ${product.command} run again.`, err);
  }

  // An APIError's own message is the whole JSON body, which is not a sentence. The
  // body carries the human one, so use that when it is there.
  const reason = String(err?.error?.error?.message || err?.message || "no reason given")
    .replace(/\s+/g, " ")
    .trim();

  return userFacing(`seaLeye.run could not finish the interview: ${reason}`, err);
}

/**
 * One model turn, retried once. Anything the retry does not fix comes back as a
 * sentence rather than a stack: the developer cannot fix an SDK trace.
 */
async function createWithOneRetry(client, params, onStep, turn = 0) {
  // One generation in the trace per turn, retry included, so a slow turn can be
  // explained from the trace the way debugTurn explains it on stderr. The trace sees
  // the shape of the conversation, never its contents (core/tracing.js).
  return traceTurn({ turn, model: params.model, messages: params.messages }, traced =>
    createOnce(client, params, onStep, traced)
  );
}

async function createOnce(client, params, onStep, traced) {
  const startedAt = Date.now();

  try {
    return await client.messages.create(params);
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
      return await client.messages.create(params);
    } catch (retryErr) {
      throw asUserFacing(retryErr);
    }
  }
}

/**
 * One line per model turn, on stderr so it never reaches a transcript or --json
 * output. Only with SEALEYE_DEBUG set: "why did that take 45 seconds" is a question
 * to answer with the turn's own numbers rather than a guess about them.
 */
function debugTurn({ turn, endedIn, ms, usage, textChars }) {
  if (!setting("DEBUG")) return;

  const u = usage || {};
  const parts = [
    `turn ${String(turn + 1).padStart(2)}`,
    String(endedIn).padEnd(14),
    `${(ms / 1000).toFixed(1)}s`.padStart(6),
    `in ${String(u.input_tokens ?? 0).padStart(6)}`,
    `out ${String(u.output_tokens ?? 0).padStart(5)}`
  ];

  // A turn that ends in a tool call can still write prose first, and prose written
  // before a tool call is never shown to anyone: the CLI reads the tool input and
  // drops the text. It is still generated, and generation is what the wait is made of,
  // so it is worth being able to see how much of a slow turn went into it.
  if (textChars) parts.push(`text ${textChars}c`);

  if (u.cache_creation_input_tokens) parts.push(`cache write ${u.cache_creation_input_tokens}`);
  if (u.cache_read_input_tokens) parts.push(`cache read ${u.cache_read_input_tokens}`);

  console.error(`  [debug] ${parts.join("  ")}`);
}

/** What a turn turned out to be, for the debug line. */
function turnEndedIn(response) {
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
function toolRecord(use, content, isError) {
  const text = String(content ?? "");
  const record = { name: use.name, path: typeof use.input?.path === "string" ? use.input.path : "." };
  if (isError) return { ...record, refused: text.replace(/^refused: /, "") };
  if (use.name === "list_files") return { ...record, entries: text ? text.split("\n").length : 0 };
  return { ...record, bytes: Buffer.byteLength(text), truncated: /\(truncated at \d+ KB\)$/.test(text) };
}

/**
 * Run the interview.
 *
 * @param {object}   options
 * @param {string}   options.appPath     the developer's folder, read only
 * @param {object}   [options.deployed]  the plan the live environment was built from,
 *                                       when this app has one. It is context, not an
 *                                       instruction: the folder still decides.
 * @param {string}   options.apiBaseUrl  the platform API, for plan validation
 * @param {function} options.ask         (question, lead[]) => Promise<string>, one line from the terminal
 * @param {function} options.onStep      (line) => void, one plain-language line of what the platform is doing
 * @param {string}   [options.user]      who is running it, for the trace (requestedBy's user)
 * @param {object}   [options.client]    an Anthropic client; tests pass a scripted one
 * @returns {Promise<{status: "submitted"|"stopped"|"invalid", plan?, summary?, assumptions?, questions?, message?, errors?, traceId?}>}
 */
export async function runInterview({
  appPath,
  apiBaseUrl,
  deployed = null,
  ask,
  onStep = () => {},
  model = setting("MODEL") || DEFAULT_MODEL,
  user,
  client
}) {
  if (!client) {
    const apiKey = resolveApiKey();
    if (!apiKey) {
      throw userFacing(
        `ANTHROPIC_API_KEY is not set, so put it in your environment or in ${USER_CONFIG_HINT} and run ${product.command} run again.`
      );
    }

    // The SDK's own retries are off: one retry, announced, beats three silent ones in
    // front of an audience.
    client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 0 });
  }

  // One trace per run, when LangFuse is configured. The session is the app's name, so
  // every run of one app lines up; the prompt is recorded by version, never by text.
  // The trace id comes back with the result, so a deployment can be joined to the
  // interview that produced it.
  return traceRun(
    {
      app: path.basename(path.resolve(appPath)),
      mode: deployed ? "re-run" : "first run",
      model,
      promptSha: promptVersion(),
      user
    },
    async run => {
      const result = await interview({ appPath, apiBaseUrl, deployed, ask, onStep, model, client });
      run.set({ status: result.status, questions: result.questions ?? 0 });
      scoreInterview(run.traceId, result);
      return run.traceId ? { ...result, traceId: run.traceId } : result;
    }
  );
}

/**
 * The interview's own scores. A plan's scores exist only when a plan reached the
 * contract check; a run that stopped before that has only its question count.
 */
function scoreInterview(traceId, result) {
  if (!traceId) return;
  scoreTrace(traceId, "questions_asked", result.questions ?? 0);
  if (Number.isFinite(result.validationRetries)) {
    scoreTrace(traceId, "plan_valid_first_try", result.status === "submitted" && result.validationRetries === 0);
    scoreTrace(traceId, "validation_retries", result.validationRetries);
  }
}

/** The conversation itself. runInterview owns the client and the trace around it. */
async function interview({ appPath, apiBaseUrl, deployed, ask, onStep, model, client }) {
  // The system prompt and the tool schemas are the same several thousand tokens on
  // every turn of a run, and a run is a dozen turns. One cache breakpoint on the
  // system block covers the tools too, since they sit in front of it in the prompt,
  // so everything fixed is written once and read back on every turn after.
  const system = [{ type: "text", text: loadSystemPrompt(), cache_control: { type: "ephemeral" } }];
  const tools = [listFilesTool, readFileTool, submitPlanTool];

  // The digest first, then what is already running. A redeploy that re-asks what the
  // live environment already answers is asking the developer to do the platform's
  // remembering.
  const messages = [{ role: "user", content: [folderDigest(appPath), deployedContext(deployed)].filter(Boolean).join("\n\n") }];

  let questions = 0;
  let validationRetries = 0;
  let nudged = false;

  // Every await in this loop is a model round-trip, and each one was six to ten
  // seconds of nothing on the screen. A spinner holds the line until the next real
  // line lands on top of it.
  let waiting = null;
  let lastLine = "reading your app";   // the first turn, before the platform has said anything

  let slowTimer = null;
  let thinkingTimer = null;

  // A redeploy is working out what moved; a first run is working out what the app
  // needs at all. Either way it is what the model is actually doing once the reading
  // has stopped, which is what the line has to be true about.
  const thinkingLabel = deployed ? "Working out what changed" : "Working out what your app needs";

  const startWaiting = () => {
    waiting = spinner(lastLine);

    // A label that names a file goes stale the moment the read finishes. On a redeploy
    // the model often reads its way to a plan without asking anything, so this was the
    // line that sat there saying "Reading sealeye.yaml 40s" with nothing being read.
    if (NAMES_A_FILE.test(lastLine)) {
      thinkingTimer = setTimeout(() => {
        if (waiting) waiting.label(thinkingLabel, { keepCount: true });
      }, THINKING_AFTER_MS);
      thinkingTimer.unref();
    }

    // The words change, the count does not: the developer is owed the whole wait, not
    // the part of it that has been worrying.
    slowTimer = setTimeout(() => {
      if (waiting) waiting.label(STILL_WORKING, { keepCount: true });
    }, SPINNER_WARN_MS);
    slowTimer.unref();
  };

  const stopWaiting = () => {
    clearTimeout(slowTimer);
    clearTimeout(thinkingTimer);
    slowTimer = null;
    thinkingTimer = null;
    if (waiting) { waiting.stop(); waiting = null; }
  };

  // Every line the platform says goes through here, so the spinner is always off the
  // line before anything else writes to it, and the last thing said becomes the label
  // for what the platform is still doing.
  const announce = line => {
    const stillWaiting = waiting !== null;
    stopWaiting();
    onStep(line);
    lastLine = line;
    if (stillWaiting) startWaiting();
  };

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    startWaiting();

    let response;
    const turnStartedAt = Date.now();

    try {
      response = await createWithOneRetry(
        client,
        {
          model,
          max_tokens: MAX_TOKENS,
          system,
          tools,
          messages,
          ...(supportsTemperature(model) ? { temperature: 0.2 } : {})
        },
        announce,
        turn
      );
    } finally {
      // Whatever came back, including an error on its way to the CLI, the line is
      // handed back before anything is printed on it.
      stopWaiting();
    }

    debugTurn({
      turn,
      endedIn: turnEndedIn(response),
      ms: Date.now() - turnStartedAt,
      usage: response.usage,
      textChars: textOf(response.content).length
    });

    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(b => b.type === "tool_use");

    if (toolUses.length > 0) {
      const results = [];

      for (const use of toolUses) {
        if (use.name === "submit_plan") {
          const submission = splitSubmission(use.input);

          announce("Checking the plan against the seaLeye.run plan contract");
          const result = await traceStep("plan checked", async step => {
            const checked = await validatePlan({ apiBaseUrl, plan: submission.plan });
            step.set({
              valid: Boolean(checked.valid),
              errorCount: (checked.errors || []).length,
              errors: (checked.errors || []).map(e => e.message),
              retry: validationRetries
            });
            return checked;
          });

          if (result.valid) {
            return { status: "submitted", ...submission, questions, validationRetries };
          }

          const errors = result.errors || [];

          if (validationRetries >= MAX_VALIDATION_RETRIES) {
            return { status: "invalid", errors, ...submission, questions, validationRetries };
          }

          validationRetries++;
          announce("The plan needs a correction, asking for one");
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            is_error: true,
            content:
              "The plan is not valid against the contract. Fix exactly these and call " +
              `submit_plan again:\n${errors.map(e => `- ${e.message}`).join("\n")}`
          });
          continue;
        }

        const { content, isError } = runTool(appPath, use.name, use.input || {});
        traceTool(toolRecord(use, content, isError));

        // The line comes after the tool ran, so it says what happened rather than what
        // was about to be attempted.
        if (use.name === "list_files" || use.name === "read_file") {
          const target = use.input?.path || ".";
          announce(
            isError
              ? `Nothing to read at ${target}, moving on`
              : use.name === "list_files"
                ? `Looking at ${target}`
                : `Reading ${target}`
          );
        }

        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          ...(isError ? { is_error: true } : {}),
          content
        });
      }

      messages.push({ role: "user", content: results });
      continue;
    }

    const text = textOf(response.content);

    if (text && isQuestion(text)) {
      // Four questions is the rule. The fifth is answered by the platform, not the
      // developer, and the model is told to submit with what it has.
      if (questions >= MAX_QUESTIONS) {
        if (nudged) {
          return { status: "stopped", message: text, questions };
        }
        nudged = true;
        traceEvent("nudged to submit", { questions });
        messages.push({
          role: "user",
          content:
            `That was question ${MAX_QUESTIONS} and there are no more. Call submit_plan now ` +
            "with the best plan you can make from what you know, and put anything you are " +
            "still unsure about in assumptions."
        });
        continue;
      }

      const { question, lead } = splitQuestion(text);
      questions++;
      traceEvent("question asked", { number: questions, question });
      stopWaiting();   // a question owns the line, and the developer owns the wait
      const answer = await ask(question, lead);
      // The answer is the developer's own words. It goes through the mask, which
      // redacts anything shaped like a secret before it can leave the machine.
      traceEvent("answer given", { number: questions, answer: answer || "(no answer)" });

      // What the platform does next is write the plan, which takes half a minute. The
      // label was still naming the last file it read, so the spinner sat there saying
      // "Reading README.md 29s" long after it had finished reading anything.
      lastLine = "Writing your plan";

      messages.push({ role: "user", content: answer || "(no answer)" });
      continue;
    }

    // No tool call and no question: the model has stopped, which is what the prompt
    // tells it to do for an app this version cannot deploy.
    return { status: "stopped", message: text || "The interview ended without a plan.", questions };
  }

  return {
    status: "stopped",
    message: `The interview did not reach a plan. Run ${product.command} run again, or write the plan yourself.`,
    questions
  };
}
