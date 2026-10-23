// src/mappings.js
// One template per deployment. Only the two core modules have a template of their own;
// paths are relative to the repo root (see core/config.js repoRoot).
export const backendMappings = {
  cloudformation: {
    static_site_edge: "templates/static_site_edge.yaml",
    http_api_serverless: "templates/http_api_serverless.yaml"
  }
};

// observability_basic and config_basic map to no template of their own:
// observability_basic becomes a parameter (retention_days -> RetentionDays) of whichever
// template is used, and compose() writes config_basic into it as environment variables.
