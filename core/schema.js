// core/schema.js
// The plan contract, as the API enforces it. planVersion 0.5 is the contract now: a plan
// names the catalog it was written against, and its modules and need kinds are checked
// against that catalog rather than a fixed list (PHASE4-PLAN Step 2). 0.2, 0.3 and 0.4
// plans still load, read against the starter catalog: see upgradePlan below. The
// interview still writes 0.4 until it reads the organization's catalog (Step 3).
//
// The change 0.4 makes is about honesty. Until seaLeye.run has ingested an
// organization's Platform Library it does not know what is in it, so it cannot call a
// module "planned" and it must not name a module it cannot build. A plan therefore
// names only the four modules the executor deploys, and everything else the app turns
// out to need is recorded as a NEED: a sentence about the app, with the code that
// shows it. A plan carrying needs is a draft.
import { terraformBuilds } from "./terraform-modules.js";

/**
 * The four modules seaLeye's own executor deploys, from templates/: the starter
 * catalog's modules. Whether a module in an organization's catalog is buildable is the
 * catalog's to say, with an executor for it (isBuildable in core/catalog.js).
 */
export const MODULE_IDS = [
  "static_site_edge",
  "http_api_serverless",
  "observability_basic",
  "config_basic"
];

/**
 * What the platform has an executor for, by the name a catalog module gives in
 * `builds_with`, and which modules that executor builds: a list of ids, or a test of a
 * catalog's entry. CloudFormation builds the four modules it has templates for.
 * OpenTofu builds an organization's Terraform module when it has everything it needs
 * (PHASE4-PLAN Step 9, core/terraform-modules.js).
 */
export const EXECUTORS = {
  cloudformation: MODULE_IDS,
  terraform: (entry, catalog) => terraformBuilds(entry, catalog?.platform).builds
};

/** The catalog a plan names when it was written against seaLeye's own four modules. */
export const STARTER_VERSION = "starter";

/** The contract this version writes and checks. Older plans are upgraded to it first. */
export const PLAN_VERSION = "0.5";

/**
 * The known kinds of need, so the same need is described the same way every run. They
 * are the words to use, not a fence: a need none of them fits is `unlisted`, with a line
 * of its own (DESIGN.md, "Needs: known kinds, and the rest in the model's own words").
 */
export const NEED_KINDS = [
  "continuous_service",
  "relational_database",
  "document_database",
  "event_stream",
  "runtime_secrets",
  "internal_only",
  "custom_domain",
  "work_queue",
  "user_sign_in",
  "scheduled_task",
  "file_storage",
  "cache"
];

/** A need none of the known kinds fits: its line is the model's own sentence. */
export const UNLISTED_NEED = "unlisted";

export const PROFILES = ["poc", "dev", "perf", "prod"];

/** The 0.2 names, and what each one is read as now. */
export const LEGACY_PROFILES = { team: "dev", prodish: "prod" };

/** A plan's profile in current terms. An unknown profile is returned untouched. */
export function normalizeProfile(profile) {
  return LEGACY_PROFILES[profile] || profile;
}

// ---------------------------------------------------------------------------
// Reading 0.2 and 0.3
// ---------------------------------------------------------------------------
// The only place in the codebase that may name a module seaLeye.run cannot build. A
// plan written before 0.4 can enable one, and the honest reading of such a plan is
// that the app needed something and the plan of the day said so in module terms. Each
// one becomes a need carrying the line that module used to have, so a developer who
// reuses an old plan sees the same app described the way seaLeye.run describes it now.
const LEGACY_MODULE_NEEDS = {
  compute_container: { kind: "continuous_service", line: "a service that runs continuously" },
  data_relational: { kind: "relational_database", line: "a relational database" },
  data_cache: { kind: "cache", line: "a cache in front of something slower" },
  events_stream: { kind: "event_stream", line: "a stream of events it publishes or reads" },
  queue_basic: { kind: "work_queue", line: "a queue between it and the work it hands off" },
  secrets_basic: { kind: "runtime_secrets", line: "secrets it reads while it runs" },
  identity_service: { kind: "user_sign_in", line: "sign-in and tokens for its own users" },
  network_private: { kind: "internal_only", line: "to be reachable from inside your organization only" },
  scheduled_job: { kind: "scheduled_task", line: "something that runs on a schedule" },
  storage_object: { kind: "file_storage", line: "somewhere to keep files it stores and reads back" },
  domain_public: { kind: "custom_domain", line: "a custom domain you already own" }
};

/**
 * Module ids from plans before 0.4, which a plan file may never name: core/plan-files.js
 * checks for them beside the catalog's own ids.
 */
export const LEGACY_MODULE_IDS = Object.keys(LEGACY_MODULE_NEEDS);

/** Every plan before 0.4 was written against the four modules, so only they are kept. */
const starterBuilds = id => MODULE_IDS.includes(id);

