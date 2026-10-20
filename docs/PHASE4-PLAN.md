# Phase 4 plan: seaLeye learns an organization's platform

Written Wed Oct 14, 2026, after Phase 3 was built apart from routing (Step 8, waiting
on the account's Bedrock access) and the gateway's span in the trace (moved here). A
draft for Greg: the decisions below are recommendations until he answers them. Nothing
in it is built yet.

**Goal** (ROADMAP Phase 4): seaLeye builds from the organization's own modules, not only
its four. A discovery agent reads the organization's platform library and writes a
catalog: each module, what it is for, its usage rules and what must be refused. The
front door agent plans from that catalog. Nothing is fine-tuned.

**Done when:**
- discovery reads a made-up organization's library and writes a catalog that passes
  its answer key: every must-refuse case refused, every planted hard case caught;
- the front door agent plans a sample app from that catalog;
- the executor builds it from that organization's own Terraform module;
- a developer whose app needs something the catalog cannot build is refused, and the
  gap report counts it;
- every model call in a discovery run is capped, named and routed through the gateway,
  and no value the scanner finds reaches a model (each such line is replaced, and the
  rest of its file read: Greg, Oct 15, 2026).

The plan has four parts, in the order the dependencies force.

- **Part A** (Steps 1 to 3) makes the catalog data instead of a file, so there can be
  more than one, without changing what any developer sees.
- **Part B** (Steps 4 to 7) builds the discovery swarm and the made-up organization it
  is graded against.
- **Part C** (Steps 8 and 9) builds from a discovered catalog: the front door plans from
  it and a Terraform executor builds it.
- **Part D** (Steps 10 and 11) is the gap report and writing it down.

## What the code looks like today

- **One catalog, in a file.** `prompts/module-catalog.yaml` holds the four modules and
  the fixed list of need kinds. `core/catalog.js` reads it; the interview's system
  prompt has it substituted in (`catalogForPrompt`).
- **Four module ids, written into the contract.** `MODULE_IDS` in `core/schema.js` is the
  plan contract's enum (planVersion 0.4). `isBuildable` is "one of the four".
- **One template per module, one backend.** `templates/` holds a CloudFormation
  template for each buildable module; the executor (`api/executor/`) shells out to the
  AWS CLI.
- **Needs are already the refusal.** A plan with needs is drafted and refused
  (UNSUPPORTED_NEEDS); the ledger (`api/needs.js`) counts them per app and team.
- **The backbone is in place.** Every model call goes through the gateway with a
  per-call token naming its run and worker; each run has a dollar cap keyed by worker
  (`spend: { interview: ... }`, built for this phase); the secret scanner runs on
  everything that arrives.
- **One evaluation.** `npm run eval:interview` runs the interview on three sample apps
  and records a LangFuse dataset run.

## Decisions this plan needs from Greg

| # | Decision | Recommendation | Needed by | Decided |
|---|---|---|---|---|
| D1 | Where traces live during Phase 4 | LangFuse Cloud, as today. Self-hosting in ca-central-1 waits until the first run on an organization's real code: a precondition for that run, not for Phase 4. Every run before it reads seaLeye's own templates, the made-up organization or public modules | Step 4 | Greg, Wed Oct 14: LangFuse Cloud; "no one will be picking this up at a real bank any time soon" |
| D2 | Where discovery runs before a customer | In the seaLeye account, like the pilot. A new account per customer, and a paid run, start with the first customer, as decided Oct 13 | Step 4 | Greg, Wed Oct 14: as recommended |
| D3 | How the swarm reads the library (Q17) | Plain code in the graph: a read-only clone of named repositories, at a named commit. The model never chooses what is read. A provider's MCP server later, through the gateway, where one adds something a clone cannot | Step 5 | Greg, Wed Oct 14: as recommended. Answers Q17 |
| D4 | What a catalog is | A versioned document per organization in Postgres, in the same shape as `module-catalog.yaml`. The four built-ins become a starter catalog. Plans name the catalog version they were made from (planVersion 0.5). A catalog goes live only when a platform engineer approves it and it passes its self-test | Step 1 | Greg, Wed Oct 14: as recommended |
| D5 | Which models the swarm uses | Workers read with the small model (`claude-haiku-5-5`); the supervisor and the rule writer use the frontier model (`claude-sonnet-5`). Both through the gateway on the Anthropic route, as named routes: the non-Bedrock half of Phase 3 Step 8, brought forward | Step 5 | Greg, Wed Oct 14: as recommended |
| D6 | A discovery run's caps | A cap per worker and per run, set from a measured run on the made-up organization, as Phase 3 sized the interview's dollar. Placeholder until measured: a dollar a worker, twenty a run | Step 6 | Greg, Wed Oct 14: as recommended. Set Thu Oct 15 from the first measured run (US$0.18, no worker over half a cent): ten cents a worker, three dollars a run |
| D7 | Where a platform engineer answers the swarm's questions | Both surfaces, one operation: `sealeye discover` and a Discovery page, on an endpoint first (parity). The run pauses with `interrupt()` and waits in Postgres, as the interview does | Step 6 | Greg, Thu Oct 15 (Q19, reopened Oct 14): the run never pauses. Questions go out on the run's events as they arise and sit on the draft with a guess; an answer is used if it comes before its entry is written, and re-runs only the entries it touches if it comes later. A guess never goes live. Both surfaces, one operation, as first written (DESIGN.md, "A discovery run never pauses") |
| D8 | The Terraform executor's scope | One root module per environment that calls the organization's module by source and version; state in an S3 bucket with a lock file, in the account the environment is built in; `terraform` run by the API like the AWS CLI. Only modules discovery marked buildable, with their inputs from the catalog | Step 9 | Greg, Wed Oct 14: as recommended. Sat Oct 17, its details (DESIGN.md, "A Terraform executor builds an organization's own modules" and the four entries after it): OpenTofu; a role of its own; platform values by stage on both surfaces; a foundation network; how a module takes an app read by code; settings and modules that run commands refused; versions and connecting modules in a second pull request |
| D9 | What the made-up organization is | A private repository, `sealeye-sample-platform`, of 10 to 15 Terraform modules and a few pipeline files, with an answer key in a file discovery never reads. Built at the start of Part B | Step 4 | Greg, Wed Oct 14: as recommended, with modules that are commonly assembled into the same kind of application (a backend API, a website, or another), so a sample app can be planned from several of them together |

## Part A: one catalog becomes many

### Step 1. The catalog as data (D4)

Built Wed Oct 14, 2026: `api/catalogs.js`, `api/migrations/006_catalogs.sql`, and
`core/catalog.js`'s `starterCatalog` and `catalogProblems`. The API reads the
organization's live catalog for `GET /catalog`, the need lines in `POST /plans/validate`
and the ledger, the plan files it writes and the evidence's patterns. Nothing makes a
catalog live from a request: that waits for Step 7's self-test. The interview's prompt
is still the starter's (Step 3), and so is the command's card, which reads its own copy
of the file (Step 2 moves it to `GET /catalog`).

- A `catalogs` table: organization, version, status (draft, approved, live, retired),
  the document, who approved it, when. One live catalog per organization.
- The four built-in modules, the need kinds and the profiles become the starter
  catalog, loaded for any organization with none. `prompts/module-catalog.yaml` stays
  as its source, so nothing a developer reads changes.
- `core/catalog.js` takes a catalog instead of reading the file; the API hands it the
  organization's live one. Tests: an organization with no catalog gets the starter one,
  word for word.

### Step 2. The plan contract learns which catalog (D4)

Built Thu Oct 15, 2026 (DESIGN.md, "A plan names its catalog"): `contractSchema` and
`EXECUTORS` in `core/schema.js`; `isBuildable`, `schemaFor` and `buildableView` in
`core/catalog.js`; `api/validate.js` checks a plan against the catalog it names;
`GET /catalog?version=` with a `document`; `catalogForPlan` in `cli/client.js`;
`catalogSentence` in `core/plan-words.js` for `sealeye catalog` and the Catalog page.
Two things beyond the list below: a deploy whose plan names a replaced catalog that no
longer builds a module it uses is refused (CATALOG_CHANGED), and contract errors carry
the values the plan's catalog allows. The interview's tool and prompt are unchanged,
byte for byte; its plan is read as 0.5 against the starter until Step 3.

- planVersion 0.5: a plan names its catalog's version, and its module ids are checked
  against that catalog, not a fixed enum. 0.4 plans still load, read against the starter
  catalog. Changing the contract is a DESIGN.md decision, written in this step.
- `isBuildable` asks the catalog: a module is buildable when the catalog marks it so
  and the platform has an executor for its kind. Anything else is a need, as today:
  refuse, never shrink.
- `GET /catalog` already exists on both surfaces; it shows the organization's live
  catalog and its version (the API sends `catalog: { version, source }` since Step 1;
  the command and the Catalog page show it in this step).
- The command draws its card and writes DEPLOYMENT_PLAN.md from its own copy of the
  starter catalog today. It reads the organization's catalog from the API instead, so
  an organization's own module reads the same on both surfaces.

### Step 3. The interview reads the organization's catalog

Built Thu Oct 15, 2026 (DESIGN.md, "The interview reads the organization's catalog"):
the first bullet below, and more than it said. The prompt named the starter's four
modules in several places, so those passages became the catalog's
(`interviewPassages`; the starter's in `prompts/interview-starter.yaml`, word for word),
the plan tool is built from the catalog, the platform stamps the plan with the
interview's catalog, and the interview keeps the catalog it started with. The starter's
prompt and tool are byte for byte the ones the eval graded that morning. The second
bullet, a catalog too large for the prompt, moved to "Owed after this plan" (Greg, Thu
Oct 15): its size is to be measured, and there is no large catalog to measure until
public module libraries are read after Step 7. Part A is done.

- The system prompt is built from the live catalog per interview, not once at start.
  The eval runs against the starter catalog and must not move.
- A catalog too large for the prompt is summarised per module (its line, when, signals),
  with the full entry read by a tool on demand. The size at which that starts is
  measured, not guessed.

## Part B: the discovery swarm

### Step 4. The made-up organization (D1, D2, D9)

Built Thu Oct 15, 2026 (DESIGN.md, "The made-up organization: Juniper Mutual"):
`GregKliewer/sealeye-sample-platform`, thirteen modules that each know their stage (a
fourteenth, `cache-valkey`, whose standing the library leaves unclear, added after the
second measured run; DESIGN.md, "An overlap the library settles is not a question"), the
library's own build-once-and-promote pipeline, the hard cases below with the overlap by
stage, and three gaps; the answer key in seaLeye
(`test/fixtures/sample-platform/answer-key.yaml`) and `npm run eval:discovery`. Greg
added the path to production on Oct 15, so the set exercises more than dev, and Q20 (a
module per stage in a plan) was raised. Not yet: "only what changed is read again"
waits for discovery (Step 6), and the smoke test grades the starter against itself
until then.

- `sealeye-sample-platform`: 10 to 15 modules that are commonly assembled into the same
  kinds of application, a backend API or a website, so a sample app's right plan uses
  several of them together (D9). Among them: modules that overlap (discovery must ask), a deprecated
  one (must be refused), a usage rule only in a README, a planted fake key (the scanner
  stops it before any model), and two or three known gaps for the gap report. Later
  commits test "only what changed is read again".
- An answer key beside it: the catalog a careful platform engineer would write. Graded
  by a script, as `eval:interview` grades plans.
- Discovery's first smoke test is seaLeye's own `templates/`, whose right entries are
  the starter catalog.

### Step 5. Reading the library (D3, D5)

Built Thu Oct 15, 2026 (DESIGN.md, "Reading the library"): `api/discovery/` reads one
commit of each repository named in `SEALEYE_LIBRARY_REPOS`, with a GitHub App or a
read-only token, by the upload's rules and both scans, before any model; the gateway
has `small` and `frontier`. Greg chose both ways in, flagged lines replaced rather than
files held back, no `.sealeye-allow` for a library, and the repositories in a setting.
`deploy/server.sh library-check` reads them on the server as the run will. Not yet: the
graph it is the first node of (Step 6).

- Plain code: clone the named repositories read-only at a commit, walk them with the
  same rules the upload uses (`core/upload-rules.js`), and scan everything with the
  secret scanner before any model sees it (its first node, as ROADMAP Phase 4 asks).
- Named routes in the gateway: `small` and `frontier`, both on the Anthropic route for
  now. The token's `worker` claim names the worker, so each one's spend and calls show
  in `gateway-calls`.

### Step 6. The swarm (D5, D6, D7)

Part a, the run in the API, built Thu Oct 15, 2026 (DESIGN.md, "The discovery run"),
with Greg's choices: an organization-wide token only, inputs read by code, a run cut off
by a restart stopped not resumed, and questions as choices with the guess first. Still
to come: 6b, `sealeye discover` and the Discovery page; 6c, only what changed is read
again. The caps were set from Greg's measured runs (D6).

Part b built Thu Oct 15, 2026 (DESIGN.md, "Discovery on both surfaces"): `sealeye
discover` asks each question as it arrives, `discover answers` and `discover status`
for later; the Discovery page, shown only to an organization-wide token, does the same.
Part a and b are released together, as parity asks.

Owed to Step 7, from the measured runs: questions that are the same issue in different
words (three about the caches in the fourth run) are not yet merged; the supervisor
should, when it sees the readers' questions.

- A LangGraph supervisor fans out one worker per module, in parallel, gathers their
  findings, and writes the catalog entries.
- It never pauses for a person (D7, answering Q19). A worker that cannot settle
  something (two modules that overlap, a rule that contradicts a README) writes a
  question with its evidence and a guess, marked as one, and carries on. The question
  goes out on the run's events and stays on the draft catalog. Before writing an entry,
  the supervisor uses any answer already given; an answer that comes later re-runs only
  the entries it touches. An entry with an open question is never approved.
- Each worker has its own cap, and the run has one, in the graph's existing `spend` map
  keyed by worker. The gateway's per-run limit and budget stay the outer limit.
- `POST /discoveries`, `GET /discoveries/{id}/events`, `POST /discoveries/{id}/answers`
  (taken while the run is going or after it ends). `sealeye discover` and the Discovery
  page on top: an engineer who is watching answers inline; one who is not answers on
  the draft later.
- Only modules changed since the last run are read again.

### Step 7. Self-test, then live

Built Fri Oct 16, 2026 (DESIGN.md, "A catalog goes live through a self-test, approved
and made live apart"). Still to be done on Greg's Mac, where the model key is: the
measured run before and after the supervisor's prompt change (merges), with `npm run
eval:discovery -- --run --library <clone>`, which now runs both passes and records them.

Not before Step 3 has shipped: until the interview plans against the live catalog, a
live catalog that drops a starter module would refuse every plan the interview writes
that uses it (CATALOG_CHANGED), and running it again would not help (DESIGN.md, "A plan
names its catalog").

- The made-up organization's answer key, as a LangFuse dataset, graded on every change
  to discovery: entries right, must-refuse cases refused, hard cases caught. Graded
  twice, so each result repeats: once with no answers (the questions raised and the
  guesses made), once with answers a script gives at fixed points.
- Must-refuse plans: for each catalog, plans that must be refused, and are. A catalog
  goes live only when they pass and a platform engineer approves it.

Greg's choices, Fri Oct 16, 2026 (DESIGN.md, "A catalog goes live through a self-test,
approved and made live apart"): any organization-wide token approves; approving and
making live are two steps, the self-test at each, and a retired catalog may go live
again; the self-test is code only; an open question makes its entry unbuildable rather
than holding up approval; the words a developer reads block; a second organization,
`juniper`, with a guard against making live a catalog that drops a module an
environment runs on; traces of shape only; the supervisor merges questions that ask the
same thing. About four and a half to five and a half days, with an independent review
before the pull request.

## Part C: building from the organization's modules

### Step 8. The front door plans from a discovered catalog

- The interview, unchanged, against the made-up organization's live catalog. Its eval
  gains apps whose right plan uses that organization's modules.

Built Fri Oct 16, 2026 (DESIGN.md, "The front door plans from a discovered catalog"):
`npm run eval:interview` runs a second set, the three sample apps against a snapshot of
Juniper Mutual's live catalog 3, its Terraform modules treated as built in the eval only
(Greg chose this over grading needs only, or waiting for Step 9). The glossary turn is
not in it (Greg).

### Step 9. A Terraform executor (D8)

- `terraform` in the API's image, pinned and checked like gitleaks. One root module per
  environment that calls the organization's module, with inputs from the plan; `plan`
  then `apply`; status mirrored from Terraform as it is from CloudFormation today
  (principle 4).
- State per environment in S3 with a lock file. The deploy role gains what the
  made-up organization's modules create, and nothing else.
- Built for the made-up organization's modules first. CloudFormation stays for the four
  built-ins.

Built Sat Oct 17, 2026, the first of two pull requests (DESIGN.md, "A Terraform executor
builds an organization's own modules", "What a Terraform module needs before seaLeye
builds it", "An organization's platform values", "An app that listens reaches a module
that calls a function" and "A Terraform environment's names, status and operations"):
OpenTofu 1.12.6 in the image with the AWS provider from a folder of its own; a plan of
one module, the one that takes the app's code (`http-api`, `static-site`); the
organization's platform values on both surfaces (`sealeye platform`, the Platform page);
the Terraform deploy role and the foundation network (`deploy/terraform-role.yaml`,
`deploy/foundation.yaml`); a stand-in `tofu` in `npm test` and the real one in
`.github/workflows/tofu.yml`. The first real build is on the pilot, after the steps in
deploy/README.md, "The Terraform executor". The second pull request: each module's
version from the library's tags, and connecting modules through what the library offers
(a module's access outputs to another's inputs), with the sample library given both.

The second, Sat Oct 17, 2026 (DESIGN.md, "Each module is built at the version its library
released" and "Modules are connected through what the library offers"; Greg: V1a, V2a,
V3a, V4, W1a to W7): versions from `<module>/vX.Y.Z` tags, read at each release's
commit, a new major version refused; a table, a bucket and a queue connected to the app
by their access outputs and the settings the plan names (planVersion 0.6), torn down
together. The database waits on the network (OPEN-QUESTIONS Q23).

## Part D: what was asked for, and writing it down

### Step 10. The gap report

- Read-only: what developers asked for that the live catalog cannot build, from the
  needs ledger, by how often and which teams. Demand first; a best-practice checklist
  only breaks ties.
- `GET /gaps`, `sealeye gaps`, and a Gaps page (parity).

### Step 11. Write it down

DESIGN.md entries for each decision; ARCHITECTURE.md's containers, a discovery flow and
the catalog in the data section; CLAUDE.md's plan contract (0.5) and layout; ROADMAP
Phase 4 ticked; BUILD-OUT's picture marked built.

## Order and rough effort

| Steps | What | Effort |
|---|---|---|
| 1 to 3 | The catalog as data, the contract, the interview | four to five days |
| 4 | The made-up organization and its answer key | two to three days |
| 5 | Reading the library, named routes | two days |
| 6 | The swarm, on both surfaces, taking answers live or later | six to eight days |
| 7 | Self-test, then live | two days |
| 8 | Planning from a discovered catalog | one to two days |
| 9 | The Terraform executor | five to seven days |
| 10 | The gap report | two days |
| 11 | Write it down | one day |

About five to six weeks. Part A changes nothing a developer sees and can ship on its
own. Steps 6 and 9 are the high-stakes ones: an independent review before each pull
request.

## Owed after this plan, or before the first customer

| Item | Bring it forward when |
|---|---|
| **A catalog too large for the interview's prompt** (from Step 3) | With public module libraries at scale, after Step 7: measure where the interview's plans or its cost start to suffer, then summarise each module (its line, when, signals) past that size, with the full entry read by a tool on demand. |
| **LangFuse in Canada** (D1) | Before the first run on an organization's real code, or any pilot that wants traces on real code. The gateway's span in the trace (once Phase 3 Step 6b) comes with it. |
| **A new account per customer, and a paid run** (D2) | The first customer run. |
| **The Bedrock route** (Phase 3 Step 8) | When the account has model access; then an organization's code can stay in its own account. |
| **Admin onboarding** (identity provider, repositories, which automation is strategic) | With Phase 5's Cognito sign-in, since both need an organization's administrator. Until then the platform team names repositories in a setting. |
| **The discovery screens' rough edges** (Greg, Oct 16) | Built Oct 16, 2026, with Q21's rule for platform words (DESIGN.md, "What a platform term is" and "The discovery screens' rough edges"). |
| **Public module libraries at scale** | After Step 7, for cost caps and scale; no answer key, checked by hand. |
