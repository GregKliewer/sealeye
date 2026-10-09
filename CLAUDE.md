# seaLeye

seaLeye is the self-service front door to an organization's own certified platform. A
developer brings an app; seaLeye reads it, asks a few questions in the developer's
language, writes a plan a person can read, and on yes builds a real environment from
modules the platform team already trusts. It refuses, plainly and with evidence, when an
app needs something the platform cannot build.

Two surfaces, one product: **seaLeye.run** is the `sealeye` command, and
**seaLeye.online** is the web portal. Both are clients of the seaLeye API.

## Read before working

- `docs/VISION.md`: what seaLeye is for, who it serves, and the principles below in full.
- `docs/ROADMAP.md`: the phases and the parity backlog. Pick work from here.
- `docs/OPEN-QUESTIONS.md`: decisions not yet made. Do not build past an open question;
  raise it.
- `DESIGN.md`: dated decisions and the reasons for them. Add to it when you decide
  something a later reader would otherwise have to guess.
- `brand/BRAND.md` (terminal) and `brand/BRAND-ONLINE.md` (portal).

## Layout

```
cli/        the sealeye command: bin/sealeye, client.js (talks to the API), interview/,
            doctor.js, brand.js (the only place terminal colours live)
api/        the API: server.js, store.js, needs.js, mappings.js, executor/ (compose,
            package, deploy, poll, report, evidence)
core/       what cli/ and api/ must agree on: schema.js (the plan contract), catalog.js,
            config.js (settings and paths), names.js
prompts/    system prompt, plan contract, plan, report and evidence templates, catalog
templates/  one CloudFormation template per buildable module, plus run.sh
apps/       sample apps for trying seaLeye. plans/ holds test plans.
test/       npm test. No AWS, no model calls.
archive/    the October 2026 demo: marketing sites, transcripts, day notes. Read-only.
```

**The import boundary.** `cli/` and `api/` import from `core/` and never from each other.
`core/` imports only from `core/`. `test/boundaries.test.js` enforces it. If the CLI
needs something the API has, it belongs in `core/` or behind an endpoint.

## Principles (invariants)

1. **Parity.** Every operation exists as an API endpoint first, then as a `sealeye`
   command and a seaLeye.online page with the same name, the same inputs and the same
   outputs. A capability ships when both surfaces have it, not before. See VISION.md.
2. **seaLeye never names a module it cannot build.** What an app needs beyond the
   buildable modules is a NEED: a sentence from the fixed list in
   `prompts/module-catalog.yaml`, with evidence naming the file and what in it shows the
   need. Evidence is required.
3. **Refuse, never shrink.** A plan with needs has status `drafted`. It is never called
   valid-and-ready, never said to "deploy as written", and the API refuses it with
   UNSUPPORTED_NEEDS and saves the record. A plan with no needs is `ready`. A profile
   never refuses on its own; only needs refuse.
4. **Status is real.** Mirror the CloudFormation stack status. Never fake a transition
   or a success.
5. **The developer's app is never modified.** Anything the platform needs is injected
   into the packaged artifact. The only files seaLeye writes into the developer's folder
   are DEPLOYMENT_PLAN.md and sealeye.yaml before they say yes, DEPLOYMENT_REPORT.md on
   success, and DEPLOYMENT_EVIDENCE.md only when they run `sealeye evidence`.
6. **No secrets, anywhere.** Setting values, ConfigValue parameters and .env contents
   never appear in evidence, markdown, the terminal, the ledger, logs or the portal.
   Names only, with "value redacted" where a value would be. Credentials come from the
   environment, the repo `.env` or `~/.sealeye/config`, never from the repo.
7. **Nothing is typed in.** Every value in a report, evidence file or ledger is read from
   a record, from a file seaLeye wrote, or from AWS at the moment of generation. A value
   that could not be read says so in words and is never guessed or left as a dash.
8. **Plain language.** Every CLI step prints one plain-language line of what the
   platform is doing. Developers see no AWS terms in the interview, no em dashes, and
   no sizes, counts or capacity numbers in any plan, card or file: capacity is "set by
   a load test", always.
9. **Developers deploy to dev.** The profile describes what the plan is designed for;
   promotion to later stages goes through the organization's pipeline and approvals.
10. **Never hard-code an organization.** The org name comes from `ORG=` in
    `~/.sealeye/config`, default "your organization".

## Names

- The product is seaLeye. The command is `sealeye`. Its subcommand that interviews and
  deploys is `run`; `init` is a hidden alias that does the same thing and never prints a
  deprecation notice.
- Stacks are `sealeye-<app>` (lowercase, `[a-z0-9-]` only, `core/names.js`). Artifacts
  are `<app>/<deploymentId>.zip`.
- Settings are `SEALEYE_<NAME>` (ACCOUNT, BUCKET, LWA_VERSION, REGION, MODEL, DEBUG,
  HOME), read through `setting()` in `core/config.js`.
- `deployme` was the original name. Until 2.17.0 the plan file was `deployme.yaml`, the
  config folder `~/.deployme`, and settings `DEPLOYME_*`. They are still read, never
  written. Only `core/config.js`, `core/names.js`, `core/schema.js` and `api/store.js`
  may name them. The word never appears in anything a developer or portal user sees.
