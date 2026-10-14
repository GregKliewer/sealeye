# Design decisions

`brand/BRAND.md` is the rule for everything the developer sees. This file is where a
deliberate departure from it is written down, with the reason, so that a difference
nobody can explain later is a bug rather than a decision.

## The dashboard header says seaLeye.online

Decided Mon Sept 22, 2026.

`apps/sealeye-online` is the page that shows environments across the organization, and
it is served from sealeye.online. Its header now reads **seaLeye.online** rather than
seaLeye.run, because a header names the thing you are looking at, and the thing you are
looking at is the dashboard rather than the command line tool.

Everything else still says seaLeye.run: the CLI banner, the report header,
`apps/sealeye-run`, and the product itself in prose. The name of the product did not
change. One page is named after its own address.

**The asset.** `brand/sealeye-online-wordmark.svg`, copied into the app folder beside
the page that uses it. It is the wordmark from `BRAND.md` with `.online` in place of
`.run`: same mark, same JetBrains Mono Bold, same phosphor `L`, and `.online` in regular
weight and Dim exactly as `.run` was. Two geometry changes follow from three more
characters: the canvas widens from 640 to 760, and the phosphor cursor block moves from
x=530 to x=648, which keeps the right margin it had before.

**It carries no provenance manifest.** The files in `brand/` ship a c2pa manifest that
describes those files. A derived file that kept it would be asserting provenance for an
image that no longer exists, so the variant was written clean.

**If the dashboard is ever shown beside the CLI**, the two wordmarks differ only in the
last word, which is the point: same product, two surfaces, and the address is how you
tell which one you are in.

## The Catalog chip says planned, not Platform Library

Decided Mon Sept 22, 2026.

**Superseded Sept 26, 2026** by planVersion 0.4: seaLeye.run no longer names modules it
cannot build, so there is no planned or requested state, only a module it builds or a
need it describes. Kept for its reasoning about naming states once. It changes `brand/BRAND-ONLINE.md` section 4, which said
"Platform Library" in its first draft.

Everything in the Catalog on seaLeye.online is in the Platform Library, including the
modules the platform builds today. A chip reading "Platform Library" on only some of the
cards therefore names the panel rather than the module, and invites the reader to think
the available ones came from somewhere else. It is also wrong about where things are
heading: once the initial install is done, everything in the library is built, and the
only modules carrying a chip at all are the new ones an app has turned out to need.

`planned` is what the plan file, the decision card and the terminal's `(planned)` marks
already say, so the console and the terminal describe a module the same way. The
terminal's refusal still names the Platform Library in its closing sentence, which is
the right place for it: there it is saying where the modules come from, which is a
sentence about provenance rather than a label on a card.

**Three states, one word each.** A module an app needs moves through more than one, and
the words are now the same everywhere:

- **available**: the platform deploys it today.
- **planned**: the platform team has agreed to support it and it has not shipped.
- **requested**: an app has turned out to need it and nobody has agreed to it yet. The
  platform team can still say no.

The difference between planned and requested is whose decision it is waiting on, and
nothing else: both are recorded in a plan, both are marked on the card, and both make
the platform decline to deploy rather than build something smaller and report success.

`availability: real` in the catalog file became `available` for the same reason the chip
changed. "Real" described what the executor could do; "available" describes where the
module has got to, which is the thing everyone reading the page or the card is actually
asking about. Nothing is `requested` today. The state exists because the demo is asked
what happens when an app needs something nobody has agreed to yet, and the honest answer
is a word rather than a shrug.

## The corporate site header says seaLeye.com

Decided Wed Sept 30, 2026.

`apps/sealeye-com` is the company's own site, the one a CIO, a head of platform
engineering or a vendor-risk team reads before a meeting. Its header reads
**seaLeye.com**, for the same reason the console's reads seaLeye.online: a header names
the thing you are looking at, and the thing you are looking at is the company rather
than either of its two products.

seaLeye.com is a name only. The real sealeye.com domain belongs to an unrelated company,
so the site is served from an S3 website address like the other two, and nothing
anywhere links to sealeye.com.

**The asset.** `brand/sealeye-com-wordmark-light.svg`, copied into
`apps/sealeye-com/images/`. It is `sealeye-online-wordmark-light.svg` with `.com` in
place of `.online`: same mark with its dark window, same ink, the same phosphor-deep `L`,
and `.com` in regular weight and Dim exactly as `.online` and `.run` are. `.com` has the
same number of characters as `.run`, so it takes the original `.run` geometry rather
than the widened `.online` one: a 640 canvas, and the cursor block back at x=530.

**It carries no provenance manifest**, for the reason the `.online` variant does not.

**The corporate site is the console's design system, not a third one.** It is set on
the light ground from `brand/BRAND-ONLINE.md`, with IBM Plex Sans for reading, JetBrains
Mono for anything that is code or data, and phosphor-deep and amber-deep in their usual
jobs. The only dark things on it are the mark and the terminal cards, which is the
console's own rule: a small dark window on a light desk. Put side by side, the three
wordmarks differ only in the last word, and the address is how you tell which door you
came in by.

## The demo becomes a product repo

Decided Thu Oct 8, 2026.

**The demo is frozen, not discarded.** The build shown on Oct 2 is the tag
`demo-2026-10-02`. The repo was renamed from `deployme-demo` to `sealeye` rather than
started fresh, because its history is the record of why seaLeye works the way it does.
The May 2026 POC documents were removed from all history first.

**Parity is a principle, not a feature.** The dry run promised that seaLeye.online does
everything seaLeye.run does, one for one. That only holds if both are clients of one API,
so the rule is: an operation is an API endpoint first, then a command and a page with
the same name, inputs and outputs, and it ships when both surfaces have it. VISION.md has
it in full.

**cli/, api/ and core/, in one package.** The CLI and the API will ship separately (a
command developers install, a service we host), so they cannot depend on each other.
What both must agree on, the plan contract, the catalog, settings and how an app name
becomes a stack name, is core/. One package rather than npm workspaces for now, because
nothing is published yet; a test enforces the boundary instead. Workspaces come when the
CLI is published (OPEN-QUESTIONS Q10).

**sealeye everywhere, deployme still read.** `deployme.yaml` was being written into
developers' folders and `~/.deployme/config` was where they were told to put their key,
so the internal name had already leaked. From 2.17.0 the names are `sealeye.yaml`,
`~/.sealeye/` and `SEALEYE_*`. The old ones are read for at least one release and never
written, and the old deployment store is copied rather than moved, so a rollback to
2.16.0 still finds everything. The `deployme` bin alias is gone; `init` stays as the
hidden alias for `run`.

**Demo material is archived, not deleted.** The three sites, transcripts, day notes,
PROGRESS, SCOPE and the QA bench are in `archive/`. The seaLeye.online mock-up is where
the real portal's design starts (OPEN-QUESTIONS Q11).

## The interview never reads secret files

Decided Fri Oct 9, 2026.

**What is refused.** The interview's `read_file` tool refuses `.env` and any `.env.*`
file except `.env.example` and `.env.sample`, plus `.envrc`, `*.pem`, `*.key`, SSH keys
(`id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*`), `.npmrc` and `credentials`. Names
are matched case-insensitively, and a symlink is judged by what it points at as well as
its own name. The refusal is text the model reads, like the other refusals, and the
`.env` one points it at `.env.example`.

**Why.** Before this, `read_file` could return a developer's real `.env`, so their
secrets could reach the model, against principle 6. Tracing (PHASE1-PLAN Part A) would
also have copied them into a third system. This is a fix whether or not tracing ships,
so it is its own commit on `main`.

**Why the names stay visible.** `list_files` still shows these files. Knowing a `.env`
exists tells the model the app reads settings, and `.env.example` or the code tells it
which ones. The names carry no secret; the contents do.

**Not covered.** Secrets pasted into ordinary files (a key in `config.js`) are still
readable. Finding those is a scanning job, not a name rule, and is not attempted here.
## Phase 1: who it is for, and how the hosted product is built

Decided Fri Oct 9, 2026. These answer the questions that blocked Phase 1 in
`docs/OPEN-QUESTIONS.md`.

**The first release is for collaborators, then a pilot group.** Both: people building
seaLeye with Greg, and a pilot group using it to deploy their own apps. So Phase 1 needs
a repo that sets up in minutes with good tests, and also a hosted API, sign-in and AWS
access for people who only use it. Collaborators come first, which makes the provenance
of the earliest code (OPEN-QUESTIONS Q12) a gate before anyone else sees the repo.

**The CLI uploads the app; the portal will read a repository.** A hosted API cannot read
a folder on the developer's machine, and the portal has no folder at all. For now the CLI
uploads a zip of the folder, with the same exclusions as packaging and with secret files
never leaving the laptop, and the API unpacks it into a scratch folder per interview.
Reading from a connected Git repository and branch comes later, for the portal and for
promotions. Upload first keeps the promise that you run seaLeye in your own folder.

**One AWS account, ca-central-1, Postgres, grown in three stages.** Everything stays in
one account and one region. The executor runs the AWS CLI and polls CloudFormation from a
long-lived process, so it needs a real machine with an IAM role, not Lambda and not
stored access keys. Each stage starts on a trigger, not a date:

1. Pilot: one EC2 t4g.small running the API, Postgres and Caddy in Docker Compose, with a
   nightly `pg_dump` to S3. About $20 a month.
2. When someone else's data matters: the same server, with Postgres moved to RDS
   (db.t4g.micro) for backups, point-in-time restore and patching. About $35 to $40.
3. When downtime becomes the problem (a second team, or anyone who expects it to stay
   up): ECS Express Mode, which is Fargate behind a load balancer, plus the same RDS.
   About $65 to $100, less with a 1-year Savings Plan.

Ruled out: API Gateway in front of the API, because it times out at 30 seconds and an
interview turn takes 25 to 45 seconds over server-sent events; Lightsail, Fly, Render and
Railway, because they mean long-lived AWS keys and data outside the account and possibly
outside Canada; Fargate Spot, because an interruption kills a running interview. Costs
are approximate USD as of Oct 9, 2026.

**Sign-in is Amazon Cognito.** Every bank will ask to use its own identity provider, so
sign-in speaks SAML and OIDC from the start. Cognito does, and it runs in the same
account and region as the API, so user records stay in Canada. Its free tier covers
10,000 people signing in directly and 50 through their own company's identity provider,
then $0.015 per person a month. Google sign-in works out of the box; GitHub needs a
small shim, because its sign-in is not standard OIDC. The CLI signs in through the
browser and keeps a token. How Cognito replaces the Phase 1 plan's temporary per-person
token (D7) is still to be decided.

**Deployments are designed for each team's own account and start in one shared account.**
A bank will require deployments in its own AWS account, through a role the API assumes.
The pilot starts with one shared seaLeye account and one team, but every deployment
already goes through an assumed role (the API's instance role may only assume roles
named `sealeye-deploy-*`), so adding a team's own account is configuration, not a
rewrite.

**Model calls move behind the API.** The interview runs in the API, with the API's
`ANTHROPIC_API_KEY` and any other model settings, and the CLI streams it. Developers no
longer need a key of their own, model cost can be priced into the product as the vision
says, and the system prompt stays off developers' machines. Tracing keys move with it.

**The portal is React and TypeScript, built with Vite, with shadcn/ui and Playwright.**
Greg builds through coding agents, and agents write React more reliably than any other
framework because there is the most of it to learn from. TypeScript makes an agent's
mistake a failed build with a clear error, rather than something found by reading code.
Vite builds plain static files that Caddy serves beside the API, so there is no second
server, and the portal talks only to the API. shadcn/ui components are copied into the
repo and styled from `brand/BRAND-ONLINE.md`. Playwright tests check that pages load and
work, and run in CI beside `npm test`. The archived seaLeye.online mock-up is the design
reference; the portal is rebuilt in `portal/`, not copied. Not chosen: Next.js (a second
server), Svelte and Vue (less for agents to draw on), staying plain (the interview page
would force a rewrite). All of it is free.

## Tracing the interview with LangFuse

Decided Fri Oct 9, 2026. These are D1 to D3 in `docs/PHASE1-PLAN.md`.

**LangFuse Cloud, Hobby plan, US region, sample apps only.** LangFuse Cloud has no
Canadian region, and self-hosting it needs Postgres, ClickHouse, Redis and S3. A trace
holds a developer's questions, answers and plan, which is fine for the sample apps and
not for a bank's code. Where traces live for an organization is written down as an open
question rather than solved, and it must be answered before the pilot group runs seaLeye
on real code.

**File contents never go into a trace.** A trace records which files were read, their
sizes and any refusals, never what is in them. Developer code can hold secrets, a trace is
a copy in a third system, and "our traces hold file names, never contents" is what a bank
needs to hear. The developer's questions and answers (through the redaction filter) and
the plan do go in; the plan holds no secrets by contract.

**Spans are hand-written, in `createWithOneRetry` and `runTool`.** LangFuse's automatic
instrumentation for Anthropic records every request whole, and every turn resends the
files read earlier, so it would break the rule above. It is also untested against the
`@anthropic-ai/sdk` 0.127 this repo pins. Hand-written spans let seaLeye decide what a
trace contains.

**What a trace holds, as built.** Checked by hand on Greg's own runs on Oct 9, and by
`test/interview-trace.test.js` on every `npm test`.

| In a trace | Never in a trace |
|---|---|
| Each turn's shape: roles, block types, tool names, file paths, lengths | Any file's contents, including earlier reads resent on later turns |
| The model's text and tool calls; `submit_plan` whole | The model's thinking (recorded as a step, not its words) |
| Each file read: path, size, truncated or not, any refusal and its reason | `.env` and credential files, which the interview cannot read at all |
| Each question, and each answer after the mask | A secret shaped like one (keys, tokens, `NAME=value` secrets, private keys) |
| The plan check: valid, error count, error messages, retry | The prompt's text (recorded as a hash of the file) |
| Token usage and cost, the model, the app name, the user name, the six scores | Anything from the developer's folder beyond names and sizes |

**How `core/tracing.js` is built.** Decided Fri Oct 9, 2026, writing PHASE1-PLAN Step 3.

- *LangFuse SDK v5, not the v4 the plan sketched.* v5 is current; the names the plan used
  (`LangfuseSpanProcessor`, `startActiveObservation`, a `mask` option) are unchanged.
- *A tracer provider of seaLeye's own, not `@opentelemetry/sdk-node`.* The plan's
  `NodeSDK` pulls in about 25 exporters seaLeye never uses (gRPC, Prometheus, Zipkin)
  and registers itself for the whole process. `sdk-trace-node` with
  `setLangfuseTracerProvider` traces seaLeye's spans and nothing else. Only the context
  manager is registered globally, because nested spans need it.
- *Names come from code, never from model or developer text.* LangFuse masks only input,
  output and metadata. Span names, status messages, the session id and the user id skip
  the mask, so they are set from seaLeye's own values: a tool name the model invents is
  recorded as `unknown_tool`, and an error is recorded by its class, not its message.
- *The prompt version is a hash of the file's content, not its git hash.* An installed
  `sealeye` has no git history to ask; the content hash names the same version either way.
- *Spans are sent as they end, not batched.* The CLI is short-lived and can be
  interrupted, and a run is a few dozen spans, so sending each one is cheap and an
  interrupted run still leaves what it did. `flushTracing()` waits for the last few.
- *Token counts use Anthropic's field names.* `input`, `output`,
  `cache_read_input_tokens` and `cache_creation_input_tokens`. LangFuse's maintained
  `claude-sonnet-5` definition prices each of these names directly (checked in the
  `sealeye-dev` project, Oct 9). Its `cache_creation_input_tokens` price is the
  five-minute cache rate, which is what the interview asks for (`ephemeral` with no
  `ttl`). If the system prompt ever moves to the one-hour cache, cache writes must be
  sent as `input_cache_creation_1h` instead, or their cost will read low.
- *The trace is sent when the interview returns, not at exit.* Only the interview is
  traced, so its trace is complete at that point, and deploy and watch can end the
  process in more ways than are worth guarding one by one. Ctrl+C and a crash also send
  what there is, waiting at most a second; with tracing off they exit exactly as before.
- *`runInterview` takes an optional `client`.* Tests pass a scripted one, so the real
  loop, tools and API can be checked for what they send to LangFuse without a model.

**Scoring a run's outcome.** Decided Fri Oct 9, 2026, writing PHASE1-PLAN Step 5.

- *The trace id travels in `origin`.* `POST /deployments` already stores `origin` as
  sent, on deployed and refused records alike, so `origin.traceId` needed no API change.
- *Six scores, from a fixed list, numbers and yes-or-no only.* `questions_asked`,
  `plan_valid_first_try` and `validation_retries` come from the interview;
  `developer_said_yes` and `needs_refused` from "Deploy this?"; `deployment_succeeded`
  from wherever a final status is read: `watch`, `status`, the first seconds after
  `run`, and the background notifier, which is where most runs end. Only `succeeded`
  and `failed` are scored. A deployment nobody looks at again gets no score.
- *One request per score, three seconds, no retries.* LangFuse's own client
  (`@langfuse/client`) retries with growing delays, and with LangFuse unreachable it
  kept a finished command alive for over a minute. Scores now go straight to
  `POST /api/public/scores`, and the client package is not used.
- *A fixed id per score (`<trace>-<name>`).* A same-day re-read replaces the score.
  LangFuse matches on id, name and date, so a re-read on a later day adds a copy with
  the same value, which is harmless for a final status.

**The interview regression set.** Decided Fri Oct 9, 2026, writing PHASE1-PLAN Step 6.

- *One fixture per sample app, answers and expected result together,* in
  `test/fixtures/eval/<app>.json` rather than the plan's `answers/` folder: what to say
  and what should come of it are one case, and a test checks every app has one.
- *What "right" means.* The outcome (ready, drafted, or how it stopped) must match. A
  ready plan must enable its building block and not the other one. Needs must match
  exactly, by kind; a missing or extra need is named. A drafted plan is not graded on
  modules. The payment processor's five expected needs are each shown in its code or
  README: it reads a Kafka stream continuously, writes to Postgres, reads a signing
  key, and says it must not be reachable from the internet.
- *Cost comes from LangFuse, not a score.* A dataset run shows each item's cost and
  latency from its linked trace, so the script does not price tokens itself.
