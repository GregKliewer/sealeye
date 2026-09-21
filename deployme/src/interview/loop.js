// src/interview/loop.js
// The `sealeye init` interview: the model looks at the developer's folder, asks at
// most four questions, and submits a planVersion 0.2 plan.
//
// The loop is written by hand rather than handed to the SDK tool runner because two
// of the three tools are not code: a question goes to a human at a terminal, and
// submit_plan ends the conversation only if the platform API says the plan is valid.
import fs from "node:fs";
import path from "node:path";

import Anthropic from "@anthropic-ai/sdk";

import { validatePlan } from "../../lib/run.js";
import { product } from "../brand.js";
import { repoRoot, loadEnv, loadUserConfig } from "../executor/env.js";
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

/**
 * Sampling parameters were removed on Sonnet 5 and the rest of the current
 * generation: sending temperature returns a 400. CLAUDE.md asks for temperature 0.2,
 * so it is still sent to any older id that accepts it.
 */
function supportsTemperature(model) {
  return !/(sonnet-5|opus-5|opus-4-[78]|fable-5|mythos-5)/.test(model);
}

/** ANTHROPIC_API_KEY from the environment, the repo .env, or ~/.deployme/config. */
export function resolveApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  loadEnv();
  loadUserConfig();
  return process.env.ANTHROPIC_API_KEY || null;
}

/** The system prompt, read relative to the CLI, never to the developer's folder. */
export function loadSystemPrompt() {
  return fs.readFileSync(path.join(repoRoot, "prompts", "interview-system.md"), "utf8");
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
 */
function splitQuestion(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

  // The question is the last line that has the question mark in it; anything above it
  // is what the platform found, and anything below is part of the same ask.
  const last = lines.reduce((found, line, index) => (line.includes("?") ? index : found), lines.length - 1);

  return {
    question: lines.slice(last).join(" ") || text,
    lead: lines.slice(0, last)
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
      `The model did not answer in time twice, so seaLeye.run stopped. Run ${product.command} init again.`,
      err
    );
  }

  if (err instanceof Anthropic.APIConnectionError) {
    return userFacing(
      `seaLeye.run could not reach the model that does the interview. Check your connection, then run ${product.command} init again.`,
      err
    );
  }

  if (err?.status === 401 || err?.status === 403) {
    return userFacing("The ANTHROPIC_API_KEY seaLeye.run is using was refused.", err);
  }

  if (err?.status === 429) {
    return userFacing(`That account is being rate limited. Wait a moment, then run ${product.command} init again.`, err);
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
async function createWithOneRetry(client, params, onStep) {
  try {
    return await client.messages.create(params);
  } catch (err) {
    if (!isRetryable(err)) throw asUserFacing(err);

    onStep("That is taking longer than it should, trying once more");
    if (process.env.DEPLOYME_DEBUG) {
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
 * Run the interview.
 *
 * @param {object}   options
 * @param {string}   options.appPath     the developer's folder, read only
 * @param {string}   options.apiBaseUrl  the platform API, for plan validation
 * @param {function} options.ask         (question, lead[]) => Promise<string>, one line from the terminal
 * @param {function} options.onStep      (line) => void, one plain-language line of what the platform is doing
 * @returns {Promise<{status: "submitted"|"stopped"|"invalid", plan?, summary?, assumptions?, questions?, message?, errors?}>}
 */
export async function runInterview({
  appPath,
  apiBaseUrl,
  ask,
  onStep = () => {},
  model = process.env.DEPLOYME_MODEL || DEFAULT_MODEL
}) {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw userFacing(
      `ANTHROPIC_API_KEY is not set, so put it in your environment or in ~/.deployme/config and run ${product.command} init again.`
    );
  }

  // The SDK's own retries are off: one retry, announced, beats three silent ones in
  // front of an audience.
  const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 0 });
  const system = loadSystemPrompt();
  const tools = [listFilesTool, readFileTool, submitPlanTool];

  const messages = [{ role: "user", content: folderDigest(appPath) }];

  let questions = 0;
  let validationRetries = 0;
  let nudged = false;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await createWithOneRetry(
      client,
      {
        model,
        max_tokens: MAX_TOKENS,
        system,
        tools,
        messages,
        ...(supportsTemperature(model) ? { temperature: 0.2 } : {})
      },
      onStep
    );

    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(b => b.type === "tool_use");

    if (toolUses.length > 0) {
      const results = [];

      for (const use of toolUses) {
        if (use.name === "submit_plan") {
          const submission = splitSubmission(use.input);

          onStep("Checking the plan against the seaLeye.run plan contract");
          const result = await validatePlan({ apiBaseUrl, plan: submission.plan });

          if (result.valid) {
            return { status: "submitted", ...submission, questions };
          }

          const errors = result.errors || [];

          if (validationRetries >= MAX_VALIDATION_RETRIES) {
            return { status: "invalid", errors, ...submission, questions };
          }

          validationRetries++;
          onStep("The plan needs a correction, asking for one");
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

        // The line comes after the tool ran, so it says what happened rather than what
        // was about to be attempted.
        if (use.name === "list_files" || use.name === "read_file") {
          const target = use.input?.path || ".";
          onStep(
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
      const answer = await ask(question, lead);
      messages.push({ role: "user", content: answer || "(no answer)" });
      continue;
    }

    // No tool call and no question: the model has stopped, which is what the prompt
    // tells it to do for an app this version cannot deploy.
    return { status: "stopped", message: text || "The interview ended without a plan.", questions };
  }

  return {
    status: "stopped",
    message: "The interview did not reach a plan. Run sealeye init again, or write the plan yourself.",
    questions
  };
}
