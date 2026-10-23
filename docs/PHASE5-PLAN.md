# Phase 5 plan: the path to production

Written Thu Oct 22, 2026, evening, after Phase 4 was built and released (2.48.1). A draft
for Greg: the decisions below are recommendations until he answers them. Nothing in it
is built yet.

**Goal** (ROADMAP Phase 5): a developer can ask to promote, and the organization's
process decides. seaLeye still builds only dev (principle 9). What it adds is the ask:
what the next stage would be built from, what that stage is missing, a request a person
can approve, and the approval itself, read from the organization's change tool.

**Done when**, on the pilot with the made-up Juniper Mutual:
- a plan approved in dev names one set of modules, and seaLeye can say which module
  serves each of them at every later stage, from the catalog, with nothing typed in
  (Q20 answered);
- a developer runs `sealeye promote` or presses Promote, is told plainly what the next
  stage is missing, and when nothing is, gets a promotion request that names the
  package by its checksum, the plan as it will be built at that stage, and the evidence
  from dev;
- a request that needs an approval waits for it, for days if need be, through a restart,
  and the approval or refusal is read from the change tool (a stand-in first, then a
  ServiceNow developer instance), never typed in;
- a gap in the gap report can become advice (two or three ways to fill it, the effort
  and trade-offs of each, a recommendation) and a ticket in the platform team's queue
  (Jira first);
- the people involved are told where they are (Slack first), and `sealeye integrations`
  and its page say which of these are connected.

Greg starts a full-time job the week of Oct 26, so this plan is built in bursts. Each
step ends released, with a handoff, and the pilot parkable.

The plan has five parts, in the order the dependencies force.

- **Part A** (Steps 0 to 2) closes what Phase 4 left, then answers Q20: one catalog
  says which module serves each stage.
- **Part B** (Steps 3 to 5) is promotion itself: the check, the request, both surfaces.
- **Part C** (Steps 6 to 8) is the organization's process: approvals in seaLeye first,
  the integrations registry, then ServiceNow.
- **Part D** (Steps 9 to 11) is gap advice and tickets, notifications, and writing it
  down.
- **Part E** is planned and not built: AWS access per team, and Cognito sign-in. Both
  wait on a bank pilot.

## What the code looks like today

- **A plan names modules, not stages.** planVersion 0.6: modules by id from the catalog
  it names, `connect` for what a used module offers the app, a profile that says what
  later stages apply. The Terraform executor builds every module at stage `dev`, always.
