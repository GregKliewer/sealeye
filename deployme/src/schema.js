// src/schema.js
// The plan contract, as the API enforces it. planVersion 0.3 extends 0.2: the older
// version string, the two older profile names and the five original modules are all
// still valid, so every plan written against 0.2 validates unchanged.
//
// What a plan may ASK for and what the platform can BUILD are deliberately different
// sets. Availability lives in prompts/module-catalog.yaml, and the API refuses to
// deploy a plan that enables a module it cannot build. A schema that refused them here
// instead would make the library unwritable and the refusal unsayable.

/** The five modules the executor deploys, and the ten it can only record. */
export const MODULE_IDS = [
  "static_site_edge",
  "http_api_serverless",
  "observability_basic",
  "config_basic",
  "domain_public",
  "data_relational",
  "data_cache",
  "events_stream",
  "queue_basic",
  "secrets_basic",
  "identity_service",
  "network_private",
  "compute_container",
  "scheduled_job",
  "storage_object"
];

export const PROFILES = ["poc", "dev", "perf", "prod"];

/** The 0.2 names, and what each one is read as now. */
export const LEGACY_PROFILES = { team: "dev", prodish: "prod" };

/** A plan's profile in 0.3 terms. An unknown profile is returned untouched. */
export function normalizeProfile(profile) {
  return LEGACY_PROFILES[profile] || profile;
}

export const planSchema = {
  type: "object",
  additionalProperties: false,
  required: ["planVersion", "app", "profile", "modules", "outputs"],
  properties: {
    planVersion: { type: "string", enum: ["0.2", "0.3"] },
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
