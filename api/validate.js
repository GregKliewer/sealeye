// api/validate.js
// The plan contract check, in one place: POST /plans/validate, POST /deployments and the
// interview's submit_plan all ask the same question and must get the same answer.
//
// Since planVersion 0.5 (PHASE4-PLAN Step 2) the question depends on the catalog the
// plan names: its modules must be ones the platform builds from that catalog, and its
// need kinds that catalog's. A plan from before 0.5 names the starter catalog.
import Ajv from "ajv";
import addFormats from "ajv-formats";

import { CONNECTED_PLAN_VERSION, STARTER_VERSION, unlistedNeedProblems, upgradePlan } from "../core/schema.js";
import { connectionProblems } from "../core/terraform-modules.js";
import { catalogModuleIds, firstSentence, isBuildable, moduleEntry, schemaFor } from "../core/catalog.js";
import { catalogGoingLive, catalogsOf, catalogAt, liveCatalog } from "./catalogs.js";
import { withPlatform } from "./platform.js";

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

// One compiled check per shape of contract: catalogs with the same buildable modules
// and need kinds share it. A handful at most, so no limit is needed.
const compiled = new Map();
function validatorFor(catalog) {
  const schema = schemaFor(catalog);
  const key = JSON.stringify([schema.properties.modules.items.properties.id, schema.properties.needs.items.properties.kind]);
  if (!compiled.has(key)) compiled.set(key, ajv.compile(schema));
  return compiled.get(key);
}

/**
 * The schema's errors as contract errors. Where the contract fixes the values a field may
 * take, they come with the error (`allowed`), because for module ids and need kinds they
 * are the plan's catalog's, and the words a client shows must name those.
 */
export function formatAjvErrors(errors = []) {
  return (errors || []).map(e => ({
    code: "SCHEMA_ERROR",
    message: `${e.instancePath || "/"} ${e.message}`,
    path: e.instancePath || "/",
    ...(Array.isArray(e.params?.allowedValues) ? { allowed: e.params.allowedValues.map(String) } : {})
  }));
}

const isVersion = v => v === STARTER_VERSION || (Number.isInteger(v) && v >= 1);

/**
 * The catalog a plan was written against, for an organization: the starter, or one of
 * its catalogs that is or was live. A draft, or one approved and never live, is not one
 * a plan can be written against; nor is a version the organization does not have.
 *
 * @returns {{ version, source: "starter" | "organization", document } | { error: object }}
 */
export function catalogOfPlan(plan, org = "default") {
  const version = plan?.catalog ?? STARTER_VERSION;
  if (version === STARTER_VERSION) return { version, source: "starter", document: withPlatform(org, catalogAt(org, STARTER_VERSION)) };
  const row = catalogsOf(org).find(c => c.version === version);
  if (!row) {
    return { error: { code: "CATALOG_UNKNOWN", path: "/catalog", message: `/catalog names version ${version}, and your organization has no catalog of that version` } };
  }
  if (row.status !== "live" && row.status !== "retired") {
    return { error: { code: "CATALOG_NOT_LIVE", path: "/catalog", message: `/catalog names version ${version}, which has never been your organization's live catalog` } };
  }
  // With the organization's platform values beside it, as the platform builds from it.
  return { version, source: "organization", document: withPlatform(org, catalogAt(org, version)) };
}

/**
 * Check a plan against the contract. A plan written against an older contract is read
 * as what it meant, then checked.
 *
 * @param {object} plan
 * @param {{ org?: string }} [options] whose catalogs a plan's version is looked up in
 * @returns {{valid: boolean, errors: object[]}}
 */
export function checkPlan(plan, options = {}) {
  return checkUpgraded(upgradePlan(plan), options);
}

/** The same check on a plan that is already upgraded, with the raw errors. */
export function checkUpgraded(plan, { org = "default" } = {}) {
  // A catalog field that is not a version at all is the contract's to report, against
  // the starter's shape, as any other field is.
  const known = plan && typeof plan === "object" && isVersion(plan.catalog) ? catalogOfPlan(plan, org) : null;
  if (known?.error) return { valid: false, errors: [known.error] };
  return checkAgainst(plan, known?.document || withPlatform(org, catalogAt(org, STARTER_VERSION)));
}

/**
 * The same check against a catalog document, whatever its status: the self-test asks it
 * of a draft or an approved catalog before any plan may name one (api/self-test.js), and
 * must get the answer a developer's plan would get once it is live.
 */
export function checkAgainst(plan, catalog) {
  const validate = validatorFor(catalog);
  const ok = validate(plan);
  const errors = ok ? [...unlistedNeedProblems(plan, catalogModuleIds(catalog)), ...connectionProblems(plan, catalog), ...connectedVersion(plan)] : formatAjvErrors(validate.errors);
  return { valid: errors.length === 0, errors };
}

/** A plan that connects modules says so in its version, 0.6 (core/schema.js). */
function connectedVersion(plan) {
  const connects = (plan?.modules || []).some(m => m && m.enabled !== false && m.connect && Object.keys(m.connect).length);
  if (connects && plan.planVersion !== CONNECTED_PLAN_VERSION) return [{ code: "CONNECTION", path: "/planVersion", message: `a plan that connects modules is planVersion ${CONNECTED_PLAN_VERSION}` }];
  return [];
}

/**
 * What stops a valid plan being built now, when the catalog it names is no longer the
 * organization's live one: a module it uses that the live catalog does not build. Empty
 * when the plan names the live catalog, or when everything it uses is still built. A
 * deploy is refused with these rather than built from a catalog that was replaced.
 *
 * @returns {string[]} each module's line, in the words of the catalog the plan names
 */
export function noLongerBuilt(plan, org = "default") {
  const live = { ...liveCatalog(org) };
  live.document = withPlatform(org, live.document);
  const named = plan?.catalog ?? STARTER_VERSION;
  // A catalog being made live this moment counts as live already (catalogGoingLive).
  const next = withPlatform(org, catalogGoingLive(org)) || null;
  if (named === live.version && !next) return [];
  const then = catalogOfPlan(plan, org).document || live.document;
  return (plan?.modules || [])
    .filter(m => m && m.enabled !== false && (!isBuildable(m.id, live.document) || (next && !isBuildable(m.id, next))))
    .map(m => firstSentence(moduleEntry(m.id, then)?.short_line || moduleEntry(m.id, then)?.line || "a module this plan uses"));
}

