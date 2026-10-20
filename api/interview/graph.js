// api/interview/graph.js
// The interview as a LangGraph graph (DESIGN.md, "The interview runs as a LangGraph
// graph"). The model looks at the app, asks at most four questions, and submits a
// plan (the model writes 0.4; the API reads it as 0.5 against the starter catalog);
// the developer then says whether to deploy it.
//
//   begin -> model_turn -> tools -> model_turn ...   (reading files, a plan to correct)
//                       -> ask   -> model_turn ...   (a question: pauses for the answer)
//                       -> model_turn                (the nudge after question four)
//                       -> end                       (stopped, or out of turns)
//            tools -> approve -> end                 (a valid plan: pauses for "Deploy this?")
//            tools -> end                            (a plan that would not validate)
//
// Two rules make the pauses safe. A resumed node runs again from its first line, so
// each interrupt() has a node of its own with no model call before it: an answer never
// pays for a model turn twice or changes the question it answered. And the saved state
// holds the conversation, file contents included, so it is kept only as long as the
// interview (service.js deletes it).
//
// Model calls go straight to the Anthropic SDK through createWithOneRetry; there are no
// LangChain model wrappers, so SEALEYE_MODEL_URL works unchanged. Tracing is seaLeye's
// own (core/tracing.js); LangFuse's LangGraph handler is never attached, because it
// records every node's state whole and the state holds file contents (D2). LangChain's
// own LangSmith tracer, which env vars can switch on, is switched off for the same
// reason (service.js).
import { Annotation, END, interrupt, START, StateGraph } from "@langchain/langgraph";

import { unsupportedNeeds } from "../../core/catalog.js";
import { addSpend, priceUsage, spendingLimitWords } from "../../core/model-prices.js";
import { scoreTrace, traceEvent, traceStep, traceTool } from "../../core/tracing.js";
import { catalogOfPlan, checkPlan } from "../validate.js";
import { CONNECTED_PLAN_VERSION, PLAN_VERSION, STARTER_VERSION, upgradePlan } from "../../core/schema.js";
import { starterCatalog } from "../../core/catalog.js";
import {
  createWithOneRetry,
  debugTurn,
  deployedContext,
  isQuestion,
  loadSystemPrompt,
  MAX_TOKENS,
  splitQuestion,
  supportsTemperature,
  textOf,
  toolRecord,
  turnEndedIn
} from "./model.js";
import { submitPlanToolFor, splitSubmission } from "./schema.js";
import { folderDigest, listFilesTool, readFileTool, runTool } from "./tools.js";

const MAX_QUESTIONS = 4;       // the interview rule
const MAX_VALIDATION_RETRIES = 2;
export const MAX_TURNS = 24;   // a stuck conversation stops instead of spending
export const WORKER = "interview";   // whose spend this graph counts (Phase 4 adds more)
const COMMAND = "sealeye";

const replace = (fallback) => Annotation({ reducer: (_, next) => next, default: fallback });

export const InterviewState = Annotation.Root({
  // What the interview was started with.
  appDir: replace(() => null),
  deployed: replace(() => null),
  // Which catalog it plans against: { org, version }, the organization's live one when
  // it started (PHASE4-PLAN Step 3). Kept here, so a run resumed after a restart, or
  // after another catalog went live, plans against the one it began with. An
  // interview saved before Oct 15, 2026 has none, and began with the starter.
  catalog: replace(() => null),
  model: replace(() => null),
  // { traceId, spanId } of the first stretch, so later stretches join its trace.
  trace: replace(() => null),
  // What each worker of this run has spent, priced from core/model-prices.js, and the
  // cap it stops at (PHASE3-PLAN Step 3). Keyed by worker, so Phase 4's workers each
  // get their own; the interview is one worker, "interview".
  spend: replace(() => ({})),
  cap: replace(() => null),
  // Files sent empty because they look like they hold a secret (core/scan.js): file,
  // line, rule and kind, never a value. read_file refuses them and says why.
  withheld: replace(() => []),
  // Archives and files that are not text, sent as their names only
  // (core/upload-rules.js). read_file refuses them and says why.
  unread: replace(() => []),

  // The conversation, and the counts the rules are written in.
  messages: replace(() => []),
  turn: replace(() => 0),
  questions: replace(() => 0),
  validationRetries: replace(() => 0),
  nudged: replace(() => false),

  // Where the model node sent us, and what the ask node is about to ask.
  route: replace(() => null),
  pending: replace(() => null),

  // How it ended: { status, ... }. approved is the answer to "Deploy this?".
  result: replace(() => null),
  approved: replace(() => null)
});

