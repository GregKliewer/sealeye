// src/mappings.js
// One template per deployment. Only the two core modules have a template of their own;
// paths are relative to the repo root (see core/config.js repoRoot).
export const backendMappings = {
  cloudformation: {
    static_site_edge: "templates/static_site_edge.yaml",
    http_api_serverless: "templates/http_api_serverless.yaml"
  }
};

// observability_basic contributes a parameter (retention_days -> RetentionDays) to
// whichever core template is used. config_basic is written into the template as
// environment variables by compose(), so it maps to no template of its own either.
export const parameterOnlyModules = ["observability_basic"];
export const ignoredModules = [];