/**
 * A plan as 0.5, whatever version it was written as.
 *
 * Every plan before 0.5 was written against seaLeye's own four modules, so it names the
 * starter catalog and nothing else about it changes. A 0.2 or 0.3 plan also keeps its
 * four buildable modules and loses the rest, each enabled one becoming a need. A module
 * that was disabled was never asked for, so it simply goes. A plan already at 0.5 is
 * returned untouched: the catalog it names is the one it was written against. So is a
 * plan of any other version, which the contract then refuses.
 */
export function upgradePlan(plan) {
  if (!plan || typeof plan !== "object") return plan;
  // Only the versions there were. Any other is left as it is, for the contract to refuse,
  // rather than read as an old plan it never was.
  if (!["0.2", "0.3", "0.4"].includes(plan.planVersion)) return plan;
  if (plan.planVersion === "0.4") return { ...plan, planVersion: PLAN_VERSION, catalog: STARTER_VERSION };

  const modules = Array.isArray(plan.modules) ? plan.modules : [];
  const kept = modules.filter(m => m && starterBuilds(m.id));

  const carried = modules
    .filter(m => m && !starterBuilds(m.id) && m.enabled !== false && LEGACY_MODULE_NEEDS[m.id])
    .map(m => ({
      ...LEGACY_MODULE_NEEDS[m.id],
      evidence: [{ file: "deployme.yaml", shows: "from an earlier plan, written before seaLeye.run 2.17.0" }]
    }));

  const needs = [...(Array.isArray(plan.needs) ? plan.needs : []), ...carried];

  return {
    ...plan,
    planVersion: PLAN_VERSION,
    catalog: STARTER_VERSION,
    modules: kept,
    ...(needs.length ? { needs } : {}),
    status: needs.length ? "drafted" : "ready"
  };
}

// Words an unlisted need's line may not hold: an address, or a promise about when. A
// module is the third: any id in the catalog the plan names, built or not, and the four.
const UNLISTED_FORBIDDEN = [
  [/https?:\/\/|www\./i, "holds an address"],
  [/\b(?:coming|soon|planned|roadmap|will be)\b/i, "makes a promise"]
];

const escaped = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * How a module's id is found in text, as a regular expression's source. An id that
 * looks like an identifier (an underscore or a digit in it: `http_api_serverless`) is
 * found anywhere as a whole word. An id that is an ordinary word (`secrets`, `queue`)
 * is found only written as code, in backticks: otherwise every sentence about secrets
 * would read as naming the module, and a need's line, an interview passage or a plan
 * file that says the word would be refused or dropped (found Oct 15, 2026, when the
 * made-up organization's `secrets` module met the starter's line for runtime_secrets).
 * Used wherever a module's name is looked for in words: here, core/catalog.js and
 * core/plan-files.js.
 */
export function moduleIdSource(id) {
  const e = escaped(id);
  return /[_0-9]/.test(String(id)) ? `\\b${e}\\b` : `\`${e}\``;
}

/**
 * What is wrong with a plan's unlisted needs, as contract errors. The schema checks the
 * shape; this checks the sentence: in the form of the known kinds' lines ("a ..." or
 * "an ..."), naming no module of `moduleIds` (the catalog's, and the four), and none of
 * the words above.
 *
 * @returns {{code: string, message: string, path: string}[]}
 */
export function unlistedNeedProblems(plan, moduleIds = MODULE_IDS) {
  const ids = [...new Set([...MODULE_IDS, ...moduleIds])];
  const forbidden = [[new RegExp(`(?:${ids.map(moduleIdSource).join("|")})`, "i"), "names a module"], ...UNLISTED_FORBIDDEN];
  const problems = [];
  (plan?.needs || []).forEach((need, i) => {
    if (need?.kind !== UNLISTED_NEED) return;
    const line = String(need.line || "").trim();
    const where = `/needs/${i}/line`;
    if (!/^(?:a|an) [a-z]/.test(line)) {
      problems.push({ code: "UNLISTED_NEED", path: where, message: `${where} must read like the known kinds' lines: "a ..." or "an ...", in lower case` });
    }
    for (const [pattern, why] of forbidden) {
      if (pattern.test(line)) problems.push({ code: "UNLISTED_NEED", path: where, message: `${where} ${why}; say what the app needs, in a few words` });
    }
  });
  return problems;
}

/** A plan is a draft when the app needs something no module supports. */
export const isDrafted = plan => (plan?.needs || []).length > 0;

/**
 * The 0.5 contract for one catalog: its module ids are the modules the plan may name
 * (those the catalog marks buildable and the platform has an executor for), its need
 * kinds the known needs. core/catalog.js's schemaFor builds it from a catalog document.
 */