- *Each app is recorded the way LangFuse's own experiment runner records an item.*
  Linking traces to a dataset run through the REST API alone was accepted but never
  shown: this LangFuse builds its Experiments view from marks on the spans. So each app
  runs under a root span linked to the dataset run, every span under it carries the
  experiment's run id, name, dataset id and item id, and the root is in LangFuse's
  `sdk-experiment` environment, which also keeps these traces apart from real runs.
  The script starts its own API with an empty store, so it adds no deployment records.
- *The older dataset-run endpoints are off for new LangFuse organizations.* Greg's
  organization (created after September 16, 2026) answers
  `GET /api/public/datasets/{name}/runs` with LEGACY_API_UNAVAILABLE_FOR_NEW_ORGANIZATION
  and points to `GET /api/public/experiments`. So the dataset-run link is tried and
  allowed to fail, and each run carries an experiment id of its own (one per run,
  shared by its items), as LangFuse's runner does when no run id comes back.
- *Recheck before November 16, 2026.* LangFuse Cloud says older public endpoints go
  then, and that OpenTelemetry ingestion is the only path to live data. Traces already
  go that way. Scores (`POST /api/public/scores`) and dataset items
  (`POST /api/public/dataset-items`) work on this organization today and are the two
  calls to check against the migration notes at langfuse.com/docs/compatibility.
- *Dataset items hold the app's name, never its files,* the same rule as traces.

## Tracing stays in the product

Decided Fri Oct 9, 2026, by Greg. Part A (pull request #4) merges to `main` now, and Part B
of PHASE1-PLAN starts from `main` on Sat Oct 10.

The plan first held this decision for a few days, because Step 8 moves tracing into the
API and building it before deciding risked wasted work. That no longer holds: tracing is
in. Working on Part B now is also the point: seaLeye is how Greg is learning LangFuse, and
how a real AI-native product is built, hands on.

What stays open is unchanged: where traces live for an organization (Q13), and the Part B
decisions that are not yet made (Q1's folder upload before Step 8, D6 and D7 before Steps
12 and 13).

## Turning tracing off for a run

Decided Fri Oct 9, 2026, after Part A of PHASE1-PLAN.

Tracing was on whenever LangFuse keys could be found, and they are found in the
environment, the repo `.env` and `~/.sealeye/config`. Unsetting the environment variables
for one command did not turn it off, so there was no way to say "not this run".

- *Two switches.* `sealeye run --no-trace` for one run, and `SEALEYE_TRACING=off` for
  every run in a shell, a `.env` or a config file, read through `setting()` like any other
  setting, so the environment wins over the files. Either one is checked first in
  `startTracing()`; everything else already does nothing when tracing has not started.
- *Anything but on, true, 1 or yes is off.* A switch exists to stop data leaving, so a
  typo in it (`SEALEYE_TRACING=of`) must not send a trace someone meant to stop.
- *It says so.* When a switch turns tracing off and keys are set, `run` prints one line,
  "Tracing is off for this run". With no keys it says nothing, as before.
- *The cost is the join.* An untraced run has no trace id, so its deployment record has
  no `origin.traceId` and its outcome is never scored.
- *The regression set refuses.* `npm run eval:interview` exists to record a run in
  LangFuse, so with `SEALEYE_TRACING` off or `--no-trace` it stops with a plain message
  instead. Without `--`, npm keeps `--no-trace` for itself and sets `npm_config_trace`,
  so the script reads that too.
- *The default stays on when keys are set.* An organization may want it the other way,
  off unless turned on; that belongs with Q13, where traces live for an organization.

## The earliest code is Greg's to share

Decided Fri Oct 9, 2026.

**Provenance confirmed.** The first commit resurrected May 2026 proof-of-concept code,
and its documents were removed from history on Oct 8. Before collaborators are invited
(the first-release decision above), Greg confirmed that he owns all of the code, and
that no line of it was lifted, copied or drawn from work produced for a previous
employer. This was OPEN-QUESTIONS Q12.

## npm run dev uses Node's own watcher

Decided Fri Oct 9, 2026.

`npm run dev` is now `node --watch api/server.js`, and nodemon is gone. nodemon was the
only thing left in `npm audit` that `npm audit fix` could not fix: its file watcher
depends on a vulnerable `braces`, and the offered "fix" was a downgrade to a 2018
release. Node has restarted on file changes by itself since 18.11, so the dependency was
doing nothing Node does not, and removing it took 27 packages out of the install. The
rest of that audit (Express's `body-parser`, `proxy-addr` and `qs`, and ajv's
`fast-uri`) was patch and minor updates within the ranges already in package.json.
`npm audit` reports nothing after this.

## The interview runs as a LangGraph graph

Decided Sat Oct 10, 2026, by Greg. This was D8 in PHASE1-PLAN.

When Step 8 moves the interview behind the API, it is built as a LangGraph.js graph
(`@langchain/langgraph`), not as the hand-written loop wrapped in endpoints. Asking the
developer and the "Deploy this?" confirmation are `interrupt()` calls. A checkpointer
saves the interview's state under its id: in memory in Step 8, then in Postgres from Step
10 (`@langchain/langgraph-checkpoint-postgres`, same database, its own tables).

Why:

- *A paused interview has to outlive the process.* Hosted, the API restarts and redeploys.
  The hand-written loop waits in memory, so a restart loses every interview mid-question.
- *Parity.* An interview the CLI starts has to be answerable from the portal. With the
  state checkpointed under the interview id, either surface resumes it.
- *It is needed again.* The Phase 3 discovery agent is long-running and stateful, and the
  Phase 4 approval gates wait days on a release decision. Writing pause-and-resume once
  by hand for Step 8 would mean writing it again for each. A state machine and a Postgres
  row would do for Step 8 alone, with fewer dependencies; it was not chosen for that
  reason.
- *Learning.* Like LangFuse, LangGraph is something Greg is learning by building seaLeye
  with it.

What does not change, and the rules that come with it:

- Model calls stay on the Anthropic SDK through `createWithOneRetry`. No LangChain model
  wrappers, so `SEALEYE_MODEL_URL` still works.
- Tracing stays hand-written (D3). LangFuse's LangGraph callback handler records every
  node's input and output whole, which would put file contents in traces (D2). It is not
  attached. The trace id lives in the graph state so one interview's spans join up across
  pauses.
- A checkpoint holds the conversation, including file contents. It is deleted when the
  interview ends or after a day, never kept in backups longer than that, and never holds
  a file `read_file` refuses.
- A resumed node runs again from its first line. Each `interrupt()` gets a node of its own,
  with no model call before it in that node.
- Cost: three dependencies (`@langchain/langgraph`, its Postgres saver, `@langchain/core`)
  and about one more day in Step 8.

## The model's address is a setting

Decided Sat Oct 10, 2026 (PHASE1-PLAN Step 8).

`SEALEYE_MODEL_URL`, when set, is the address every interview model call goes to,
passed to the Anthropic client as its base URL. Unset means Anthropic's own address, so
nothing changes by default.

Why: a bank will not let a tool send its developers' code straight to
api.anthropic.com. It will want the traffic to go through the AI gateway it already
approves, often to Claude on Bedrock in its own AWS account. With the address as a
setting, seaLeye fits behind that gateway and needs no route of its own to the
internet. Whether seaLeye runs a gateway of its own is OPEN-QUESTIONS Q14, and is not
decided here. `test/model-url.test.js` runs one turn against a stand-in at that address
and checks nothing else was called.

## The interview runs in the API

Decided Sat Oct 10, 2026 (PHASE1-PLAN Step 8, built on D8).

The interview moved from `cli/interview/loop.js` to `api/interview/`, as the LangGraph
graph DESIGN.md already describes: `begin`, `model_turn`, `tools`, `ask`, `approve`.
`sealeye run` uploads the folder, follows the interview's events and sends the answers.
It holds no model key and no LangFuse keys.

**The endpoints.** `POST /interviews` takes `{ app, zip, deployed?, user?, trace? }`,
with the zip as base64, and returns an interview id. `POST /interviews/{id}/answers`
takes `{ answer }`, which is the text of an answer or y/n to "Deploy this?", from any
client. `GET /interviews/{id}/events` is a server-sent event stream. It carries
`started`, `step`, `question`, `answered`, `plan`, `finished` and `failed`, each with a
sequence number. A client that reconnects gets everything after the last one it saw.
`plan` means the interview is waiting on "Deploy this?". `finished` says whether it was
approved. `DELETE /interviews/{id}` drops an interview the developer left; `sealeye
run` calls it on Ctrl+C, so the API keeps nothing of their app.

**What travels in the upload (`core/upload.js`).** The folder travels without
node_modules, .git, .github, .do, seaLeye's own folders and symlinks. Secret files
(`core/secrets.js`, the same list `read_file` refuses) travel as empty files with
their names. That keeps `list_files` showing that a `.env` exists, which tells the
model the app reads settings, while the contents never leave the laptop. The API checks
every rule again when it unpacks, because it cannot trust the client: no absolute
paths, no `..`, at most 25 MB unpacked and 5,000 files (checked before inflating), and
a secret file that arrives with contents is written empty. Excluded folders match
whatever their case, as macOS and Windows folders do.

Because the whole folder now travels, not only the files the model chose to read, the
list of secret files was widened the same day (`core/secrets.js`): `.netrc`,
`.git-credentials`, `.pgpass`, `.yarnrc.yml`, `.pypirc`, `.dockercfg`, keystores
(`.p12`, `.pfx`, `.jks`, `.keystore`), Terraform variables and state, and
service-account JSON files. `read_file` refuses the same list.

The upload also leaves out what the folder's `.gitignore` files leave out (decided the
same day). Before, the interview read the folder in place with no limit; with a 25 MB
and 5,000-file cap, a Python `.venv` or a build folder would otherwise stop an
interview that used to run. What a developer has told git is not their source is
almost never what the interview needs to read. Nested `.gitignore` files apply to their
own folders, and a deeper rule wins, as in git. Secret files still travel as names even
when ignored, because `.env` is nearly always ignored and its name is how the model
learns the app reads settings. A folder still over the cap after that is refused with
a sentence saying so. The trade-off: a file that is ignored but would have helped the
interview (a generated config, say) is no longer visible to the model.

**Each interview has its own scratch folder.** It is named after the app, so the
model's view is the same as before, and it lives in `~/.sealeye/interviews` of the
user the API runs as, not in a shared temp folder another user could tamper with. The
scratch folder and the saved state are both deleted when the interview ends, or after a
day if it never does. A sweep also removes scratch folders no live interview owns,
which covers an API that was stopped mid-interview.

**One trace across pauses.** Each stretch of work after a pause opens a span named
`interview resumed`. Its parent is the first stretch's `sealeye run` span, whose trace
id and span id are kept in the graph's state (`traceRun`'s `continueFrom`). Each
stretch's output says what it ended on: `asked a question`, `submitted`, `approved`,
`declined` or `stopped`.

**Tracing off is per interview.** `--no-trace` and a CLI-side `SEALEYE_TRACING=off`
send `trace: false`, and the API runs that interview under `withoutTracing`, so every
helper in `core/tracing.js` is a no-op for it alone. One developer's choice must not
turn tracing off for everyone else on a shared API. It must also not leave their turns
as stray traces of their own.

**LangSmith stays off.** LangChain sends every graph run to LangSmith when
`LANGSMITH_TRACING` (or `LANGSMITH_TRACING_V2`, `LANGCHAIN_TRACING`,
`LANGCHAIN_TRACING_V2`) is "true". That would send each node's whole state, file
contents included, past the mask and past `--no-trace`. The interview service sets all
four to "false" for its process. LangGraph's own step limit is raised above the
interview's 24 turns, so the interview's limit is the one that stops a long read.

**The model is the API's choice.** `SEALEYE_MODEL` and `SEALEYE_MODEL_URL` are read where
the API runs. A developer's own `SEALEYE_MODEL` no longer changes anything.
"Tracing is off for this run" prints whenever the developer turns tracing off, even if
the API has no LangFuse keys and would not have traced anyway; the CLI cannot know.

**Scores moved with the keys.** The approve node scores `developer_said_yes` and
`needs_refused`. The executor scores `deployment_succeeded` when a deployment reaches
a final status, and never from a tear-down, which would overwrite how the deployment
itself went. The CLI's own scoring calls do nothing without keys, so they were left in place.

**What did not move yet: deploying from the upload.** `sealeye run` still deploys with
`appPath`, the developer's folder, as `sealeye deploy` does. Setting values no longer
stand in the way (see "Setting values travel with the deploy, for now"), so packaging
from an upload is Step 9's to build. This is fine for Step 8, which is done against a
local API.

`npm run eval:interview` runs the same graph in-process (`runInterview` in
`api/interview/service.js`) and checks plans in-process, so it no longer starts an API.

## Setting values travel with the deploy, for now

Decided Sat Oct 10, 2026, by Greg. This answers OPEN-QUESTIONS Q15. **The retrofit to
the organization's secret store was built on Oct 12 (PHASE2-PLAN Part B; "Settings live in
the organization's store"). Sending values from `.env` remains for apps that have not
moved over, a laptop API, and the sample apps.**

When the API deploys an app with config_basic, it needs each setting's value (a Stripe
key, say). It used to read them from the `.env` in the app folder, which only works
while the API runs on the developer's machine. A hosted API has only the upload, which
carries `.env` as an empty name. There were three options:

- (a) the CLI sends the values with the deploy request;
- (b) the values live in the organization's secret store, and the deployed app reads
  them when it starts;
- (c) hosted deploys use the plan's placeholders.

**Chosen: (a) now, (b) later.** (a) is about half a day and keeps the developer
experience exactly as it is: edit `.env`, run again. (b) is three to five days, changes
the plan contract, and adds a step to a developer's first deploy, and it is what a bank
will require. Most of (b) is the same work whether or not (a) came first, so (a) costs
little to retire.

**How (a) works.** `createDeployment` in the CLI reads the developer's `.env` and sends
`settings` with `POST /deployments`: the values of the settings the plan names, and only
those (`core/settings.js`). The API accepts only strings for those names
(`acceptSent`), hands them to that one deployment's NoEcho parameters, and never puts
them on the record, in a response or in a log. They travel over the API's TLS once per
deploy. The honest limit: values do leave the laptop, which the interview upload was
designed not to do. When asked about it, the answer is that moving them to the
organization's secret store is on the roadmap, Phase 1 work item 10.

**Three choices that keep the retrofit cheap:**

1. *Every deployment records where each setting came from, by name.* A record's
   `settings` list holds `{ name, source }`, where source is `sent`, `.env` (the local
   API reading the folder) or `plan`, never the value. The apps still to move to the
   store are the records with a `sent` or `.env` source.
2. *One function decides where values come from.* `settingValues` in
   `api/executor/settings.js` is the only place that knows the sources and their order.
   (b) adds a `store` source there, and the executor, the report and the evidence stay
   as they are; their wording for a source also comes from that file
   (`sourceInWords`).
3. *(a) stays after (b) exists,* for dev and the sample apps, so (b) is required only
   where an organization turns it on. A team that has no secret store yet is never
   blocked.

## Deployments package an uploaded copy

Decided Sat Oct 10, 2026 (PHASE1-PLAN Step 9, its first part).

`sealeye run` and `sealeye deploy` now send the app with the deploy request as a zip
(`zip` on `POST /deployments`, base64). The API unpacks it into a folder of that
deployment's own, packages from it as it used to package the developer's folder, and
for a static site syncs from it. A hosted API never needs the developer's disk.

