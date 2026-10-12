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
cli/        the sealeye command: bin/sealeye, client.js (talks to the API), interview/
            (follow.js streams the interview; render.js), doctor.js,
            store-offer.js (moving .env values into the store),
            brand.js (the only place terminal colours live)
api/        the API: server.js, store.js, db.js, migrations/, needs.js, mappings.js, validate.js, interview/
            (the LangGraph graph, the model, the tools, the service), executor/
            (compose, package, deploy, poll, report, evidence)
core/       what cli/ and api/ must agree on: schema.js (the plan contract), catalog.js,
            config.js (settings and paths), names.js, secrets.js (which files hold
            secrets), upload.js and upload-rules.js (what travels to the API, the
            walk both surfaces use), tracing.js, token.js
            (what a token looks like; api/tokens.js issues and checks them),
            plan-files.js (DEPLOYMENT_PLAN.md and sealeye.yaml, written by the
            command and sent with the interview's plan for the portal),
            plan-words.js and evidence-summary.js (words the command and the portal
            both say). secrets.js, upload-rules.js, plan-words.js and
            evidence-summary.js run in a browser, so the portal imports them too
prompts/    system prompt, plan contract, plan, report and evidence templates, catalog
templates/  one CloudFormation template per buildable module, plus run.sh and
            sealeye-settings.mjs (the settings reader run.sh loads first)
deploy/     the pilot server: Dockerfile's start script, its CloudFormation (server,
            deploy role), compose, Caddy, and the release scripts. deploy/README.md
portal/     seaLeye.online: React, TypeScript, Vite, Tailwind, shadcn-style components in
            src/components/ui. Its own package.json. Calls the API at /api and nothing
            else. tests/ holds the Playwright tests and the test API they run against
sites/      the pages Caddy serves beside the portal: run/ (seaLeye.run, its installer).
            release.sh adds the package, the version, and the built portal
