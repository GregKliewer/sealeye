# Phase 5 plan: the path to production

Written Thu Oct 22, 2026, evening, after Phase 4 was built and released (2.48.1); revised
Sat Oct 24 after 2.50.0 (the portal's sections, paging, which apps use each module); and
rewritten the same day, when Greg widened principle 9: seaLeye builds and manages every
stage, not only dev, each applied the way the organization chose for it (DESIGN.md,
"seaLeye builds every stage, the way the organization chose for each"). A draft for
Greg: the decisions below are recommendations until he answers them. Decided so far
(Sat Oct 24, 2026): D1, D2, D3, D5, D6 and D12, all as recommended, so Steps 1 to 5 can
be built. Nothing in it is
built yet. The decisions were renumbered in the rewrite. D1 was widened the same
afternoon to the three ways infrastructure changes from stage to stage (Greg asked what
is typical), and Juniper Mutual's library gained a module a stage adds.

**Goal** (ROADMAP Phase 5): a developer can ask to promote, the organization's process
decides, and the approved stage is built and managed from then on, as the same app with
the same plan. Who applies each later stage is the organization's choice, made per
stage in its catalog:

- **A. seaLeye applies it**, with its own executor, after the stage's gate approves. For
  a platform with no pipeline that builds infrastructure.
- **B. The organization's pipeline applies it, and seaLeye drives it**: it starts the
  run with what the stage needs and reads the result back as the stage's status. For a
  platform whose certified pipeline is already its control point.
- **C. The organization's pipeline calls seaLeye's executor** as one of its steps.
  Planned, built only when an organization asks.

Phase 5 is built in two halves, so the first ships something whole:
- **5a**: the stage map, an environment at a stage, asking to promote, gates and
  approvals, and A, proven on Juniper Mutual's sit, uat and staging.
- **5b**: B, with GitHub Actions, proven on Juniper Mutual's own pipeline for staging and
  prod.
Gap advice and tickets, notifications and integrations' page fit either side.

**Done when**, on the pilot with the made-up Juniper Mutual:
- a plan approved in dev names one set of modules, and seaLeye says which module serves
  each at every later stage, and who applies that stage, from the catalog, with nothing
  typed in (Q20 answered);
- a developer runs `sealeye promote` or presses Promote, is told plainly what the next
  stage is missing, and when nothing is, makes a request that names the package by its
  checksum and the plan as it will be built at that stage;
- a request whose stage has a gate waits for it, for days if need be, through a restart,
  and the decision is read from the change tool (a stand-in first, then a ServiceNow
  developer instance), never typed in, and never made by the person who asked;
- once approved, a stage seaLeye applies is built and is then one more environment of the
  same app: listed, its status real, its logs and evidence read, and every later change
  to it behind the same gate (5a);
- a stage the organization's pipeline applies is started by seaLeye and its status read
  back from the pipeline's run (5b);
- a gap can become advice and a ticket (Jira first), people are told where they are
  (Slack first), and `sealeye integrations` and its page say what is connected.

Greg starts a full-time job the week of Oct 26, so this plan is built in bursts. Each
step ends released, with a handoff, and the pilot parkable. Nothing past dev is left
standing between bursts: it costs money, a staging database most of all.

The plan has six parts.
- **Part A** (Steps 0 to 2): close Phase 4, then the stage map, each stage's gate and
  who applies it, in the catalog.
- **Part B** (Steps 3 to 5): an environment at a stage, access to each stage's account,
  and settings by stage. The foundations every applier needs.
- **Part C** (Steps 6 to 9): asking, waiting, approving, and seaLeye applying (A), on
  both surfaces. The end of 5a's core.
- **Part D** (Steps 10 and 11): integrations and ServiceNow.
- **Part E** (Steps 12 and 13): 5b, the organization's pipeline (B).
- **Part F** (Steps 14 to 16): gap advice and tickets, notifications, writing it down.
- Planned, not built: C, AWS access per team, and Cognito sign-in.

## What the code looks like today

- **A plan names modules, not stages.** planVersion 0.6: modules by id from the catalog
  it names, `connect` for what a used module offers the app, a profile that says what
  later stages apply.
- **Everything assumes dev.** The Terraform executor gives every module `stage: dev`
  (`DEVELOPER_STAGE` in `api/executor/terraform/root.js`); an environment's name is
  `sealeye-<team>-<app>-<hash>` with no stage in it (`environmentName` in
  `core/names.js`); its state is `tofu-state/<org>/<environment>.tfstate`; a record has
  no stage; `sealeye list` and Environments show one row per app; every build acts
  through one Terraform role in one account.
- **Discovery already reads the path to production, as words.** Each reader writes
  which stages a module is for and a rule's stages; the draft keeps a module's stages
  only inside `guidance` ("For dev, sit, uat.") and each rule's as free text in
  `rules[].stages`. The library reader writes `discovery.path_to_production`: the stages
  in order, what is aside (perf), and the gates ("staging: a platform team approval";
  "prod: a platform team approval and an approved change ticket"). Nothing reads either
  as data yet.
- **The made-up library plants the case.** Juniper's `postgres` is for dev, sit and uat;
  `postgres-cluster` is for staging up and takes the same required inputs; from its
  1.1.0 release (Oct 22, 2026) it offers what `postgres` offers and a reader address
  besides, though live catalog 9 read 1.0.0, which offers no access policy and only an
  address and a reader address. Its pipeline builds a package once and promotes it by
  checksum, one stage at a time (`app-promote.yml`), each stage in its own account with
  its own state; staging and prod need a platform team approval, prod a change ticket
  too. Its apply step is a placeholder that only prints what it would run.
- **Platform values are already kept by stage** (`api/platform.js`, `GET
  /platform?stage=`). **An app's settings are not**: they are kept by team and app
  (`/sealeye-apps/<team>/<app>/`), and only for the `default` organization.
- **The record of what was built is already exact.** A deployment keeps its plan's and
  its artifact's checksums, and a Terraform one its root module's, so a later stage can
  be built from the very package dev ran, and the request can say so.
- **Which apps stand on each module, at which release, is already read**
  (`api/module-use.js`, `usedBy` in GET /catalog): the release a promotion carries
  forward (D7), and the list of apps a stage map changes.
- **One change at a time per environment** (`api/busy.js`), and a deploy queue with real
  status: what a later stage's build joins.
- **Waiting in Postgres is already done once.** The interview's graph is checkpointed in
  Postgres (`api/interview/pgstore.js`). Discovery chose never to pause.
- **The portal has sections, and new pages join them** (2.49 to 2.50): Environments,
  Validate, Catalog, Platform and Team, a section of several pages shown as a second row
  of tabs. Long lists page with status chips (`portal/src/components/Paging.tsx`).
- **Nothing talks to another system yet.** "Raise a gap ticket" prints text only;
  Integrations is drawn only in the archived mock-up.
- **The Terraform role is near IAM's limit.** Its inline policy is about 9,100 of 10,240
  characters, and it cannot build a cluster (`cluster:`, `rds!cluster-*`).

## Decisions this plan needs from Greg

| # | Decision | Recommendation | Needed by | Decided |
|---|---|---|---|---|
| D1 | How a plan's modules change at a later stage (Q20) | **The catalog says how each module changes by stage, in the three ways libraries do it; the plan is unchanged.** (1) **Inputs by stage**, the most common: the same module, told its stage, with the stage's platform values (Juniper's `postgres-cluster` keeps one instance below staging and two from staging up). Nothing new in the catalog beyond each entry's `stages`; the executor stops giving every module `dev`. (2) **`instead`**, where a later stage needs a different kind of resource: `instead: { from: staging, module: postgres_cluster }` on `postgres`. (3) **`with`**, a module the stage adds beside what the plan names, never one an app asks for: `with: [{ from: staging, module: backup_plan, beside: relational_database }]` in the catalog's path. A plan keeps naming what dev runs; the plan at any stage is resolved from the catalog by code, as the plan plus its `instead`s and the stage's `with`s. No new planVersion: the plan the developer approved is what is built at every stage. A module's release is not a stage rule: dev running a newer release than prod happens only while an upgrade is promoted (D7). Alternatives: (b) planVersion 0.7, a plan naming needs that the catalog fills per stage, about four more days; (c) a plan per stage, written at promotion, so what reaches production is no longer what was approved | Step 1 | Greg, Sat Oct 24, 2026: as recommended, revised after our discussion of how libraries change a module by stage |
| D2 | Who writes the stage map | **Discovery's supervisor writes `stages`, `instead` and the path's `with`, code checks them, a platform engineer corrects them.** A `with` must name a module the catalog has that meets no need an app asks for, beside a need some module meets; one it cannot place is a question. Code refuses an `instead` it cannot prove: the later module takes the same required inputs, offers every output the earlier one offers (so `connect` still holds), meets the same needs, and the two cover the path with no stage left over. A pair it cannot prove becomes a question with a guess. Alternatives: code alone infers pairs (brittle: two caches meet the same need); or engineers write the map by hand | Step 2 | Greg, Sat Oct 24, 2026: as recommended |
| D3 | Who applies each stage, and how that is set | **Per stage, in the catalog's path, beside its gate: `applies: sealeye` or `applies: pipeline` (with the pipeline named).** Discovery proposes it from the library's pipelines and README; the platform team approves it with the catalog, and can change it with an edit like any word. dev is always seaLeye's. For Juniper: sit and uat seaLeye, staging and prod its pipeline, as its library says. Until 5b, a stage its pipeline applies is never applied by seaLeye instead: the request is made and approved, and the developer is told plainly that the platform team's pipeline builds it. For the 5a proof, Greg may set Juniper's staging to `sealeye` for a while, to prove a gated stage with a cluster | Step 1 | Greg, Sat Oct 24, 2026: as recommended |
| D4 | Which changes at a later stage need its gate | **Every change to what runs or holds data**: deploy again, configure, a setting, pause and resume, tear down. Never reading: status, logs, evidence, performance. A stage with no gate (Juniper's sit and uat) takes changes as dev does. Tearing down a stage held to production's rules (staging up) also needs the app's name typed, as the data warning does now. Alternative: only promotion needs the gate, and later changes are the team's (simpler, but a change to prod would skip the change process) | Step 8 | |
| D5 | What an environment at a stage is | **One app, one environment per stage.** A record gains `stage` (dev when absent, so every record today stays as it is). A later stage's name is `sealeye-<team>-<app>-<stage>-<hash>`, its hash over the stage too, and dev keeps today's name so nothing standing is renamed; its state is `tofu-state/<org>/<stage>/<environment>.tfstate`. `sealeye list` and Environments keep one row per app, with its stages and each one's state; commands that act on an environment take `--stage` (dev by default); the portal's environment page has a stage picker. Alternative: a later stage as a separate app (`account-notes-api-staging`), simpler and wrong: the vision says one app | Step 3 | Greg, Sat Oct 24, 2026: as recommended |
| D6 | Where a later stage is built, and with what permissions | **A role per stage, named as a platform value per stage (`deploy_role`), assumed by the API for that stage's builds.** On the pilot, one account, with a role per later stage and state kept apart by stage; each new role starts from a managed policy, so the Terraform role's inline limit stops mattering, and only the staging and prod roles can build a cluster. An independent review before the pull request. A second AWS account for staging and prod is the truer test and waits until a pilot asks, since the role-per-stage shape already supports it. Alternative: a second account now (more setup, closer to a bank) | Step 4 | Greg, Sat Oct 24, 2026: as recommended |
| D7 | Which catalog, and which release, a stage is built from | **The live catalog, checked against the plan's own, and each kept module at the release dev built.** If the plan's catalog is no longer live and the live one does not build a module the plan uses, the request is refused as CATALOG_CHANGED is. A module the plan keeps is built at the release its dev environment runs (read as `api/module-use.js` reads it); a module that takes over (`instead`) is at the live catalog's release, and the request says it was never built in dev | Step 6 | |
| D8 | Which package a later stage runs | **The package dev ran, by the checksum it already records**, the way Juniper's pipeline promotes: built once. For A, seaLeye deploys that artifact again at the stage; for B it is what the pipeline is handed. A bank requiring its own build from a commit waits on a bank pilot | Step 7 | |
| D9 | How a promotion waits, and then builds | **A plain record with a status and a poller, no graph.** `requested`, `waiting` (on whom), `approved` or `refused` (by whom, read from the change tool), then for A `building` and the deployment it queued, or for B `handed_off` and the pipeline's run. The poller reads each waiting request's decision every few minutes and on start, and an approved A request joins the deploy queue like any deploy, under the same one-change-at-a-time rule. Alternative: the LangGraph graph waiting with `interrupt()` in Postgres, as ROADMAP Phase 5 says: proven in the interview, but a graph with no model in it adds a checkpoint schema for what one table and a loop do | Step 7 | |
| D10 | Where an approval comes from first | **A stand-in change tool inside seaLeye, then a ServiceNow developer instance behind the same interface.** The stand-in: an organization-wide token approves or refuses on both surfaces. ServiceNow polled outward from the API, no door into the pilot; a webhook later. **The person who asked never approves their own request**, in any tool (Q16 asks the same of a catalog's approver) | Step 7 | |
| D11 | Who may ask, and which gates apply | **Anyone on the app's team may ask for the next stage, one stage at a time; the gates are the catalog's**, approved with it. A stage with no gate is requested and applied at once. perf is built from staging for a load test when the catalog sets it aside, never promoted to | Step 6 | |
| D12 | Where an app's settings for a later stage live (Q26) | **By stage in the same store: `/sealeye-apps/<team>/<app>/<stage>/`, dev keeping today's path.** Set on both surfaces with `--stage`, and at a gated stage a change behind the gate (D4). The check names any setting dev has that the next stage lacks. Settings stay the `default` organization's until they are kept by organization, which is owed and not in this plan; Juniper's plans read none | Step 5 | Greg, Sat Oct 24, 2026: as recommended |
| D13 | Where promotion lives in the portal | **In the sections that exist.** An app's row in Environments shows its stages; its page has a stage picker and, on each stage, a Promote card when it offers one; Environments gains tabs, Environments and Promotions (a team's requests, paged with status chips); Platform gains Approvals (the stand-in's queue) and Integrations. Alternatives: Promotions as a sixth section (the bar holds five, by the Oct 23 decision); or no list across apps | Step 9 | |
| D14 | Where an integration's credentials live | **The organization's store, by organization**: `/sealeye-integrations/<org>/<integration>/`, put in by an organization-wide token on both surfaces, names out and values in, never back. The API reads them only to call that system | Step 10 | |
| D15 | How seaLeye drives an organization's pipeline (5b) | **A pipeline adapter, GitHub Actions first**: seaLeye starts the named workflow with `workflow_dispatch` (the stage, the package's checksum, the promotion's id, and where to fetch what the stage is built from, Q25), through a GitHub App the organization installs on the named repositories, and reads the run's jobs back as the stage's status, its outputs from the run's summary or an artifact it publishes. Status is the run's, never assumed (principle 4). GitLab and Azure Pipelines when an organization asks | Step 12 | |
| D16 | Proving B on the made-up organization | **Make Juniper's `app-promote.yml` apply for real**: the library's workflow assumes a staging or prod role in the pilot account through GitHub's OpenID Connect, fetches what seaLeye hands it, and applies it. The library stays public, so the roles trust only that repository and those environments. Alternative: a stand-in pipeline inside seaLeye's own repository (proves the adapter, not a real organization's pipeline) | Step 13 | |
| D17 | How gap advice is written | **The frontier route writes it, capped**, from the gap report's demand, the evidence lines plans gave, and the library's catalog: two or three ways, the effort and trade-offs of each, a recommendation, marked as advice. A cap per gap from a measured run (placeholder: ten cents a gap, a dollar a report). On both surfaces first, then Jira. Alternative: code-only advice per need kind | Step 14 | |
| D18 | What is notified, and where first | **Slack first, by an incoming webhook per organization; Teams after.** Only what a person must act on: a promotion waiting on them, a promotion decided, a stage built or failed, a discovery question asked | Step 15 | |

## Part A: close Phase 4, then the stage map

### Step 0. Close Phase 4

Not code, or very little, about an hour on Greg's Mac:
- Apply the library patch that adds `backup-plan` (pattern 3: from staging up, beside
  every app that keeps a relational database; its README and the library's say so),
  merge it, and tag `backup-plan/v1.0.0`. seaLeye's answer key already has its entry and
  grades it as `addition`.
- Check that Juniper's live catalog reads `postgres-cluster` at 1.1.0 (`SEALEYE_TOKEN=$JT
  sealeye catalog show`). If it is still at 1.0.0, run discovery again and make its
  catalog live: the stage map cannot be proven against 1.0.0. Run it again anyway once
  `backup-plan` is tagged, so the live catalog has it.
- Refresh the Juniper eval's snapshot to that catalog (`test/fixtures/juniper-catalog-9.json`
  today), a small pull request.
- Run `npm run eval:interview -- --set juniper` and `--set starter`: the "before" for
  Step 2's prompt change.
- Tear down `account-notes-api` and park the pilot.

### Step 1. The stage map, the gates and the appliers in the catalog (D1, D3)

Built Sat Oct 24, 2026 (2.51.0): `core/stages.js` (the path, `resolveForStage`,
`stageMapProblems` in the catalog's shape, `stageMapGaps` as the self-test's sixth
check, `stages`, and the words both surfaces say); GET /catalog's `stages`; `sealeye
catalog` and `catalog show`, the Catalog page and the Discovery page's catalog view; the
answer key's stage map for Juniper Mutual. As written below, except that the answer key
says the library's pipeline applies sit and uat too, since its pipeline and README say
so; D3's "sit and uat seaLeye" would be an edit by the platform team.

- A catalog's path becomes data: `path` (the stages in order), `aside` (perf), and per
  stage its `gate` (D11) and who `applies` it (D3). The starter's path is `[dev]` only,
  so nothing a starter organization sees changes.
- An entry gains `stages` and, optionally, `instead: { from, module }`.
  The path gains `with` (D1). `resolveForStage(plan, catalog, stage)` in
  `core/catalog.js` returns the plan as it would be built at that stage: each module told
  that stage (inputs by stage need nothing more), each `instead` taken, each `with`
  added beside what it stands beside, the `connect` carried over, or why it cannot be.
- The self-test proves each `instead` and `with` (D2), refuses a path with a stage no one applies,
  and checks the words a developer reads.
- Shown wherever a catalog is: `sealeye catalog` and `catalog show`, the Catalog page
  and the Discovery page's catalog view, each module's stages and "from staging, the
  platform uses the clustered database", beside its `usedBy`; and the path, its gates,
  who applies each stage and what each stage adds ("from staging, a daily copy of what
  your app stores, kept apart from it"), on the Catalog page and in `sealeye catalog`.
- DESIGN.md, "A module per stage, in the catalog" (Oct 24, 2026), answers Q20.

About three and a half days.

### Step 2. Discovery writes it; the interview plans for dev (D2, D3)

- The supervisor writes each entry's `stages` and `instead`, and the library reader's
  path gains each stage's `with` (Juniper's `backup-plan`, from its README and the
  library's) and `applies`, read from the pipelines (Juniper's `app-promote.yml`
  applies every stage past dev); code checks them; what it cannot prove is a question
  with a guess.
- The answer key's `overlap`, `addition` and `stages` are graded (`stages_mapped`,
  `path_mapped`), each pattern of D1 by its own case.
- The interview's passages offer only modules whose stages include dev, and say of one
  with an `instead` that the platform uses the other from that stage. `npm run
  eval:interview` before (Step 0) and after.
- `npm run eval:discovery -- --run` before and after, and an independent review before
  the pull request. The prompts' hash (`readerVersion`) changes, so the next run reads
  every module.

About two and a half to three and a half days, with the review.

## Part B: an environment at a stage

### Step 3. One app, an environment per stage (D5)

- Records, names, state and the busy rule gain the stage, as D5 says; every record and
  environment standing today is dev, unchanged. The executor gives a module the stage it
  is built for, never `dev` by rule.
- `sealeye list`, `status`, `logs`, `evidence`, `teardown` and the rest take `--stage`;
  Environments shows an app's stages in its row; an environment's page picks its stage.
  Evidence and the report name the stage. `core/environments.js` keeps one key per app
  and stage.
- No new operation yet: dev is the only stage anything builds until Step 8. A test
  builds a made-up sit environment with the stand-in `tofu` to prove the names and state.

About four to five days.

### Step 4. Each stage's account and role (D6)

- A role per later stage, in `deploy/` (one template, a stage as its parameter), each
  from a managed policy: sit and uat as the Terraform role has today, staging and prod
  also able to build and delete a cluster, protected against deletion as the library
  asks, and able to make a stage's backup plan (Juniper's `backup-plan`). Named per stage
  as a platform value; the API assumes it for that stage's builds,
  reads and tear-downs.
- The pilot's foundation network gains what a later stage's modules need, by stage, as
  platform values (on the pilot the same network, kept apart by security groups).
- An independent review before the pull request: it widens what seaLeye can build.
- A cluster costs real money while it stands; the staging values on the pilot use the
  smallest instance the module allows, and every proof is torn down the same day.

About three to four days, with the review.

### Step 5. Settings by stage (D12)

- The store's path gains the stage, dev keeping today's; `sealeye settings` and the
  Settings card take a stage; the run script reads its own stage's.
- The check (Step 6) names any setting dev has that the next stage lacks, by name only.

About two days.

## Part C: asking, approving, and seaLeye applying (A)

### Step 6. What the next stage is missing (D7, D11)

`GET /deployments/{id}/promotion?to=<stage>` (the next stage when `to` is left out),
read-only:
- the next stage from the catalog's path, or why there is none;
- who applies it (D3) and its gate (D11);
- each module as it will be built there (`resolveForStage`, at the release D7 says), and
  any that cannot be;
- what that stage is missing, in the developer's words: a platform value not set for it
  ("the staging database network is not set yet; your platform team sets it"),
  including what a module the stage adds needs ("staging's backup vault is not set
  yet"), a setting dev has and it lacks, a module the live catalog no longer builds;
- what dev must show first: standing and succeeded.

About two days.

### Step 7. The promotion request, and waiting (D8, D9, D10)

- `POST /promotions` ({ deployment, to }) refuses with what is missing (422
  PROMOTION_MISSING), and otherwise saves a promotion: who asked, from which stage to
  which, the package's checksum, the plan and catalog it resolved with, the gate and who
  applies it. `GET /promotions`, `GET /promotions/{id}`. A table and a migration. One
  open promotion per app and stage (409 PROMOTION_OPEN).
- The change description, written by code from the record and the dev evidence, nothing
  typed in (principle 7): what changes, from what, with what at stake. It is what the
  change tool's change carries.
- The poller of D9, starting with the server and surviving a restart.
- A change-tool interface (`api/integrations/`): open a change, read its state, read
  who decided. The stand-in implements it: `POST /promotions/{id}/decision` ({ decision,
  reason }), an organization-wide token's only, refused for the person who asked (403
  OWN_REQUEST).
- The first record that waits for days: an independent review before the pull request.

About four days, with the review.

### Step 8. seaLeye applies a stage, and manages it (D4, D8)

- An approved promotion to a stage seaLeye applies queues a deploy at that stage: the
  package dev ran (D8), the plan resolved for the stage, the stage's role (D6), values
  and settings. Its status is the build's, as dev's is; a failure says why and leaves
  the promotion `failed`, never `approved` and silent.
- A stage's `with` modules are built in the same root module, beside what they stand
  beside, and torn down with it. They neither run the app nor are used by it, which the
  executor does not build today (`terraformBuilds`): it learns a third kind, a module the
  stage adds, whose inputs come only from seaLeye and the stage's platform values.
- A stage the organization's pipeline applies is not built by seaLeye: until 5b the
  request ends `approved`, saying the platform team's pipeline builds it (D3).
- Every change to a gated stage goes through the same gate (D4): deploy again,
  configure, settings, pause, tear down each make a change request first, and act only
  on approval. A tear-down of a stage held to production's rules also asks for the app's
  name.
- Proven on the pilot: a Juniper app promoted to sit (no gate) and to staging with the
  stand-in's approval, its database a cluster with a backup plan beside it, all three
  patterns of D1 in one build (with D3's staging set to `sealeye` for the proof), across a parked and restarted pilot, then torn down through its gate.

About five to six days.

### Step 9. Both surfaces (D13)

- `sealeye promote [<app>] [--to <stage>]`: the check, then "Ask to promote to sit?
  [y/N]", then the request and what it waits on. `sealeye promote status`, and `sealeye
  promote approve|refuse <id>` for the stand-in. Names settled in DESIGN.md before
  building and added to `core/operations.js`.
- The portal, as D13 says: the stages in Environments and on an environment's page, the
  Promote card, the Promotions and Approvals tabs, paged with status chips.
- Parity: both surfaces released together; the parity backlog's Promote row is built in
  the same commit. That ends 5a's core.

About four to five days.

## Part D: integrations and ServiceNow

### Step 10. Integrations, on both surfaces (D14)

- `GET /integrations`, `PUT` and `DELETE /integrations/{name}` (names out, values in),
  `POST /integrations/{name}/check`, an organization-wide token's only.
- `sealeye integrations` and an Integrations tab in Platform: each job (approvals,
  pipelines, gap tickets, notifications), what is connected for it, when it last worked,
  and what seaLeye does without it.
- The server's role gains read of `/sealeye-integrations/*` only, with a review.

About two to three days.

### Step 11. ServiceNow (D10)

- A free developer instance, a normal change opened from the promotion with the change
  description, its state and approver read by the poller. An integration user, never a
  person's password. A stage whose gate names a change ticket (Juniper's prod) carries
  its number.
- A stand-in ServiceNow in `npm test`; proven once on the pilot.

About three to four days. With Step 10, 5a is done.

## Part E: 5b, the organization's pipeline (B)

### Step 12. The pipeline adapter (D15, Q25)

- A pipeline interface beside the change tool's: start a run for a stage, read its
  status and outputs. GitHub Actions implements it, through the integrations registry.
- An approved promotion to a stage the pipeline applies starts its run, and the
  promotion and the stage's environment follow the run's status; the stage's outputs
  (its address) are read from the run, and evidence names the run.
- Changes to that stage (D4) start the pipeline too; a tear-down is the pipeline's, with
  its own workflow, or refused with words when the organization has none.
- What the pipeline is handed to build from is Q25, settled before this step.

About four to five days.

### Step 13. Juniper's pipeline, for real (D16)

- The library's `app-promote.yml` applies what seaLeye hands it, assuming the stage's
  role through GitHub's OpenID Connect; a teardown workflow beside it. Delivered as a
  patch, merged and tagged by Greg.
- Proven on the pilot: Juniper's staging and prod built by its own pipeline, started by
  `sealeye promote`, with the stand-in approving staging and ServiceNow approving prod.

About two to three days. With Step 12, 5b is done.

## Part F: gaps, notifications, writing it down

These need nothing above but the integrations registry (Step 10), and can be built
between other steps.

### Step 14. Gap advice, then gap tickets (D17)

- `POST /gaps/{kind}/advice`, capped, through the gateway, saved with the gap, shown in
  `sealeye gaps --advice` and on the Gaps page. Read by the platform team only.
- Graded on the made-up library's three planted gaps.
- Then Jira: a ticket per gap, carrying the advice and the apps waiting on it (linked by
  the `path` GET /needs gives), updated, never duplicated.

About four to five days.

### Step 15. Notifications (D18)

A notifier interface, Slack first by an incoming webhook, Teams after. A plain line and a
link, never a setting, a value or a token. About two days.

### Step 16. Write it down

DESIGN.md as each decision is made; ARCHITECTURE.md's containers, deployment (a role per
stage), the promotion flow and the data section; CLAUDE.md's API, executor and current
limits; ROADMAP Phase 5 ticked; BUILD-OUT's pictures; OPEN-QUESTIONS without Q25 (Q20 and
Q26 left it on Oct 24). About one to two days.

## Planned, not built

### C: the pipeline calls seaLeye's executor

`POST /stages/{stage}/builds` for a promotion already approved in the organization's own
process, called by a pipeline step with a token for that pipeline, naming its run; the
build and its status are A's, the record names the pipeline. Built when an organization
asks. About two to three days then.

### AWS access per team

A role in each team's account, per stage, on the shape Step 4 builds. When a bank pilot
gives seaLeye more than one account. About three to four days then.

### Cognito sign-in (Q16)

`sealeye login` through the browser, keeping a refresh token; the portal through the
hosted page; teams and an organization-wide scope from Cognito groups; tokens kept for
automation, such as a pipeline calling C. Its own plan when it is built. About five to
seven days then.

## Open questions this plan answers, and leaves

- **Q20** (a module per stage): answered Oct 24, 2026 by D1 and D2 (DESIGN.md, "A module
  per stage, in the catalog"); built in Steps 1 and 2.
- **Q25** (how a pipeline that applies a stage gets what to build): opened Oct 24, 2026,
  to be settled before Step 12.
- **Q26** (an app's settings at a later stage): answered Oct 24, 2026 by D12 (DESIGN.md, "An
  app's settings are kept by stage"); built in Step 5.
- **Q16** (Cognito sign-in): planned, not built. D10 answers its newest part, whether
  one person may ask and approve, "no" for a promotion.
- **Q13** (where traces live): answered Oct 13, 2026; its build is owed before the
  first customer's real code.
- **Q10** and **Q24**: left. This plan's new names match on both surfaces.

## Order and rough effort

| Steps | What | Effort |
|---|---|---|
| 0 | Close Phase 4 | an hour or two |
| 1 to 2 | The stage map (inputs by stage, `instead`, `with`), gates and appliers; discovery writes them | six to seven days |
| 3 to 5 | An environment at a stage, a role per stage, settings by stage | nine to eleven days |
| 6 to 9 | Ask, wait, approve, seaLeye applies, both surfaces | fifteen to seventeen days |
| 10 to 11 | Integrations and ServiceNow | five to seven days |
| | **5a** | **thirty-five to forty-two days** |
| 12 to 13 | The pipeline adapter, Juniper's pipeline for real | six to eight days |
| | **5b** | **six to eight days** |
| 14 to 16 | Gap advice and Jira, notifications, writing it down | seven to nine days |

About forty-eight to fifty-nine working days, nine and a half to twelve weeks of full
days, and longer in bursts. That is about four and a half weeks more than the plan that
stopped at a request, and more than the two to three weeks first guessed on Oct 24: the
stage has to reach names, state, roles, settings and every operation, not only
promotion. Steps 2, 4, 7 and 10 need an independent review before their pull requests.

What ships whole along the way: Steps 1 to 2 (every catalog says its path); Steps 3 to 9
(a team promotes through sit to staging with seaLeye applying); 5a (with ServiceNow);
5b.

## Owed after this plan, or before the first customer

| Item | Bring it forward when |
|---|---|
| **Everything PHASE4-PLAN still owes** (LangFuse in Canada, a paid account per customer, the Bedrock route, a large catalog, public libraries at scale) | Before the first customer's real code. |
| **C** | When an organization's pipeline must keep the gate and call seaLeye to build. |
| **A second account per stage** (D6) | When a pilot asks, or before a bank; the role per stage already allows it. |
| **The organization's own build** (D8) | When a bank requires its build, not seaLeye's, to be promoted. |
| **Settings and costs by organization** | Before a second real organization keeps settings. |
| **Pipelines beyond GitHub Actions** | When an organization's pipeline is GitLab, Azure Pipelines or Jenkins. |
| **A webhook from the change tool** | When polling is too slow or a bank asks for it. |
| **Teams** (D18) | After Slack, when an organization asks. |