export function contractSchema({ moduleIds = MODULE_IDS, needKinds = NEED_KINDS } = {}) {
  return contractShape({ versions: [PLAN_VERSION], moduleIds: [...moduleIds], needKinds: [...needKinds], catalogField: true });
}

/** The contract against the starter catalog: seaLeye's own four modules. */
export const planSchema = contractSchema();

/**
 * The shape the interview writes a plan in, for one catalog: 0.4's, with the modules and
 * need kinds of the catalog it was given (PHASE4-PLAN Step 3). The model never chooses
 * which catalog: the platform stamps the plan 0.5 with the interview's own. For the
 * starter catalog it is planSchema04 exactly.
 */
export function interviewContract({ moduleIds = MODULE_IDS, needKinds = NEED_KINDS } = {}) {
  return contractShape({ versions: ["0.2", "0.3", "0.4"], moduleIds: [...moduleIds], needKinds: [...needKinds], catalogField: false });
}

/**
 * The 0.4 contract, frozen. The interview still writes 0.4 against the starter catalog
 * (its submit_plan tool, api/interview/schema.js), and the API reads what it writes as
 * 0.5 against the starter, until PHASE4-PLAN Step 3 moves the interview to the
 * organization's catalog. Kept exactly as it was, so the model sees no change.
 */
export const planSchema04 = contractShape({
  versions: ["0.2", "0.3", "0.4"],
  moduleIds: MODULE_IDS,
  needKinds: NEED_KINDS,
  catalogField: false
});

function contractShape({ versions, moduleIds, needKinds, catalogField }) {
  // A catalog the platform builds nothing from yet: a plan names no module, and is the
  // record of what the app needs, drafted. Without this no plan could be written against
  // it, and every interview failed on the contract (Oct 17, 2026, Juniper's catalog before
  // discovery recorded what its modules take).
  const buildsNothing = moduleIds.length === 0;
  return {
    type: "object",
    additionalProperties: false,
    // With nothing to build, what the app needs is the whole plan: at least one need.
    required: ["planVersion", "app", "profile", "modules", "outputs", ...(catalogField ? ["catalog"] : []), ...(buildsNothing ? ["needs"] : [])],
    properties: {
      planVersion: { type: "string", enum: versions },
      // The catalog the plan was written against: "starter" for seaLeye's own four
      // modules, or the version of one of the organization's own catalogs.
      ...(catalogField ? { catalog: { oneOf: [{ type: "string", enum: [STARTER_VERSION] }, { type: "integer", minimum: 1 }] } } : {}),
      app: {
        type: "object",
        additionalProperties: false,
        required: ["name", "type"],
        properties: {
          name: { type: "string", minLength: 1 },
          type: { type: "string", enum: ["static-site", "api"] }
        }
      },
      profile: { type: "string", enum: [...PROFILES, ...Object.keys(LEGACY_PROFILES)] },
      // Only what the platform builds from the plan's catalog. A plan cannot ask for a
      // module the platform does not build, because naming one would be claiming
      // knowledge of a library nobody has read, or a promise nobody can keep.
      modules: {
        type: "array",
        minItems: buildsNothing ? 0 : 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: {
            id: moduleIds.length ? { type: "string", enum: moduleIds } : { type: "string", not: {} },
            enabled: { type: "boolean", default: true },
            inputs: { type: "object", additionalProperties: true }
          }
        }
      },
      // What the app needs that no module supports yet. Evidence is required and
      // non-empty: a need without the code that shows it is a guess, and a guess is the
      // thing this whole change exists to stop.
      needs: {
        type: "array",
        ...(buildsNothing ? { minItems: 1 } : {}),
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "line", "evidence"],
          properties: {
            kind: { type: "string", enum: [...needKinds, UNLISTED_NEED] },
            // For a known kind, the catalog's line. For an unlisted need, a short phrase
            // about the app in the same form ("a search index over its documents"): the
            // kind of thing, never a product (the technology goes in the evidence), never
            // a module, never a promise. Checked further in unlistedNeedProblems.
            line: { type: "string", minLength: 1, maxLength: 90 },
            evidence: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["file", "shows"],
                properties: {
                  file: { type: "string", minLength: 1 },
                  // A short phrase, not a sentence: this sits in a narrow column beside
                  // the need, on a card and in a refusal, and a paragraph there wraps
                  // into something nobody reads.
                  shows: { type: "string", minLength: 1, maxLength: 70 }
                }
              }
            },
            profile_expects: { type: "string", minLength: 1 }
          }
        }
      },
      status: { type: "string", enum: ["ready", "drafted"] },
      outputs: {
        type: "array",
        items: {
          type: "string",
          enum: ["public_url", "logs", "metrics", "metrics_dashboard", "log_stream"]
        }
      },
      execution: {
        type: "object",
        additionalProperties: false,
        properties: {
          strategy: { type: "string", enum: ["pipeline", "direct"] }
        }
      }
    }
  };
}
