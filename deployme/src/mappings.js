// src/mappings.js
export const backendMappings = {
  cloudformation: {
    static_site_edge: "cfn/static-site.yaml",
    http_api_serverless: "cfn/http-api.yaml",
    observability_basic: "cfn/observability.yaml",
    config_basic: "cfn/config.yaml",
    domain_public: "cfn/domain.yaml"
  },
  terraform: {
    static_site_edge: "tf/modules/static_site_edge",
    http_api_serverless: "tf/modules/http_api_serverless",
    observability_basic: "tf/modules/observability_basic",
    config_basic: "tf/modules/config_basic",
    domain_public: "tf/modules/domain_public"
  }
};