- **Discovery already reads the path to production, as words.** Each reader writes
  which stages a module is for (`stages`, in the library's terms) and a rule's stages;
  the draft keeps a module's stages only inside `guidance` ("For dev, sit, uat.") and
  each rule's as free text in `rules[].stages`. The library
  reader writes `discovery.path_to_production`: the stages in order, what is aside
  (perf), and the gates ("staging: a platform team approval"; "prod: a platform team
  approval and an approved change ticket"). Nothing reads either as data yet.
- **The made-up library plants the case.** Juniper's `postgres` is for dev, sit and
  uat; `postgres-cluster` is for staging up and takes the same required inputs; from
  its 1.1.0 release (Oct 22, 2026) it offers what `postgres` offers and a reader address
  besides, though live catalog 9 read 1.0.0, which offers no access policy. Its pipeline builds a package once and
  promotes it by checksum, one stage at a time (`app-promote.yml`). The answer key grades
  the overlap as "caught when each entry names the other"; how a plan names a module per
  stage "still waits on Q20".
- **Platform values are already kept by stage** (`api/platform.js`, `GET
  /platform?stage=`), so "what the next stage is missing" can be read for a module's
  inputs today. An app's settings are kept by team and app, not by stage.
- **The record of what was built is already exact.** A deployment keeps its plan's
  and its artifact's checksums, and a Terraform one its root module's (recorded in
  `api/server.js` and the executors, reported by `api/executor/evidence.js`), so a
  request can name the package by checksum without building anything again.
- **Waiting in Postgres is already done once.** The interview's graph is checkpointed
  in Postgres (`api/interview/pgstore.js`) and each `interrupt()` survives a restart.
  Discovery chose never to pause (PHASE4-PLAN D7).
- **Nothing talks to another system yet.** "Raise a gap ticket" (`sealeye needs
  --request`) prints text only. Integrations is drawn only in the archived mock-up.
- **The Terraform role is near IAM's limit.** Its inline policy is about 9,100 of
  10,240 characters; its next widening goes to a managed policy, with an independent
  review.

## Decisions this plan needs from Greg

| # | Decision | Recommendation | Needed by | Decided |
|---|---|---|---|---|
| D1 | How a plan names a different module at a later stage (Q20) | **The catalog carries the stage map; the plan is unchanged.** Each entry gains `stages` (which stages it is for, from the catalog's own path) and, where another module takes over, `instead: { from: staging, module: postgres_cluster }`. A plan keeps naming the dev module, and the module at any stage is resolved from the catalog by code. No new planVersion: the plan the developer approved is the plan that is promoted, word for word. The catalog's shape changes, so it is still a DESIGN.md decision. Alternatives: (b) planVersion 0.7, where a plan names a need ("a relational database") and the catalog fills it per stage: cleaner on paper, but the interview, the validator, the executor and every fixture change, about four more days; (c) a plan per stage, written at promotion: simple to build, but what reaches production is no longer what was approved in dev | Step 1 | |
| D2 | Who writes the stage map | **Discovery's supervisor writes `stages` and `instead`, code checks them, a platform engineer corrects them.** The supervisor already judges which needs a module meets; the stages are said in each README. Code refuses an `instead` the self-test cannot prove: the later module must take the same required inputs, offer every output the earlier one offers (so a plan's `connect` still holds), meet the same needs, and the two must cover the path with no stage left over. A pair it cannot prove becomes a question with a guess, as an overlap does now. Alternatives: code alone infers pairs from `meets` and stages (brittle: two caches meet the same need); or a platform engineer writes the map by hand on both surfaces (no model risk, more work for them, and a new kind of edit beyond words) | Step 2 | |
| D3 | Which catalog resolves a promotion | **The live catalog, checked against the plan's own.** A promotion resolves each module through the live catalog; if the plan's catalog is no longer live and the live one does not build a module the plan uses, the request is refused with the same words as CATALOG_CHANGED, and the developer runs `sealeye run` again in dev. Alternative: the plan's own catalog version always (what was approved in dev, but a retired module could be promoted) | Step 3 | |
| D4 | What "request" means before any integration exists | **A promotion record, and three things written by code from it, no model:** the change description (what changes, from what evidence, with what risk, said from the plan, the dev evidence and the stage map); the plan as it would be built at that stage; and that stage's root module (`main.tf.json` with the stage's modules and platform values), checked offline with `tofu validate`. The team carries them to its own pipeline. Alternatives: a model writes the change description from the same evidence (reads better, one capped call, a prompt to evaluate); or seaLeye triggers the organization's pipeline itself (a CI/CD integration, which the roadmap does not have yet) | Step 4 | |
| D5 | Which package is promoted | **seaLeye's dev package, by the checksum it already records.** This is what Juniper's pipeline asks for: built once, promoted by checksum. A bank may instead require its own build from a commit in its repository; that waits on a bank pilot and changes only what the request names | Step 4 | |
| D6 | Does seaLeye build anything past dev in this phase | **No.** The stage's root module is written and validated offline, never applied, so the Terraform role is not widened and nothing past dev costs money. Alternative: a stand-in pipeline on the pilot applies staging for Juniper, proving the cluster builds: it needs the role widened for clusters (`cluster:`, `rds!cluster-*`) in a managed policy, an independent review, and a two-instance cluster built and torn down for each proof | Step 4 | |
| D7 | How a promotion waits for days | **A plain record with a status and a poller, no graph.** A promotion makes no model call (D4), so it is a state machine: `checking`, `missing` (it says what), `requested`, `waiting` (on whom), `approved` or `refused` (by whom, read from the change tool), `handed_off`. A poller in the API reads each waiting request's approval from its tool every few minutes and on start. Alternative: the LangGraph graph waiting with `interrupt()` in Postgres, as ROADMAP Phase 5 says: proven in the interview, but a graph with no model in it adds a checkpoint schema and resumption code for what one table and a loop do. Either way the ROADMAP line changes or stands with this decision | Step 4 | |
| D8 | Where an approval comes from first | **A stand-in change tool inside seaLeye first, then a ServiceNow developer instance behind the same interface.** The stand-in: an organization-wide token approves or refuses on both surfaces, recorded by who and when. The interface: open a change, read its state, read who decided. ServiceNow's free developer instance next, read by polling outward from the API (no door into the pilot for it); a webhook later, if a bank wants it. A developer instance sleeps when idle and is reclaimed after a period unused, so the eval and the pilot proof wake it first | Step 6 | |
| D9 | Who may ask, and which gates apply | **Anyone on the app's team may ask for the next stage, one stage at a time; the gates are the catalog's.** The gates discovery read (`path_to_production.gates`) become data in the catalog, approved with it like any entry: Juniper's sit and uat need no approval, staging needs a platform team approval, prod also an approved change ticket. A stage with no gate is requested and handed off at once. Alternative: gates set by hand on the Platform page, apart from discovery | Step 3 | |
| D10 | Where an integration's credentials live | **The organization's store, by organization:** `/sealeye-integrations/<org>/<integration>/`, put in by an organization-wide token on both surfaces, names out and values in, never back (as an app's settings are). The API reads them only to call that system. Integrations are by organization, so they work for `juniper`, unlike settings and costs today | Step 7 | |
| D11 | How gap advice is written | **The frontier route writes it, capped, from what seaLeye already holds:** the gap report's demand, the evidence lines developers' plans gave, and the library's catalog. Two or three ways to fill the gap, the effort and trade-offs of each, a recommendation, marked as advice. A cap per gap set from a measured run, as discovery's were (placeholder: ten cents a gap, a dollar a report). Shown on both surfaces first; a ticket in Jira after. Alternative: code-only advice from a fixed table per need kind (no model, but generic) | Step 9 | |
| D12 | What is notified, and where first | **Slack first, by an incoming webhook per organization; Teams after, by the same interface.** Only what a person must act on: a promotion waiting on them, a promotion decided, a discovery question asked. A deploy's own progress stays in the command and the portal | Step 10 | |

## Part A: what Phase 4 left, then one module per need

### Step 0. Close Phase 4

Not code, or very little. Before anything else, about an hour on Greg's Mac:
- Refresh the Juniper eval's catalog snapshot to the live catalog
  (`test/fixtures/juniper-catalog-9.json` today), a small pull request.
- Run `npm run eval:interview -- --set juniper` and `--set starter`, the first since the
  database and the logs work. They are the "before" every prompt change in Step 2 is
  compared with.
- Tear down `account-notes-api` on the pilot, then park it between bursts.

### Step 1. The stage map in the catalog (D1)

- A catalog's path to production becomes data: `path: [dev, sit, uat, staging, prod]`,
  `aside: [perf]`, and `gates` per stage (D9). The starter catalog has the path
  `[dev]` only, so nothing a starter organization sees changes.
- An entry gains `stages` (a list, from the path) and, optionally, `instead: { from,
  module }`. `resolveForStage(plan, catalog, stage)` in `core/catalog.js` returns each of
  the plan's modules as it would be built at that stage, the `connect` carried over, or
  the reason it cannot be.
- The self-test proves each `instead` (D2's checks), and refuses a catalog whose map
  leaves a stage of the path without a module for a module that ends.
- The plan contract does not change (D1). A DESIGN.md entry, "A module per stage, in the
  catalog", answers Q20 and removes it from OPEN-QUESTIONS.

About two to three days.

### Step 2. Discovery writes the map; the interview plans for dev (D2)

- The supervisor writes each entry's `stages` and `instead`, from what the readers
  already found; code checks them; a pair it cannot prove becomes a question with its
  guess.
- The answer key's `overlap` is graded properly: `postgres` for dev, sit, uat with
  `instead: { from: staging, module: postgres_cluster }`, and `stages_mapped` joins the
  eval's grades.
- The interview's passages offer only modules whose stages include dev, and say, of a
  module with an `instead`, that the platform uses the other from that stage. A prompt
  change: `npm run eval:interview` before (Step 0) and after.
- A discovery change: `npm run eval:discovery -- --run` before and after, and an
  independent review before the pull request. A change to discovery's prompts changes
  `readerVersion` (a hash of them), so the next run reads every module.

About two to three days, with the review.

## Part B: asking to promote

### Step 3. What the next stage is missing (D3, D9)

An endpoint first: `GET /deployments/{id}/promotion?to=<stage>` (the next stage when
`to` is left out). Read-only, it answers with:
- the next stage, from the catalog's path, or why there is none (dev is the only stage;
  perf is built from staging and never promoted to);
- each module as it would be built there (`resolveForStage`), and any that cannot be;
- what that stage is missing, in the developer's words: a platform value a module
  needs at that stage that is not set ("the staging database network is not set yet;
  your platform team sets it"), a module the live catalog no longer builds (D3);
- what the dev environment must show first: that it is standing and succeeded, and its
  evidence was read;
- the stage's gate (D9), and whom it waits on;
- the settings the app reads, by name only, with a line that the next stage's values
  are the pipeline's to supply (settings are not kept by stage; a new question, below).

About two days.

### Step 4. The promotion request (D4, D5, D6, D7)

- `POST /promotions` ({ deployment, to }) refuses with what is missing (422
  PROMOTION_MISSING, the same list as Step 3), and otherwise saves a promotion record:
  who asked, from which environment and stage, to which, the package's checksum, the
  plan and the catalog version it resolved with, and the gate. `GET /promotions`, `GET
  /promotions/{id}`. A new table and migration (`010_promotions.sql`). One open
  promotion per environment and stage (409 PROMOTION_OPEN).
- Written by code from the record, nothing typed in (principle 7): the change
  description, the plan at that stage (as DEPLOYMENT_PLAN.md is written for dev), and the
  stage's root module, checked with `tofu validate` and never applied (D6). `GET
  /promotions/{id}/files`.
- The status machine of D7, with a poller in the API that starts with the server and
  survives a restart. A stage with no gate goes straight to `handed_off`.
- The developer's folder: nothing is written into it unless they ask (principle 5);
  `sealeye promote --out <folder>` writes the three files into a folder they name, never
  over a file that is there, as `sealeye plan --out` does.

About three to four days.

### Step 5. `sealeye promote` and the Promote button

- `sealeye promote [<app>] [--to <stage>]`: the check first, in plain lines; then "Ask
  to promote to sit? [y/N]"; then the request, and what it waits on.
  `sealeye promote status` lists the caller's promotions. Names settled in DESIGN.md
  before building, and added to `core/operations.js`.
- The portal: a Promote card on an environment's page (Control), shown only when the
  environment offers it (`environmentOperations`), with the same check, the same
  question and the same request; a Promotions list.
- Parity: both surfaces released together. The parity backlog's Promote row is built
  in the same commit.

About two to three days.

## Part C: the organization's process

### Step 6. Approvals, with a stand-in change tool (D8)

- A change-tool interface in `api/integrations/`: open a change from a promotion, read
  its state, read who decided. The stand-in implements it inside seaLeye.
- `POST /promotions/{id}/decision` ({ decision, reason }), an organization-wide token's
  only, for the stand-in. On both surfaces: `sealeye promote approve|refuse <id>` and
  the Promotions page's Approve and Refuse. The person on the record is the token's.
- A refused promotion says why, and stays as a record; asking again makes a new one.
- Proven on the pilot: a Juniper app promoted to sit with no gate, and to staging with
  the stand-in's approval, across a parked and restarted pilot.

About three days.

### Step 7. Integrations, on both surfaces (D10)

- `GET /integrations`, `PUT` and `DELETE /integrations/{name}` ({ values }, names out and
  values in, never back), an organization-wide token's only, with a check that
  connects and says in words whether it worked (`POST /integrations/{name}/check`).
- `sealeye integrations` and an Integrations page: each job (approvals, gap tickets,
  notifications), what is connected for it, when it last worked, and what seaLeye does
  without it. The archived mock-up's design, showing only what is real.
- The credentials in the organization's store (D10). The pilot server's role gains read
  of `/sealeye-integrations/*` and nothing else: a small widening of the server's role,
  not the Terraform role, still with a review.

About two to three days.

### Step 8. ServiceNow (D8)

- A free ServiceNow developer instance, with a change model whose states map to D7's.
  The adapter opens a normal change from the promotion (the change description as its
  body), and the poller reads its state and who approved it.
- Credentials as D10: an integration user, never a person's password.
- A stage whose gate names an approved change ticket (Juniper's prod) carries the
  ticket's number in the hand-off.
- Tested with a stand-in ServiceNow in `npm test` (no network), and proven once on the
  pilot against the developer instance.

About three to four days.

## Part D: gaps, notifications, writing it down

### Step 9. Gap advice, then gap tickets (D11)

- `POST /gaps/{kind}/advice`: the frontier route, capped per gap and per report, named
  through the gateway, with the gap report's demand and the library's catalog. Saved
  with the gap, marked as advice, and shown in `sealeye gaps --advice` and on the Gaps
  page. The platform team reads it; no developer does, so module and product names are
  allowed, and no app's code is in it, only the evidence lines plans already carry.
- Graded: the made-up library's three planted gaps (an event stream, users signing in,
  scheduled work) each get advice that names a real way to fill it. A small eval, run
  before and after any change to its prompt.
- Then Jira: a ticket per gap in the platform team's project, through the integrations
  registry, carrying the advice and updated, never duplicated, when demand grows. The
  `sealeye needs --request` row of the parity backlog becomes this.

About two to three days for advice, two for Jira.

### Step 10. Notifications (D12)

- A notifier interface, Slack first by an incoming webhook, Teams after by the same
  interface. Each message is a plain line and a link to the portal page, never a
  setting, a value or a token.
- Sent for a promotion waiting on someone, a promotion decided, and a discovery
  question asked.

About two days.

### Step 11. Write it down

DESIGN.md entries as each decision is made; ARCHITECTURE.md's containers (the poller,
the integrations), a promotion flow, and the promotions table in the data section;
CLAUDE.md's API, layout and current limits; ROADMAP Phase 5 ticked; BUILD-OUT's picture
marked built; OPEN-QUESTIONS without Q20.

About one day.

## Part E: planned, not built (waits on a bank pilot)

### AWS access per team

The executor assumes a role in each team's account instead of acting in the seaLeye
account: a role per team, named on the team's record, trusted by the API's role and
bounded as the deploy roles are today; state per account; costs read from each. Built
when a bank pilot gives seaLeye more than one account. About four to five days then.

### Cognito sign-in (Q16)

`sealeye login` opens the browser and keeps a refresh token; the portal signs in
through the hosted page; a person's team and an organization-wide scope come from
Cognito groups; tokens stay for automation only, issued as today; existing token holders
sign in once and their token is retired. Admin onboarding (the identity provider, the
repositories) comes with it. Its own plan when it is built. About five to seven days
then.

## Open questions this plan answers, and leaves

- **Q20** (a module per stage): answered by D1 and D2, in Step 1's DESIGN.md entry.
- **Q16** (Cognito sign-in): planned in Part E, not built.
- **Q3** (sign-in): answered Oct 9, 2026 by choosing Cognito; what is left of it is
  Q16. ROADMAP's Phase 1 lines still name Q3, and Step 11 points them at Q16.
- **Q13** (where traces live): answered Oct 13, 2026 (LangFuse in ca-central-1). Its
  build is owed before the first customer's real code, not in this plan.
- **Q10** (publishing the command): left. The installer works for a friendly team.
- **A new one, to raise in Step 3:** an app's settings at a later stage. Today they are
  kept by team and app, not by stage, so the check can name them but not say whether
  the next stage has them. Leaning: the pipeline's, until a bank pilot shows how its
  teams keep them.

## Order and rough effort

| Steps | What | Effort |
|---|---|---|
| 0 | Close Phase 4: the evals, the snapshot, park | an hour or two |
| 1 to 2 | The stage map, discovery writes it, the interview plans for dev | four to six days |
| 3 to 5 | The check, the request, both surfaces | seven to nine days |
| 6 | Approvals with a stand-in | three days |
| 7 | Integrations on both surfaces | two to three days |
| 8 | ServiceNow | three to four days |
| 9 | Gap advice, then Jira | four to five days |
| 10 | Notifications | two days |
| 11 | Write it down | one day |

About twenty-six to thirty-three working days, so five and a half to seven weeks of full
days, and longer in bursts. Parts A and B are worth having alone: a developer can ask to
promote and get a request a person can carry to the pipeline. Steps 2 and 7 need an
independent review before their pull requests (discovery, and a role widened); Step 4
too, as the first record that waits for days.

## Owed after this plan, or before the first customer

| Item | Bring it forward when |
|---|---|
| **Everything PHASE4-PLAN still owes** (LangFuse in Canada, a paid account per customer, the Bedrock route, a large catalog, public libraries at scale) | As PHASE4-PLAN says: before the first customer's real code. |
| **Building past dev** (D6's alternative) | When a pilot wants seaLeye to prove a stage builds, or to be its pipeline. The Terraform role's widening goes to a managed policy, with a review. |
| **seaLeye triggers the organization's pipeline** (D4's alternative) | When a pilot's pipeline can be called (GitHub Actions' `workflow_dispatch` is the made-up one's). |
| **The organization's own build** (D5's alternative) | When a bank requires its build, not seaLeye's, to be promoted. |
| **Settings by stage** | When a bank pilot shows where its teams keep a stage's settings. |
| **A webhook from the change tool** | When polling is too slow or a bank asks for it. |
| **Teams** (D12) | After Slack, when an organization asks. |
