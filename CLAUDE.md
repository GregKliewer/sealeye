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

Product and command (decided Sept 20)
- The product is seaLeye.run. The developer-facing command is `sealeye`, a bin alias
  for bin/deployme (the `deployme` alias stays until Day 6). Internal names (deployme
  API, folders, repo, .env variables, deployme.yaml) stay as they are and never appear
  in anything the developer sees.
- CloudFormation stacks are named sealeye-<app>.
- Fiction: seaLeye.run is the vendor; Greg is its SE; the developer and the platform
  team are at the bank. Copy the developer sees says seaLeye.run or sealeye, never
  deployme.
- Every command prints prompts/banner.txt first (ASCII wordmark plus one line). The
  report template prompts/report.md starts with the wordmark line. Colours come from
  the chosen brand direction and live in one place: deployme/src/brand.js.
- Brand spec: brand/BRAND.md. Colours only from deployme/src/brand.js.
- Brand spec: brand/BRAND.md. Colours only from deployme/src/brand.js.

Executor rules (decided Day 3)
- Shell out to the AWS CLI (child_process), parsing --output json. No AWS SDK dependency.
  Deploy = spawn `aws cloudformation deploy` in the background; status = poll
  `describe-stacks` every 5 s; outputs read fresh from describe-stacks after every deploy.
- One template per deployment: http_api_serverless -> templates/http_api_serverless.yaml,
  static_site_edge -> templates/static_site_edge.yaml. observability_basic.retention_days
  -> RetentionDays. config_basic and domain_public are ignored until Day 6.
- Stack name: sealeye-<app.name> (lowercase, [a-z0-9-] only). Artifact key:
  <app.name>/<deploymentId>.zip so every deploy changes S3Key.
- POST /deployments takes { plan, appPath }. The plan contract is unchanged.
- Packaging: rsync app -> dist/stage/<deploymentId>/ (exclude node_modules .git .do
  .github), npm install --omit=dev there, copy templates/run.sh, chmod +x, zip, s3 cp.
  The developer's folder is read-only to the API.
- Status map: CREATE_IN_PROGRESS/UPDATE_IN_PROGRESS -> running; CREATE_COMPLETE/
  UPDATE_COMPLETE -> succeeded; anything with ROLLBACK or FAILED -> failed with the first
  CREATE_FAILED reason from describe-stack-events; DELETE_IN_PROGRESS -> destroying;
  stack gone -> destroyed. Never fake a transition.
- The API returns outputs, failureReason and a rendered markdown report in the record.
  The CLI writes DEPLOYMENT_REPORT.md into the app folder on succeeded. Nothing else
  writes there.
- Static destroy empties the bucket (aws s3 rm --recursive) before delete-stack.