**A second upload, not the interview's.** The interview's upload was built for reading
source: it leaves out what `.gitignore` leaves out and carries secret files as empty
names. A deploy needs what ships, and build output a `.gitignore` names (a static
site's `dist/`) is often exactly that. So a deploy upload (`core/upload.js`, purpose
`deploy`) follows the packager's own rules, unchanged from when it read the folder in
place: everything but `node_modules`, `.git`, `.github`, `.do`, and `.env` wherever it
is, whose values travel separately (see "Setting values travel with the deploy, for
now"). Other files the interview treats as secret, a certificate say, are packaged as
they always were, because an app may need them to run. The limits are larger: 100 MB
and 20,000 files, unpacked. The app is sent twice in one `sealeye run`, once for the
interview and once to deploy, which is the price of keeping the two sets of rules apart.

**`appPath` becomes a name when a zip comes with it.** It is the developer's own path
to their folder, kept on the record so their next run recognises a live environment
and so the report can say where the app came from. The API never reads it. A request
with `appPath` and no `zip` still means a folder on the API's machine, so older clients
and the local API keep working (add, do not break). Records say which with `source`:
`upload` or `folder`.

**The copy lives only while the deployment is in flight.** It is in
`~/.sealeye/deploy-uploads/<deploymentId>/` of the user the API runs as, removed once
the deployment reaches a final status, and swept after a day if the API stopped first.
A bad upload is refused with a 400 before any record is written.

Known limit: a zip does not carry file permissions, so a file the app needs to be
executable loses that bit. The platform's own start script is added after unpacking
and is unaffected.

## One small server in ca-central-1

Decided Sat Oct 10, 2026 (PHASE1-PLAN Step 9, D4; built as `deploy/`). The plan's
choice stands: one EC2 t4g.small running the API behind Caddy in Docker Compose, about
$20 a month. How it is built, and where it differs from the plan:

- **Two platform stacks, never named `sealeye-*`.** `platform-sealeye-server` is the
  server and `platform-sealeye-deploy-role` is the deploy role. Apps are
  `sealeye-<app>` (since Oct 11, `sealeye-<team>-<app>-<hash>`: "Each team's
  environments have names of their own"), and the deploy role may only touch stacks with
  that prefix, so it can never change the platform itself.
- **The server cannot build anything.** Its own role reads `/sealeye/*` parameters,
  pulls its image, uses its own bucket, and may assume `sealeye-deploy-*` roles. Every
  deployment goes through `sealeye-deploy-pilot` (Q4: one account to start). That role
  can create only what the two module templates contain, under seaLeye's names: stacks
  `sealeye-*`, function roles `sealeye-*-FunctionRole-*` with Lambda's basic logging
  policy and nothing else, functions, HTTP APIs, `/aws/lambda/*` log groups, the
  artifact bucket, and site buckets named `<app>-<account>`. A team's own account is
  the same template deployed there, trusting the server's role.
- **No change to the executor.** `deploy/start.mjs` writes an AWS CLI profile that
  assumes the deploy role from the instance's credentials and makes it the default, so
  every `aws` the executor runs goes through it. It is the one place outside the
  executor that runs the AWS CLI, to read the server's settings with the server's own
  role.
- **Settings and secrets live in Parameter Store under `/sealeye/`**, SecureStrings for
  secrets, read into the API's memory at start. They are never in an image, a compose
  file or a log; the start line names the settings it read, never their values.
- **No SSH.** The firewall opens 80 and 443 only, and a shell is through Session
  Manager. Instance metadata needs a session token, with one extra hop so the container
  can reach it.
- **Releases from Greg's Mac until CI exists (Step 11).** `deploy/release.sh` refuses
  uncommitted changes, builds the arm64 image (running `npm test` inside the build),
  pushes it to the stack's own repository, uploads the server config, and restarts the
  server through Session Manager, waiting until the API is healthy. Image tags are
  immutable: the commit and a timestamp.
- **Differences from the plan.** Postgres is not in the compose file yet; Step 10 adds
  it with its password in Parameter Store. Uploads are unpacked on the server's own
  disk, not S3, since they live for minutes. Backups get their place in the config
  bucket (`backups/`, kept 30 days) for Step 10 to use.

Not tested here: building the image and deploying the templates, which need Docker and
AWS. Both templates pass `cfn-lint`; `test/server-start.test.js` runs the start script
against a stand-in for SSM.

## Deployment records live in Postgres

Decided Sat Oct 10, 2026 (PHASE1-PLAN Step 10, D5; D8 for interviews).

With `DATABASE_URL` set, the API keeps its deployment records and its interviews in
progress in Postgres. Without it, nothing changes: records in `~/.sealeye/deployments.json`
and interviews in memory, which is what a laptop API and `npm test` use.

**The store keeps its functions, and its map.** `putDeployment`, `getDeployment`,
`listDeployments` and `count` stay synchronous, so nothing that calls them changed. The
map in memory is still what they read. With a database, every change is written through
to the `deployments` table, one write after another so the table always ends with the
last change, and the map is filled from the table at start (`openStore`). A stop waits
for the last write. This is right while the API is one process, which the pilot server
is. ECS Express Mode (stage 3 of the hosting plan) runs more than one, and the store
then has to read from Postgres instead; that is a change inside `api/store.js` only.

**Each row is the record as it always was, with columns beside it.** The whole record is
kept as JSON, so readers, reports and evidence are unchanged. Beside it: `org_id`,
`team_id`, `created_by`, `surface`, `trace_id`, `app`, `status`, `started_at`. Until
sign-in (Step 13) every record is org and team "default", with `created_by` from the
CLI's `requestedBy` and `surface` "cli"; sign-in fills them for real.

**Migrations are plain SQL** in `api/migrations/`, applied in name order at start, each
in a transaction, recorded in `schema_migrations`.

**Interviews live in their own schema, `interview_state`,** with LangGraph's checkpoint
tables (through its Postgres saver), the interview records and their events. The API
makes the schema and tables at every start rather than by migration, because the
backup leaves the whole schema out and a restored database has to get them back by
itself. At start, an interview waiting on the developer waits again, one that was
mid-step carries on from its last saved step, and an ended one stays for a client to
replay. The model client is made on demand, since a restored interview reaches it
without `POST /interviews` having run.

**What was in flight is picked up again** (`api/executor/resume.js`), with or without a
database. A deployment that was running is watched until CloudFormation says how it
ended, through the same loop a live deployment uses; a final status counts as its own
only if the change was seen under way before the restart, and otherwise the deployment
fails with that said plainly. A tear-down is started again; every step of it is safe to
repeat. One still being prepared fails with the reason. A change set that was made and
never run now ends a deployment instead of being polled forever. Three kinds are left
exactly as they were, marked interrupted, with nothing asked of AWS: a record imported
from another machine (its account and role may not be this server's), one more than a
day old, and one that is not the newest for its stack, since acting on it could tear
down or claim the result of the deployment that came after. Whether the change was seen
under way is kept on the record (`sawInProgress`), so a static site whose stack had
finished while its files were syncing finishes the sync after a restart.

**A write that fails is kept and tried again.** A record whose write to Postgres failed
is written again from the map with the next write and at shutdown, which logs any still
unsaved. Strings lose NUL characters on the way in, which Postgres refuses in JSON. The
first-start adoption of an old `deployments.json` is one transaction: all of it or none,
and none means the next start tries again.

**On the server:** Postgres 16 in the compose file, reachable only from the API, its
password from `/sealeye/POSTGRES_PASSWORD`, read by Postgres only when it first creates
the database. A nightly `pg_dump` at 03:15 Toronto time goes to the config bucket's
`backups/` (kept 30 days), without `interview_state`: interviews hold developers' code
and live a day at most. `deploy/server.sh restore-check` restores the newest dump into a
scratch database and compares counts. The first start on an empty database brings in
the API's own old `deployments.json`; `deploy/server.sh import` brings in a laptop's.

**Tests:** the ones that need Postgres run when `SEALEYE_TEST_DATABASE_URL` points at a
server they may create databases on, and are skipped otherwise, so `npm test` still
needs nothing but Node. CI (Step 11) should set it.

## Installing an app's dependencies runs none of its code

Decided Sat Oct 10, 2026 (PHASE1-PLAN Step 10 review).

The packager runs `npm install --omit=dev --ignore-scripts` in the staging folder, with
an environment holding only what npm needs (`installEnv` in `api/executor/package.js`):
the path, a home, a proxy and certificates. No keys, no deploy role, no database address.
And the API removes `POSTGRES_PASSWORD` from its own environment once it has built the
database address.

Why: the app and every package it depends on are code nobody on the platform has
reviewed, and an install script runs as the API. On the pilot server that process can
reach the instance's role through the metadata service (the containers need it, so the
hop limit is 2) and the database next door. Before this, any developer, or any package
an app depended on, could read the API's settings or call AWS as the server.

What it costs: a dependency that builds native code at install time (bcrypt, sharp and
the like) is not built. Such a package would rarely have worked anyway, since it would
have been built for the server rather than the function's runtime. If a developer needs
one, that is a platform decision (build in a runtime-matched container), not a reason to
run unreviewed code inside the API.

Confirmed by Greg on Sun Oct 11, 2026 (PHASE2-PLAN Step 5): install scripts stay off.

What it does not fix: the metadata service is still reachable from the API's container,
so code that does run inside it (the API's own dependencies) could still reach the
server's role. Building in a separate, unprivileged container is the full fix, and
belongs with the move off the single pilot server.

## GitHub tests every change and builds the image

Decided Sat Oct 10, 2026 (PHASE1-PLAN Step 11, ROADMAP Phase 1 item 8).

`.github/workflows/test.yml` runs `npm test` on every push and pull request, with a
Postgres 16 service so the database tests run rather than skip. A push to main that
passes then builds the server's image on an arm64 runner, the server's own processor,
so nothing is emulated and the Dockerfile's `npm test` runs again on the real
architecture. The image is tagged `main-<commit>` and stored in ECR; a re-run finds it
and stops, since tags there cannot be overwritten.

**GitHub reaches AWS with no stored keys.** It proves to AWS which repository and branch
is asking (OpenID Connect), and `deploy/ci-role.yaml` makes a role that accepts only
this repository's main branch and may only push the `sealeye-api` image. It matches
GitHub's subject in the form GitHub sends it, `repo:<owner>@<ownerId>/<name>@<repoId>:ref:refs/heads/main`:
the numeric ids never change, so a renamed repository's old name cannot be claimed by
someone else and used to push. (Found on the first run: the name-only form was refused.) A pull request,
another branch or a fork gets nothing. The role's address is a repository variable,
`SEALEYE_CI_ROLE_ARN`; without it, the image step is skipped and the tests still run, so
the workflow works before the role exists.

**Putting an image live stays a person's decision.** `deploy/release.sh` uses GitHub's
image for the commit it is run on when there is one, and builds locally otherwise. It
does not deploy on merge: the pilot server has real environments behind it, and a
release is still something you choose to do (PHASE1-PLAN Step 11: "manual until there is
a reason to automate").

## Each domain has one job

Decided Sat Oct 10, 2026 (PHASE1-PLAN Step 12, D6).

- `api.sealeye.online` is the API, and the command's default: a developer installs and
  runs, with nothing to configure. `SEALEYE_API` or `--api` points it elsewhere, a
  local API included (`DEFAULT_API` in `core/config.js`).
- `sealeye.online` is the portal. Until Step 14 builds it, a page in the console's light
  brand says what it will be and sends developers to seaLeye.run.
- `sealeye.run` is the command's home page and its installer:
  `curl -fsSL https://sealeye.run/install | sh` checks for Node.js 20 and runs
  `npm install -g` on a package the server hosts.
- `sealeye.org` redirects to sealeye.run for now.

All four are served by the pilot server's Caddy, which gets each certificate itself.
DNS for each is a Route 53 zone (`deploy/dns.yaml`), as `sealeye.online` already was.
The pages live in `sites/` and go to the server with every release, beside the image.

**The package is a file on the server, not a registry.** `release.sh` runs `npm pack`
and the server hosts `sealeye-<version>.tgz`; the installer names the version it was
released with. No npm account, no private registry, and a release is still one command.
package.json `"files"` limits the package to `cli/`, `core/` and the prompt and template
files the command reads. The API and the interview's system prompt never leave the
server, and `test/package-contents.test.js` fails if they would. The package still
installs every dependency in package.json, the API's included, which is heavier than
the command needs; splitting the dependencies is worth doing when the package grows.

**Anyone with the address can install it, and the API answers anyone, until Step 13.**
The command is a thin client, so installing it gives nothing the API does not already
give. But the API takes requests without asking who is calling, and each interview
spends model credit and each deploy builds in the pilot account. The pages ask not to be
indexed (robots.txt and noindex) until Step 13 puts a token in front of the API.

## seaLeye is published under AGPL-3.0, by OpMo Advisory Inc.

Decided Mon Oct 12, 2026.

seaLeye is made available to others as free software under the GNU Affero General Public
License, version 3 only (`LICENSE`), with the copyright held by OpMo Advisory Inc.
(`NOTICE`, `package.json`). The name, the marks and the three domains are not licensed:
a fork must take its own name. Contributions come in under the Developer Certificate of
Origin, licensed to OpMo so that the combined work can also be offered under other terms
later (`CONTRIBUTING.md`).

**Why AGPL and not Apache or a source-available license.** The aim is that anyone can
use, read and change seaLeye, and that nobody can take it and run it as a closed hosted
service: the AGPL's network clause requires a hosted derivative to publish its source.
Apache would allow a closed fork; a source-available license would keep the code from
being open source at all. The AGPL leaves the copyright holder free to offer other terms
to an organization that cannot accept it, which is where any commercial path lies.

**Why the publisher is named in the repository and the package.** The record of who made
seaLeye and when now lives where anyone can check it: the git history, a tagged
baseline release, the author and license fields, and this entry. seaLeye is a prior,
independent work of its author, developed on its own time and equipment, and this
record is what establishes that for any later agreement that asks.

**What this does not change.** `private: true` stays on `package.json` until Q10
decides how the command is published; the AGPL covers what the installer and the
repository distribute either way. The pages stay unindexed until Step 15 passes.

## Every caller has a token, until sign-in

Decided Sun Oct 11, 2026 (PHASE1-PLAN Step 13, D7; a stand-in until Q3).

Every request but `GET /health` carries `Authorization: Bearer sl_...`. A token is 32
random bytes, issued to one person, with an organization and a team. The check runs
before a request's body is read, so nobody uploads anything without one.

**Only a hash is kept.** The API stores the token's SHA-256 (Postgres `tokens`, or
`tokens.json` beside a laptop API, 0600), and looks it up on every request, so a revoked
token stops at once. `deploy/server.sh token add` makes the token on the administrator's
Mac and sends the server only the hash: the token is in no log, shell history or Session
Manager record. SHA-256 rather than a slow password hash, because a token is random and
long, not something a person chose.

**The person is the token's.** A deployment's `requestedBy` is the token's email and
name, marked `verified: "token"`; the machine is still as the command line reported it,
and the change record says which is which. The record gets the token's organization and
team, the columns Step 10 left waiting. An interview belongs to the person who started
it: anyone else's token gets "not found" for it, as for one that does not exist.
Records are their organization's; with one organization, "default", nothing changes yet.

**The command keeps the token.** `sealeye login` reads it without echoing it (or from a
pipe, never as an argument, so it stays out of shell history), checks it with
`GET /whoami`, and saves it as `SEALEYE_TOKEN` in `~/.sealeye/config`, readable by the
developer alone. `sealeye logout` removes it; `sealeye whoami` and `sealeye doctor` say
who you are. A refused token is one sentence saying to ask for a new one.

**An API with a database always asks.** `SEALEYE_AUTH=off` exists for a laptop API and
the tests, and the API refuses to start with it when `DATABASE_URL` is set, so the
server cannot be left open by a stray setting.

**What sign-in replaces.** The admin script and `sealeye login`'s paste. Not the shape:
`req.caller` (person, organization, team) is what an identity provider will fill, so the
records, the checks and the change record stay as they are.

## The portal signs in with a session cookie

Decided Sun Oct 11, 2026 (PHASE1-PLAN Step 14; Greg chose this over keeping the token in
the browser's storage).

A browser cannot keep a token the way `~/.sealeye/config` does: anything in its storage
can be read by any script that ever runs on the page. So the portal's sign-in page sends
the token once to `POST /sessions`, and the API answers with a session cookie in its
place. The browser never keeps the token.

- **The cookie**, `__Host-sealeye_session`, is a random value, `HttpOnly` (no script
  can read it), `Secure`, `SameSite=Strict`, for twelve hours. The `__Host-` prefix
  makes the browser refuse any cookie of that name that names a domain or a narrower
  path, and the API refuses a request carrying two, so nothing else can shadow it. The API keeps only its hash (Postgres
  `sessions`, or `sessions.json` beside a laptop API), and a session ends when it
  expires, when its person signs out (`DELETE /sessions`), or when the token it came
  from is revoked.
- **One origin.** The portal calls the API at `sealeye.online/api/...`, which Caddy
  passes to the API, so the cookie never crosses to another site and no cross-origin
  rules are needed. The command line keeps using `api.sealeye.online` with its token.
- **Changes need the portal's header.** A request that changes something with the
  cookie must also carry `x-sealeye-portal: 1`, and so must signing in and out. A page on another site cannot add that
  header without the API agreeing to it first, which it never does. Together with
  `SameSite=Strict`, that is the defence against another site acting through a signed-in
  browser.
- **Records say which surface.** A deployment's `surface` and a tear-down's
  `destroyRequestedBy.surface` are `cli` or `portal`, from how the request was signed in,
  not from anything the client says.

Real sign-in (Q3) replaces the token paste on the sign-in page with an identity
provider's redirect. The session, the cookie and everything behind them stay.

## The portal is a client of the API

Decided Sun Oct 11, 2026 (PHASE1-PLAN Step 14; A9).

`portal/` is React and TypeScript, built with Vite into static files that Caddy serves
at `sealeye.online`. There is no second server: every value on a page comes from the
same API the command uses, at `/api` on the same origin.

- **Three pages, the ones that exist.** Environments (one row per environment, grouped
  as `sealeye list` groups them, with the counts a console summarises first), Control
  (one environment's state, its history, and tear down) and Catalog (the modules from
  `GET /catalog` and the needs ledger from `GET /needs`). Pause, Configure, Logs,
  Performance, Costs and Team stay in the archived mock-up: a button for something the
  platform cannot do is a question asked in front of the platform team.
- **Tear down asks twice**, once with the button and once by typing the app's name, then
  calls `DELETE /deployments/{id}`, the endpoint `sealeye destroy` uses, and reads the
  status every five seconds until it is gone, as `sealeye watch` does.
- **shadcn/ui, without its installer.** The few components the pages need (button, card,
  badge, input, table, dialog) are written in `src/components/ui` the way shadcn ships
  them, on Radix and Tailwind, so there is nothing to fetch at build time and nothing
  the pages do not use. Colours and type are `brand/BRAND-ONLINE.md`'s, as Tailwind
  theme values in `src/index.css`.
- **A strict content security policy.** Caddy sends one that allows only this site's own
  scripts and no framing, which is what makes a cookie no script can read worth having.
  Responses under `/api` get one that allows nothing at all, so no API answer on the
  portal's origin can ever render as a page.
- **Tested in a browser.** `portal/tests/` drives the built portal in Chromium against
  the real API with sample records: sign-in refuses a wrong token and keeps nothing a
  script can read, each page shows the API's data and no other organization's, tear
  down finishes and is recorded as the portal's, and sign-out ends the session. GitHub
  runs it on every change, beside `npm test`.


## Each team sees its own environments

Decided Sun Oct 11, 2026 (PHASE2-PLAN D1). Built the same day (PHASE2-PLAN Step 1).

A person sees, watches, gets evidence for and tears down only their own team's
environments. A token issued as organization-wide sees every team's, which is how the
administrator keeps an overview. Another team's record answers "not found", as another
person's interview already does, so its existence is not given away. The needs ledger
stays organization-wide on purpose: it is the platform team's view of what drafted plans
wait on, and it names apps and needs, not people. What shows a need, file names and lines
from an app's code, is that app's team's, as is its deployment id: another team sees the
app, its team and its needs without them, and an organization-wide token sees all of it
(decided by Greg the same day, after the independent review raised it).

Why a scope on the token rather than real roles: roles belong to sign-in (Q16, Cognito
groups). A token is either team-scoped or organization-wide when it is issued, which is
enough for a pilot run by one administrator. The checks read `req.caller.scope`, which a
Cognito group can fill later without the checks changing.

## Each team's environments have names of their own

Decided Sun Oct 11, 2026 (PHASE2-PLAN D2). Built the same day (PHASE2-PLAN Step 2).

Two teams can each have an app of the same name, each with its own environment. Within
a team, one app name is one dev environment and one path to production: a teammate's
`sealeye run` of the same app updates the team's environment, and the record says who
did it.

**How.** Each environment has a name, `sealeye-<team>-<app>-<hash>`, and every name it
has in AWS comes from it: the stack, and the function, log group, API and static site
bucket in it. The developer sees only the app name, in the command, the portal and every
file seaLeye writes; the one place the team shows is a static site's address. The rule
is `environmentName` in `core/names.js`.

- **The hash is always there**, six hex characters of the organization, team and app.
  The plan first had a hash only for names cut short, but hyphens alone are ambiguous:
  team `a` with app `b-c` and team `a-b` with app `c` would both be `sealeye-a-b-c`, and
  team `payments` with app `foo` would be the `sealeye-payments-foo` that an app called
  payments-foo already had. The hash ends both.
- **It fits.** The readable part stops at 34 characters, so a name is at most 49: a
  function name may be 64, and a static site's bucket, `<name>-<account>`, 63.
- **The templates did not change shape.** Their `AppName` parameter was always the name
  everything is called after; it is now the environment's name rather than the bare app
  name.

**No migration.** Every record keeps its `stackName`, and now its `resourceName`.
`namingFor` in `api/executor/compose.js` reuses the names on the team's latest record
for that app, unless it was torn down, so environments made before this keep
`sealeye-<app>` (their bare app name is read from the record's `AppName` parameter), and
only a first deploy, or the first after a tear down, gets the new name. Another team's
records never count. The needs ledger counts an app per team, and a draft, which has no
stack, is grouped by team and app on both surfaces.

**A stack two teams already share belongs to whoever deployed to it last.** Before this,
two teams' apps called foo both landed on `sealeye-foo`, and each deploy replaced the
other's code, so the stack holds the last deployer's environment. That team keeps using
it as before. The other team's next deploy gets a name of its own instead of changing
it, and a team-scoped token of the other team cannot tear it down
(`409 SHARED_ENVIRONMENT`, asking the platform team to). An organization-wide token,
which sees both, can, but never a stack another organization deployed to last. A stack
being torn down is not reused either.

**Both surfaces say whose it is when it could be either.** An organization-wide token
sees every team's environments, so when they span more than one team the command's
tables and the portal's Environments rows add the team, and the portal's Control page
names it. `sealeye run` with such a token matches a folder only to an environment in the
person's own team.

**The deploy role reaches only `sealeye-*` functions, log groups and site buckets.** At
first it kept "any function in the account", because functions made before this were
named after the bare app. Once Greg's last such API was torn down (Oct 11, 2026), the
only environments left from before were the static sites `sealeye-com`, `sealeye-run`
and `sealeye-online`, whose buckets already start with `sealeye-`, so the role was
narrowed the same day. An environment from before whose function or bucket does not
start with `sealeye-` would now have to be torn down by hand.

**Why not refuse the second team.** That was the first recommendation: refuse a second
team's deploy while the first team's environment is live. Greg chose against it, because
common names such as `test-app` would collide often, and a developer should not have to
rename an app because of a team they cannot see. It costs about a day more.

**Why the organization is not in the readable name.** Each organization will deploy into
its own account (ROADMAP Phase 1 item 5), where names need only be unique within the
account. It is in the hash, so two organizations sharing one account before then would
still not meet.

## sealeye doctor checks what this machine needs

Decided Sun Oct 11, 2026 (PHASE2-PLAN Step 5, Greg's call).

`sealeye doctor` was written for a laptop that ran the API itself, so it checked the AWS
CLI, AWS credentials, the artifact bucket, the adapter layer and the model key. A
developer using the hosted API needs none of them, and would have seen five failures
that meant nothing. Now, when the API is not on this machine (`isLocalApi` in
`cli/doctor.js`: localhost, 127.x or ::1), doctor checks only the API, the token, Node,
and whether a Mac can show a notice when a deploy finishes (advice, never a failure).
When the API does not answer, the fix it offers is to tell the platform team, not to
start it. With an API on this machine, every check runs as before.

## Settings live in the organization's store

Decided Sun Oct 11, 2026 (PHASE2-PLAN D3 to D5, Greg chose each as recommended), with
three more of his calls on Mon Oct 12: a lighter reader, a permissions boundary, and no
plan-contract change. Built Oct 11 and 12 (PHASE2-PLAN Part B). It replaces "Setting
values travel with the deploy, for now" for every app that moves over.

**Where (D3).** Parameter Store, encrypted with the account's default key, in the
account and region the app runs in, at `/sealeye-apps/<team>/<app>/<NAME>`. Standard
entries cost nothing and stay in ca-central-1, and a folder per app is what lets each
function read its own and no other. Secrets Manager was not chosen: about $0.40 a value
a month, for rotation these values do not need yet. A bank's own Vault or Secrets
Manager would be another source in `settingValues`, not a rewrite. The folder is the
team's and the app's, not the organization's: each organization will run in its own
account (ROADMAP Phase 1 item 5), as with environment names. Never `/sealeye/`, which
holds the platform's own keys.

**Putting values in (Step 8, built Oct 11).** `PUT /apps/{app}/settings/{name}`,
`sealeye settings set NAME` and the Settings card on the portal's Control page. The name
was settled before building: `sealeye settings` rather than the plan's `sealeye secrets`,
because seaLeye calls these settings everywhere else and not every one is a secret.
Guarantees, each tested:

- A value travels once, inward. The command reads it hidden or from a pipe, never as an
  argument; the API hands it to the AWS CLI in a file only the API can read, removed as soon as the
  call ends, never on a command line;
  listing asks the store for names and dates only. No answer, log, record or the change
  log ever holds one.
- A refused write is reported by the error's name alone (`AccessDeniedException`),
  because AWS's validation messages quote the value they refused. For the same reason the
  API answers any body it cannot read without quoting it, and logs only the error's name
  on the settings routes.
- Who changed which setting, when and from which surface is kept (`setting_changes`):
  names, never values.
- Not yet true of a setting that is *not* in the store: a value sent from `.env` reaches
  `aws cloudformation deploy` as a `--parameter-overrides` argument, where another
  process on the server could read it while the deploy runs. It was so before Part B;
  storing the setting is the way out, and passing parameters another way is owed
  (PHASE2-PLAN, "Owed after this plan").
- A team reaches only its own folder; an organization-wide token may name a team.

**Reading at start (D4).** *As first decided; the reader now signs its own request and
loads no SDK (below).* A `node --import` preload in the packaged app reads the folder
in one call with the AWS SDK that Lambda's Node runtime already carries, sets the values
as environment variables, then the app starts. No layer to track, no shell quoting of
values. CloudFormation's own lookups were ruled out: an encrypted one cannot feed a
function's environment, and a Secrets Manager one leaves the value in the function's
configuration.

Checked on a real function on Mon Oct 12, 2026 (PHASE2-PLAN Step 7,
`deploy/spikes/settings-read/`), nodejs20.x (Node 20.20.2), x86, 512 MB:

- The preload loads Lambda's own SDK through `createRequire` and reads the folder.
- Encrypted values decrypt with only `ssm:GetParametersByPath` on the folder, and no KMS
  permission, because they use the account's default Parameter Store key.
- The role kept the function out of another app's folder and out of `/sealeye/`
  (`AccessDeniedException` for both).
- Reading took 880 to 980 ms, including loading the SDK. The kit started a fresh Node
  process on every run, so both runs paid it; in a real app the preload runs once per
  process, so the cost falls on a cold start only.

**The reader signs its own request (Greg, Oct 12).** About a second on every cold start
was too much to accept for a convenience, so the reader (`templates/sealeye-settings.mjs`,
packaged as `.sealeye/settings.mjs` and run by `run.sh` with `node --import`) does not
load the SDK. It signs its one `GetParametersByPath` request with Signature Version 4
using `node:crypto`, from the credentials Lambda puts in the function's environment; its
signatures were checked against AWS's own signer, with and without a session token, and
the test keeps those vectors. It skips a stored name the platform or the runtime owns
(`RESERVED_NAME` in `core/settings.js`, which the API also refuses), tries once more after
a dropped connection or throttling, and if it cannot read the settings the app does not
start: one line on stderr names the error, never a value. An app started without its
settings would look healthy and behave wrongly.

**Every function role carries a permissions boundary (Greg, Oct 12).** Reading its own
folder needs a policy written onto the function's role, and IAM cannot limit what a
written policy says. So `deploy/deploy-role.yaml` creates `sealeye-function-boundary-*`
(write logs, read under `/sealeye-apps/`), and the deploy role may create a function role,
or change its policies, only with that boundary on it; removing a boundary is denied.
Whatever a template or a compromised API writes, a function can do no more than log and
read app settings, and its own role narrows that to its folder. A compromised API could
still point a function at another team's folder, within the boundary; it can read every
folder itself anyway. Removing a policy, or a role, needs no boundary, since taking
permissions away gives none, so a function role made before this can still be torn
down; no API environment from before was live when it shipped. The boundary also allows
`kms:Decrypt` through Parameter Store only, which a function's own role does not grant,
so it never stands between a function and its settings.

**No organization in the folder.** `/sealeye-apps/<team>/<app>/` holds no organization,
because each organization runs in its own account (ROADMAP Phase 1 item 5). Two
organizations in one account would share folders; that must not happen before item 5.
The reserved names cover what the platform and the runtime set; others such as `PATH`
or `TZ` are the app's own to set, and change only the app's environment.

**The plan does not say where values live (Greg, Oct 12).** PHASE2-PLAN Step 9 would have
added a source to each setting in the plan contract. Where values come from is a fact
about the platform, not a choice for the developer or the model, so the contract, the
prompt and the interview are unchanged: the platform asks the store at deploy time.

**At deploy.** The executor asks the store which settings an API app has (its team's
folder). Those have the source `store`: no value is passed to the template, and the
function gets `SEALEYE_SETTINGS_PATH` and leave to read that folder alone. Every other
setting is passed as before. A store that cannot be asked stops the deploy.

**Apps already deployed with sent values (D5).** Nothing moves by itself. The next
`sealeye run` of such an app offers once to store what its `.env` holds, naming the
settings and never showing a value (`cli/store-offer.js`); a no is remembered on that
machine. The command tells the API which names it left out because the store had them,
and the deploy stops if the store does not: a safety net against the two disagreeing,
not a security control, since an older client sends no such list. Values already in the store are not sent with a deploy, and `sealeye run` says
in one line that they come from the store, so editing `.env` is not mistaken for changing
the deployed app. `deploy/server.sh settings-sources` lists the live environments still
on `.env` values, by name.

## A setting goes to the store through a private file, not standard input

Decided Mon Oct 12, 2026, after the first live check of Part B. The first live `sealeye settings set` failed with "the store refused it". The API passed the
value to `aws ssm put-parameter` as `--cli-input-json file:///dev/stdin`. Node gives a child
process a socket on standard input, which the AWS CLI cannot open as `/dev/stdin` (ENXIO),
and with a shell pipe instead the CLI reads the file twice and gets nothing the second time.
The tests passed because the stand-in read standard input however it arrived. Now the API
writes the input to a file (0600) in a folder of its own (0700), names that file, and
removes both when the call ends. The value is still never on a command line. The stand-ins
in the tests and the portal's test API read only from a named file, so the old way fails
there too.

## Part C's three calls: the portal's interview, pause, integrations

Decided Mon Oct 12, 2026 (PHASE2-PLAN D6 to D8, Greg chose each as recommended).

- **D6. The portal's interview reads a folder chosen in the browser**, zipped there under
  the same rules as the command's upload: `.gitignore` respected, no `node_modules` or
  `.git`, secret files as names only. The rules live once, in a part of `core/` that runs
  in a browser as well as in Node, so the two surfaces cannot send different things.
  Connecting a repository waits: it needs sign-in (Q16) and an app on the organization's
  source host, and a folder covers the pilot.
- **D7. Pause is for APIs only, for now.** The function's reserved concurrency goes to
  zero, so it stops taking requests and costs nothing while it waits; resume removes the
  limit. Both read the state back from AWS (principle 4). A static site says plainly it
  cannot be paused: hiding a public bucket needs more of the deploy role than a pause is
  worth before anyone has asked for it.
- **D8. Integrations moves to Phase 4.** It would only show connections to ServiceNow,
  Jira and Teams, which are Phase 4 work; a page now would show nothing it can do, which
  the portal does not do.

## The portal shares words with the command through core/

Decided Mon Oct 12, 2026, building PHASE2-PLAN Step 13 (Evidence, Validate, Health).

- **One set of words.** The evidence summary (`core/evidence-summary.js`) and the plain
  sentences for contract errors (`core/plan-words.js`, moved from `cli/interview/`) are
  imported by the command and by the portal's pages, so the two surfaces cannot drift.
  A core file the portal imports must run in a browser, with everything it imports:
  `test/boundaries.test.js` checks it. Step 15's upload rules will use the same path.
- **Validate says ready or drafted.** `POST /plans/validate` adds `status` and `needs`
  (each in the catalog's words, with the plan's evidence) to a plan that meets the
  contract, worked out from the needs and never from the status a plan claims. Before
  this, `sealeye validate` said "Your plan is valid" of a plan with needs, which
  principle 3 does not allow.
- **Evidence is read when asked.** Reading it asks AWS what it says now and sends one GET
  to the app's address, so Control shows a button rather than reading it on every visit.
  The download is the same DEPLOYMENT_EVIDENCE.md the command writes.
- **Health is the portal's `sealeye doctor`.** The page is called Health, as the parity
  table has it, because the browser has nothing of a machine to check: it shows whether
  the platform answers and its version, who is signed in and what they see, and whether
  the page itself is the platform's version (a page left open across a release is not).

## Deploying again

Decided Mon Oct 12, 2026, building PHASE2-PLAN Step 14.

`POST /deployments` takes `fromDeployment` in place of an upload: the code that
deployment packaged goes out again, with the plan given or the one it had. The portal's
Deploy again (in Control) and "Deploy this plan" (in Validate) send it, and so does
`sealeye deploy --again <app | deploymentId> [-f plan.yaml]`, the command's name for it:
a flag on `deploy` rather than a new command, because it is a deploy with its code
already on the platform. A request without `fromDeployment` is unchanged.

- **The code is the artifact in S3, unchanged.** Nothing is staged, installed or
  uploaded; the record carries the earlier artifact's key and checksum, and the evidence
  says whose code it ran. It is checked with a head-object before anything changes, so
  code that is no longer kept fails with nothing built.
- **APIs only.** A static site's files are synced from the upload and not kept, so there
  is nothing to send again; it says so, and `sealeye run` in the folder is the way.
- **Every setting from the store.** There is no `.env` here. A setting the plan asks for
  that is not in the store is refused, with its name, unless the earlier deployment
  itself used the plan's own placeholder for it: otherwise a value that came from a
  developer's `.env` last time, or a new setting, would silently become a placeholder.
  So "store it first" is the rule, which is where Part B wanted every value anyway.
- **Same app, same start.** The plan must name the earlier deployment's app and start it
  with the same entry point, because the packaged `run.sh` starts that file; a plan that
  changes it needs a new upload. A drafted plan is refused as any deploy is.
- **The team's own.** Only the environment's team may deploy it again. An
  organization-wide token sees every team's environments but changes only its own
  team's, which keeps who deployed what inside the team that answers for it. Revisit
  with real roles (Q16).
- **Every deploy is a change.** Every API deploy now passes its own id as the
  template's `DeploymentId`, which the function carries as `SEALEYE_DEPLOYMENT_ID`.
  Before this the artifact key changed every time; deploying the same code again with
  the same parameters would otherwise be an empty change set, which the deploy command
  accepts quietly, and the stack's status would be the previous deployment's. With it,
  the function restarts and reads its settings anew, which is the point of deploying a
  setting change again, and the status is this deployment's own (principle 4).
- **The checksum is the earlier one.** The record carries the artifact's checksum from
  when it was packaged; head-object checks it is still there, not that its bytes are
  unchanged. The bucket is the platform's own and only the deploy role writes to it.
- **Refused before any record.** Each of these is an answer to the request, not a failed
  deployment: nothing was attempted. A record is written only once it will be tried,
  and it names its environment from the start, so a page watching it sees it at once.

## A changed command is a new version

Decided Mon Oct 12, 2026, after `sealeye deploy --again` answered "Missing required
--file" on Greg's Mac: his command was the one installed before it existed, still called
2.17.0, like every release since Oct 8.

The version in package.json is what developers install (`sealeye-<version>.tgz`), what
the banner prints and what Health compares. Releasing a changed command under the same
version replaces the package behind one name, so npm may install its cached copy, and
nobody can tell which they have. So a pull request that changes what the package holds
raises the version (minor for a new command or flag, patch for a fix), and release.sh
packs the command and compares it with the one sealeye.run already serves under that
version: different contents, same version, and it stops before building anything. The
API and portal can change without a new version; they are not installed. 2.18.0 is the
first: `deploy --again`, `validate`'s ready or drafted, and the shared evidence words.

## One walk decides what travels, from the command and from the browser

Decided Mon Oct 12, 2026, building PHASE2-PLAN Step 15 (D6: the portal reads a folder
chosen in the browser, under the command's rules).

The rules about what of a folder goes to the API, and the walk that applies them, move
from core/upload.js into core/upload-rules.js, which runs in a browser. It walks any
tree of folders and files: the command hands it the disk, seaLeye.online the folder the
developer chose. What it needs from a package, the .gitignore matcher, the caller hands
in, so the file imports nothing but core/secrets.js (which no longer needs node:path).
The command's zipFolder becomes async to share the walk; it sends the same thing as
before. test/upload-parity.test.js runs the command's walk and the browser's (a flat
file list, as a folder input gives it) over one folder, for an interview and for a
deploy, and compares what each would send.

Found on the way, and owed (PHASE2-PLAN, "Owed after this plan"): a deploy upload leaves
out `.env` only, as the packager always has, so a `.env.production` with values in it is
packaged into the function's code. The interview upload sends it as a name only.

## New environment: the interview in the portal

Decided Mon Oct 12, 2026, building PHASE2-PLAN Step 15.

- **The folder is read in the browser, by the command's walk** (core/upload-rules.js):
  the folder picker where the browser has one, a dropped folder, or the folder input.
  The picker and a drop are read lazily, so node_modules is never opened. The zip is made
  in the browser; secret files go as names only. A yes reads the folder again with the
  deploy rules, as `sealeye run` does.
- **The plan's files come from the API.** The plan event carries DEPLOYMENT_PLAN.md and
  sealeye.yaml (core/plan-files.js), so the page offers exactly what the command writes
  into the folder. The portal cannot write into the folder, so it offers them to
  download; a "Not now" keeps them there and deploys nothing.
- **Every setting from the store.** There is no `.env` to read in a browser, and sending
  one would put values through a page. A yes with settings the store does not have asks
  for them first, stores each, and then deploys, naming them as expected in the store.
- **A deploy names its environment from the start.** Every new deployment record carries
  `environment`, the stack name it is for, from the moment it is queued, and lists group
  by it, so the page can go straight to the environment and follow it. `stackName` is
  still set only once the stack is composed: a record with one has something in AWS to
  describe or tear down, and one that failed before that does not (a deployment made
  again had set stackName at once; corrected here).
- **An interview held in the portal says so in its evidence**: "in the portal" where the
  command's says "via sealeye run".
- **What a browser cannot see.** A browser shows a link inside the folder as the file it
  points to, so where the command leaves links out, the portal sends what they point to.
  Secret names are still sent as names only. A dropped folder is opened file by file
  for sizes, so a big file is refused before it is read.
- **A drafted plan sends none of the folder**: the deploy request carries an empty zip,
  is refused, and the draft is saved, as the command's is.
- **Finishing an interview started elsewhere**: see "An interview can be finished on the
  other surface".

## Secret files never go into the package

Decided Mon Oct 12, 2026 (Greg, as recommended), after Step 15 found that a deploy left
out only the file named `.env`.

A deploy now leaves out every file `core/secrets.js` names: `.env.production` and the
other `.env.*` files (examples excepted), `.envrc`, keys and keystores (`.pem`, `.key`,
`.p12`, ...), SSH keys, package-manager and git credentials, Terraform variables and
state, and service-account JSON. Both surfaces' uploads leave them out (one rule in
core/upload-rules.js), and the packager removes them from a folder it copies whole on
the API's own machine. The report says so in a line. Settings reach an app from the
store or with the deploy, never inside its code.

What it costs: an app that ships a file of one of these names on purpose, a public CA
certificate as `ca.pem` say, or that installs from a private registry through its own
`.npmrc`, does not get it. That app needs the file under another name, or the value in
the store; a private registry for installs is a platform setting still to come.

## Logs pass through the masking traces do

Decided Mon Oct 12, 2026, building PHASE2-PLAN Step 16 (`sealeye logs`, the portal's
Logs card, `GET /deployments/{id}/logs`). The command's name is the one ROADMAP
proposed.

An app's logs are its own output and may hold anything a developer printed. Principle 6
says no secret value reaches the terminal or the portal, so the API masks every line
before either surface sees it: the patterns traces are masked with (core/tracing.js:
private keys, AWS access key ids, Anthropic and LangFuse keys, bearer tokens, seaLeye
tokens, now added, and `NAME=value` where the name says key, secret, token or password),
and `NAME=value` or `NAME: value` for every setting the app has in the store, whose
values the API never reads. Masking is a backstop, not a guarantee: a value printed
bare, with no name beside it, cannot be told from any other text, and that is said on
the page.

Lines come newest first over a window of 15 minutes, an hour, 6 hours or a day, at most
200 of them; the command prints them oldest first, as a terminal reads. They are read
when asked, never stored. A static site has no code running and says so. The deploy role
gains `logs:FilterLogEvents` on `/aws/lambda/sealeye-*` only.

## Pause and resume

Built Mon Oct 12, 2026 (PHASE2-PLAN Step 17, D7), as `sealeye pause` and `sealeye
resume`, the portal's Pause card, and `GET /deployments/{id}/paused`, `POST .../pause`
and `.../resume`. The names are ROADMAP's.

- An API pauses by its function's reserved concurrency going to zero, and resumes by the
  reservation being removed. Nothing else changes and nothing is removed; a request to a
  paused API is refused by AWS.
- The state is read from AWS after every change and whenever Control opens, and a
  change AWS does not confirm is said to have failed (principle 4). Each change is
  written on the environment's newest record with who asked and from where; lists show
  "Paused" from that record, as of the last change made through seaLeye.
- A static site says it cannot be paused. Its team may pause and resume it, as may an
  organization-wide token, as for a tear-down: a platform team may need to stop an app
  that misbehaves.
- Deploying again does not resume: the template does not set a reservation, so a paused
  API stays paused until someone resumes it.
- The deploy role gains lambda:PutFunctionConcurrency, DeleteFunctionConcurrency and
  GetFunctionConcurrency on `sealeye-*` functions.

## Configure is a deploy of the same code again

Built Mon Oct 12, 2026 (PHASE2-PLAN Step 18), as `sealeye config <app> [--retention
<days>]` and the portal's Configure card. The name is ROADMAP's.

What there is to configure on a running environment today is its settings, which Part B
built (`sealeye settings`, the Settings card, read by the app when it starts), and how
long its logs are kept. Logs' retention is in the plan (observability_basic), so a change
is a deployment of the code the environment already has, with the plan changed
(`fromDeployment` with a plan): no new endpoint, the history shows who changed it, and
the status is the deploy's. Both surfaces offer 1, 3, 7, 14, 30, 60, 90, 180 or 365
days (core/retention.js); compose refuses a hand-written plan with a value CloudWatch
does not accept, before anything is built.

The developer's sealeye.yaml is not changed (principle 5), so both surfaces say that it
still has the old value, and that the next `sealeye run` with it puts it back.

## Team shows people, never tokens

Built Mon Oct 12, 2026 (PHASE2-PLAN Step 19), as `sealeye team`, the portal's Team page
and `GET /team`. The name is ROADMAP's.

It lists the people with a token in use, one row per person and team: name, email, when
they were first given one, and when they last used seaLeye. Never a token, a hash or a
token id. A team's token sees its team; an organization-wide token sees every team in
its organization, and is itself marked "every team". A revoked token's person is not
listed. Issuing and revoking stay with the administrator on their Mac (`deploy/server.sh
token`): that is access to the platform, and it waits for sign-in (Q16) to move onto a
page.

## Performance shows readings, not capacity

Decided Mon Oct 12, 2026, before building PHASE2-PLAN Step 20's first half (`sealeye
perf`, the portal's Performance card, `GET /deployments/{id}/performance`). The name is
ROADMAP's.

Principle 8 keeps sizes, counts and capacity numbers out of plans, cards and files,
because a plan that says "handles 500 requests a second" is a promise nobody measured.
Performance is the other thing: what was measured. It shows requests, errors, requests
refused (while paused or busy), and the time the app's code took (the average, and the
time 95 in 100 finished within), per period and over the window, read from CloudWatch
when asked. Every view of it says these are readings of what happened, and that what an
app can take is set by a load test. Nothing here is written into a plan or a file, and
it never says what the app could handle.

The readings are the function's (AWS/Lambda Invocations, Errors, Throttles, Duration):
what the app itself did. A period with no requests has no time measured, and says so
rather than showing zero. The deploy role gains cloudwatch:GetMetricData, which takes no
resource; it reads only what the API asks for, by function name.

## Costs come from tags, a day behind

Built Mon Oct 12, 2026 (PHASE2-PLAN Step 20's second half), as `sealeye costs`, the
portal's Costs page and `GET /costs?since=7d|30d`. The name is ROADMAP's.

- **Tags on what costs money.** Both templates now tag what an environment pays for with
  `sealeye:app` and `sealeye:team`: an API's function, its log group and its address, a
  site's bucket. On the resources themselves, not the stack, so the function's role and
  the bucket policy need no tagging permissions; the deploy role gains only the older
  log-group tagging calls, which CloudFormation may still use. An environment gets its
  tags the next time it is deployed.
- **Greg turns them on once.** AWS counts a tag in billing only after it is activated
  in the Billing console (Cost allocation tags), and a key appears there only after a
  resource carries it, up to a day later. Until then costs answer with none.
- **Read by tag, from Cost Explorer.** By `sealeye:app`, filtered to the caller's team
  (an organization-wide token sees every team, by both tags), summed over the window, a
  day at a time. Cost Explorer answers from us-east-1, about a day behind, and charges
  for each call, so the API keeps an answer for an hour. Costs without seaLeye's tags are
  left out, and every view says so, and that it is a day behind (principle 7: nothing
  typed in, nothing guessed). The deploy role gains ce:GetCostAndUsage, which takes no
  resource.
- **One organization per account, for now.** Cost Explorer answers for the whole AWS
  account, and the tags name the app and team, not the organization. Every token is
  org "default" today, and each organization will deploy into its own account (ROADMAP
  Phase 1 item 5), so nothing crosses. If two organizations ever share an account, add a
  `sealeye:org` tag and filter on it first (owed in PHASE2-PLAN).

## An interview can be finished on the other surface

Built Mon Oct 12, 2026 (Greg asked for it with Steps 16 to 20).

An interview is kept by id, and its starter may answer it from either surface.
`GET /interviews` lists the caller's own that are still open (working, waiting for an
answer, or waiting for "Deploy this?"), never anyone else's. `sealeye interviews` shows
them; New environment lists them with Continue, which replays everything so far and
carries on, and Drop. A continued interview has no folder in the browser, so at a yes
the page asks for the app's folder to package (a drafted plan sends none). Leaving the
page drops only an interview started on it; one picked up from elsewhere stays open for
its owner, and any interview is dropped after a day as before.

## Day-two operations: what the review of Steps 16 to 20 changed

Mon Oct 12, 2026. An independent review before the pull request found these, all fixed:

- **Logs are read newest first.** CloudWatch reads forward from a start time, so a busy
  app's window gave its oldest lines. The API now reads backwards from now in widening
  steps (a minute, five, fifteen, an hour, six, a day) until it has enough or the window
  is used.
- **Masking covers JSON and whole values.** `"NAME": value` is caught as well as
  `NAME=value`, for every secret-looking name and every setting the app is known to
  have (in the store, given from a .env by its deploys, or asked for by its plan). An
  unquoted value is taken to the end of the line, since values hold spaces and commas;
  taking too much is the safe side. Lines are masked as text, never re-formatted. When
  the store cannot be read, the answer says only the other names were used.
- **A deploy of a paused API says so.** The template sets no reservation, so a paused API
  stays paused through a deploy; the record, the report and the command now say it is
  still paused, read from AWS when the deploy succeeds.
- **A torn-down environment says it was torn down** to logs, performance and the
  command's name lookup, rather than "nothing yet".
- **A stack another team now runs is theirs.** On a stack from before teams had names
  of their own, an older record's team can no longer read the logs or readings of, or
  pause, what the other team runs there now; an organization-wide token still can.


## One change at a time

Mon Oct 12, 2026 (Greg asked whether anything stopped a tear-down during a build).

Nothing did. A tear-down while a deploy was packaging was undone when the deploy went on
to create the stack again, and two deploys at once left one failed for a reason nobody
chose. Now the API refuses a deploy, a deploy again (configure included), a tear-down, a
pause or a resume of an environment while another change to it is queued, packaging,
running or tearing down (`api/busy.js`), with 409 ENVIRONMENT_BUSY and one sentence
naming what is under way, who started it, from which surface and when, and
`sealeye watch <id>` to follow it. Both surfaces show that sentence; the portal locks
its buttons before anyone clicks, with the same reason. The guard is in the API, not
the clients, so an old command or a script gets it too.

- A drafted plan changes nothing, so it is still saved whatever is under way.
- A change marked interrupted, or begun more than a day ago, stops counting: a restart
  picks up what it can (executor/resume.js) and the rest must not lock an environment
  for ever. A tear-down counts from when it was asked for, not from its deploy's start.
- Storing a setting is not refused: it changes nothing running. The portal says a value
  stored during a change is certain to reach the environment at its next deploy.

## A replaced deploy says so

Mon Oct 12, 2026. Greg saw two history rows marked Live after a configure. Each record
was showing its own result, and both had succeeded. A record keeps its true result, so
`GET /deployments` now marks a successful deploy that a later successful deploy of the
same stack has replaced (`replaced`, `replacedBy`, from `api/replaced.js`); a failed
deploy replaces nothing, since the stack rolled back. The portal shows Replaced, by
which deploy, and `sealeye list --deployments` says "succeeded (replaced by …)". Paused
is likewise only the current deploy's to say. `replacedBy` names the newer deploy only
when the reader can see it.

## A change under way is plain on every page

Mon Oct 12, 2026 (Greg chose A and C of three options). While a change is under way,
Control shows a banner across the top with what is happening, the step the platform is
on now (the same line `sealeye watch` prints, now in the `GET /deployments` summary as
`step`), how long it has taken, to the second, who started it from where, and an
indeterminate bar, since the platform cannot honestly say how far along it is. Every
card that would change the environment is locked with the reason. The status badge
breathes, the history row under way is marked with its step, the tab title says
"Building · app", and Environments shows the step under the app and reads again every
five seconds while anything is changing. Motion stops for anyone who has asked their
system for less.

## Name the app, not the deployment

Mon Oct 12, 2026. Every command that acts on an environment takes the app's name, which
means your team's environment of that name (two teams can each have one; a name never
reaches another team's). With no name, it uses the app the current folder's sealeye.yaml
plans, and says so in a line. `watch` and `status` take an app name too, following its
newest change. A deployment id still names exactly that deployment.

## The polish: what the review changed

Mon Oct 12, 2026. An independent review before the pull request found these, all fixed:

- **Two deploys again at once both got through.** Deploy again reads the settings store
  before it records anything, and a second request could pass the check in that wait.
  It is checked again after the last wait, just before the record is written.
- **`sealeye destroy` with no name tore down the folder's app without asking.** A
  tear-down is never a default: with no name it asks "Tear down <app>? [y/N]", and with
  no one to ask (no terminal, or `--json`) it refuses until the app is named.
- **A hung packaging step could lock an environment for a day.** A change still queued
  or packaging after an hour stops counting: nothing has reached AWS for it.
- **One failed read froze Control.** The page keeps the last state, says the read failed
  and tries again; Environments the same.
- **A tear-down through an older record was invisible in the portal.** The pages lock and
  show the banner for any record of the environment that is under way, as the API does.
- **Paused could outlive a resume** on a record a failed deploy sat above. Paused is now
  said by the environment's newest successful record, and cleared on the others.
- **A tear-down picked a record that never reached AWS** (on main too): when the newest
  deploy failed before its stack was named, the tear-down marked that record gone and
  left the environment running. Both surfaces now tear down through the newest record
  that has a stack.

Left as they were, and owed: after a first create rolls back, the executor's delete of
that stack is not waited for, so a redeploy at once can meet it still deleting; and a
tear-down interrupted by a restart is judged stale by its deploy's age, not the
tear-down's (executor/resume.js). Both settled below.

## The architecture is written down, as diagrams in text

Mon Oct 12, 2026. With Phase 2's day-two operations built and the repo public, Greg
asked to take stock: one set of documentation with the vision, roadmap, design and
architecture, and the standard diagrams, for outside readers and for whoever changes the
code next.

- `docs/README.md` is the entry point: seaLeye in two minutes, where it stands, a
  reading path for each kind of reader, and a map of every document. The existing
  documents stay where they are and keep their jobs; the map links them rather than
  rewriting them.
- `docs/ARCHITECTURE.md` is new: C4 context, containers and the API's components, the
  interview graph, deployment, four sequence flows (`sealeye run`, portal sign-in, an
  app reading its settings, a release), the data model, the security boundaries, and an
  index of the DESIGN.md entries behind each part.
- **Mermaid, not pictures.** GitHub draws it, a reviewer sees a diagram change as a text
  diff, and a coding agent can keep it true. The C4 views are flowcharts in the C4 style,
  because Mermaid's own C4 syntax still renders poorly on GitHub. Message text in a
  sequence diagram has no semicolons; they end the line.
- **A diagram is code.** A change that makes one wrong fixes it in the same commit, as a
  roadmap row is. Nothing in these documents names an account, a bucket or any other
  value of one installation, since the repo is public.

## A failed first create is cleared before anything else

Mon Oct 12, 2026 (owed from the polish review). When a first create fails and rolls
back, the platform deletes the dead stack so the next deploy starts clean. It used to
ask for the delete and move on, so a redeploy at once met the stack half-deleted and
failed for a reason that was not the real one. Now the record says failed at once, with
its real reason, and carries `cleaningUp` until the stack is gone; `api/busy.js` counts
that as a change under way ("being cleared after a build that failed"), the portal shows
it as one, and `sealeye list --deployments` says "failed (removing what it left)". The
wait gives up after fifteen minutes and says so on the record; the lock stops counting
after half an hour whatever happens; after a restart the platform waits again.

A tear-down interrupted by a restart is now judged by when it was asked for, not when
its deployment started, so tearing down a deploy from last week is finished after a
restart like any other. "A newer deployment has used the stack" likewise means one that
started after the tear-down was asked for.

## The roadmap gains a governed backbone and a door for agents

Tue Oct 13, 2026, by Greg, after working through how seaLeye would use the stack an
agent control plane is built from (LangGraph, LangFuse, agentgateway). Two phases are
added and the rest renumbered: old Phase 3 is now 4, old 4 is now 5, old 5 is now 7.
Entries above this one, and PHASE1-PLAN and PHASE2-PLAN, keep the old numbers.
`docs/BUILD-OUT.md` draws each phase.

- **Phase 3, a governed backbone, comes before discovery.** This answers Q14.
  agentgateway goes in front of every model call, with a key per caller, spend caps per
  run and per worker, a rate limit, and routing. Q14 leaned against a gateway for the
  pilot because one interview on one box gained little from it. The Phase 4 swarm
  changes that: many workers spending at once, reads to authorize, and one audit trail
  to keep. Building discovery on the gateway from its first day is cheaper than adding
  one later.
- **Routing has two reasons, and they differ by phase.** In discovery it is cost: small
  models for bulk reading, the frontier model for the rules. Everywhere it is data: an
  organization's code goes only to an endpoint in its own account. Routing lowers the
  cost of a call; caps and the graph's own limits are what stop a runaway.
- **Traces live in Canada (answers Q13).** LangFuse is self-hosted in ca-central-1 in
  Phase 3. Until then, the old leaning holds: tracing off for any pilot on real code.
- **Gateways log no bodies.** The rule for traces ("file names, never contents")
  applies to the gateway too, since a swarm reading an organization's code would
  otherwise copy it into gateway logs.
- **Discovery runs in a new account opened for the prospect or customer, and the run
  is paid.** This settles the ingestion-sandbox question left open after the October
  demo.
- **Learning the platform means a catalog, not a fine-tuned model.** The swarm writes
  each module's purpose, usage rules and what must be refused. The front door agent
  plans from it, and must-refuse evals in LangFuse decide whether it goes live.
- **Team accounts and Cognito sign-in move to Phase 5.** Both were deferred in Phase 1
  until a bank pilot, and the path to production is where a bank pilot needs them.
- **Phase 6, seaLeye for agents, comes after the path to production.** seaLeye's
  operations become MCP tools behind the gateway, so a coding agent gets what a
  developer gets: the same contract, the same human yes, the same evidence, with the
  agent named. After Phase 5, so agents get the whole path, not a side door to dev.
- **How the swarm reads the library is open (Q17).** The leaning is the provider's own
  MCP server where one exists, plain code otherwise, and no MCP servers built by seaLeye
  for other teams' services.


## Phase 3, settled after review

Tue Oct 13, 2026, by Greg, after a review of the new roadmap the same day. Each bullet
below was a concern raised in that review, and each is Greg's call unless it says
otherwise.

- **seaLeye holds the cap on a run; the gateway is the outer limit.** agentgateway's
  budgets belong to an API key in its configuration, over fixed time windows, and are
  charged after a response returns: the call that crosses a budget completes, and only
  the next one is refused. It has no notion of a run or a worker. So the cap per run and
  per worker lives in the graph, which already stops a stuck interview after
  `MAX_TURNS`: it adds up `usage` from each response, stops the run at its cap and says
  why. The gateway's budget and rate limit sit behind that, for whatever the graph gets
  wrong. Phase 3's "done when" says so.
- **Self-hosting LangFuse moves to Phase 4.** It needs ClickHouse, Redis and blob
  storage beside Postgres, which the pilot's one small server cannot carry, and nothing
  in Phase 3 sends an organization's code through a trace. Phase 4's discovery is the
  first work that does, so LangFuse moves to Canada before the first discovery run.
  Until then Phase 3's gateway spans join the run's trace in LangFuse Cloud, and tracing
  stays off for any pilot on real code. The answer to Q13 is unchanged; only its timing
  moved.
- **The pictures draw discovery where it runs.** BUILD-OUT.md had the swarm inside "one
  small server in ca-central-1", while the decision above it puts each run in a new
  account opened for the customer. Phases 4 to 7 now draw the swarm in that account,
  apart from seaLeye's API; the catalog it writes lives with the API.
- **The secret scanner comes forward to Phase 3, and answers Q6.** Today a secret file
  travels as an empty name, but a key written into `config.js` reaches the model and the
  trace. A deterministic scanner, never a model, decides: a file with a finding travels
  as a name only, `read_file` refuses it as it refuses `.env`, and the developer is told
  the file and line, never the value. The model may still say something looks like a
  secret, but never as the only check. It is built for the interview now and becomes the
  discovery swarm's first node in Phase 4. Where it runs, and whether a finding stops a
  deploy, are PHASE3-PLAN D3 and D4.
- **An agent's plan waits in a queue in the portal.** In Phase 6 the human yes that a
  developer gives at the terminal is given in the portal for an agent: its plan waits
  there until a person on the agent's team approves or refuses it, and the agent is told
  which. Nothing an agent asks for is built without that yes.
- **The second-person test runs alongside Phase 3.** It needs nothing Phase 3 builds,
  and Phase 3 needs nothing it finds. One overlap to watch: if the scanner (D4) refuses
  a deploy with a finding, WELCOME.md and the sample apps must agree with it before the
  tester runs them.
- **"Bedrock in the organization's account" is not "in Canada".** Checked the same day:
  Bedrock serves Claude to ca-central-1 only through cross-region profiles, not in
  region. The routing rule still holds, since the endpoint is in the organization's own
  account, but residency of inference is now Q18, with the commands that settle it for
  a given account. Until then the interview's calls to the Anthropic API, in the US, are
  acceptable for the friendly team and the sample apps, and ARCHITECTURE.md says so.
- **Discovery is tested on a made-up organization first.** No customer's library is
  needed to test Phase 4. A private repository for a fictional organization holds
  Terraform modules with known right answers and planted hard cases, much as the
  interview is graded on three sample apps. It lives in its own repository, not in this
  one, so discovery reads it the same way it will read a customer's (Q17). seaLeye's own
  building blocks are the smoke test before it; public module libraries test scale and
  cost; a paying customer tests usefulness last. ROADMAP Phase 4 lists the four layers.
- **seaLeye finds gaps and advises; drafting modules comes last.** Greg asked whether
  seaLeye should do more than discover: find gaps, offer options and fill them. Decided
  Oct 13, 2026, in three steps. Phase 4 adds a gap report, built from the needs ledger
  so each gap is backed by what developers asked for, not by a generic checklist.
  Phase 5's gap tickets carry options, effort and a recommendation; the platform team
  chooses. A new Phase 8, last on purpose and movable if an organization wants it
  sooner, has seaLeye draft the module as a pull request in the platform team's
  repository, written by a coding agent from seaLeye's specification. seaLeye never
  merges its own module: code that creates an organization's infrastructure needs an
  accountable owner, the team that runs it.

## Phase 3's decisions, as recommended

Tue Oct 13, 2026, by Greg. He accepted every recommendation in PHASE3-PLAN's decision
table, and chose where the gateway's image comes from the same evening. D2 is the entry
above ("seaLeye holds the cap on a run"); the rest are here, with the reason each
recommendation gave.

- **D1. A model call names its caller with a token the API signs.** Each call carries a
  token that lasts five minutes: `iss` the API, `aud` the gateway, `sub` the person's
  token id (never an email, since the gateway logs it), and `org`, `team`, `run`,
  `worker` and `surface`. The gateway checks it with `jwtAuth` against the API's public
  key. A key per person or worker was refused because every new person or Phase 4 worker
  would mean a gateway configuration change, and a held key can leak. Plain headers were
  refused because anything that can reach the gateway could claim to be anyone. The API
  also holds one gateway key of its own, because agentgateway attaches a budget to a key:
  the token says who, the key carries the budget. In Phase 6 Cognito becomes a second
  issuer on the same policy, so nothing here is thrown away.
- **D3. The scanner runs twice.** Shared rules in `core/`, before upload on both
  surfaces, so a finding never leaves the developer's machine; then gitleaks in the API
  over what arrived, as the deeper check and, in Phase 4, the swarm's first node. One
  set of rules means the command and the portal can never disagree about a file.
- **D4. A finding stops a deploy.** The deploy is refused until the value moves to a
  setting, or the line is listed in `.sealeye-allow`, which records the file, line and
  rule, never the value, and shows in evidence. Deploying a key that is known to be in
  the code would put it in the artifact, so a warning is not enough; the allow file is
  the way past a false finding, and it leaves a record. For the interview, a file with a
  finding travels as a name only, as a `.env` does.
- **D5. A run's cap is three times the largest run Step 1 measures.** Large enough that
  no honest run meets it, small enough that a loop is stopped in minutes. The gateway's
  monthly budget is a figure Greg names before Step 7; it is not named yet.
- **D6. The pilot stays on the Anthropic API; the Bedrock route is built and proved.**
  Bedrock serves Claude to Canada only through cross-region profiles (Q18), so moving the
  pilot there gains no residency until Q18 is answered for a bank, and it would change the
  interview's model to Sonnet 5.5 before the eval set has passed on it. Building the route
  now means the bank pilot finds it ready.
- **D7. The gateway is a container on the same server, its image pulled by digest from
  its public registry.** It is reachable only from the API, on Compose's internal
  network with no published port, and it holds the model key in place of the API. The
  server moves to a t4g.medium only if Step 4 shows the small one cannot carry it. The
  image is not mirrored into a second ECR repository: a digest already fixes exactly
  what runs, and a mirror would add a repository and push rights for CI to keep, for no
  gain in a pilot. Revisit if an organization requires every image to come from its own
  account.

## A run's cap is close, not exact

Wed Oct 14, 2026, by Greg, while settling where the cap's prices come from (PHASE3-PLAN
Step 3).

- **The cap prices from a table in the platform's config, and nothing else.** LangFuse
  knows each run's cost, but tracing is optional by design, it learns the cost after the
  call, and it is in the US; the cap has to decide from the reply just returned, with no
  network call. LangFuse and the providers' bills are how the table is checked, never
  what the cap reads. Anthropic publishes no price list a program can read; AWS's Price
  List API has Claude only under `AmazonBedrockService`, and not every model yet.
- **Two things let a run spend past its cap.** The cap is checked after each reply, so
  the reply that crosses it is already paid for: a run can overshoot by up to one turn.
  And a price can change before the table does.
- **A stale table is not fixed by use.** Greg's point: comparing the platform's totals
  with the bill only finds drift where there is traffic, so if seaLeye sits idle the
  table can be out of date on the day the first organization starts, and the comparison
  only notices after that organization has spent against it. Even then it only notices;
  a person updates the table. So the check does not wait for customers. The table
  carries the date its prices were last checked against the providers' pages;
  `release.sh` warns past 90 days; and checking it, with an eval run compared against
  the Cost API, is an operating step before any organization starts using seaLeye and
  before any release that changes the model (deploy/README.md, "Model prices", written
  in Step 9). A model with no price in the table is refused, so a new model can never
  run uncapped.
- **The direction of the risk.** A price cut makes the cap stricter than it says, which
  is safe. The harm is a rise on a model already in use, which is uncommon; a new model
  at a new price is caught by the refusal above.
- **Organizations are told, in these words or close to them:** "seaLeye stops a run at
  its spending limit, using the model prices seaLeye holds. The limit is checked after
  each reply from the model, so a run can go past it by up to one reply, and by more if
  a provider changes its prices before seaLeye's are updated. The monthly model budget
  is the outer limit. Neither replaces the spending limits and billing alerts you set
  with the model provider, which are the only hard ceiling on what you are charged."
  This goes in the material the first organization reads before it starts
  (PHASE3-PLAN, "Owed after this plan").

## What a run costs, and a cap of a dollar

Wed Oct 14, 2026, by Greg, from PHASE3-PLAN Step 1. `npm run eval:interview` on the
three sample apps, with `claude-sonnet-5` at list prices (US dollars), read back from
LangFuse:

| App | Turns | Input | Output | Cache read | Cache write | Cost |
|---|---|---|---|---|---|---|
| beneficiary-lookup-api | 6 | 8,999 | 2,224 | 56,145 | 11,229 | $0.0795 |
| payment-events-processor | 2 | 5,735 | 2,545 | 22,458 | 0 | $0.0414 |
| static-website | 2 | 2,758 | 1,091 | 22,458 | 0 | $0.0209 |

The largest run was 6 turns and $0.0795; the typical one 2 turns and $0.0414. An
earlier pass had the largest at 4 turns and $0.0749, so runs vary a little from pass to
pass. The cached system prompt is 11,229 tokens; writing it costs about $0.028 and falls
on whichever run comes first in a five-minute window, which in a pilot is most runs.

- **A run's cap is $1.00, not three times the largest sample run.** D5 as written gives
  about $0.24. The sample apps are a few small files, and only the system prompt is
  cached, so each turn sends the whole conversation again, every file read so far
  included: a run's cost grows with roughly the square of what it reads. By estimate,
  not measurement, an honest run on a real app (twelve turns, eight files of real size)
  costs $0.40 to $0.60, which $0.24 would stop; a run that reads a 20 KB file every turn
  until `MAX_TURNS` costs about $3.00. A dollar leaves room for the first and stops the
  second around its fourteenth turn.
- **Measured again on a real app before Step 3 makes it bind.** One interview on an app
  larger than the samples; if its cost is more than a third of the cap, the cap is
  raised before it can stop anyone.
- **Caching the conversation, not only the system prompt, would cut long runs'
  cost several-fold.** Not part of Phase 3; noted so the cap is revisited if it is done.

## sealeye online opens the portal

Decided Wed Oct 14, 2026.

`sealeye online` opens seaLeye.online in the browser: Environments, or with an app's
name or a deployment id, that environment's page. `sealeye portal` and `sealeye open`
are the same command, for whoever reaches for those words first; `online` is the one
the help names first because it is the portal's own name.

- **It is a way to the portal, not an operation, so it has no endpoint of its own.**
  Parity is about what a person can do to an environment; this only says where to look.
  Its one read is `GET /deployments`, to say which page.
- **One rule for an environment's key.** The portal's pages are
  `/environments/<key>`, and `core/environments.js` is now the one place that says what
  the key is, imported by `sealeye list` and the portal's Environments alike, so the
  page the command opens is the page the portal shows.
- **The token never travels to the browser.** Opening the portal already signed in
  would put the token in an address, and so in history and server logs. The portal
  signs in as it always has, and now comes back to the page that was asked for rather
  than to Environments, so the deep link survives a sign-in. A one-time sign-in code
  from the API would remove the paste; it overlaps with Q3 and waits for it.
- **The portal's address follows the API's.** `api.<domain>` is served beside the
  portal at `<domain>`; `SEALEYE_PORTAL` names it outright, for a laptop API, which has
  no portal anyone can know and says so.
- **Where nothing can open a browser (no display, an SSH session), it prints the
  address instead of failing.** `--print` prints only the address, for a script;
  `BROWSER` chooses the browser, as it does for other tools.
## The secret scanner

Wed Oct 14, 2026, PHASE3-PLAN Step 2, as D3 and D4 decided: the shared rules before
upload on both surfaces, then gitleaks in the API; a finding refuses a deploy unless
`.sealeye-allow` names its line. What building it settled:

- **The shared rules are few and sure** (`core/scan.js`): private key blocks, cloud
  access key ids, and the GitHub, GitLab, Slack, Stripe, Anthropic, OpenAI, Google, npm
  and SendGrid token shapes; a password in a connection address to a real host; and a
  long, random-looking value given to a name that ends in password, pwd, secret, token
  or key. The last two skip placeholders, references to other code, paths, UUIDs,
  common local defaults and values with no digit. Run over 20,300 files of installed
  npm and Python packages, they flagged 13 lines, all real-looking sample tokens in
  libraries' own tests and docs. gitleaks, in the API, is the wide net.
- **Every rule is linear in the line, and the API's scan is off its event loop.** The
  first version of the name-and-value rule let a match start anywhere, and a crafted
  40 KB line took half a second; the second review found the OpenAI rule did the same
  with a line of repeated `sk-`. Key shapes are now matched token by token (the line cut
  into runs of the characters a key can hold, each run matched whole by an anchored,
  bounded pattern), and the name-and-value rule finds the word and reads the value by
  hand. A test holds every rule under a second and a half on million-character lines
  built to make a regex backtrack; the worst crafted 25 MB line takes about 13 seconds.
  In the API the shared rules run in a worker thread with a two-minute limit, so a slow
  scan holds up only its own request.
- **Nothing is cut short.** Every byte of every file that travels is scanned, by both
  scanners: a key at the end of an 11 MB bundle got past a 2 MB cap here and gitleaks'
  10 MB one (found in review). A binary file is scanned for the shapes of keys only, not
  for name and value, which compiled files fake; the interview never reads one.
- **Words a developer reads name no cloud provider** (principle 8): "a cloud access
  key", not an AWS one. A finding is always a file, a line, a rule and a kind; no
  function keeps, logs or returns the value, and the tests check each fake key is
  nowhere it should not be.
- **One finding per line, and a line is what is allowed.** The shared rules and gitleaks
  name the same value differently (`cloud-access-key`, `aws-access-token`), so the allow
  file matches file and line, keeps the rule for the record, and the words show the
  shared rule's name where both found it. A malformed allow line allows nothing.
- **gitleaks always runs on seaLeye's terms.** By default it obeys a `.gitleaks.toml`,
  a `.gitleaksignore` and `gitleaks:allow` comments in the folder it scans, so a
  developer's repository could switch it off; tried, it did, and the review found the
  `.gitleaksignore` is read from the scanned folder whatever gitleaks is told. So the API
  never runs it on an app's folder: it scans a copy of its own, in a folder of a random
  name, with no `.gitleaksignore`, passes its own configuration (`api/gitleaks.toml`),
  runs from an empty folder with no `GITLEAKS_*` variables, ignores `gitleaks:allow`,
  redacts, and reads three fields of its report before deleting it. A finding it cannot
  place fails the scan rather than being dropped. Pinned at 8.30.1 by version and
  checksum in the image.
- **The copy is what would be packaged**: no `node_modules`, `.git` or secret files, and
  links followed as zip follows them (each real folder once), so a `config.js` that is
  a link to a key is read, and a laptop deploy from a folder with a real `.env` is not
  refused for it. Folders are skipped only where packaging's rsync skips them, matched
  as exactly. A link out of the app folder is refused, unless it is something packaging
  leaves out anyway (a shared `.env`, a monorepo's `node_modules`): packaging would
  store whatever it points at on the API's machine. For a folder on the API's machine
  the scan reads a copy and rsync then packages the folder, so a link changed in
  between goes unscanned; uploads hold no links, so this is a laptop API's gap only.
- **Known misses, left to gitleaks:** a key glued to the characters before it
  (`prefix-AIza...`, `GITHUB_TOKEN_ghp_...`) is one longer token to the shared rules,
  which match whole tokens to stay linear. Every file is scanned, whatever `.gitignore` says,
  and `.gitleaksignore`, kept from gitleaks, is still read by the shared rules.
- **Fail closed only where the deeper check was expected.** Without gitleaks (a laptop
  API, CI), the shared rules are the scan and the record says so. With gitleaks
  installed and failing, neither the interview nor the deploy goes ahead (503
  SCAN_FAILED): the point of the second scan is what the first one misses.
- **The API never takes the client's word for what is safe.** It scans what arrived;
  a file with a finding is emptied before the graph starts. The client's own findings
  only explain a file that arrived empty, and can never hide one that has contents.
- **A refused deploy keeps nothing**: no record, the upload removed. Unlike a drafted
  plan, it is not part of the app's history, just code that has to change first. The
  busy check moved after the scan, which waits, so two deploys cannot both pass it.
- **Evidence says how the code was checked** (shared rules, or with gitleaks) and lists
  each allowed line. A deploy again inherits the scan of the deployment that packaged
  the code; a deployment from before this says it was not checked.
- **The allow file is the developer's word, for both uses.** A line it names is let
  through to a deploy, and the interview may read that file too, since it is not a
  secret. It names a line number, so it excuses whatever is later written on that line;
  evidence lists every allowed line so a reviewer sees them.
- **What is not scanned:** a drafted plan sends no code; `runInterview`, which reads a
  folder in place for the eval, cannot empty files without changing the developer's
  app (principle 5), and runs only on the sample apps.

## The interview reads around a secret, not past the file

Wed Oct 14, 2026, by Greg, after the first interview on an app larger than the samples
(hagopj13/node-express-boilerplate). Sample JWTs in its Swagger comments sent
`src/routes/v1/auth.route.js` empty, and the model could not read the login and token
routes it most needed. This revises "The secret scanner" for the interview only; a
deploy with a finding is still refused.

- **A flagged line is replaced, not its file.** For an interview, each line with a
  finding travels as `[seaLeye: this line was not sent: it looks like it holds a GitHub
  token]`, so the model reads the rest of the file and the line numbers stay true. The
  value never travels either way.
- **Unless the value runs over many lines.** A private key is flagged on its first line
  and its body would follow it, so a file with one is still sent empty; so is a file
  where gitleaks found a value over several lines, and a binary file.
- **The client's word still counts only where it holds.** A finding the client sends
  explains a line only if that line arrived replaced, or a file only if it arrived
  empty; the API replaces whatever its own scan finds.

## Needs: known kinds, and the rest in the model's own words

Wed Oct 14, 2026, by Greg. The first interview on a real app
(hagopj13/node-express-boilerplate) called MongoDB "a relational database": the list of
need kinds had no document database, and the interview had to choose from it. Greg
asked whether a fixed list is needed at all.

- **The list stays, as the words to use, not a fence.** It is what lets the needs ledger
  and Phase 4's gap report count "twelve apps need X" as one number, the eval grade
  needs exactly, and a profile say what it will ask of each need. Those are worth
  keeping. What is not worth keeping is forcing a need into the nearest kind, which
  tells the platform team the wrong thing, or leaving it out, which shrinks a plan that
  should refuse (principle 3).
- **A need none of the kinds fits is `unlisted`**, with a line of the model's own in the
  same form as the list's ("a search index over its documents"). It drafts the plan
  like any need, and needs evidence like any need. The contract refuses a line that is
  not "a ..." or "an ...", names a module, holds an address or makes a promise
  (`unlistedNeedProblems`, `core/schema.js`), at most 90 characters.
- **The kind of thing, never the product.** An unlisted line says "a document database",
  not "MongoDB"; the technology is in the evidence ("mongoose in package.json"), where
  the platform team still sees it. The ledger keeps its rule of naming no vendor.
- **The ledger shows unlisted needs apart**, one row per wording, marked "not in the
  list yet" in `sealeye needs` and on the portal's Catalog. A wording that keeps coming
  back is a candidate for the list: added by hand for now, proposed by the gap report in
  Phase 4.
- **`document_database` joins the list**, since a real app has already needed it.
- Changing the catalog and the prompt changes what the interview writes, so
  `npm run eval:interview` runs before and after; the sample apps have no need this
  changes.
## The cap on every run

Wed Oct 14, 2026, PHASE3-PLAN Step 3, as D2 and D5 decided. First measured on a real
app, hagopj13/node-express-boilerplate: 6 turns and $0.152, twice the largest sample run
for the same turns, and well under a third of the dollar, so the cap stays a dollar.

- **Prices live in `core/model-prices.js`**, read from Anthropic's pricing page on
  Oct 14 and dated: Sonnet 5, Sonnet 5.5, Opus 5.5, and Haiku 5.5, which is priced by
  each request's prompt length. It priced the measured sample run at $0.0795, as
  LangFuse did. Bedrock's names for the same models join it with Step 8.
- **Checked before each call, not after.** The reply that crosses the cap is already
  paid for, so it is used: if it was the plan, the developer has a plan. A run that
  reads forever stops at the call after it crosses, so it goes past the cap by one
  reply at most, as "A run's cap is close, not exact" says.
- **The words carry no amount** (principle 8): the run reached its spending limit,
  nothing was written or built, run it again, and tell the platform team if it stops
  there again. The trace is scored `spending_limit_reached`.
- **Keyed by worker.** The run's spend is `{ interview: {...} }`, so Phase 4's workers
  each get their own without a new design.
- **A model with no price never starts** (503 MODEL_NOT_PRICED), checked before the
  upload is unpacked. An unpriced model would otherwise run with no cap at all.
- **The table is checked two ways**: the eval flags a run whose own count differs from
  LangFuse's by more than five percent, and `release.sh` warns when `checkedOn` is more
  than 90 days old. deploy/README.md, "Model prices", is the operating step.

## Inference from Canada: disclosed, on the US profile (answers Q18)

Wed Oct 14, 2026, by Greg, after reading in his own account what Bedrock offers from
ca-central-1. The commands, for reading it again in any account:

```sh
aws bedrock list-inference-profiles --region ca-central-1 --type-equals SYSTEM_DEFINED \
  --query "inferenceProfileSummaries[?contains(inferenceProfileId,'claude')].inferenceProfileId" --output text
aws bedrock get-inference-profile --region ca-central-1 \
  --inference-profile-identifier us.anthropic.claude-sonnet-5 --query 'models[].modelArn' --output text
```


- **There is no Canadian profile.** From ca-central-1 every Claude profile is `us.` or
  `global.`. The US profile for Sonnet 5 may run a call in ca-central-1, us-east-1,
  us-east-2 or us-west-2, and Bedrock picks per call; the global profile may run it in
  any commercial region. Neither keeps inference in Canada.
- **The Bedrock route uses `us.anthropic.claude-sonnet-5`.** It is the interview's own
  model, so Step 8 needs no change of model and no eval on another one; this replaces
  the plan's assumption that Canada offered only Sonnet 5.5. The global profile is not
  used: a bank's code going to any region is not something to offer.
- **Inference is disclosed, not kept in Canada.** Greg's call: where an organization's
  code is sent for inference is stated plainly, the US profile's four regions for
  Bedrock, the US for the Anthropic API, and stored data stays in Canada. Banks often
  grant an exception for a case like this; one that will not is the time to wait for a
  Canadian profile or run a model of the organization's own (Phase 7).
- **Disclosed where it is read**: the evidence for a deployment, and what the platform
  team is told when an organization starts, name the route the interview took and the
  regions a call on it may run in (PHASE3-PLAN Step 8).

## A deployment keeps the plan it was approved with

Wed Oct 14, 2026. Greg could not find a deployment's plan or report in the portal once
it had been deployed: the plan's files were shown only during the interview, and the
report only ever reached the developer's folder. Both surfaces now show them for any
deployment, from `GET /deployments/{id}/plan`.

- **The files are kept as approved, not rebuilt.** At `POST /deployments`, the API
  writes DEPLOYMENT_PLAN.md and sealeye.yaml for the plan and keeps them on the record
  (`planFiles`, `api/plan-record.js`). Rebuilding later from today's catalog and template
  could quietly differ from what the developer said yes to. Recommended over rebuilding
  on each read, and Greg went ahead with it.
- **The interview's notes come from the API, never from a client.** The summary and
  assumptions are in DEPLOYMENT_PLAN.md but not in the plan a client sends. When "Deploy
  this?" is answered, the API notes them, keyed by the person and the plan's exact text,
  for an hour; a deploy of that same plan by that person picks them up. A client could
  have sent the markdown, but then a record would hold text the platform did not write
  (principle 7). They are noted whichever way the question is answered, and a deploy of
  that same unchanged plan within the hour (the drafted plan saved after a "no", or
  `sealeye deploy -f` of the files the interview wrote) picks them up, which is right:
  they are the same notes the developer's DEPLOYMENT_PLAN.md has. Kept in memory: an API
  restarted between the answer and the deploy, a deploy more than an hour later, a plan
  edited before it was deployed, or one changed with Configure is written from the plan
  alone, and the words say so without guessing why (the record's `origin.planSource`
  decides between "from a plan file", "deployed again" and "not kept").
- **Once deployed, the interview's notes are the team's.** Before, an interview's words
  were its starter's alone; the summary and assumptions are now part of the deployment's
  record, which the team and an organization-wide token read, as they read its plan.
- **A file without its notes says so.** Its Notes section says the summary and
  assumptions are not part of the record, and never "No assumptions were needed", which
  would be a claim the platform cannot make (`notesKept: false` in
  `core/plan-files.js`).
- **Deploy again of the same plan keeps the earlier files**, which are what was
  approved; a changed plan is written down fresh.
- **Records from before this** have their files written from their plan when read, dated
  when the deployment started, and marked `rebuilt`; both surfaces say so.
- **The report is the record's own** (`report`, written when a deploy succeeds). With
  none, both surfaces say why in the same words (`core/plan-report-words.js`): drafted,
  failed with the platform's reason, still under way, or a report that could not be
  written.
- **`sealeye plan` writes into no folder unless asked.** It prints the plan (or the
  report, with `--report`); `--out <folder>` writes the three files there and refuses if
  any is already there, because an app's own sealeye.yaml is the plan it deploys next and
  an older one must never quietly replace it.
- **The list stays small, and so does the polled record.** `GET /deployments` carries
  neither the files nor the report, and `GET /deployments/{id}`, which the command polls
  while it watches a change, leaves the files to `/plan`.
- **An old plan is read as the contract reads it.** A 0.2 or 0.3 plan is upgraded before
  it is written down, so a module seaLeye cannot build appears as the need it described,
  never by its id (principle 2). A plan that cannot be written down at all gets a
  sentence on both surfaces and the reason in the server's log.

## agentgateway, read and run (Step 4)

Wed Oct 14, 2026, PHASE3-PLAN Step 4. The gateway could not run where its configuration
was written, so that configuration came from agentgateway v1.6.0's source and published
schema. The spike in `deploy/spikes/agentgateway/` then ran it on Greg's Mac (arm64),
against a stand-in model that answers as Anthropic's API does, and then against
Anthropic itself. **All 26 and all 8 checks passed**,
and the run contradicted nothing the source said. It found one thing the source reading
missed: the dollar signs in comments, below.

What the run showed:

- **The calls are unchanged.** The SDK, pointed at the gateway, got tool use, cache
  reads and writes, and a whole stream back. Upstream, the model saw the gateway's key.
  It saw neither the caller's token nor the API's key. Tools, cache marks and the beta
  header arrived as sent.
- **Every bad token is a 401.** Missing, expired, signed with another key, naming
  another algorithm, another audience, another issuer, no person, no expiry: all
  refused. A valid token with no API key, or the wrong one, was refused too. So the
  API's own key and the per-call token work together.
- **The per-run limit counts what Anthropic bills, after the reply.** Each stand-in reply
  was 11,000 tokens (input, cache writes, cache reads and output). Against 25,000, the
  third call was let through with 3,000 left and the fourth refused: 429, "rate limit
  exceeded", retry in a day. Another run kept its own limit.
- **The money budget works the same way.** At $0.05, with $0.0287 a call at Sonnet 5's
  prices, the second call crossed it and the third was refused with `budget_exceeded`.
  Its retry time was 19 days: the end of the gateway's 30-day period, not of the
  month.
- **No timeout cut a slow call.** A reply that took 95 seconds and a stream silent for
  70 both came through.
- **Nothing leaked.** No prompt, reply, token or key in the access log or in the
  SQLite file. The log line for a model call holds the model, the token counts, cache
  reads and writes, a cost (`agw.ai.usage.cost.total`), timings, `jwt.sub`, and the
  `run` and `worker` claims.
- **A restart keeps the budget and forgets the run limits.** A spent budget still
  refused after a restart (it lives in SQLite). A spent run's limit was back (it lives
  in memory).
- **It is small.** 14 MiB idle and 21 MiB with twenty streams at once, on arm64. D7
  stands: a container on the pilot server, with no larger server.
- **The real route to Anthropic works the same** (8 of 8). With the gateway holding the
  key, tool use came back, a 5,858-token system prompt was written to the cache on the
  first call and read from it on the second, a stream arrived whole, and a call with
  no token was refused before it reached Anthropic. The log held the same fields, and
  no content. Anthropic refuses an `anthropic-beta` value it does not know, which shows
  the gateway passes that header on unchanged.

What the source said, and what it means for Steps 5 to 7:

- **The Anthropic route keeps what the interview sends.** `/v1/messages` is served as
  is. Tools, `cache_control`, `anthropic-beta` and streaming pass through. Usage keeps
  its cache reads and writes, and fields the gateway does not know are kept. The
  gateway sends its own key as `x-api-key`, replacing whatever the caller sent, and
  sets `anthropic-version` itself. `SEALEYE_MODEL_URL` is the gateway's address with no
  path; the SDK adds `/v1/messages`.
- **jwtAuth's default lets a call with no token through** (`mode: optional`). The
  configuration says `strict`. With `issuer`, `audiences` and `requiredClaims: [exp,
  iss, aud, sub]` set, every failure is a 401. The keys come as JWKS, each with a
  `kid`. Ed25519 (EdDSA) is accepted, so the API can sign with Node's own crypto and no
  new package. Claims reach the access log (`jwt.run`, and `jwt.sub` by default).
- **A money budget only exists on a fixed API key, and it needs a database.** USD
  budgets attach to keys in the `apiKey` policy, not to token claims. The gateway
  refuses to start with one and no `config.database`. SQLite in a file is enough; it
  does not need Postgres. So the API holds one gateway key, sent in a header of its own
  (`x-sealeye-gateway-key`), which carries the monthly budget (D5's outer limit). The
  per-call token goes in `Authorization`. That the two work together is the spike's
  first thing to confirm.
- **The budget prices from a table compiled into the gateway.** It is the same
  close-not-exact as seaLeye's cap, from a different table. It drifts when prices
  change, until the gateway is upgraded or its catalog is overridden. Its window is
  fixed periods counted from 1970, so `30d` is not a calendar month; a monthly budget
  resets on a day that moves.
- **A per-run limit in tokens needs no database.** `localRateLimit` with `type: tokens`,
  keyed by `jwt.run`, counts input, cache and output tokens after each reply, and
  refuses the call after the one that crosses it, as seaLeye's cap does. It lives in
  the gateway's memory, so a restart forgets it. That is acceptable for an outer limit
  behind seaLeye's own cap.
- **Both refusals are 429**, and the interview retries a 429 once (`isRetryable` in
  `api/interview/model.js`). Step 6 must treat a 429 from the gateway as final and tell
  the developer in words, not retry it. The budget's body says `budget_exceeded`.
- **No timeout unless one is set**, and a 32 MiB body limit on model calls. The
  configuration sets `requestTimeout: 15m` and `responseIdleTimeout: 5m`, above the
  interview's 120 seconds, so the interview's own timeout stays the one that acts.
- **No bodies in the access log by default.** Prompts and replies are captured only
  when a log, trace or metric field names `llm.prompt` or `llm.completion`, so no field
  does. The database stores `metadata`, never `full`. The admin port is off, since its
  debug view logs claims. With no `tracing:` block, nothing leaves as a trace.
- **Bedrock is translated by default**: Anthropic's format becomes Bedrock's Converse
  and back, including tools, streaming and cache points. A cache `ttl` is dropped, and
  only an allowlist of `anthropic-beta` values crosses. Neither matters to the
  interview, which uses the five-minute cache and no beta. The gateway can instead send
  Anthropic's own format to Bedrock (`bedrockEndpointPreference: mantlePreferred`).
  Which one the pilot uses waits on Bedrock access in the account.
- **The image is `ghcr.io/agentgateway/agentgateway:v1.6.0`**, built for amd64 and
  arm64, and signed. The run showed its digest, `sha256:9d3e6044ddcdc0878b1787f77bd401252b95e22684203fb5e874c4c42d2ed90c`
  (the multi-arch index, read Oct 14). It reports version 1.6.0 at the same commit
  as the source read here, built for arm64 on Greg's Mac. Step 5 pulls it by this
  digest.
- **The configuration file expands every `$NAME`, comments included**, and refuses to
  start when one is unset. That is how the keys stay out of it. The run showed the
  comments part: the spike's first configuration explained this in a comment that
  named `$NAME`, and the gateway refused to start looking for a variable called NAME.
  The one exception is the `# yaml-language-server: $schema` line. So no comment, and
  no expression, in a gateway configuration holds a dollar sign. Step 5 checks that in
  a test.

## The gateway's budget: $20 a period

Wed Oct 14, 2026, PHASE3-PLAN D5, Greg's figure. The gateway's money budget on the API's
key is $20, the outer limit behind each run's own dollar (Step 7).

- **What it buys.** A typical run measured so far costs $0.08 to $0.15, so $20 is about
  130 to 250 runs. If every run stopped at its own cap, it would still be 20. That is
  room for the pilot, not for a team using it every day; raise it when one is.
- **"Monthly" is the gateway's 30 days**, not the calendar month. Its periods are counted
  from 1970 (DESIGN.md, "agentgateway, read and run (Step 4)"), so the budget resets on
  a date that moves by a day or two each month. The words an administrator reads say "a
  30-day period", never "a month".
- **Close, not exact, as the run cap is.** The gateway prices from its own table and
  charges after each reply, so the call that crosses $20 is let through, and spending can
  pass it by that one reply. A price change the gateway's table has not caught up with
  moves it further.
- **It survives a restart**, since the gateway keeps it in SQLite; the per-run token
  limits do not, and need not.
- **It is a setting, not a constant.** Step 5 reads it from the server's environment
  (`SEALEYE_GATEWAY_BUDGET`, in US dollars), with $20 as the default, so raising it is a
  restart, not a release.

## One list of words for both surfaces

Wed Oct 14, 2026, decided by Greg. The portal's "Tear down" button and `sealeye destroy`
did the same thing under two names, which reads as two different operations, and
principle 1 says an operation has the same name on both surfaces.

- **The command is `sealeye teardown`.** `destroy` stays as an alias, never shown in
  help, so scripts and habits keep working, the way `init` stays for `run`. The portal's
  word won because the portal is where newer people meet seaLeye, and "tear down" was
  already the command's own word in every line it printed.
- **`core/operations.js` is the one list.** Each operation has the command's word, its
  aliases, and the portal's label. The command turns an alias into its command once,
  before dispatching; the portal reads its labels and every command line it shows from
  the list. It runs in a browser, so the portal imports it.
- **`test/operations.test.js` holds both surfaces to it**: the command handles every
  operation, its help shows every command and no alias, the portal shows every
  operation it labels through the list, and the portal types no command line of its
  own. Renaming a command is one edit.
- **A label and a command may differ only where one names a page and the other an
  action**: Environments and `list`, Health and `doctor`, New environment and `run`. Two
  pairs are not like that and are left for Greg to decide: Configure and `config`,
  Performance and `perf`.
- **The portal shows each action's command line.** Control's Deploy again, Pause and
  Tear down are one Actions card of buttons, each with its command line under it and a
  button that copies it. What each does is said in its dialog, where it is asked, rather
  than on the page; Pause gains a dialog for that, and Resume, which puts back what was
  there, does not. A change under way locks the card once, said at the top. Configure
  and Settings end with their command line; Logs, Performance, Evidence and the change
  under way name theirs in a sentence, as they did.
- **Plan and report shows `sealeye plan <deployment>`**, with `--report` on the report's
  tab, for the deployment it is showing.

## The model gateway on the server

Wed Oct 14, 2026, PHASE3-PLAN Step 5, as D7 decided and the Step 4 spike showed.

- **A container next to the API**, agentgateway v1.6.0 pinned by the digest the spike
  ran (`deploy/compose.yaml`). Its settings are `deploy/gateway.yaml`, sent by
  `release.sh` the way the Caddyfile is. It publishes no port and sits on a network of
  its own (`model`) that only the API joins, so neither Caddy nor Postgres can reach it.
  That network is not an internal one, so the gateway still reaches the model's address.
- **The model key moves to the gateway.** It is kept at
  `/sealeye/gateway/ANTHROPIC_API_KEY`. `deploy/settings.mjs` leaves out anything under
  `/sealeye/gateway/` (`apiSettings`), so the API's environment never holds it.
  `deploy/gateway.sh` writes it, with the gateway's key and budget, to
  `secrets/gateway.env`: 0600, read by compose for the gateway alone. Like the database
  password, it is a file on the server's disk, because the gateway's image has no shell
  or AWS CLI to read Parameter Store itself.
- **This is a boundary in the process, not in AWS.** The API's container still uses
  the server's instance role, which may read `/sealeye/gateway/`. So an attacker who
  could run code in the API could still fetch the key. What this removes is the key
  sitting in the API's memory, its environment and anything it starts (npm, gitleaks,
  the AWS CLI). Keeping it out of the API's reach in AWS needs the API to have a role
  of its own, which waits for the move off one server (PHASE2-PLAN, "Owed after this
  plan").
- **The API calls the gateway with its own key**, `SEALEYE_GATEWAY_KEY`, in the
  `x-sealeye-gateway-key` header, and sends no model key at all
  (`modelCredential` in `api/interview/model.js`). A laptop API, with no gateway key,
  calls Anthropic with `ANTHROPIC_API_KEY` as before. `SEALEYE_MODEL_URL` with no
  gateway key still sends the model key, for an organization's own gateway that takes
  one.
- **The budget is on from the first release**: $20 for each 30-day period, or
  `SEALEYE_GATEWAY_BUDGET` (DESIGN.md, "The gateway's budget: $20 a period"). Its
  refusal is a 429, which the interview would otherwise call a busy model and retry, so
  a refusal that says `budget_exceeded` is never retried, and the developer reads that
  seaLeye has used its model budget for this period, with no amount (`isBudgetSpent`).
  Step 7 still shows it once on the server. The per-run token limit waits for Step 6,
  since without a token per call every run would share one limit.
- **Switching is a step of its own, and so is switching back.** The release brings the
  gateway up but does not move the API. Greg moves it by setting `SEALEYE_MODEL_URL`
  and deleting the API's model key, then restarting the API. Switching back is the
  reverse, with no release (deploy/README.md, "The model gateway").
- **The budget's amount is filled in like the keys.** The gateway fills in names in the
  file's text before reading it as YAML (`parse_config` in its source), so
  `amount: $SEALEYE_GATEWAY_BUDGET` becomes a number. The spike used a written amount,
  so the server checks it: a release asks the gateway to validate its settings, keys
  filled in, before restarting it, and keeps the old gateway running if they fail.
- **Reviewed before the pull request** by a separate agent. It found that a release
  stopped by a missing key had already replaced the server's compose file, so the
  secrets are now read before anything else changes. It also found that the SDK, given
  no key, would look for other credentials of its own, so the gateway's client never
  does. A gateway that is not ready fails the release only once the API uses it.
- **Live on Oct 14, 2026.** Greg released it, switched the API over, and ran an
  interview on apps/static-website. The API's settings show `SEALEYE_MODEL_URL` and its
  gateway key and no model key. The gateway logged each of the three model calls, with
  no prompt or reply, from the API's address only. The interview cost $0.050, with
  cache writes and reads as expected.
- **The gateway's cost matches seaLeye's prices exactly.** It priced each of the three
  calls to the same tenth of a cent as `core/model-prices.js` does. One difference to
  remember when reading its log: its `gen_ai.usage.input_tokens` includes the tokens read
  from and written to the cache. Anthropic's `input_tokens`, which the run cap counts,
  leaves them out.
- **Nothing a person sees changes.** Every check the gateway makes is in its own log,
  `deploy/server.sh gateway-logs`, which drops any line holding one of its keys.

## A token on every model call

Wed Oct 14, 2026, PHASE3-PLAN Step 6, as D1 decided: the API signs a short-lived token
for each model call, and nobody but the API holds the means to make one.

- **What it says.** The claims are:
  - `sub`, the person: the token holder's email, or `sealeye-api` on a laptop API with
    token checks off.
  - `org` and `team`.
  - `run`, the interview's id.
  - `worker`: `interview` today, and each of Phase 4's workers later.
  - `surface`: `cli` or `portal`, as the API already decides for records.
  - `trace`: the run's LangFuse trace id, when it has one.

  The issuer is `sealeye-api` and the audience `sealeye-gateway`. Every call, a retry
  included, signs a fresh token with an id of its own, and the gateway checks it when
  the call arrives, so each lasts a minute (`api/gateway-token.js`). An interview saved
  before tokens existed names its owner and says `unknown` for the team and surface it
  never recorded.
- **Ed25519, with Node's own crypto.** It needs no package. The Step 4 spike showed the
  gateway accepts EdDSA. The key's id is the first 16 hex characters of the SHA-256 of
  its public half, so the token and the key set agree without a second setting.
- **The private half is the API's alone.** It is `SEALEYE_GATEWAY_SIGNING_KEY`, a
  SecureString. The gateway gets only the public half, `/sealeye/gateway/JWKS`, written
  to a file by `deploy/gateway.sh`. `deploy/gateway-signing-key.mjs` makes both on
  Greg's Mac and hands each value to the AWS CLI in a 0600 file, never on a command
  line. A new key is that script with `--replace`, then `gateway-restart`.
- **The gateway requires it** (`jwtAuth`, strict, with issuer, audience and
  `requiredClaims: [exp, iss, aud, sub]`). It writes `jwt.sub`, `org`, `team`, `run`,
  `worker`, `surface` and `trace` into each line of its log. A claim that is missing
  (`trace`, for a run with tracing off) leaves its field out; it does not fail the
  call (the gateway's source, `eval_keep_empty`).
- **Only a call to the platform's gateway carries a token.** An API calling Anthropic
  with the model key sends no second credential, even if it has a signing key.
- **The API says at start which key it signs with**, by its public id, or that it has
  none or cannot read it, and carries on: deploys and the portal keep working, the
  gateway refuses the calls, and the developer reads that the API's credentials for the
  model were refused. A release checks that the id the API signs with is the one in the
  gateway's key set (`scripts/gateway-key-id.js`, `gateway.sh ready`), and fails, saying
  how to fix it, when they differ while the API uses the gateway.
- **A release checks the gateway's settings before anything restarts** (`gateway.sh
  validate`, before `docker compose up`), so a mistake in them stops the release with
  the old gateway still running.
- **The key script cannot leave half a pair.** It stores the public half first. If the
  private half then fails, it puts the previous public half back, or says the halves no
  longer match. A pair found half stored is made again.
- **Joining the trace, for now, is by id.** The plan asked for the gateway's own span
  in the run's LangFuse trace. The gateway can export spans (OTLP), but that puts
  LangFuse's keys in the gateway and needs the API to send a trace header on each
  call, and neither has run in the spike. Today the `trace` field in the gateway's log
  joins a line to its LangFuse trace by id. Exporting spans was owed as Step 6b, after
  a spike run (PHASE3-PLAN).
- **Tested two ways.** `test/gateway-token.test.js` starts the real API with tokens,
  runs one interview from the command and one from the portal, and checks each call's
  token against the public half. The spike (`deploy/spikes/agentgateway/probe.mjs`)
  now signs with the API's own signer, so a run of it on Greg's Mac shows whether the
  gateway itself accepts the API's tokens and logs their claims. The refused cases
  (none, expired, another key, another issuer or audience) run there too, since CI does
  not run the gateway. Greg ran it on Oct 14 against agentgateway v1.6.0: 26 of 26. The
  gateway let the API's own token through and logged its person, organization, team,
  run, worker, surface and trace. It refused every bad token with a 401 that names why.
- **The first release stopped before changing anything**, because `gateway.sh` asked
  Parameter Store whether the signing key exists with `describe-parameters`. The server's
  role may not make that call: it names `/sealeye/` parameters one by one. It now reads
  only the key's name, without decrypting it, which the role allows, and a test keeps
  the server's scripts to the calls the role allows.
- **Reviewed before the pull request** by a separate agent. It found nothing that
  leaks. Its findings were about the rollout: no check that the two halves match, a
  key script that could leave half a pair, settings started before they were checked,
  and a claim of a spike run that had not happened yet. Each is fixed above.

## The outer limit, and a record of calls kept 90 days

Wed Oct 14, 2026, PHASE3-PLAN Step 7. The budget and its plain words came with Step 5;
this adds the rest.

- **A per-run limit in the gateway**: two million tokens a day for each run, keyed on
  the token's `run` claim, counted after each reply. A run's own dollar
  (`core/model-prices.js`) stops it long before that, since a dollar is a few hundred
  thousand tokens of the interview's mix. So the limit acts only on a run the API's own
  count failed to stop: a bug, or a worker without a cap. It lives in the gateway's
  memory, so a restart resets it, which is acceptable for a backstop. It is a fixed
  number in `deploy/gateway.yaml`, not a setting, because nobody should need to tune it.
- **Told as the run's limit.** The gateway refuses with a 429 in plain text and
  `x-ratelimit-*` headers, but it adds those headers to every reply it lets through,
  Anthropic's 429 included, so the headers alone do not tell them apart. Only the gateway's own refusal
  is plain text with no Anthropic request id (`isRunLimitReached` in
  `api/interview/model.js`). A run the gateway stops is not retried, and ends as the
  run's own cap ends it: stopped, reason `spending_limit`, with the same words and the
  same trace score. To the developer it is one limit. Anthropic's 429 is still a busy
  model, retried once.
- **The record of calls is the gateway's own SQLite file**, read, never written, by
  `deploy/server.sh gateway-calls`. It runs `sqlite3` from the API's image, as the
  gateway's own user (65532), so no file it shares with the gateway changes owner. It
  shows one row per call: time, person, team, run, worker, surface, model, tokens, cost
  and status. It can be narrowed to a run or a person, checked against a plain pattern
  before it reaches the query. It never selects the payload columns, which stay empty
  (`database.llm: metadata`).
- **Kept 90 days** (Greg's choice). A nightly job (`sealeye-gateway-prune`, 03:45
  Toronto, after the backup) deletes older calls. It touches only the call log, never
  the budget's own tables. The gateway itself keeps calls forever.
- **Whether a stored row carries the token's claims** is from the gateway's source:
  a row's attributes are the log line's fields. The spike now checks it with `sqlite3`
  on a copy of the file. Until Greg's run confirms it, a row that lacks them would show
  empty person and run columns, and no more.
- **Shown once on the server**, on purpose: a budget below what the period has spent,
  one interview refused in plain words with the refusal in the record, then the budget
  put back (deploy/README.md, "The record of model calls, and the outer limit shown
  once"). That is the second half of Phase 3's "done when".
- **Reviewed before the pull request** by a separate agent. Its main finding was the
  one above: the first version took Anthropic's own 429, seen through the gateway, for
  the run's limit. It also found that a stopped run ended as failed, and that
  `gateway-calls 5` was read as a name. Each is fixed; a lone number is now how many
  calls. The reviewer checked the SQLite handling against the gateway's source:
  - deleting while the gateway writes is safe;
  - the budget cannot lose spend;
  - `unixepoch(completed_at)` reads the gateway's timestamps;
  - reading as the gateway's own user keeps the files it shares with the gateway
    owned by it.
- **Shown on the server, Oct 14.** Greg released it, set the budget below what the
  period had spent, and ran an interview. It was refused in plain words, and worked
  again once the budget was put back. That completes the second half of Phase 3's
  "done when".


## LangFuse in Canada waits for an organization's real code

Wed Oct 14, 2026, Greg, writing the Phase 4 plan (PHASE4-PLAN D1): "no one will be
picking this up at a real bank any time soon."

- **What changes.** Self-hosting LangFuse in ca-central-1 was to come before Phase 4's
  first discovery run ("Phase 3, settled after review"). It now comes before the first
  run on an organization's real code instead.
- **Why that is safe.** Every Phase 4 run before that reads code that is no one's
  secret: seaLeye's own templates, a made-up organization written for the purpose, and
  public module libraries. Traces still hold no file contents, and the scanner still
  stops a file with a finding before any model or trace.
- **What it saves.** A second server's worth of LangFuse (ClickHouse, Redis, blob
  storage) to run and back up, months before anyone needs it.
- **What it keeps owed.** The first customer run cannot start until traces are in
  Canada, or tracing is off for it. The gateway's own span in the trace (once Phase 3
  Step 6b) comes with the self-hosted LangFuse, as decided earlier today.

## The gateway's span waits for LangFuse in Canada

Wed Oct 14, 2026, Greg's call. PHASE3-PLAN Step 6b, the gateway's own span in each run's
LangFuse trace, moves to Phase 4, to be built with self-hosted LangFuse in ca-central-1.

- **What it would cost now:**
  - LangFuse Cloud's secret key would be held by the gateway as well as the API.
  - The API would send a trace header on every call.
  - The gateway's sampling would need a spike run, so that a run with `--no-trace`
    never appears in LangFuse through the gateway.
  - Spans would carry the token's claims, the person's email among them, to LangFuse
    Cloud in the US.
- **What it would add now is small.** Every gateway log line and every row of
  `gateway-calls` already carries the run's trace id, so a call joins its trace by
  hand. Tracing is meant to stay off for any pilot on real code until LangFuse is in
  Canada.
- **In Phase 4**, the gateway's spans go to the organization's own LangFuse in Canada,
  with a key the platform team holds, so the same work brings no new holder of an
  outside key and nothing more to the US.
- **Phase 3's "done when"** asked that every model call in a trace name its caller and
  its route. The caller is named, by trace id, in the gateway's log and record; the
  route comes with Step 8. The span itself is Phase 4's.

## Phase 4's decisions, and one reopened

Wed Oct 14, 2026, Greg, answering PHASE4-PLAN's decisions.

- **As recommended:**
  - D2: discovery runs in the seaLeye account until the first customer.
  - D3: plain code reads the library, a read-only clone at a named commit; the model
    never chooses what is read. This answers Q17.
  - D4: a catalog is a versioned document per organization in Postgres; the four
    built-ins are the starter catalog; plans name the version they were made from.
  - D5: workers on the small model, the supervisor and rule writer on the frontier
    model, both as named routes through the gateway.
  - D6: a cap per worker and per run, set from a measured run.
  - D8: Terraform as one root module per environment, state in S3.
- **D9, with Greg's refinement.** The made-up organization's modules are ones commonly
  assembled into the same kind of application (a backend API, a website, or another),
  so a sample app's right plan uses several of them together, as a real platform
  library is used.
- **D7, reopened as Q19.** Pausing a discovery run for a platform engineer means the
  run waits until someone notices, so discovery would need watching. Greg: "we should
  consider first alternative interaction models that allow full runs to complete quickly
  without pausing for human intervention." Q19 sets out the options. It blocks Step 6
  only, so Part A goes ahead.

## The catalog is data, and every organization starts with the starter

Wed Oct 14, 2026, PHASE4-PLAN Step 1 (D4).

- **What it is.** A catalog is the document `prompts/module-catalog.yaml` has always
  been: modules, need kinds, profiles and patterns. Each organization can have its own,
  versioned, in the `catalogs` table (`api/migrations/006_catalogs.sql`), or in
  `~/.sealeye/catalogs.json` beside a laptop API, read from memory and written through
  (`api/catalogs.js`), as the deployment store is.
- **The starter.** An organization with no live catalog has the starter catalog, which
  is the file, word for word and read fresh each time. Every organization today has
  it, so nothing a developer sees changes.
- **Draft, approved, live, retired.** Discovery will write drafts. A platform engineer
  approves one, by name. Only an approved catalog goes live, and the live one it
  replaces is retired in the same transaction; the database allows one live catalog
  per organization. Nothing makes a catalog live from a request yet: the self-test
  (Step 7) comes before any endpoint or command that does.
- **Where the API reads it.** `GET /catalog` (which now says which catalog, as
  `catalog: { version, source }`), the need lines in `POST /plans/validate` and in the
  needs ledger, the plan files written onto a record, and the evidence's patterns, each
  from the caller's or the record's organization. Every function in `core/catalog.js`
  already took the catalog it reads; the API now hands it the organization's.
- **What still reads the starter.** The interview's prompt (Step 3), the command's card
  and plan files (Step 2 moves them to `GET /catalog`), and the plan contract's fixed
  module ids and need kinds (Step 2's planVersion 0.5). Until those land, an
  organization's catalog can reword the starter but not add to it.
- **A catalog holds no secret.** It is names, lines and signals, so it is backed up
  with the rest of Postgres.
