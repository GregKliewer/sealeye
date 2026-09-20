// src/schema.js
export const planV02Schema = {
  type: "object",
  additionalProperties: false,
  required: ["planVersion", "app", "profile", "modules", "outputs"],
  properties: {
    planVersion: { type: "string", const: "0.2" },
    app: {
      type: "object",
      additionalProperties: false,
      required: ["name", "type"],
      properties: {
        name: { type: "string", minLength: 1 },
        type: { type: "string", enum: ["static-site", "api"] }
      }
    },
    profile: { type: "string", enum: ["poc", "team", "prodish"] },
    modules: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: {
            type: "string",
            enum: [
              "static_site_edge",
              "http_api_serverless",
              "observability_basic",
              "config_basic",
              "domain_public"
            ]
          },
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