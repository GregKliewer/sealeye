// src/interview/schema.js
// The input schema for the submit_plan tool the interview gives the model.
//
// The plan half is planV02Schema itself, not a copy: the contract is frozen and the
// interview must not be able to drift from what POST /plans/validate accepts. The two
// extra arguments are conversation output, not part of the plan, and are dropped
// before the plan is validated or deployed.
import { planV02Schema } from "../schema.js";

export const submitPlanInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["plan", "summary", "assumptions"],
  properties: {
    plan: {
      ...planV02Schema,
      description:
        "The planVersion 0.2 deployment plan. Exactly one of static_site_edge and " +
        "http_api_serverless enabled, observability_basic always enabled, " +
        "domain_public always disabled."
    },
    summary: {
      type: "string",
      minLength: 1,
      description:
        "A few sentences in the developer's own language: what their app is, how it " +
        "will run, what they get back. Names the enabled modules and explains each " +
        "in plain language. No cloud vendor terms, no invented URL, no em dash."
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

/** Split a submit_plan tool input into the plan the API takes and the interview's own output. */
export function splitSubmission(input) {
  const { plan, summary = "", assumptions = [] } = input || {};
  return { plan, summary, assumptions };
}
