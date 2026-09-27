// src/schema.js
// The plan contract, as the API enforces it. planVersion 0.4 is what the interview
// writes now. 0.2 and 0.3 plans still load: see upgradePlan below.
//
// The change 0.4 makes is about honesty. Until seaLeye.run has ingested an
// organization's Platform Library it does not know what is in it, so it cannot call a
// module "planned" and it must not name a module it cannot build. A plan therefore
// names only the four modules the executor deploys, and everything else the app turns
// out to need is recorded as a NEED: a sentence about the app, with the code that
// shows it. A plan carrying needs is a draft.

/** The four modules the executor deploys. There is no other kind. */
export const MODULE_IDS = [
  "static_site_edge",
  "http_api_serverless",
  "observability_basic",
  "config_basic"
];

/** The fixed kinds of need, so the same need is described the same way every run. */
export const NEED_KINDS = [
  "continuous_service",
  "relational_database",
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

/** Is this a module this version of the platform builds? */
export const isBuildable = id => MODULE_IDS.includes(id);

/**
 * A plan as 0.4, whatever version it was written as.
 *
 * A 0.2 or 0.3 plan keeps its four buildable modules and loses the rest, each enabled
 * one becoming a need. A module that was disabled was never asked for, so it simply
 * goes. A plan already at 0.4 is returned untouched.
 */
export function upgradePlan(plan) {
  if (!plan || typeof plan !== "object") return plan;
  if (plan.planVersion === "0.4") return plan;

  const modules = Array.isArray(plan.modules) ? plan.modules : [];
  const kept = modules.filter(m => m && isBuildable(m.id));

  const carried = modules
    .filter(m => m && !isBuildable(m.id) && m.enabled !== false && LEGACY_MODULE_NEEDS[m.id])
    .map(m => ({
      ...LEGACY_MODULE_NEEDS[m.id],
      evidence: [{ file: "deployme.yaml", shows: "from an earlier plan" }]
    }));

  const needs = [...(Array.isArray(plan.needs) ? plan.needs : []), ...carried];

  return {
    ...plan,
    planVersion: "0.4",
    modules: kept,
    ...(needs.length ? { needs } : {}),
    status: needs.length ? "drafted" : "ready"
  };
}

/** A plan is a draft when the app needs something no module supports. */
export const isDrafted = plan => (plan?.needs || []).length > 0;

export const planSchema = {
  type: "object",
  additionalProperties: false,
  required: ["planVersion", "app", "profile", "modules", "outputs"],
  properties: {
    planVersion: { type: "string", enum: ["0.2", "0.3", "0.4"] },
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
    // Only the four. A plan cannot ask for a module the platform does not build,
    // because naming one would be claiming knowledge of a library nobody has read.
    modules: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: { type: "string", enum: MODULE_IDS },
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
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "line", "evidence"],
        properties: {
          kind: { type: "string", enum: NEED_KINDS },
          line: { type: "string", minLength: 1 },
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
