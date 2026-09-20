# Scope freeze (code freeze Sun Sept 27)
IN: sealeye init (introspect, interview, DEPLOYMENT_PLAN.md + deployme.yaml, confirm,
hand off to deploy); real CloudFormation executor for http_api_serverless (Lambda +
HTTP API + logs) and static_site_edge (S3 website); observability_basic (log group,
small dashboard); config_basic (Lambda env vars); DEPLOYMENT_REPORT.md; deployme
destroy; a recorded end-to-end run as insurance.
OUT: Terraform, GitHub Actions, CodePipeline, CloudFront, custom domains, databases,
multiple environments, drift/updates beyond "deploy again updates the stack", any web UI.
If a day slips, drop in this order: dashboard, config_basic, static path. Never the
Node API happy path or the recording.