- Brand: every command prints `prompts/banner.txt` first. Terminal colours live only in
  `cli/brand.js`. Prompts are amber `ask()`, echoed answers phosphor `answer()`,
  platform actions dim `step()`.

## The plan contract

planVersion 0.4 (`core/schema.js`, `prompts/plan-contract.yaml`). Four buildable modules:
static_site_edge, http_api_serverless, observability_basic, config_basic. 0.2 and 0.3
plans still load: a planned module in an old plan is read as the need it described and
the plan becomes a draft. `core/schema.js` is the only file allowed to name the old
module ids, and only for that. Changing the contract is a DESIGN.md decision.

## API

POST /plans/validate, POST /deployments ({ plan, appPath }), GET /deployments,
GET /deployments/{id}, GET /deployments/{id}/evidence, DELETE /deployments/{id},
GET /needs, GET /health. Keep existing endpoints and commands working; add, do not
break.

## Executor

- Shell out to the AWS CLI (child_process, `--output json`). No AWS SDK. `cfn.js` is the
  only file that spawns `aws`. Deploy spawns `aws cloudformation deploy` in the
  background; status polls `describe-stacks` every 5 s; outputs are read fresh after
  every deploy.
- One template per deployment: http_api_serverless and static_site_edge each have one.
  observability_basic.retention_days becomes RetentionDays; config_basic becomes
  environment variables.
- Packaging: copy the app to `dist/stage/<deploymentId>/` (excluding node_modules, .git,
  .github), `npm install --omit=dev` there, add `templates/run.sh`, zip, upload.
- Status map: CREATE/UPDATE_IN_PROGRESS -> running; CREATE/UPDATE_COMPLETE ->
  succeeded; anything with ROLLBACK or FAILED -> failed, with the first CREATE_FAILED
  reason from describe-stack-events, read before any cleanup; DELETE_IN_PROGRESS ->
  destroying; stack gone -> destroyed. A terminal status is ignored until this
  deployment's own operation is visibly under way. A static deploy succeeds only after
  the sync. ROLLBACK_COMPLETE is deleted; UPDATE_ROLLBACK_COMPLETE is not.
- Static destroy empties the bucket before delete-stack.

## Interview

- `sealeye run` runs in the app folder with `claude-sonnet-5` (`SEALEYE_MODEL`
  overrides) via @anthropic-ai/sdk, temperature 0.2. ANTHROPIC_API_KEY missing is a
  clear message and exit 1.
- Tools: list_files and read_file, read-only, inside the app folder only (no `..`, no
  symlinks out, no node_modules, .git, .sealeye); read_file capped at 20 KB,
  list_files at 40 entries. read_file refuses secret files (`.env`, `.env.*` except
  `.env.example` and `.env.sample`, `.envrc`, `*.pem`, `*.key`, SSH keys, `.npmrc`,
  `credentials`); list_files still shows their names. submit_plan(plan, summary,
  assumptions) ends it.
- Tracing (LangFuse, `core/tracing.js`) is on only when LangFuse keys are set. It
  records the shape of each turn, file paths and sizes, never file contents; anything
  new the interview records goes through those helpers, not straight to LangFuse.
  Scores are numbers and yes-or-no values from the fixed list in `core/tracing.js`;
  `deployment_succeeded` is scored only from a final status read from the platform.
- At most four questions, one per turn, in developer language. Look at the folder
  before asking anything the folder can answer.
- The submitted plan goes to POST /plans/validate; errors go back to the model; two
  retries, then stop and show them.
- Confirmation boundary: show the summary and the files, then "Deploy this? [y/N]". Only
  y proceeds, into the same deploy and watch paths `sealeye deploy` uses. `run` has no
  deployment logic of its own.

## Evidence and the needs ledger

`sealeye evidence` creates nothing in AWS and changes no deploy; its one outbound
request is a single GET of the app's own URL, recorded with status and timing. The
ledger (`sealeye needs`) counts an app once however many times it drafted, reads each
need's line from `prompts/module-catalog.yaml`, and never names a vendor or a date. The
refusal says the plan is drafted and saved, lists the needs with evidence, and says that
when the organization's Platform Library supports them, `sealeye run` again finishes
the plan. No mechanism, no vendor, no date, never "coming soon".

## Current limits (change through ROADMAP.md, not ad hoc)

- One backend: CloudFormation. No Terraform, GitHub Actions or CodePipeline yet.
- Region ca-central-1 (`SEALEYE_REGION` is an explicit opt-out). Runtime nodejs20.x.
  No CloudFront.
- The API runs locally on one machine with a JSON file store and no sign-in. Phase 1
  of the roadmap replaces this.
- seaLeye.online in `archive/sealeye-online` is a static mock-up with sample data, not
  a client of the API.

## Working here

- `npm test` before every commit. It needs no AWS and no API key.
- `npm run eval:interview` before and after any change to `prompts/`. It runs the
  interview on each sample app, grades the plans, and records a LangFuse dataset run;
  it needs ANTHROPIC_API_KEY and LangFuse keys, and deploys nothing.
- `npm start` runs the API from the repo root; `npm link` from the repo root installs
  `sealeye`.
- One decision per commit where possible. A decision goes in DESIGN.md with its date and
  reason; a finished roadmap row is updated in the same commit as the work.
