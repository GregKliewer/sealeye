# deployme: platform CLI + API demo (Blitzy panel, Oct 2)
Purpose: a developer runs `deployme init` in their app folder; the CLI interviews them
(Claude Messages API), writes DEPLOYMENT_PLAN.md + deployme.yaml (planVersion 0.2),
and on confirmation the deployme API creates a real AWS environment via CloudFormation
and returns DEPLOYMENT_REPORT.md.

Hard rules
- The planVersion 0.2 contract (deployme/src/schema.js, prompts/plan-contract.yaml) is
  frozen. Do not add modules or fields. Five modules: static_site_edge,
  http_api_serverless, observability_basic, config_basic, domain_public (ignored by
  the executor).
- One backend: cloudformation. No Terraform, no GitHub Actions, no CodePipeline.
- Region ca-central-1. Runtime nodejs20.x. No CloudFront (too slow to create live).
- The developer's app is never modified. Anything the platform needs (handler shim,
  run.sh) is injected into the packaged artifact, not the source folder.
- Status must be real: mirror CloudFormation stack status. Never fake success.
- Every CLI step prints one plain-language line of what the platform is doing.
- Keep the existing endpoints and CLI commands working; add init and destroy.
- Secrets: ANTHROPIC_API_KEY and AWS creds from env or ~/.deployme/config; never in
  the repo.

Layout: deployme/bin/deployme (CLI), deployme/lib/ (client), deployme/src/server.js
(API), deployme/src/executor/ (cfn composition, packaging, deploy, poll, report),
templates/ (cfn fragments per module), prompts/ (system prompt, plan template,
contract, report template), apps/ (sample apps), plans/ (test plans), docs/ (May POC
material, read-only reference).

Definition of done for the demo: from a clean copy of apps/sample-expressjs (later
renamed), `deployme init` -> y -> URL in under 5 minutes; `deployme destroy` cleans up.
