# deployme: platform CLI + API demo (Blitzy panel, Oct 2)
Purpose: a developer runs `deployme run` in their app folder; the CLI interviews them
(Claude Messages API), writes DEPLOYMENT_PLAN.md + deployme.yaml (planVersion 0.4),
and on confirmation the deployme API creates a real AWS environment via CloudFormation
and returns DEPLOYMENT_REPORT.md.

Hard rules
- The planVersion 0.4 contract (deployme/src/schema.js, prompts/plan-contract.yaml).
  Four modules, and they are the only ones seaLeye.run ever names: static_site_edge,
  http_api_serverless, observability_basic, config_basic. domain_public is gone; a
  custom domain is a need like any other.
- seaLeye.run never names a module it cannot build. It has not ingested anyone's
  Platform Library, so it cannot know what is in one, and "planned" and "requested"
  were claims it had no standing to make. What an app needs beyond the four modules is
  a NEED: a sentence from the fixed list in prompts/module-catalog.yaml, with evidence
  naming the file and what in it shows the need. Evidence is required.
- A plan with needs has status `drafted` and is never called valid-and-ready and never
  said to "deploy as written". The API refuses it with UNSUPPORTED_NEEDS and saves the
  record. A plan with no needs is `ready`.
- 0.2 and 0.3 plans still load. A planned module in an old plan is read as the need it
  was describing and the plan becomes a draft. deployme/src/schema.js is the only file
  allowed to name the old module ids, and only for that.
- One backend: cloudformation. No Terraform, no GitHub Actions, no CodePipeline.
- Region ca-central-1. Runtime nodejs20.x. No CloudFront (too slow to create live).
- The developer's app is never modified. Anything the platform needs (handler shim,
  run.sh) is injected into the packaged artifact, not the source folder.
- Status must be real: mirror CloudFormation stack status. Never fake success.
- Every CLI step prints one plain-language line of what the platform is doing.
- Keep the existing endpoints and CLI commands working; add run and destroy.
- Secrets: ANTHROPIC_API_KEY and AWS creds from env or ~/.deployme/config; never in
  the repo.

Endpoints: POST /plans/validate, POST /deployments, GET /deployments,
GET /deployments/{id}, GET /deployments/{id}/evidence, DELETE /deployments/{id},
GET /needs, GET /health.

Layout: deployme/bin/deployme (CLI), deployme/lib/ (client), deployme/src/server.js
(API), deployme/src/executor/ (cfn composition, packaging, deploy, poll, report,
evidence),
templates/ (cfn fragments per module), prompts/ (system prompt, plan template,
contract, report template), apps/ (sample apps), plans/ (test plans), docs/ (May POC
material, read-only reference).

Definition of done for the demo: from a clean copy of apps/sample-expressjs (later
renamed), `deployme run` -> y -> URL in under 5 minutes; `deployme destroy` cleans up.

Product and command (decided Sept 20)
- The product is seaLeye.run. The developer-facing command is `sealeye`, a bin alias
  for bin/deployme (the `deployme` alias stays until Day 6). Internal names (deployme
  API, folders, repo, .env variables, deployme.yaml) stay as they are and never appear
  in anything the developer sees.
- The subcommand that interviews and deploys is `run`, so the line a developer types
  echoes the domain: `cd your-app && sealeye run`. `init` is still accepted and does
  exactly the same thing, so rehearsal habits and older fixtures keep working, but it
  is not in the help text and it never prints a deprecation notice.
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
  -> RetentionDays. config_basic is written into the template as environment variables.
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
  The files seaLeye.run writes into the developer's folder are DEPLOYMENT_PLAN.md and
  deployme.yaml before the developer says yes, DEPLOYMENT_REPORT.md on succeeded, and
  DEPLOYMENT_EVIDENCE.md only when the developer runs `sealeye evidence`. Nothing else
  writes there.
- Static destroy empties the bucket (aws s3 rm --recursive) before delete-stack.

Interview rules (decided Day 4)
- `sealeye run` runs in the app folder. Model: the Sonnet id from the Day 1 curl test,
  via @anthropic-ai/sdk, temperature 0.2. ANTHROPIC_API_KEY from env; a clear message
  and exit 1 if missing.
- Tools: list_files(path) and read_file(path), read-only, resolved inside the app folder
  only (reject .., symlinks out, node_modules, .git); read_file capped at 20 KB;
  list_files capped at 40 entries. submit_plan(plan, summary, assumptions) ends the
  interview; its plan input schema is prompts/plan-contract.yaml (planVersion 0.4, four
  modules, needs with evidence, no new fields).
- At most four questions, one per assistant turn, developer language, no AWS terms.
  Look at the folder before asking anything the folder can answer.
- Validation: the submitted plan goes to POST /plans/validate; errors return to the
  model as the tool result; two retries, then stop with the errors shown.
- Files: the CLI renders DEPLOYMENT_PLAN.md from prompts/plan-template.md using the
  submission, and writes deployme.yaml (the plan as submitted). Both into the app
  folder. Nothing else is written there before the developer says yes.
- Confirmation boundary: print the summary and the files, then "Deploy this? [y/N]".
  Only y proceeds. Then call the existing deploy + watch code paths; run has no
  deployment logic of its own.
- Every prompt line is amber ask(); every echoed answer phosphor answer(); every
  platform action a dim step() line. No em dash in anything the developer sees.

Evidence rules (Sept 27)
- Nothing in an evidence file or the ledger is typed in. Every value is read from a
  record, from a file seaLeye.run wrote, or from AWS at the moment of generation. A
  value that could not be read says so in words ("not recorded before 2.16.0", "not
  checked: describe-stacks failed") and is never guessed or left as a dash.
- No secrets, anywhere. Setting values, ConfigValue parameters and .env contents never
  appear in the evidence JSON, the markdown, the terminal or the ledger. Names only,
  with "value redacted" where a value would be, the shape compose.js already uses.
- `sealeye evidence` creates nothing in AWS and changes no deploy. Its CloudFormation
  calls are read only, and its one outbound request is a single GET of the app's own
  URL, recorded with its status and how long it took.
- The ledger (`sealeye needs`) is the platform team's view of drafted plans. It counts
  an app once however many times it drafted, it reads each need's line from
  prompts/module-catalog.yaml rather than from the plan so a need reads one way
  everywhere, and it never names a vendor or a date.

Platform Library rules (revised Sept 26)
- planVersion 0.4. Four modules, all of them buildable. Everything else an app needs is
  a need, described in plain language with the code that shows it.
- Three tiers were real, plan-only and mocked. There are two now: what seaLeye.run
  builds, and what it can only describe. Nothing is ever described as a module.
- The refusal is the API's decision, rendered by the CLI. It says the plan is drafted
  and saved, lists the needs with their evidence, and says that when the organization's
  Platform Library has modules supporting them, running `sealeye run` again finishes the
  plan. No mechanism, no vendor, no date, and never "coming soon".
- No sizes, counts or capacity numbers in any plan, card, file or prompt output.
  Profiles select patterns (multi-zone, warm capacity, a queue in front of a burst,
  perf provisioned from prod's plan). Capacity is "set by a load test", always. A
  pattern attaches to a module in the plan; what a profile expects of a need lives on
  the need.
- Developers only ever deploy to a dev environment. The profile describes what the plan
  is designed for; the pipeline builds the later stages from it.
- A profile never refuses on its own. Only needs refuse.
- The org name for messages comes from ~/.deployme/config ORG=..., default "your
  organization". Never hard-code a bank.