apps/       sample apps for trying seaLeye. plans/ holds test plans.
test/       npm test. No AWS, no model calls.
archive/    the October 2026 demo: marketing sites, transcripts, day notes. Read-only.
```

**The import boundary.** `cli/` and `api/` import from `core/` and never from each other.
`core/` imports only from `core/`. `portal/src` may import a `core/` file only if it, and
everything it imports, runs in a browser (no `node:` modules, no packages).
`test/boundaries.test.js` enforces it. If the CLI needs something the API has, it belongs
in `core/` or behind an endpoint.

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
- An environment's name is `sealeye-<team>-<app>-<hash>` (`environmentName` in
  `core/names.js`: lowercase, `[a-z0-9-]` only, at most 49 characters, the hash of the
  organization, team and app). Its stack, function, log group, API and static site
  bucket are all named after it, so two teams' apps of the same name are two
  environments; the developer sees only the app name. `namingFor` in
  `api/executor/compose.js` keeps an existing environment's names from its record, so
  ones made before this keep `sealeye-<app>`. seaLeye's own infrastructure is
  `platform-sealeye-*`, which the deploy role cannot touch. Artifacts are
  `<name>/<deploymentId>.zip`.
- Settings are `SEALEYE_<NAME>` (ACCOUNT, BUCKET, LWA_VERSION, FUNCTION_BOUNDARY_ARN, REGION, MODEL, DEBUG,
  HOME, TRACING, MODEL_URL, API, TOKEN, AUTH), read through `setting()` in
  `core/config.js`. SEALEYE_TOKEN is a secret: it lives in `~/.sealeye/config` (0600),
  is never printed, logged or put on a record.
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

POST /plans/validate, POST /deployments ({ plan, appPath, zip?, settings? }, or
{ fromDeployment, plan? } to deploy code the platform already has again), GET /deployments,
GET /deployments/{id}, GET /deployments/{id}/evidence, DELETE /deployments/{id},
GET /needs, GET /health, POST /interviews ({ app, zip }), POST
/interviews/{id}/answers ({ answer }), GET /interviews/{id}/events (server-sent events),
DELETE /interviews/{id}, GET /whoami, GET /catalog, GET /apps/{app}/settings, PUT
/apps/{app}/settings/{name} ({ value }) and DELETE /apps/{app}/settings/{name} (an app's
settings in the store: names out, values in, never back), POST /sessions ({ token }) and
DELETE /sessions (the portal's sign-in and sign-out). Every endpoint but GET /health
and the two /sessions needs `Authorization: Bearer <token>` (`api/tokens.js`) or the
portal's session cookie; a change made with the cookie must also carry
`x-sealeye-portal: 1`. A record says which surface made it. A laptop API may run with
`SEALEYE_AUTH=off`, an API with a database never can. The person on a record is the
token's, never what the command line says. An interview is its starter's; a record is
its team's, seen by that team and by an organization-wide token, never by another
organization; the needs ledger is the whole organization's, but an app's evidence and
deployment id in it are its team's (and an organization-wide token's). Keep existing endpoints and commands working; add, do not
break.

## Executor

- Shell out to the AWS CLI (child_process, `--output json`). No AWS SDK. `cfn.js` is the
  only file that spawns `aws`. Deploy spawns `aws cloudformation deploy` in the
  background; status polls `describe-stacks` every 5 s; outputs are read fresh after
  every deploy.
- One template per deployment: http_api_serverless and static_site_edge each have one.
  observability_basic.retention_days becomes RetentionDays; config_basic becomes
  environment variables.
- Packaging: the app arrives as an uploaded copy (`core/upload.js`, purpose `deploy`:
  no node_modules, .git, .github, .do or secret file of any kind), unpacked into
  `~/.sealeye/deploy-uploads/<deploymentId>/` and removed when the deployment ends.
  Copy it to `dist/stage/<deploymentId>/`, `npm install --omit=dev` there, add
  `templates/run.sh`, zip, upload. `appPath` with no zip is still a folder on the API's
  machine. A deployment made again (`fromDeployment`, `sealeye deploy --again`, the
  portal's Deploy again) stages nothing: it reuses the earlier artifact in S3, checked
  first with head-object, and takes every setting from the store. APIs only.
- Status map: CREATE/UPDATE_IN_PROGRESS -> running; CREATE/UPDATE_COMPLETE ->
  succeeded; anything with ROLLBACK or FAILED -> failed, with the first CREATE_FAILED
  reason from describe-stack-events, read before any cleanup; DELETE_IN_PROGRESS ->
  destroying; stack gone -> destroyed. A terminal status is ignored until this
  deployment's own operation is visibly under way. A static deploy succeeds only after
  the sync. ROLLBACK_COMPLETE is deleted; UPDATE_ROLLBACK_COMPLETE is not.
- Static destroy empties the bucket before delete-stack.

## Interview

- The interview runs in the API (`api/interview/`) as a LangGraph graph with
  `claude-sonnet-5` (`SEALEYE_MODEL` overrides) via @anthropic-ai/sdk, temperature 0.2,
  at `SEALEYE_MODEL_URL` when set. The API holds ANTHROPIC_API_KEY; without it,
  POST /interviews says so. `sealeye run` uploads the folder (`core/upload.js`: without
  what `.gitignore` leaves out, secret files as names only), follows the events and sends the answers; it holds no keys.
- Each `interrupt()` (a question, "Deploy this?") is in a node of its own with no model
  call before it. An interview's scratch folder and saved state are deleted when it
  ends, or after a day.
- Tools: list_files and read_file, read-only, inside the app folder only (no `..`, no
  symlinks out, no node_modules, .git, .sealeye); read_file capped at 20 KB,
  list_files at 40 entries. read_file refuses secret files (`core/secrets.js`: `.env`,
  `.env.*` except `.env.example` and `.env.sample`, `.envrc`, keys and keystores, SSH
  keys, package-manager and git credentials, Terraform variables and state,
  service-account JSON); list_files still shows their names, and the upload carries
  them as empty files. LangSmith tracing stays off in the API (it would send file
  contents). submit_plan(plan, summary,
  assumptions) ends it.
- Tracing (LangFuse, `core/tracing.js`) is on only when the API has LangFuse keys, and
  `sealeye run --no-trace` or `SEALEYE_TRACING=off` turns it off for that interview; a
  switch that does says so in one line. An interview is one trace across its pauses. It records the shape of each turn, file paths and sizes, never
  file contents; anything new the interview records goes through those helpers, not
  straight to LangFuse.
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
- The API runs on one pilot server (https://api.sealeye.online, `deploy/`), with
  records and interviews in Postgres, or locally with a JSON file and interviews in
  memory (no `DATABASE_URL`). No sign-in yet: each person has a token, issued with
  `deploy/server.sh token add` and kept by `sealeye login`, a stand-in until Q3 (ROADMAP
  Phase 1 item 3, Q16). Every token is org "default" until there is a second
  organization. A token is for one team, or issued `--org-wide` to see every team's.
  The store reads from memory, written through to Postgres: one API process only.
- An app's settings live in the organization's store (Parameter Store,
  `/sealeye-apps/<team>/<app>/`), put in with `sealeye settings set` or the portal's
  Settings card, and read by the app when it starts (`templates/sealeye-settings.mjs`,
  which signs its own request; no SDK). Every function role carries the platform's
  permissions boundary (`SEALEYE_FUNCTION_BOUNDARY_ARN`). Settings not in the store still
  travel with each deploy from the developer's `.env`, and are never kept.
  `settingValues` in `api/executor/settings.js` is the one place that decides where each
  comes from (store, sent, .env, plan), and a record keeps each setting's name and
  source, never its value.
- seaLeye.online (`portal/`) has Environments, New environment (the interview, from a
  folder chosen in the browser), Control (state, deploy again, tear down,
  settings, history, evidence), Validate (check a plan, and deploy a ready one with the
  code the platform has), Catalog (modules and the needs ledger) and Health. Pause, Configure, Logs, Performance, Costs and
  Team are drawn in the archived mock-up only; the portal shows nothing it cannot do.

## Working here

- `npm test` before every commit; GitHub runs it on every push and pull request
  (`.github/workflows/test.yml`), with Postgres. It needs no AWS and no API key. Tests that need
  Postgres run only with `SEALEYE_TEST_DATABASE_URL` set (a server they may create
  databases on), and are skipped without it.
- `npm run eval:interview` before and after any change to `prompts/`. It runs the
  interview graph in-process on each sample app, grades the plans, and records a
  LangFuse dataset run; it needs ANTHROPIC_API_KEY and LangFuse keys, and deploys
  nothing.
- `npm start` runs the API from the repo root; `npm link` from the repo root installs
  `sealeye`. The command talks to https://api.sealeye.online unless `SEALEYE_API` or
  `--api` says otherwise, so point it at `http://localhost:3000` for a local API.
- The portal: `cd portal && npm ci && npm run build`, then `npm run test:e2e`
  (Playwright starts `tests/test-api.mjs`, the real API with sample records, and the
  built portal). `npm run dev` with `SEALEYE_PORTAL_API` set runs it against any API.
  Every value on a page comes from an API call; colours and type from
  `brand/BRAND-ONLINE.md` (`src/index.css`).
- Developers install with `curl -fsSL https://sealeye.run/install | sh`: the package
  release.sh packs, limited by package.json "files" to the command and what it reads.
  `test/package-contents.test.js` keeps the API and the interview prompt out of it.
  A pull request that changes what the package holds (`cli/`, `core/`, the prompt files
  it carries) raises the version in package.json; release.sh stops if the command
  changed and the version did not.
- One decision per commit where possible. A decision goes in DESIGN.md with its date and
  reason; a finished roadmap row is updated in the same commit as the work.