/** Whether an interview's catalog is the starter: by its version, never its document. */
export const isStarterRef = ref => !ref || ref.version === undefined || ref.version === STARTER_VERSION;

/** The organization an interview's catalog belongs to: "default" on a laptop API. */
const catalogOrg = ref => ref?.org || "default";

/**
 * The document of an interview's catalog: the one it started with, or the starter for an
 * interview saved before it kept one. Null when the organization no longer has it.
 */
export function interviewCatalog(ref) {
  if (isStarterRef(ref)) return starterCatalog();
  return catalogOfPlan({ catalog: ref.version }, catalogOrg(ref)).document || null;
}

/**
 * The model's plan, stamped with the interview's catalog: 0.5, naming the catalog. The
 * model writes the 0.4 shape and never a catalog, so it cannot plan against one it was
 * not given. Against the starter, an older plan reads as it always did (upgradePlan).
 */
export function stampCatalog(plan, ref) {
  if (!plan || typeof plan !== "object") return plan;
  const version = ref?.version ?? STARTER_VERSION;
  const { catalog: _ignored, ...written } = plan;
  if (version === STARTER_VERSION) return { ...upgradePlan(written), catalog: STARTER_VERSION };
  // The model writes the 0.4 shape. Any other version is left as written, for the check
  // to refuse and the model to correct, rather than hidden by the stamp.
  if (written.planVersion !== undefined && written.planVersion !== "0.4") return { ...written, catalog: version };
  // 0.6 when it connects a module the app uses to the app's (core/schema.js).
  const connects = (written.modules || []).some(m => m && m.enabled !== false && m.connect && Object.keys(m.connect).length);
  return { ...written, planVersion: connects ? CONNECTED_PLAN_VERSION : PLAN_VERSION, catalog: version };
}

/**
 * Build the graph. `runtimeFor(interviewId)` returns what a node needs that is not
 * state and must never be saved with it: the model client and the event sink.
 */
