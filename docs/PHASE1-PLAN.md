# Phase 1 plan: LangFuse tracing, then a hosted API

Written Thu Oct 8, 2026. Part A was built on the branch `langfuse-tracing` and merged to
`main` on Fri Oct 9 (pull request #4), when Greg decided tracing stays in the product
(DESIGN.md, "Tracing stays in the product"). The plan first held that decision for a few
days; it did not need to wait. Part B, Steps 8 to 14, was built Oct 10 and 11, 2026.
Step 15, the second-person test, became PHASE2-PLAN Step 6 and is still open.

The plan has two parts. **Part A** (Steps 0 to 7) adds LangFuse to the interview as it runs
today, on Greg's machine, and can be finished in a few days. **Part B** (Steps 8 to 15) is
Phase 1 proper: the API is hosted, the interview moves behind it, and tracing moves with
it. Part B starts from `main` on Sat Oct 10.

## What the code looks like today

These facts shape every step below.

- **The only model calls are in the CLI.** `cli/interview/loop.js` calls
  `client.messages.create` in `createWithOneRetry`. The API never talks to Claude. So in
  Part A, tracing lives with the CLI, and in Part B it moves to the API with the interview
  (OPEN-QUESTIONS Q8).
- **The interview is a hand-written loop**, not the SDK tool runner: model turn, then
  `list_files` / `read_file` / `submit_plan`, a question to the developer, or a stop. Each of
  those is a natural span in a trace.
- **`read_file` can read `.env` today.** `BLOCKED` in `cli/interview/tools.js` covers
  `node_modules`, `.git`, `.sealeye` and `.deployme`, but not `.env`. So a developer's real
  secrets can already reach the model, against principle 6. Tracing would copy them into a
  third system. Step 1 fixes this first.
- **The CLI is a short-lived process.** Traces are sent in the background, so the CLI must
  flush them before it exits, or the last turns of every run are lost.
- **The deployment record already carries provenance** (`requestedBy`, `origin`,
  `planSha256`). The trace id joins it, so a deployment's outcome can be scored against the
  interview that produced it.

## Decisions this plan needs from Greg

Per CLAUDE.md, nothing is built past an open question. These are the calls, with a
recommendation for each. Each answer goes in DESIGN.md with its date and reason.

| # | Decision | Recommendation | Needed by | Decided
|---|---|---|---|---|
| D1 | LangFuse Cloud or self-hosted for Part A | Cloud, Hobby plan (free), US region, sample apps only | Step 2 | Cloud, Hobby plan, US region, sample apps only
| D2 | Do file contents ever go into a trace? | No. Paths, sizes and refusals only. | Step 3 | No. Paths, sizes, and refusals only
| D3 | Auto-instrumentation or hand-written spans | Hand-written, in `createWithOneRetry` and `runTool` | Step 3 | Hand-written, in createWithOneRetry and runTool
| D4 | Where the hosted API runs (Q2) | One EC2 t4g.small in ca-central-1 for the pilot; ECS Express Mode later | Step 9 | Yes (A2, stage 1)
| D5 | Database (Q2) | Postgres in a container on the same machine, nightly dump to S3 | Step 10 | Yes (A2, stage 1)
| D6 | Which domain does what | See Step 12 | Step 12 | As stated in Step 12
| D7 | Sign-in (Q3) | Defer to its own plan. Part B ships with a temporary per-person token. | Step 13 |
| D8 | The interview as a LangGraph graph, or hand-rolled | LangGraph, with the Postgres saver from Step 10 (see Step 8) | Step 8 | LangGraph (Sat Oct 10, DESIGN.md)

**Why D1 is Cloud for now, and not for a bank.** LangFuse Cloud offers US, EU and Japan
regions only, with no Canadian region. A trace holds a developer's questions, answers and
plan. That is fine for the sample apps in `apps/`, and not fine for a bank's code. A bank
deployment would run LangFuse inside its own network, which is the Phase 5 "in-network"
item. Self-hosting is not a small job: it needs Postgres, ClickHouse, Redis and S3, and
LangFuse documents its single-machine Docker setup as for testing only. So Part A uses
Cloud, and the residency question is written down rather than solved.

**Why D3 is hand-written.** LangFuse's documented route for Anthropic in Node is an
OpenTelemetry instrumentation that wraps the SDK and records every request and response
whole. That records exactly what D2 rules out, because every turn's input includes earlier
file contents. It is also untested against the `@anthropic-ai/sdk` 0.127 this repo pins.
Hand-written spans let seaLeye decide what a trace contains. That is the principle-6
answer, and it is the more useful thing to learn.

## Part A: tracing the interview

**Status:** built and checked by hand on Fri Oct 9, 2026, on `langfuse-tracing` (pull
request #4, merged Fri Oct 9). Where the build differs from the steps below, DESIGN.md says
why: LangFuse SDK v5 with a tracer provider of seaLeye's own (Step 3), scores sent one
bounded request each rather than through `@langfuse/client` (Step 5), and regression
runs recorded as LangFuse experiments, because dataset runs are off for new
organizations (Step 6).

### Step 0. Branch and baseline

```bash
cd ~/dev/sealeye
git switch main && git pull
git switch -c langfuse-tracing
npm test
```

**Done when:** the branch exists and all nineteen checks pass.

### Step 1. Stop the interview reading secrets (do this on `main` as well)

This is a principle-6 bug whether or not tracing ever ships, so it is its own commit and
can be cherry-picked to `main` right away.

- In `cli/interview/tools.js`, refuse any file whose name is `.env` or starts with `.env.`,
  except `.env.example` and `.env.sample`. Refuse with a reason the model can read
  ("refused: .env holds secret values; read .env.example instead"), like the other
  refusals.
- Do the same for a short list of obvious credential files: `*.pem`, `*.key`, `id_rsa*`,
  `.npmrc`, `credentials`.
- `list_files` still shows these names, because the model needs to know a `.env` exists,
  but never its contents.
- Add tests to `test/` for each refused name and for `.env.example` still being readable.
- DESIGN.md entry: what is refused, and why names stay visible.

**Done when:** `npm test` passes, and `sealeye run` on an app with a `.env` plans from
`.env.example` and the code alone.

### Step 2. A LangFuse project and keys

1. Sign up at langfuse.com, choose the **US** region, and create a project called
   `sealeye-dev`.
2. Create an API key pair and put the keys in `~/.sealeye/config`, never in the repo:
   ```
   LANGFUSE_PUBLIC_KEY=pk-lf-...
   LANGFUSE_SECRET_KEY=sk-lf-...
   LANGFUSE_BASE_URL=https://us.cloud.langfuse.com
   ```
3. Check whether LangFuse knows the price of `claude-sonnet-5` (Settings, Models). If it
   doesn't, add a model definition with Anthropic's current per-token prices, so costs show
   up per run. This matters later: the vision prices model costs into the product.

**Done when:** the keys load through `loadUserConfig()`, and no LangFuse value is in any
tracked file (`git grep -i langfuse_secret` finds nothing).

### Step 3. `core/tracing.js`: one module that owns what a trace may contain

It lives in `core/` because the interview moves from `cli/` to `api/` in Part B, and the
tracing should not have to move with it. `test/boundaries.test.js` should keep passing.

```bash
npm install @langfuse/tracing @langfuse/otel @langfuse/core @opentelemetry/api \
  @opentelemetry/sdk-trace-node @opentelemetry/context-async-hooks
```

Built on LangFuse v5 with a tracer provider of seaLeye's own rather than `NodeSDK`;
DESIGN.md says why. The sketch below still describes what the module does.

What the module does:

- **Off unless configured.** With no LangFuse keys, every function is a no-op. Tracing
  never makes a run fail: every export path is wrapped in try/catch and logs only under
  `SEALEYE_DEBUG`.
- **Starts and flushes.** `startTracing()` registers a `NodeSDK` with a
  `LangfuseSpanProcessor`. `flushTracing()` calls `forceFlush()` with a short timeout and is
  called on every CLI exit path, including errors and Ctrl-C.
- **Redacts in two layers.**
  - *By construction:* the helpers below take only fields seaLeye chose. File contents never
    reach them (D2).
  - *As a backstop:* the span processor's `mask` option runs one function over everything
    that is exported. It redacts AWS access keys (`AKIA...`), Anthropic keys (`sk-ant-...`),
    LangFuse secret keys, private-key blocks, and any `NAME=value` line whose name contains
    KEY, SECRET, TOKEN or PASSWORD. Each becomes `[value redacted]`, the same wording the
    evidence files use.
- **Exposes four helpers** shaped like the interview:
  - `traceRun({ app, mode, model, promptSha, user }, fn)` is the root of one `sealeye run`.
    `mode` is first run or re-run, and `user` comes from the existing `requestedBy`. The
    session id is the app name, so every run of one app lines up in LangFuse.
  - `traceTurn({ turn, model, usage, endedIn, ms, retried }, ...)` is one model call as a
    *generation*. It records the token usage, including cache reads and writes, which the
    current debug line already prints. Its input is the **shape** of the conversation
    (roles, block types, tool names, file paths) and never block contents. Its output is the
    model's text and tool calls, with `submit_plan` input recorded in full, because the plan
    contains no secrets by contract.
  - `traceTool({ name, path, bytes, truncated, refused })` covers `list_files` and
    `read_file`: the path and the size, never the contents.
  - `traceEvent(name, attrs)` covers a question asked, an answer given (the answer text goes
    through `mask`), a validation failure with its error messages, the nudge after question
    four, and the final status.
- **Records the prompt version, not the prompt.** `promptSha` is the git hash of
  `prompts/interview-system.md`. The repo stays the source of truth for prompts. LangFuse's
  prompt management is worth knowing about, but moving prompts out of git would break the
  "decisions live next to the code" rule.

Tests (no network, like the rest): redaction of each pattern; the no-op path when keys are
missing; and a test that `traceTool` given a `content` field drops it.

**Done when:** `npm test` passes with and without LangFuse keys set.

### Step 4. Instrument the interview

Small, local changes in `cli/interview/loop.js`. The control flow stays as it is.

- `runInterview` runs inside `traceRun`.
- `createWithOneRetry` wraps each call in `traceTurn`. A retry is recorded on the same turn
  (`retried: true` plus the error class), so slow turns can be explained from the trace.
  That is what `debugTurn` does today on stderr.
- `runTool` calls are wrapped in `traceTool`.
- `submit_plan` gets a span covering the call to `POST /plans/validate`, with `valid`, the
  error count and the retry number.
- The returned `status` (`submitted`, `stopped` or `invalid`) and the question count are set
  on the root.
- In `cli/bin/sealeye`, `run` calls `startTracing()` first and `flushTracing()` on every
  exit.
- The trace id is returned with the interview result.

**Done when:** one `sealeye run` on `apps/static-website` shows one trace in LangFuse, with
a generation per turn, a span per file read, token usage and cost, and no file contents
anywhere. Open three traces and look for this yourself; don't take the code's word for it.

### Step 5. Join the trace to the deployment, and score the outcome

This is where tracing becomes evaluation.

- `POST /deployments` already accepts an `origin` object. The CLI adds `traceId` to it, so
  the record names the interview that produced it. The API stores it and changes nothing
  else (keep existing endpoints working).
- Scores, posted against the trace (one bounded request each; DESIGN.md says why not
  `@langfuse/client`):
  - `plan_valid_first_try` (boolean)
  - `validation_retries` (0 to 2)
  - `questions_asked` (0 to 4)
  - `developer_said_yes` (boolean, from the "Deploy this? [y/N]" boundary)
  - `needs_refused` (boolean: the plan was drafted with needs)
  - `deployment_succeeded` (boolean, posted when `watch` or `status` sees a terminal stack
    status). Status is real here as everywhere: only a status read from CloudFormation is
    scored, and a deployment that was never watched gets no score rather than a guess.

**Done when:** a successful run and a deliberately failing one (an app with an unsupported
need) both show their scores, and the deployment record holds the trace id.

### Step 6. A small regression set from the sample apps

The `ask` callback is already injected, so a scripted run needs no new interview code.

- `scripts/eval-interview.js` runs `runInterview` against each app in `apps/` with
  pre-written answers in `test/fixtures/eval/<app>.json` (with the expected result beside
  them), and without deploying.
- Each run is linked to a LangFuse dataset item named after the app, with the expected
  outcome: the static site gives a `ready` plan with `static_site_edge`; the API gives
  `http_api_serverless`; the payment events processor is refused with the needs it should
  name.
- The script scores each run: right modules, right needs, number of questions, and cost.
- It is not part of `npm test`, which stays offline. It is run by hand
  (`npm run eval:interview`) before any change to `prompts/`.

This is the Phase 3 "self-test: plans that must be refused, and are" in miniature.

**Done when:** one command produces a LangFuse dataset run comparing the three apps, and
running it twice shows how much the results vary between runs.

### Step 7. Write it down

- DESIGN.md: tracing decisions D1 to D3, what is and isn't in a trace, and the residency
  limit.
- ROADMAP.md: an "Observability" line under Phase 1, and a note that Phase 3's self-test
  starts from Step 6.
- OPEN-QUESTIONS: add **Q13. Where do traces live for an organization?** The options are
  LangFuse in their network, LangFuse Cloud with a regional contract, or tracing off. It
  blocks any pilot with real code.

**Done when:** the branch is pushed and has a pull request describing it, unmerged:

```bash
git push -u origin langfuse-tracing
gh pr create --draft --fill
```

### What Part A gives you on Tuesday

A live example of the ACP's problem in miniature: an agent working in a regulated setting,
traced end to end, with a human approval gate and guardrails that are tested rather than
assumed. It also gives you three things worth saying in the room:

- **Why you didn't use the auto-instrumentation.** It records everything, and in a bank,
  "everything" includes secrets.
- **The residency gap.** There's no Canadian region, and self-hosting needs four data
  stores.
- **The connection that matters.** Tracing only becomes governance when a trace is joined
  to a real outcome. Step 5 is that join.

## Part B: the hosted API (from Sat Oct 10)

This is roadmap Phase 1, work items 1 to 8, in the order the dependencies force.

### Step 8. Move the interview behind the API (Q8)

Hosting the API first and leaving the interview on laptops would mean every developer
holds an Anthropic key and LangFuse keys. So the interview moves first, and tracing moves
with it.

- New endpoints, following the parity rule (API first):
  - `POST /interviews` starts one and returns an id.
  - `POST /interviews/{id}/answers` sends the developer's answer.
  - `GET /interviews/{id}/events` streams progress lines, questions and the final plan as
    server-sent events.
- `runInterview` moves to `api/interview/`, unchanged inside. `ask` becomes "emit a question
  event and wait for the answer endpoint". `onStep` becomes "emit a step event". The CLI
  keeps its spinner and its amber prompts, and renders the events.
- **The folder problem (Q1):** the model's tools read the app, and on a hosted API the app
  is not there. Go with the leaning (c): the CLI uploads a zip of the folder (same exclusions
  as packaging, plus the Step 1 secret files, which never leave the laptop). The API unpacks
  it into a per-interview scratch folder, which the tools and later the packager read. The
  repository option comes later, for the portal.
- `core/tracing.js` is now started once by the API. The API holds the only keys, and the
  CLI has none.
- **The model address is a setting** (`SEALEYE_MODEL_URL`, read with `setting()` like
  `MODEL`), passed to the Anthropic client as its base URL. Unset means Anthropic's own
  address, so nothing changes by default. This lets an organization send the interview's
  model calls through its own AI gateway (Agent Gateway, or whatever it already runs, often
  in front of Claude on Bedrock in its own AWS account) instead of seaLeye needing its own
  route to api.anthropic.com. About a day. A test runs one interview turn against a stand-in
  server at that address. Before saying this in a pitch, check whether the model seaLeye
  uses is offered on Bedrock in ca-central-1. Whether seaLeye runs a gateway of its own is
  Q14, and is not part of this step.

**Done when:** `sealeye run` works end to end against a local API with
`ANTHROPIC_API_KEY` unset on the CLI side, and the trace looks the same as in Part A.
Also done when: with `SEALEYE_MODEL_URL` pointed at a stand-in, the API's model calls go
there and nowhere else.

#### The interview as a LangGraph graph (D8, decided)

Greg chose LangGraph on Sat Oct 10 (DESIGN.md, "The interview runs as a LangGraph graph").
This section is how Step 8 is built; the endpoints and events above stay as written.

Read the bullets above with one change: `runInterview` does not move unchanged. Wrapped by
hand, the loop would wait in memory for the answer endpoint, which leaves two gaps. A paused interview lives only in the API process, so a restart or deploy loses it.
And an interview is tied to the connection that started it, so the portal cannot pick up
an interview the CLI began, which the parity rule eventually needs.

LangGraph (`@langchain/langgraph`, the JavaScript version, so no language change) closes
both. The interview becomes a small graph: read the app, model turn, run tools, ask the
developer, write the plan, wait for approval. Asking and approval become `interrupt()`
calls. A checkpointer saves the graph's state at every step under the interview id, and
`POST /interviews/{id}/answers` resumes it with `Command({ resume: answer })`, from
whichever surface sent the answer. The endpoints and the events stay as above.

**What it changes elsewhere**

- **Checkpoint store.** Step 8 comes before Postgres (Step 10). Use the in-memory saver in
  Step 8, then switch to the Postgres saver (`@langchain/langgraph-checkpoint-postgres`) in
  Step 10, in the same database with its own tables. A restart test goes into Step 10's
  "done when".
- **Model calls stay as they are.** Nodes call `createWithOneRetry` and the Anthropic SDK
  directly. No LangChain model wrappers, so `SEALEYE_MODEL_URL` still works unchanged.
- **Tracing stays hand-written (D3).** LangFuse's LangGraph callback handler records every
  node's input and output whole, and the state holds file contents, which D2 rules out.
  Do not attach it. The trace id goes into the graph's state so the spans of one interview
  join up across pauses.
- **The checkpoint holds file contents too.** It is the conversation so far, so it gets the
  same care as the scratch folder: deleted when the interview ends or after a day, and never
  copied into backups longer than that. This is a new place secrets could sit, and Step 1's
  blocked files must already be absent from it.
- **A resumed node runs again from its start.** LangGraph replays the interrupted node from
  the top when it resumes. So each interrupt gets a node of its own, and no model call sits
  in the same node before an `interrupt()`. Otherwise every answer repays for a model turn
  and can change the question that was just answered.

**The trade-off**

| | Hand-rolled (Step 8 as written) | LangGraph |
|---|---|---|
| Survives an API restart | No, unless a resume layer is written | Yes, once the Postgres saver is in |
| CLI starts, portal finishes | Needs its own state store | Built in, by interview id |
| New dependencies | None | `@langchain/langgraph`, its Postgres saver, `@langchain/core` |
| Effort | Two to three days | About one more day, mostly the graph and its tests |
| Later phases | Rebuild for Phase 3 ingestion and Phase 4 approval gates | Same pattern carries into both |

The hand-rolled route could get restart-safety from a state machine and a row in Postgres.
That is less code to depend on, but it is the same feature written a second time, and the
Phase 3 discovery agent and the Phase 4 gates that wait days on a release decision would
need it again. That is why LangGraph was chosen.

**Done when (added to Step 8's):** an interview paused at a question resumes from the
answer endpoint with no model call repeated, and its trace is one trace across the pause.
Step 10 adds: it also resumes after the API restarts.

### Step 9. One small server in ca-central-1 (D4)

Recommendation for the pilot: **one EC2 t4g.small** (2 vCPU, 2 GB, ARM) in ca-central-1,
running Docker Compose with three containers: the API, Postgres and Caddy.

Why this one:

- **The executor needs a real machine.** It spawns the AWS CLI, runs
  `aws cloudformation deploy` in the background and polls every 5 seconds in-process. That
  rules out Lambda.
- **It needs an IAM role, not stored keys.** EC2 takes an instance profile, and the API can
  assume each team's deploy role from it (Q4). Lightsail is cheaper, but it can't attach an
  instance role, so it would mean long-lived access keys on the box.
- **App Runner is out.** AWS stopped taking new App Runner customers on April 30, 2026 and
  points to ECS Express Mode instead.
- **ECS Express Mode is the next step, not the first.** It gives Fargate, a load balancer
  with TLS and autoscaling at no extra charge beyond those resources. But the load balancer
  plus a managed database costs several times this setup, and a pilot of a few people
  doesn't need it yet. Move when a second team arrives, or when the server going down for an
  hour stops being acceptable.

Work:

- A `Dockerfile` for the API, with the AWS CLI installed, built for arm64, and `npm test`
  run in the build.
- `deploy/compose.yaml` and `deploy/Caddyfile`. A CloudFormation template for the server
  itself in `deploy/`: the instance, a security group open on 443/80 only, an Elastic IP,
  the instance role, and an S3 bucket for backups and uploads. It is seaLeye's own
  infrastructure, built the same way it builds everyone else's.
- The instance role may only assume roles named `sealeye-deploy-*`. A team's own account
  trusts that role (Q4, start with one account).
- Secrets (Anthropic key, LangFuse keys, database password) live in SSM Parameter Store as
  SecureStrings and are read at container start, never in compose files.

Approximate monthly cost in USD (check the AWS calculator for today's ca-central-1
prices):

| Item | Pilot (this step) | Later (ECS Express + RDS) |
|---|---|---|
| Compute | t4g.small, about $14 | Fargate 0.5 vCPU / 1 GB, about $20 |
| Load balancer | none, Caddy does TLS | ALB, about $20 and up |
| Database | in the container, $0 | RDS db.t4g.micro, about $15 to $18 |
| Disk, public IP, backups | about $6 | about $10 |
| LangFuse | Hobby, $0 (50k units) | Core, $29 if needed |
| **Total** | **about $20** | **about $65 to $100** |

Model usage and the environments developers create are billed separately in either case.
A traced run is roughly 30 to 40 LangFuse units (turns, tool spans and scores), so the free
50k units covers well over a thousand runs a month.

**Done when:** `curl https://api.sealeye.online/health` answers from the server.

### Step 10. Postgres instead of `deployments.json` (D5)

- `api/store.js` keeps its exported functions (`putDeployment`, `getDeployment`,
  `listDeployments`, `count`), so nothing calling them changes. The body moves to Postgres
  through `pg`, with plain SQL migrations in `api/migrations/`.
- Every record gets `org_id`, `team_id`, `created_by`, `surface` (cli or portal) and
  `trace_id`.
- The in-flight rule stays: a deployment that was running when the API restarted says so.
  After a restart, the API resumes polling anything still `running`, which the file store
  never did.
- `pg_dump` runs nightly to the S3 bucket, with a 30-day lifecycle rule. Test a restore once
  before anyone else's data is in it.
- A one-off importer for Greg's existing `~/.sealeye/deployments.json`.
- The interview's checkpointer moves from the in-memory saver to the Postgres saver (D8).
  Its tables are left out of the nightly dump (`pg_dump --exclude-table`), because a
  checkpoint holds file contents and is kept for a day at most.

**Done when:** an interview paused at a question resumes after the API restarts, the API
restarts without losing or faking a status, and a restore from last
night's dump works.

### Step 11. CI

- `.github/workflows/test.yml` runs `npm test` on every push and pull request (Phase 1 item
  8).
- A second job builds the arm64 image on `main` and pushes it to ECR. Deploying it is a
  manual `docker compose pull && up -d` until there is a reason to automate.

### Step 12. Domains (D6)

DNS can stay with the current registrar: point an A record at the Elastic IP and Caddy
obtains certificates itself. Route 53 is only worth it ($0.50 per zone per month) if you
want the DNS in the CloudFormation template too. *Done Oct 10, 2026, with Route 53 for
all three domains (DESIGN.md, "Each domain has one job"; deploy/README.md).*

| Address | Serves | Why |
|---|---|---|
| `sealeye.online` | the portal (static files, from Caddy) | the product's front door |
| `api.sealeye.online` | the API | the address both clients use. CLI default changes from `localhost:3000`. |
| `sealeye.run` | the command's home page and `sealeye.run/install` | the name of the command is the name of the site |
| `sealeye.org` | redirect to `sealeye.run` for now | keep it. It could host open docs or a standard later. |

The portal and API on one parent domain also keep sign-in cookies simple in Step 13.
seaLeye.com stays a name only, as DESIGN.md says.

### Step 13. Who is calling (D7, a stand-in until Q3 is answered)

- Until sign-in is decided, the API requires a bearer token. Tokens are issued per person by
  a small admin script and stored hashed in Postgres. `sealeye login` asks for the token
  and keeps it in `~/.sealeye/config`.
- Every record and trace gets the token's person, org and team. This is the shape real
  sign-in will fill, so nothing after it changes when an identity provider replaces the
  script.
- Real sign-in (OIDC first, SAML-capable, per the Q3 leaning) gets its own plan.
- *Done Oct 11, 2026 (DESIGN.md, "Every caller has a token, until sign-in"). Tokens are
  made on the administrator's Mac and only their hash reaches the server.*

### Step 14. The portal reads live data (Phase 1 item 7, Q9)

- Rebuild the portal in `portal/` with React + TypeScript and Vite, using shadcn/ui for
  buttons, tables and forms (A9). The seaLeye.online mock-up in `archive/` is the design
  reference, not code to copy. Colours and type come from `brand/BRAND-ONLINE.md`.
- Build Environments, Catalog and Control first. Where the mock-up inlined sample JSON,
  the new pages call the API, and nothing else.
- `npm run build` in `portal/` produces static files that Caddy serves at
  `sealeye.online` (Step 12). There is no second server.
- Playwright tests check that each page loads and shows live data from a test API, and
  that tear down works. CI (Step 11) runs them next to `npm test`.
- Tear down from the portal calls `DELETE /deployments/{id}`, the same endpoint
  `sealeye destroy` uses, and the record says which surface did it.
- Update the parity table rows for List, Status, Tear down and Needs ledger.
- *Done Oct 11, 2026 (DESIGN.md, "The portal signs in with a session cookie" and "The
  portal is a client of the API"). Catalog got its endpoint and command on the way.*

### Step 15. The Phase 1 "done when", tested by someone else

A second person, on their own machine, with only the token and `npm i -g` from a tarball
(Q10 stays open), runs `sealeye run`, gets a URL, sees it on seaLeye.online, and tears it
down from the portal. Watch them do it rather than doing it for them.

## Order and rough effort

| Steps | What | Effort |
|---|---|---|
| 0 to 2 | Branch, secret-file fix, LangFuse account | an evening |
| 3 to 4 | Tracing module and interview spans | a day |
| 5 to 6 | Scores and the regression set | a day |
| 7 | Write-up and draft PR | an hour |
| | **Interview, Tue Oct 13. Merge decision.** | |
| 8 | Interview behind the API, as a LangGraph graph | three to four days |
| 9 to 12 | Server, Postgres, CI, domains | two to three days |
| 13 to 15 | Tokens, live portal, second-person test | two to three days |

Steps 1 and 3 are where the safety of the whole thing is decided. Review those two diffs
line by line, even if everything else is skimmed.
