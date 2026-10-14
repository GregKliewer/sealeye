// api/validate.js
// The plan contract check, in one place: POST /plans/validate, POST /deployments and the
// interview's submit_plan all ask the same question and must get the same answer.
import Ajv from "ajv";
import addFormats from "ajv-formats";

import { planSchema, unlistedNeedProblems, upgradePlan } from "../core/schema.js";

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(planSchema);

export function formatAjvErrors(errors = []) {
  return (errors || []).map(e => ({
    code: "SCHEMA_ERROR",
    message: `${e.instancePath || "/"} ${e.message}`,
    path: e.instancePath || "/"
  }));
}

/**
 * Check a plan against the contract. A plan written against an older contract is read
 * as what it meant, then checked.
 *
 * @returns {{valid: boolean, errors: object[]}}
 */
export function checkPlan(plan) {
  return checkUpgraded(upgradePlan(plan));
}

/** The same check on a plan that is already upgraded, with the raw errors. */
export function checkUpgraded(plan) {
  const ok = validate(plan);
  const errors = ok ? unlistedNeedProblems(plan) : formatAjvErrors(validate.errors);
  return { valid: errors.length === 0, errors };
}