export function buildInterviewGraph({ runtimeFor, checkpointer }) {
  const runtime = config => runtimeFor(config?.configurable?.thread_id);

  // The first message: the folder's digest, then what is already running. A redeploy
  // that re-asks what the live environment already answers is asking the developer to
  // do the platform's remembering.
  async function begin(state) {
    if (state.messages.length) return {};
    const opening = [folderDigest(state.appDir, { withheld: state.withheld }), deployedContext(state.deployed)].filter(Boolean).join("\n\n");
    return { messages: [{ role: "user", content: opening }] };
  }

  // Every return from a model turn carries the run's spend as it stands after the call.
  const lastSpend = new Map();
  async function model(state, config) {
    const id = config?.configurable?.thread_id;
    lastSpend.delete(id);
    const out = await modelTurn(state, config);
    const spend = lastSpend.get(id);
    lastSpend.delete(id);
    return spend ? { ...out, spend } : out;
  }

  async function modelTurn(state, config) {
    const { client, emit } = runtime(config);

    if (state.turn >= MAX_TURNS) {
      return finish(state, {
        status: "stopped",
        message: `The interview did not reach a plan. Run ${COMMAND} run again, or write the plan yourself.`
      });
    }

    // The cap on the run, checked before each call rather than after: the reply that
    // crossed it is already paid for, so it is used, and if it was the plan the
    // developer has a plan. A run can therefore spend past its cap by one reply
    // (DESIGN.md, "A run's cap is close, not exact").
    const spent = state.spend?.[WORKER]?.cost || 0;
    if (Number.isFinite(state.cap) && spent >= state.cap) {
      traceEvent("spending limit reached", { worker: WORKER });
      return finish(state, { status: "stopped", reason: "spending_limit", message: spendingLimitWords(COMMAND) });
    }

    // The system prompt and the tool schemas are the same several thousand tokens on
    // every turn, and a run is a dozen turns. One cache breakpoint on the system block
    // covers the tools too, since they sit in front of it.
    const catalog = interviewCatalog(state.catalog);
    if (!catalog) {
      return finish(state, {
        status: "stopped",
        message: `The catalog this interview started with is no longer one your organization has. Run ${COMMAND} run again.`
      });
    }
    const starter = isStarterRef(state.catalog);
    const system = [{ type: "text", text: loadSystemPrompt(catalog, { starter }), cache_control: { type: "ephemeral" } }];
    const startedAt = Date.now();

    let response;
    try {
      response = await createWithOneRetry(
        client,
        {
          model: state.model,
          max_tokens: MAX_TOKENS,
          system,
          tools: [listFilesTool, readFileTool, submitPlanToolFor(catalog, { starter })],
          messages: state.messages,
          ...(supportsTemperature(state.model) ? { temperature: 0.2 } : {})
        },
        line => emit({ type: "step", line }),
        state.turn
      );
    } catch (err) {
      // The platform's gateway stopped this run at its per-run limit (model.js,
      // isRunLimitReached): it ends as the run's own cap ends it, stopped, not failed.
      if (err?.reason === "spending_limit") {
        traceEvent("spending limit reached", { worker: WORKER });
        return finish(state, { status: "stopped", reason: "spending_limit", message: err.message });
      }
      throw err;
    }

    debugTurn({
      turn: state.turn,
      endedIn: turnEndedIn(response),
      ms: Date.now() - startedAt,
      usage: response.usage,
      textChars: textOf(response.content).length
    });

    // What this reply cost, added to the run's spend before anything else happens, so
    // every way this node returns carries it (spendOf, below).
    state = { ...state, spend: { ...state.spend, [WORKER]: addSpend(state.spend?.[WORKER], priceUsage(state.model, response.usage)) } };
    lastSpend.set(config?.configurable?.thread_id, state.spend);

    const messages = [...state.messages, { role: "assistant", content: response.content }];
    const turn = state.turn + 1;

    if (response.content.some(b => b.type === "tool_use")) {
      return { messages, turn, route: "tools" };
    }

    const text = textOf(response.content);

    if (text && isQuestion(text)) {
      // Four questions is the rule. The fifth is answered by the platform, not the
      // developer, and the model is told to submit with what it has.
      if (state.questions >= MAX_QUESTIONS) {
        if (state.nudged) return finish({ ...state, messages, turn }, { status: "stopped", message: text });

        traceEvent("nudged to submit", { questions: state.questions });
        return {
          messages: [
            ...messages,
            {
              role: "user",
              content:
                `That was question ${MAX_QUESTIONS} and there are no more. Call submit_plan now ` +
                "with the best plan you can make from what you know, and put anything you are " +
                "still unsure about in assumptions."
            }
          ],
          turn,
          nudged: true,
          route: "model"
        };
      }

      const { question, lead } = splitQuestion(text);
      const number = state.questions + 1;
      traceEvent("question asked", { number, question });
      return { messages, turn, questions: number, pending: { number, question, lead }, route: "ask" };
    }

    // No tool call and no question: the model has stopped, which is what the prompt
    // tells it to do for an app this version cannot deploy.
    return finish({ ...state, messages, turn }, { status: "stopped", message: text || "The interview ended without a plan." });
  }

  async function tools(state, config) {
    const { emit } = runtime(config);
    const last = state.messages[state.messages.length - 1];
    const uses = (last?.content || []).filter(b => b.type === "tool_use");
    const results = [];
    let validationRetries = state.validationRetries;

    for (const use of uses) {
      if (use.name === "submit_plan") {
        // The model writes the plan; the platform says which catalog it is against.
        const split = splitSubmission(use.input);
        const submission = { ...split, plan: stampCatalog(split.plan, state.catalog) };

        emit({ type: "step", line: "Checking the plan against the seaLeye.run plan contract" });
        const checked = await traceStep("plan checked", async step => {
          const outcome = checkPlan(submission.plan, { org: catalogOrg(state.catalog) });
          step.set({
            valid: outcome.valid,
            errorCount: outcome.errors.length,
            errors: outcome.errors.map(e => e.message),
            retry: validationRetries
          });
          return outcome;
        });

        if (checked.valid) {
          return finish({ ...state, validationRetries }, { status: "submitted", ...submission }, "approve");
        }

        if (validationRetries >= MAX_VALIDATION_RETRIES) {
          return finish({ ...state, validationRetries }, { status: "invalid", errors: checked.errors, ...submission });
        }

        validationRetries++;
        emit({ type: "step", line: "The plan needs a correction, asking for one" });
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          is_error: true,
          content:
            "The plan is not valid against the contract. Fix exactly these and call " +
            `submit_plan again:\n${checked.errors.map(e => `- ${e.message}`).join("\n")}`
        });
        continue;
      }

      const { content, isError } = runTool(state.appDir, use.name, use.input || {}, { withheld: state.withheld, unread: state.unread || [] });
      traceTool(toolRecord(use, content, isError));

      // The line comes after the tool ran, so it says what happened rather than what
      // was about to be attempted.
      if (use.name === "list_files" || use.name === "read_file") {
        const target = use.input?.path || ".";
        emit({
          type: "step",
          line: isError
            ? `Nothing to read at ${target}, moving on`
            : use.name === "list_files"
              ? `Looking at ${target}`
              : `Reading ${target}`
        });
      }

      results.push({ type: "tool_result", tool_use_id: use.id, ...(isError ? { is_error: true } : {}), content });
    }

    return {
      messages: [...state.messages, { role: "user", content: results }],
      validationRetries,
      route: "model"
    };
  }

  // A node of its own, and nothing before the interrupt: on resume it runs again from
  // the top, and the only thing above this line is reading the state.
  async function ask(state) {
    const answer = interrupt({ type: "question", ...state.pending });
    const text = typeof answer === "string" && answer.trim() ? answer : "(no answer)";

    // The answer is the developer's own words. It goes through the mask, which redacts
    // anything shaped like a secret before it can leave the platform.
    traceEvent("answer given", { number: state.pending?.number, answer: text });

    return {
      messages: [...state.messages, { role: "user", content: text }],
      pending: null,
      route: "model"
    };
  }

  // "Deploy this? [y/N]". Only a yes is a yes.
  async function approve(state) {
    const answer = interrupt({ type: "confirm", ...state.result });
    const approved = answer === true || (typeof answer === "string" && answer.trim().toLowerCase() === "y");

    const traceId = state.trace?.traceId;
    if (traceId) {
      scoreTrace(traceId, "developer_said_yes", approved);
      scoreTrace(traceId, "needs_refused", unsupportedNeeds(state.result.plan).length > 0);
    }

    return { approved, route: null };
  }

  return new StateGraph(InterviewState)
    .addNode("begin", begin)
    .addNode("model_turn", model)
    .addNode("tools", tools)
    .addNode("ask", ask)
    .addNode("approve", approve)
    .addEdge(START, "begin")
    .addEdge("begin", "model_turn")
    .addConditionalEdges("model_turn", s => (s.result ? END : s.route), { tools: "tools", ask: "ask", model: "model_turn", [END]: END })
    .addConditionalEdges("tools", s => (s.route === "approve" ? "approve" : s.result ? END : "model"), {
      approve: "approve",
      model: "model_turn",
      [END]: END
    })
    .addEdge("ask", "model_turn")
    .addEdge("approve", END)
    .compile({ checkpointer });
}

