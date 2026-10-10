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

The plan held this decision until after the Lightworks interview on Tue Oct 13, for two
reasons: Step 8 moves tracing into the API, so building it before deciding risked wasted
work, and the interview demo ran on this code. Neither holds. Tracing is in, and Part A is
not being demoed. Working on Part B now is also the point: seaLeye is how Greg is learning
LangFuse, and how a real AI-native product is built, hands on, alongside the interview
process.

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
