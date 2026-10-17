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
- `docs/ARCHITECTURE.md`: how it is built, with the context, container, deployment,
  flow and data diagrams. A change that makes a diagram wrong fixes it in the same
  commit. `docs/README.md` maps every document.
- `docs/OPEN-QUESTIONS.md`: decisions not yet made. Do not build past an open question;
  raise it.
- `DESIGN.md`: dated decisions and the reasons for them. Add to it when you decide
  something a later reader would otherwise have to guess.
- `brand/BRAND.md` (terminal) and `brand/BRAND-ONLINE.md` (portal).

## Layout

```
cli/        the sealeye command: bin/sealeye, client.js (talks to the API), interview/
            (follow.js streams the interview; render.js), discover.js (a discovery run,
            its questions answered as they come; discover-screen.js draws its window),
            catalogs.js (`sealeye catalog versions|test|edit|fix|approve|live`), platform.js
            (`sealeye platform`, the organization's platform values), doctor.js,
            store-offer.js (moving .env values into the store),
            brand.js (the only place terminal colours live)
api/        the API: server.js, store.js, db.js, migrations/, catalogs.js (each organization's
            catalog, or the starter), self-test.js (what a catalog passes before it is
            approved and made live), catalog-use.js (the environments a catalog would
            stop building), needs.js, mappings.js, validate.js,
            secret-scan.js and gitleaks.toml (the API's scan of what arrives),
            gateway-token.js (the token on every model call), model-routes.js (the
            gateway's named routes, small and frontier), discovery/ (reading a platform
            library: github.js fetches one commit, tar.js reads it, library.js walks and
            scans it; terraform.js finds modules and their inputs; readers.js the
            workers and the supervisor; draft.js the draft catalog; service.js the run;
            store.js its records and questions), platform.js (each organization's
            platform values, by stage), interview/
            (the LangGraph graph, the model, the tools, the service), executor/
            (compose, package, deploy, poll, report, evidence; terraform/ the
            Terraform executor: tofu.js the only file that spawns `tofu`, library.js
            the module's code at the catalog's commit, root.js the root module,
            index.js the lifecycle)
core/       what cli/ and api/ must agree on: schema.js (the plan contract), catalog.js,
            terraform-modules.js (what a Terraform module needs before it is built),
            config.js (settings and paths), names.js, secrets.js (which files hold
            secrets), scan.js (which values look like secrets, .sealeye-allow, and
            the words for a finding), upload.js and upload-rules.js (what travels to the API, the
            walk both surfaces use), tracing.js, token.js
            (what a token looks like; api/tokens.js issues and checks them),
            plan-files.js (DEPLOYMENT_PLAN.md and sealeye.yaml, written by the
            command and sent with the interview's plan for the portal),
            plan-words.js, evidence-summary.js and plan-report-words.js (words the
            command and the portal both say), retention.js (how long logs are kept), setting-names.js,
            environments.js (what an environment's key is: one row in `sealeye
            list`, one page in the portal, the page `sealeye online <app>` opens),
            operations.js (every operation's command, aliases and portal label),
            discovery-words.js (what both surfaces say about a discovery run, a
            catalog's status and its self-test), developer-words.js (the cloud's
            names, and sizes and counts, that a developer never reads), catalog-edits.js
            (which words of a draft's entry a person may change, and keeping them).
            secrets.js, scan.js, upload-rules.js, plan-words.js, evidence-summary.js,
            plan-report-words.js, retention.js, setting-names.js, environments.js,
            operations.js, discovery-words.js, developer-words.js and catalog-edits.js run in a browser,
            so the portal imports them too
prompts/    system prompt and the starter's passages for it (interview-starter.yaml), plan
            contract, plan, report and evidence templates, catalog
templates/  one CloudFormation template per buildable module, plus run.sh,
            sealeye-settings.mjs (the settings reader run.sh loads first) and
            sealeye-handler.mjs (the adapter a module that calls a function gets)
deploy/     the pilot server: Dockerfile's start script, its CloudFormation (server,
            deploy role, Terraform role, foundation), compose, Caddy, and the release
            scripts. deploy/README.md
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
   Both take their words from `core/operations.js`: the command its word and aliases,
   the portal its labels and every command line it shows (`test/operations.test.js`).
2. **seaLeye never names a module it cannot build.** What an app needs beyond the
   buildable modules is a NEED: a sentence from the known kinds in
   `prompts/module-catalog.yaml`, or, when none fits, an `unlisted` need with a line of
   its own in the same form ("a ..."), naming the kind of thing and never a product or
   a module (`unlistedNeedProblems` in `core/schema.js`). Evidence, naming the file and
   what in it shows the need, is required either way.
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
   `sealeye plan --out` writes a deployment's plan and report only into the folder it
   names, and never over a file that is there.
6. **No secrets, anywhere.** Setting values, ConfigValue parameters and .env contents
   never appear in evidence, markdown, the terminal, the ledger, logs or the portal.
   Names only, with "value redacted" where a value would be. Credentials come from the
   environment, the repo `.env` or `~/.sealeye/config`, never from the repo. A value
   that looks like a secret in an app's code (`core/scan.js`) never reaches the model or
   a deploy: a finding is a file, a line, a rule and a kind, and never the value.
7. **Nothing is typed in.** Every value in a report, evidence file or ledger is read from
   a record, from a file seaLeye wrote, or from AWS at the moment of generation. A value
   that could not be read says so in words and is never guessed or left as a dash.
8. **Plain language.** Every CLI step prints one plain-language line of what the
   platform is doing. Developers see no product or trademark names (Lambda, Terraform)
   and no one cloud's own nouns (log group), no em dashes, and no sizes, counts or
   capacity numbers in any plan, card or file: capacity is "set by a load test",
   always. Words every cloud uses the same way are fine (subnet, region, bucket), as are
   Kubernetes and Docker; an acronym is spelled out in the same line ("Virtual Private
   Cloud (VPC)"); a configuration choice is said as what it does for the app ("keeps
   running if one data centre fails", never "multi-AZ"). `core/developer-words.js`
   holds the rule (DESIGN.md, "What a platform term is").
9. **Developers deploy to dev.** The profile describes what the plan is designed for;
   promotion to later stages goes through the organization's pipeline and approvals.
10. **Never hard-code an organization.** The org name comes from `ORG=` in
    `~/.sealeye/config`, default "your organization".
11. **Every model call goes through the gateway, named, and carries no content out.** On
    the server, the API holds no model key and calls the model only through the gateway
    (`deploy/gateway.yaml`), with a token it signs naming the person, team, run, worker
    and surface. The gateway's log and its record of calls hold who, which run, tokens
    and cost, never a prompt, a reply, a token or a key: no setting that captures
    `llm.prompt` or `llm.completion`, and `database.llm` is `metadata`.
    `test/gateway-config.test.js` keeps it so.

## Names

- The product is seaLeye. The command is `sealeye`. Commands that act on an environment
  take the app's name (your team's environment of that name) or a deployment id; with
  neither, the app the current folder's sealeye.yaml plans. Its subcommand that interviews and
  deploys is `run`; `init` is a hidden alias that does the same thing and never prints a
  deprecation notice. Tearing down is `teardown`, the portal's "Tear down"; `destroy` is
  a hidden alias, as `init` is.
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
  HOME, TRACING, MODEL_URL, API, PORTAL, TOKEN, AUTH, RUN_CAP, GATEWAY_KEY, GATEWAY_BUDGET,
  GATEWAY_SIGNING_KEY, LIBRARY_REPOS, GITHUB_APP_ID, GITHUB_APP_KEY, GITHUB_READ_TOKEN,
  DISCOVERY_WORKER_CAP, DISCOVERY_RUN_CAP, TERRAFORM_ROLE_ARN, TOFU),
  read through `setting()` in
  `core/config.js`. SEALEYE_TOKEN is a secret: it lives in `~/.sealeye/config` (0600),
  is never printed, logged or put on a record. SEALEYE_GATEWAY_KEY is a secret too: the
  key the API calls the platform's model gateway with, kept in the server's settings. So
  is SEALEYE_GATEWAY_SIGNING_KEY, the Ed25519 key the API signs each model call's token
  with (`api/gateway-token.js`); the gateway holds only its public half.
  SEALEYE_GITHUB_APP_KEY (the GitHub App's private key) and SEALEYE_GITHUB_READ_TOKEN are
  secrets too: what the API reads a platform library with, from the server's settings,
  sent to GitHub's API and nowhere else (`api/discovery/github.js`).
- `deployme` was the original name. Until 2.17.0 the plan file was `deployme.yaml`, the
  config folder `~/.deployme`, and settings `DEPLOYME_*`. They are still read, never
  written. Only `core/config.js`, `core/names.js`, `core/schema.js` and `api/store.js`
  may name them. The word never appears in anything a developer or portal user sees.
- Brand: every command prints `prompts/banner.txt` first. Terminal colours live only in
  `cli/brand.js`. Prompts are amber `ask()`, echoed answers phosphor `answer()`,
  platform actions dim `step()`.

## The plan contract

planVersion 0.5 (`core/schema.js`). A plan names its catalog (`catalog: starter`, or
the version of one of the organization's catalogs that is or was live), and its module
ids and need kinds are checked against that catalog (`schemaFor` in `core/catalog.js`,
`api/validate.js`). A module is buildable when its catalog marks it `availability:
available` and an executor builds what its `builds_with` names (`EXECUTORS`:
cloudformation and the starter's four, static_site_edge, http_api_serverless,
observability_basic, config_basic; terraform, a module whose every required input has a
source, that takes the app's code and runs no commands, `terraformBuilds` in
`core/terraform-modules.js`), and no question it rests on is still open (`open`). What a
catalog builds is read with the organization's platform values beside it
(`withPlatform` in `api/platform.js`), never stored in it. 0.2, 0.3 and 0.4 plans are read as 0.5 against the
starter: a planned module in a 0.2 or 0.3 plan is read as the need it described and the
plan becomes a draft. The interview's model writes the 0.4 shape with its catalog's
modules (`interviewContract`; `planSchema04` for the starter) and never a catalog: the
graph stamps the plan 0.5 with the interview's own (`stampCatalog`). `core/schema.js` is the only file allowed to
name the old module ids, and only for that. Changing the contract is a DESIGN.md
decision.

Each organization may have catalogs of its own (`api/catalogs.js`, the `catalogs` table:
draft, approved, live, retired; one live). One with no live catalog has the starter,
`prompts/module-catalog.yaml`, word for word. The API hands the functions in
`core/catalog.js` the catalog a plan or a record names, or for the catalog listing and
the needs ledger the organization's live one. A catalog goes live in two steps, each
behind the self-test (`api/self-test.js`, PHASE4-PLAN Step 7): an organization-wide
token approves a draft, then makes an approved or retired one live, which is refused
while any environment of the organization runs on a module it would not build (409
CATALOG_IN_USE, `api/catalog-use.js`). The self-test is plain code: the catalog's shape,
no question about the whole catalog open, a plan for each module that must be refused
refused and one for each it builds accepted (by the same check as POST
/plans/validate), and no product name, unspelled acronym, setting, size or count in the words a developer reads
(`core/developer-words.js`). A deploy whose plan names a replaced
catalog that no longer builds a module it uses is refused with 409 CATALOG_CHANGED. The
command draws its card and DEPLOYMENT_PLAN.md from `GET /catalog?version=`, never its
own copy (`catalogForPlan` in `cli/client.js`).

## API

POST /plans/validate, POST /deployments ({ plan, appPath, zip?, settings? }, or
{ fromDeployment, plan? } to deploy code the platform already has again), GET /deployments,
GET /deployments/events (server-sent events: the id of each deployment the caller can see
whenever what GET /deployments shows of it changes; five minutes a stream), GET /deployments/{id}, GET /deployments/{id}/plan (the plan as approved and the report), GET /deployments/{id}/evidence, GET /deployments/{id}/logs (masked), GET /deployments/{id}/performance (readings), GET /deployments/{id}/paused and POST
/deployments/{id}/pause and /resume (APIs only), DELETE /deployments/{id},
GET /needs, GET /health, GET /interviews (your own still open), POST /interviews ({ app, zip, findings? },
answered with the interview and its findings), POST
/interviews/{id}/answers ({ answer }), GET /interviews/{id}/events (server-sent events),
DELETE /interviews/{id}, GET /whoami, GET /team (people with tokens, never a token), GET /costs (by tag), GET /catalog (the organization's live catalog, or the starter, and which; ?version= the one a plan names; `document` is it as clients draw a plan from it, only what the platform builds), GET /apps/{app}/settings, PUT
/apps/{app}/settings/{name} ({ value }) and DELETE /apps/{app}/settings/{name} (an app's
settings in the store: names out, values in, never back), POST /sessions ({ token }) and
DELETE /sessions (the portal's sign-in and sign-out), GET /platform (?stage=; the
organization's platform values and what each Terraform module still needs), PUT and
DELETE /platform/values/{name} ({ value, stage? }: a word or a list of words, never a
secret), an organization-wide token's only, POST /discoveries (a run over the
library the server names), GET /discoveries, GET /discoveries/{id} (the run and its
questions, and whether an answer is being written into the draft), GET /discoveries/{id}/events (server-sent events), GET
/discoveries/{id}/catalog (its draft), POST /discoveries/{id}/answers ({ question, answer },
while it runs or after); discovery is an organization-wide token's only, one run at a time for an organization (409 RUN_GOING), over one library repository (409 ONE_LIBRARY). GET /catalogs (the organization's catalogs and which is live), GET
/catalogs/{v}/self-test (its word check names each field to change, which `sealeye catalog
fix` and the portal walk with the edits below), POST /catalogs/{v}/approve (a draft; 422 SELF_TEST_FAILED with
the result) and POST /catalogs/{v}/live (an approved or retired one; 422
SELF_TEST_FAILED, 409 CATALOG_IN_USE), GET /catalogs/{v} (one, with its document) and
POST /catalogs/{v}/edits ({ module, field, text }: a draft's words only, answered with
the self-test), an organization-wide token's only too. Every endpoint but GET /health
and the two /sessions needs `Authorization: Bearer <token>` (`api/tokens.js`) or the
portal's session cookie; a change made with the cookie must also carry
`x-sealeye-portal: 1`. A record says which surface made it. A laptop API may run with
`SEALEYE_AUTH=off`, an API with a database never can. The person on a record is the
token's, never what the command line says. An interview is its starter's; a record is
its team's, seen by that team and by an organization-wide token, never by another
organization; the needs ledger is the whole organization's, but an app's evidence and
deployment id in it are its team's (and an organization-wide token's). One change at a
time per environment: a deploy, deploy again, tear-down, pause or resume while another
change to it is queued, packaging, running or tearing down is refused with 409
ENVIRONMENT_BUSY (`api/busy.js`), naming what is under way; drafted plans are still
saved. GET /deployments marks a success a later success replaced (`replaced`,
`replacedBy`) and carries the live `step`, and each record says what its environment
offers (`operations`, `environmentOperations` in `core/operations.js`). A deploy whose
plan's catalog says `builds_with: terraform` is built by the Terraform executor, whatever
`backend` the request names; one that executor cannot build is refused with 409
CANNOT_BUILD, and an environment built one way is not built the other until it is torn
down (409 ENVIRONMENT_BUILT_ANOTHER_WAY). Logs, pause, resume and performance answer 409
NOT_FOR_THIS_ENVIRONMENT for a Terraform environment. A deploy whose code looks like it holds a
secret is refused with 422 SECRETS_FOUND (file, line and rule, nothing kept); when the
scan itself cannot finish, an interview or a deploy is refused with 503 SCAN_FAILED.
Keep existing endpoints and commands working; add, do not break.

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
  machine. Before anything is queued the code is scanned (`api/secret-scan.js`: the
  shared rules, then gitleaks with seaLeye's own configuration, never one found in the
  folder, and `gitleaks:allow` ignored); a finding refuses the deploy unless the
  developer's `.sealeye-allow` names its line, and the record keeps what was allowed
  (file, line, rule) for the evidence. A deployment made again (`fromDeployment`, `sealeye deploy --again`, the
  portal's Deploy again) stages nothing: it reuses the earlier artifact in S3, checked
  first with head-object, and takes every setting from the store. APIs only.
- Status map: CREATE/UPDATE_IN_PROGRESS -> running; CREATE/UPDATE_COMPLETE ->
  succeeded; anything with ROLLBACK or FAILED -> failed, with the first CREATE_FAILED
  reason from describe-stack-events, read before any cleanup; DELETE_IN_PROGRESS ->
  destroying; stack gone -> destroyed. A terminal status is ignored until this
  deployment's own operation is visibly under way. A static deploy succeeds only after
  the sync. ROLLBACK_COMPLETE is deleted; UPDATE_ROLLBACK_COMPLETE is not.
- Static destroy empties the bucket before delete-stack.
- **The Terraform executor** (`api/executor/terraform/`, PHASE4-PLAN Step 9) builds a
  plan of one module from the organization's library at the commit its catalog names,
  fetched read-only with discovery's reader and checked again for anything it would
  run. It writes `main.tf.json` (the module by its folder, inputs from seaLeye, the
  app's code and the platform values, the plan's own optional inputs; S3 state under
  `tofu-state/<org>/<environment>.tfstate` with a lock file; AWS provider 5.100.0), then
  `init`, `plan`, `apply`, `output`, with `tofu` given only what it needs
  (`tofuEnv`) and acting through the Terraform deploy role (SEALEYE_TERRAFORM_PROFILE).
  Status is OpenTofu's exit and the outputs read back; a site's files are synced after,
  through the same role. A restart during a build fails it, keeping the state's lock
  for `deploy/server.sh tofu-unlock`. The module's `name` is `moduleName` in
  `core/names.js` (at most 31 characters), its stage always dev; settings never travel
  to it. `npm test` uses a stand-in `tofu` (SEALEYE_TOFU); `.github/workflows/tofu.yml`
  runs the real one (`scripts/tofu-check.js`).

## Interview

- The interview runs in the API (`api/interview/`) as a LangGraph graph with
  `claude-sonnet-5` (`SEALEYE_MODEL` overrides) via @anthropic-ai/sdk, temperature 0.2,
  at `SEALEYE_MODEL_URL` when set. The API holds ANTHROPIC_API_KEY, or on the server
  only SEALEYE_GATEWAY_KEY, the model key being the gateway's (`modelCredential`);
  without either, POST /interviews says so. `sealeye run` uploads the folder (`core/upload.js`: without
  what `.gitignore` leaves out, secret files as names only), follows the events and sends the answers; it holds no keys.
- An interview starts with the organization's live catalog and keeps it in its saved
  state. Its prompt and plan tool are built from that catalog: the passages of
  `prompts/interview-system.md` that speak of the modules (`{{name}}`) are the
  catalog's (`interviewPassages` in `core/catalog.js`; the starter's in
  `prompts/interview-starter.yaml`, which, like the prompt, never leaves the server),
  or written from its modules and rules. It never hears of a module the catalog does not
  build. The starter's prompt and tool are pinned by `test/interview-catalog.test.js`:
  changing them means running the eval before and after, then updating the pins.
- Each `interrupt()` (a question, "Deploy this?") is in a node of its own with no model
  call before it. An interview's scratch folder and saved state are deleted when it
  ends, or after a day.
- Tools: list_files and read_file, read-only, inside the app folder only (no `..`, no
  symlinks out, no node_modules, .git, .sealeye); read_file capped at 20 KB,
  list_files at 40 entries. read_file refuses secret files (`core/secrets.js`: `.env`,
  `.env.*` except `.env.example` and `.env.sample`, `.envrc`, keys and keystores, SSH
  keys, package-manager and git credentials, Terraform variables and state,
  service-account JSON); list_files still shows their names, and the upload carries
  them as empty files. A line with a value that looks like a secret (`core/scan.js`,
  scanned before upload and again in the API with gitleaks) is sent and kept as a line
  saying why (`redactedLine`), so the rest of the file is read; a private key, or any
  value over several lines, sends its file empty, and read_file refuses it, naming the
  line and the kind. package.json with one is not parsed for the folder's digest. Archives and files that are not text travel as names only too
  (`isNotText` in `core/upload-rules.js`; the API empties any that arrive with contents,
  `holdNotText`), and read_file refuses them, saying so. A deploy still carries them. LangSmith tracing stays off in the API (it would send file
  contents). submit_plan(plan, summary,
  assumptions) ends it.
- Tracing (LangFuse, `core/tracing.js`) is on only when the API has LangFuse keys, and
  `sealeye run --no-trace` or `SEALEYE_TRACING=off` turns it off for that interview; a
  switch that does says so in one line. An interview is one trace across its pauses. It records the shape of each turn, file paths and sizes, never
  file contents; anything new the interview records goes through those helpers, not
  straight to LangFuse.
  Scores are numbers and yes-or-no values from the fixed list in `core/tracing.js`;
  `deployment_succeeded` is scored only from a final status read from the platform.
- Every reply is priced from `core/model-prices.js` (never LangFuse) and added to the
  run's spend, keyed by worker; before each model call, a run that has reached its cap
  (`SEALEYE_RUN_CAP`, a dollar by default) stops with status `stopped`, reason
  `spending_limit` and `spendingLimitWords`, so it can go past the cap by one reply.
  A model with no price never starts (503 MODEL_NOT_PRICED). `release.sh` warns when
  the prices were checked more than 90 days ago.
- Every model call, the interview's and discovery's, streams its reply (`askModel` in
  `api/interview/model.js`): it waits up to 120 s for the reply to start, and then gives
  up only when the model goes quiet for 60 s, never on the reply's length; either is
  retried once. Through the gateway, a streamed call carries its signed token too.
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
known need's line from `prompts/module-catalog.yaml`, counts an unlisted need by its own
words in a row marked "not in the list yet", and never names a vendor or a date. The
refusal says the plan is drafted and saved, lists the needs with evidence, and says that
when the organization's Platform Library supports them, `sealeye run` again finishes
the plan. No mechanism, no vendor, no date, never "coming soon".

## Current limits (change through ROADMAP.md, not ad hoc)

- Two backends: CloudFormation for the starter's four, and OpenTofu for an
  organization's own Terraform modules, one module a plan until modules can be
  connected. No GitHub Actions or CodePipeline yet.
- Region ca-central-1 (`SEALEYE_REGION` is an explicit opt-out). Runtime nodejs20.x.
  No CloudFront from seaLeye's own templates; an organization's module may use it.
- The API runs on one pilot server (https://api.sealeye.online, `deploy/`), with
  records and interviews in Postgres, or locally with a JSON file and interviews in
  memory (no `DATABASE_URL`). No sign-in yet: each person has a token, issued with
  `deploy/server.sh token add` and kept by `sealeye login`, a stand-in until Q3 (ROADMAP
  Phase 5, Q16). Tokens are in org "default", except the pilot's second organization,
  `juniper` (`deploy/server.sh token add ... --org juniper`), where Juniper Mutual's
  discovered catalog may go live. An app's settings and costs are kept by team, not yet
  by organization, so they answer 409 NOT_FOR_THIS_ORGANIZATION to any organization
  but default; a plan built from the organization's own modules deploys in any
  organization, since it reads no settings. A token is for one team, or issued
  `--org-wide` to see every team's.
  The store reads from memory, written through to Postgres: one API process only.
  Every model call on the server goes through agentgateway, a container beside the API
  (`deploy/gateway.yaml`, `deploy/gateway.sh`), which holds the model key and a money
  budget for each 30-day period; only the API can reach it. Every call carries a token
  the API signs, naming the person, team, run, worker and surface, which the gateway
  requires and logs.
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
  pause, settings, configure, history, plan and report, performance, logs, evidence), Validate (check a plan, and deploy a ready one with the
  code the platform has), Catalog (modules and the needs ledger), Costs, Team, Health,
  and Discovery (Edit words on its draft, and its Catalogs card: the self-test, Edit
  words on any other draft, Fix what blocks approval, Approve,
  Make live), and Platform (the organization's platform values), shown only
  to an organization-wide token. Control shows only what an environment offers. Costs and the Settings card are shown only to an
  organization whose settings and costs are kept (`hasSettingsAndCosts` in
  `core/token.js`); the header names the token's own organization. Integrations is
  drawn in the archived mock-up only (Phase 5); the portal shows nothing it cannot do.

## Working here

- `npm test` before every commit; GitHub runs it on every push and pull request
  (`.github/workflows/test.yml`), with Postgres. It needs no AWS and no API key. Tests that need
  Postgres run only with `SEALEYE_TEST_DATABASE_URL` set (a server they may create
  databases on), and are skipped without it.
- `npm run eval:discovery` grades a catalog against the made-up organization's answer key
  (`test/fixtures/sample-platform/answer-key.yaml`; the library is the private
  `GregKliewer/sealeye-sample-platform`). `--library <clone>` also checks the key against
  the library and the scanner against its planted secret; with `SEALEYE_SAMPLE_PLATFORM`
  set to a clone, `npm test` does too. No model, no keys.
- A platform library is read by `readLibrary` (`api/discovery/library.js`): one commit,
  read-only, walked by `core/upload-rules.js` with purpose `discovery` (`.github` read,
  secret files as names), scanned again with gitleaks, each flagged line replaced, and no
  `.sealeye-allow` honoured. `deploy/server.sh library-check` reads the repositories in
  `SEALEYE_LIBRARY_REPOS` on the server that way. A discovery worker asks the gateway for
  a route (`small`, `frontier`; `api/model-routes.js`), never a model by name.
- A discovery run (`api/discovery/service.js`) never waits on a person: readers raise
  questions with a guess, and an answer re-writes only the entries it touches, whenever
  it comes. Code, not the model, reads each module's inputs, decides which entries rest
  on an open question, and applies the questions the supervisor merges (`merges`).
  Entries whose words fail the self-test's word check go back to the supervisor once, to
  be written in plain words, before the draft is kept (`inPlainWords`). A
  run is traced in LangFuse as its shape only (`traceDiscovery`, `traceDiscoveryCall` in
  `core/tracing.js`): workers, files by path and size, tokens, cost, questions by kind;
  never a file, a prompt or a reply. `npm run eval:discovery -- --run --library <clone>`
  runs it for real twice (it needs a model key), with no answers and with the answer
  key's at fixed points, grades each draft with its self-test, prints each worker's
  spend, and with LangFuse keys records both as the `sealeye-discovery` dataset. Run it
  before and after any change to discovery or its prompts.
- `npm run eval:interview` before and after any change to `prompts/`. It runs the
  interview graph in-process on each sample app, grades the plans, and records a
  LangFuse dataset run; it needs ANTHROPIC_API_KEY and LangFuse keys, and deploys
  nothing. It runs two sets (`--set starter` or `--set juniper` for one): the
  starter's, and Juniper Mutual's, planned against a snapshot of its live catalog
  (`test/fixtures/juniper-catalog-3.json`, cases in `test/fixtures/eval-juniper/`)
  with its Terraform modules treated as built for the eval only (`treatAsBuilt`).
- `npm start` runs the API from the repo root; `npm link` from the repo root installs
  `sealeye`. The command talks to https://api.sealeye.online unless `SEALEYE_API` or
  `--api` says otherwise, so point it at `http://localhost:3000` for a local API.
- `sealeye online` (also `portal`, `open`) opens the portal, or with an app's name or a
  deployment id, that environment's page. The portal's address follows the API's
  (`portalFor` in `core/config.js`); `SEALEYE_PORTAL` names it outright. Signing in
  comes back to the page asked for.
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