/**
 * How an interview ended, with its counts, and the interview's own scores against its
 * trace. A plan's scores exist only when a plan reached the contract check; a run that
 * stopped before that has only its question count.
 */
function finish(state, result, route = null) {
  // `turns` is how many model calls the run made, so a reader of its trace (the
  // regression set) can tell when it has every one of them.
  // `spent` is what the run cost by seaLeye's own count, in US dollars: for the
  // regression set to compare with LangFuse's, never shown to a developer.
  const spent = state.spend?.[WORKER]?.cost;
  const full = {
    ...result,
    questions: state.questions,
    validationRetries: state.validationRetries,
    ...(Number.isFinite(state.turn) ? { turns: state.turn } : {}),
    ...(Number.isFinite(spent) ? { spent } : {})
  };
  const traceId = state.trace?.traceId;

  if (traceId) {
    scoreTrace(traceId, "questions_asked", state.questions);
    scoreTrace(traceId, "spending_limit_reached", result.reason === "spending_limit");
    if (result.status === "submitted" || result.status === "invalid") {
      scoreTrace(traceId, "plan_valid_first_try", result.status === "submitted" && state.validationRetries === 0);
      scoreTrace(traceId, "validation_retries", state.validationRetries);
    }
  }

  return {
    ...(state.messages ? { messages: state.messages } : {}),
    ...(Number.isFinite(state.turn) ? { turn: state.turn } : {}),
    ...(state.spend ? { spend: state.spend } : {}),
    validationRetries: state.validationRetries,
    result: full,
    route
  };
}
