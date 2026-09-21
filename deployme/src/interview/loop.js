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

/** A turn ending in "?" is a question for the developer. */
function isQuestion(text) {
  return text.endsWith("?");
}

/**
 * Split an assistant turn into the line to ask and whatever it said first, so the
 * question can be printed as one amber prompt line with its context above it.
 */
function splitQuestion(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  return { question: lines.pop() || text, lead: lines };
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
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Put it in your environment or in ~/.deployme/config and run sealeye init again."
    );
  }

  const client = new Anthropic({ apiKey });
  const system = loadSystemPrompt();
  const tools = [listFilesTool, readFileTool, submitPlanTool];

  const messages = [{ role: "user", content: folderDigest(appPath) }];

  let questions = 0;
  let validationRetries = 0;
  let nudged = false;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system,
      tools,
      messages,
      ...(supportsTemperature(model) ? { temperature: 0.2 } : {})
    });

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

        if (use.name === "list_files" || use.name === "read_file") {
          const target = use.input?.path || ".";
          onStep(use.name === "list_files" ? `Looking at ${target}` : `Reading ${target}`);
        }

        const { content, isError } = runTool(appPath, use.name, use.input || {});
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
