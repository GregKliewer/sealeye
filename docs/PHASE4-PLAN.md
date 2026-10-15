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
  and no file with a finding reaches a model.

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
| D6 | A discovery run's caps | A cap per worker and per run, set from a measured run on the made-up organization, as Phase 3 sized the interview's dollar. Placeholder until measured: a dollar a worker, twenty a run | Step 6 | Greg, Wed Oct 14: as recommended |
| D7 | Where a platform engineer answers the swarm's questions | Both surfaces, one operation: `sealeye discover` and a Discovery page, on an endpoint first (parity). The run pauses with `interrupt()` and waits in Postgres, as the interview does | Step 6 | Reopened, Greg, Wed Oct 14: a run that waits on a person stalls until someone notices. Look first at ways a whole run finishes quickly without pausing. Now Q19 in OPEN-QUESTIONS.md; blocks Step 6, not Part A |
| D8 | The Terraform executor's scope | One root module per environment that calls the organization's module by source and version; state in an S3 bucket with a lock file, in the account the environment is built in; `terraform` run by the API like the AWS CLI. Only modules discovery marked buildable, with their inputs from the catalog | Step 9 | Greg, Wed Oct 14: as recommended |
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

- The system prompt is built from the live catalog per interview, not once at start.
  The eval runs against the starter catalog and must not move.
- A catalog too large for the prompt is summarised per module (its line, when, signals),
  with the full entry read by a tool on demand. The size at which that starts is
  measured, not guessed.

## Part B: the discovery swarm

### Step 4. The made-up organization (D1, D2, D9)

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

- Plain code: clone the named repositories read-only at a commit, walk them with the
  same rules the upload uses (`core/upload-rules.js`), and scan everything with the
  secret scanner before any model sees it (its first node, as ROADMAP Phase 4 asks).
- Named routes in the gateway: `small` and `frontier`, both on the Anthropic route for
  now. The token's `worker` claim names the worker, so each one's spend and calls show
  in `gateway-calls`.

### Step 6. The swarm (D5, D6, D7)

- A LangGraph supervisor fans out one worker per module, in parallel, gathers their
  findings, and writes the catalog entries. How it handles ambiguity (two modules that
  overlap, a rule that contradicts a README) is Q19: pausing for a platform engineer, as
  first planned, or finishing the run and leaving the questions on the draft.
- Each worker has its own cap, and the run has one, in the graph's existing `spend` map
  keyed by worker. The gateway's per-run limit and budget stay the outer limit.
- `POST /discoveries`, `GET /discoveries/{id}/events`, `POST /discoveries/{id}/answers`:
  the interview's shape, reused. `sealeye discover` and the Discovery page on top.
- Only modules changed since the last run are read again.

### Step 7. Self-test, then live

- The made-up organization's answer key, as a LangFuse dataset, graded on every change
  to discovery: entries right, must-refuse cases refused, hard cases caught.
- Must-refuse plans: for each catalog, plans that must be refused, and are. A catalog
  goes live only when they pass and a platform engineer approves it.

## Part C: building from the organization's modules

### Step 8. The front door plans from a discovered catalog

- The interview, unchanged, against the made-up organization's live catalog. Its eval
  gains apps whose right plan uses that organization's modules.

### Step 9. A Terraform executor (D8)

- `terraform` in the API's image, pinned and checked like gitleaks. One root module per
  environment that calls the organization's module, with inputs from the plan; `plan`
  then `apply`; status mirrored from Terraform as it is from CloudFormation today
  (principle 4).
- State per environment in S3 with a lock file. The deploy role gains what the
  made-up organization's modules create, and nothing else.
- Built for the made-up organization's modules first. CloudFormation stays for the four
  built-ins.

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
| 6 | The swarm, on both surfaces | five to seven days |
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
| **LangFuse in Canada** (D1) | Before the first run on an organization's real code, or any pilot that wants traces on real code. The gateway's span in the trace (once Phase 3 Step 6b) comes with it. |
| **A new account per customer, and a paid run** (D2) | The first customer run. |
| **The Bedrock route** (Phase 3 Step 8) | When the account has model access; then an organization's code can stay in its own account. |
| **Admin onboarding** (identity provider, repositories, which automation is strategic) | With Phase 5's Cognito sign-in, since both need an organization's administrator. Until then the platform team names repositories in a setting. |
| **Public module libraries at scale** | After Step 7, for cost caps and scale; no answer key, checked by hand. |
