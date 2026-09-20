// src/mappings.js
// One template per deployment. Only the two core modules have a template of their own;
// paths are relative to the repo root (see executor/env.js repoRoot).
export const backendMappings = {
  cloudformation: {
    static_site_edge: "templates/static_site_edge.yaml",
    http_api_serverless: "templates/http_api_serverless.yaml"
  }
};

// observability_basic contributes a parameter (retention_days -> RetentionDays) to
// whichever core template is used. config_basic and domain_public are ignored by the
// executor until Day 6. None of the three map to a template of their own.
export const parameterOnlyModules = ["observability_basic"];
export const ignoredModules = ["config_basic", "domain_public"];
