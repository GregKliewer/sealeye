// api/interview/schema.js
// The input schema for the submit_plan tool the interview gives the model.
//
// The plan half is planSchema itself, not a copy: the contract is frozen and the
// interview must not be able to drift from what POST /plans/validate accepts. The two
// extra arguments are conversation output, not part of the plan, and are dropped
// before the plan is validated or deployed.
import { planSchema } from "../../core/schema.js";

export const submitPlanInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["plan", "summary", "assumptions"],
  properties: {
    plan: {
      ...planSchema,
      description:
        "The planVersion 0.4 deployment plan. Exactly one of static_site_edge and " +
        "http_api_serverless enabled, observability_basic always enabled. Modules are " +
        "only ever those four: never name a module seaLeye.run cannot build. Anything " +
        "else the app needs goes in needs, each with the code that shows it. status is " +
        "drafted when needs is not empty, ready when it is."
    },
    summary: {
      type: "string",
      minLength: 1,
      description:
        "A few sentences in the developer's own language: what their app is, how it " +
        "will run, what they get back. Names the enabled modules and explains each " +
        "in plain language. When the plan carries needs, one sentence saying the plan " +
        "is drafted and which needs have no module yet, never when they might. No " +
        "cloud vendor terms, no invented URL, no em dash."
    },
    assumptions: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description:
        "Every judgement made that the developer did not confirm out loud, one short " +
        "string each. An empty list is almost always wrong."
    }
  }
};

// The tool definition itself, so the interview loop and any test share one shape.
export const submitPlanTool = {
  name: "submit_plan",
  description:
    "Submit the finished deployment plan and end the interview. Call this exactly " +
    "once, after every question you needed has been answered. If the result reports " +
    "validation errors, correct the plan and call it again.",
  input_schema: submitPlanInputSchema
};

/**
 * Split a submit_plan tool input into the plan the API takes and the interview's own
 * output.
 *
 * The summary is cleaned on the way through. Seen in testing on Sept 21: the model
 * occasionally closes the summary string early and writes the rest of the tool input
 * as markup inside it, which leaves the real summary followed by
 * `</summary><parameter name="assumptions">[...]` and an empty assumptions array.
 * Rather than show the developer a paragraph with markup in the middle of it, take the
 * summary up to the leak and recover the assumptions from it if they are parseable.
 */
export function splitSubmission(input) {
  const { plan, summary = "", assumptions = [] } = input || {};
  const cleaned = cleanSummary(summary);

  return {
    plan,
    summary: cleaned.summary,
    assumptions: assumptions.length ? assumptions : cleaned.assumptions
  };
}

const LEAK = /<\/summary>|<parameter\s+name=/i;

function cleanSummary(summary) {
  const text = String(summary || "");
  const leak = text.search(LEAK);
  if (leak === -1) return { summary: text.trim(), assumptions: [] };

  const recovered = /<parameter\s+name="assumptions">\s*(\[[\s\S]*?\])/i.exec(text);
  let assumptions = [];

  if (recovered) {
    try {
      const parsed = JSON.parse(recovered[1]);
      if (Array.isArray(parsed)) assumptions = parsed.filter(a => typeof a === "string");
    } catch {
      // Not parseable: better no assumptions than markup presented as one.
    }
  }

  return { summary: text.slice(0, leak).trim(), assumptions };
}
