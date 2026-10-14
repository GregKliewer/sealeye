# Phase 3 plan: a secret scanner, then a governed door for every model call

Written Tue Oct 13, 2026, at 2.21.1, after the roadmap gained Phase 3 and a review the
same day settled its shape (DESIGN.md, "The roadmap gains a governed backbone and a door
for agents" and "Phase 3, settled after review"). Nothing in it is built yet.

The plan has two parts, in the order the dependencies force.

- **Part A** (Steps 1 to 3) needs no gateway. It measures what a run spends, stops a
  key written into an app's code from reaching the model, and gives every run a cap of
  its own. Each is worth having even if the gateway slipped.
- **Part B** (Steps 4 to 9) puts agentgateway in front of every model call: proved
  first, then on the server, then naming its caller, then as the outer spending limit,
  then routing, then written down.

**The second-person test runs alongside.** PHASE2-PLAN Step 6 needs nothing this plan
builds. One overlap: once Step 2 ships, a deploy with a finding may be refused (D4), so
the sample apps and WELCOME.md must agree with the scanner before the tester runs them.
Step 2 checks that.

**Done when** (ROADMAP Phase 3): a looping run is stopped by seaLeye's own cap rather
than by a person, and told why; the gateway's budget refuses calls once it is crossed,
as the outer limit; every model call in a trace names its caller and its route; no trace
or gateway log holds file contents.

## What the code looks like today

- **One client, one seam.** `api/interview/model.js` makes one Anthropic client with the
  SDK's retries off, a 120 second timeout and one announced retry. `SEALEYE_MODEL_URL`,
  when set, sends every call somewhere else instead. Nothing sets it yet. The default
  model is `claude-sonnet-5`, and the system prompt and tools are cached.
- **The only limit on a run is its turns.** `MAX_TURNS` is 24 in
  `api/interview/graph.js`. Each turn's `usage` is read, but only for debug output;
  nothing adds it up.
- **The API holds the model key.** `ANTHROPIC_API_KEY` comes from the server's settings
  under `/sealeye/` into the API's own environment.
- **Secrets are found by file name only.** `core/secrets.js` names the files that hold
  secrets (`.env`, `.pem`, `credentials` and the rest), and `core/upload-rules.js`, the
  one walk both surfaces use, sends them as empty names. Every other file travels whole,
  and `read_file` returns it to the model. A key written into `config.js` reaches the
  model, and its path and size reach the trace.
- **Traces carry names and sizes, never contents** (`core/tracing.js`), in LangFuse
  Cloud, and only when the API has LangFuse keys.
- **The server is one t4g.small** running the API, Postgres and Caddy under Docker
  Compose (`deploy/compose.yaml`). `deploy/server.yaml` already allows a t4g.medium.
  The server's role has no Bedrock permission.
- **Spikes have a home.** `deploy/spikes/settings-read` is how Part B of PHASE2-PLAN
  proved its read path before building it. Step 4 follows that pattern.

## Decisions this plan needs from Greg

Each answer goes in DESIGN.md with its date and reason, and the "Decided" column is
filled in here. All seven are recorded in DESIGN.md, "Phase 3's decisions, as
recommended" (D2 in "Phase 3, settled after review").

| # | Decision | Recommendation | Needed by | Decided |
|---|---|---|---|---|
| D1 | How a model call says who made it | The API signs a short-lived token for each call (below). Nobody holds a gateway key but the API. | Step 6 | As recommended (Tue Oct 13) |
| D2 | Where the cap on a run lives | In the graph; the gateway's budget is the outer limit | Step 3 | As recommended (Tue Oct 13) |
| D3 | Where the scanner runs | Twice. Shared rules in `core/`, before upload, on both surfaces, so a finding never leaves the machine; then gitleaks in the API over what arrived, as the deeper check and the swarm's first node later | Step 2 | As recommended (Tue Oct 13) |
| D4 | What a finding does to a deploy | The deploy is refused until the value moves to a setting, or the line is allowed in `.sealeye-allow` (which records the file, line and rule, never the value, and shows in evidence) | Step 2 | As recommended (Tue Oct 13) |
| D5 | How big the caps are | A run's cap: three times the largest run Step 1 measures. The gateway's budget: a monthly amount Greg names | Steps 3 and 7 | Changed (Wed Oct 14): a run's cap is $1.00, not three times the largest sample run, which came to about $0.24; the gateway's budget is $20 for each 30-day period (Wed Oct 14, DESIGN.md, "The gateway's budget: $20 a period") |
| D6 | Which route the pilot uses | Build the Bedrock route and prove it in Greg's account; keep the Anthropic API as the pilot's route until Q18 is answered for a bank | Step 8 | As recommended (Tue Oct 13) |
| D7 | Where the gateway runs (informed by Step 4) | A container on the same server, reachable only from the API, holding the model key in place of the API. Move to a t4g.medium only if Step 4 shows the small one cannot carry it | Step 5 | As recommended (Tue Oct 13); the image pulled by digest from its public registry |

**D1, in more detail.** The gateway sees one caller, the API process, so the person,
team, run and worker have to travel with each call. Three ways:

- **A gateway key per person or worker.** agentgateway's keys live in its
  configuration, so every new person or Phase 4 worker means a configuration change, and
  a key somebody holds is a key somebody can leak.
- **Plain headers** (`x-sealeye-person` and so on). Easy, but anything that can reach
  the gateway can claim to be anyone.
- **A signed token per call (recommended).** The API signs a token that lasts five
  minutes, with `iss` the API, `aud` the gateway, `sub` the token id of the person (never
  an email, since the gateway logs it), and `org`, `team`, `run` (the interview's id),
  `worker` (`interview` today; one per worker in Phase 4) and `surface`. The gateway
  checks it with its `jwtAuth` policy against the API's public key, and its logs, trace
  attributes and rate limits read the claims (`jwt.run`, `jwt.team`). The signing key
  lives in the server's settings beside the other secrets; the gateway gets only the
  public half. In Phase 6 a coding agent brings a token from Cognito instead, a second
  issuer on the same policy, so nothing here is thrown away.

The API also authenticates to the gateway with one key of its own, because agentgateway
attaches a budget to a key (D5): the token says who, the key carries the budget.

## Part A: before the gateway

### Step 1. Measure a run (D5)

Run `npm run eval:interview` and read each run's `usage` from the debug output and
LangFuse: input, output and cached tokens per turn and per run, and what each run cost.
The eval reads each run's tokens and cost back from its LangFuse trace and prints them
as one table, and says so when LangFuse has no price for the model rather than showing
a cost of nothing.
Record the largest run and the typical one in DESIGN.md. They size D5, and they are the
"before" for every later step.

Done Wed Oct 14 (DESIGN.md, "What a run costs, and a cap of a dollar"): the largest
sample run was 6 turns and $0.0795, the typical one 2 turns and $0.0414. The real app
measured before Step 3: 6 turns and $0.152.

Greg ran the two commands now in DESIGN.md ("Inference from Canada") on Oct 14, so Step 8 knows
where a Bedrock call from Canada may run.

### Step 2. The secret scanner (D3, D4)

Built Wed Oct 14, at 2.23.0 (DESIGN.md, "The secret scanner"). gitleaks is 8.30.1, pinned
by checksum in the image.

- **Rules in `core/scan.js`**, no dependencies, so the command and the browser run the
  same ones: private key blocks, cloud access keys, the common service tokens (GitHub,
  GitLab, Slack, Stripe and the like), and a long, random-looking value assigned to a
  name such as `password`, `secret`, `token` or `api_key`. High confidence over
  coverage: a false finding stops a developer, so each rule must earn its place.
- **Before upload.** `collectUpload` (`core/upload-rules.js`) runs the rules. For the
  interview, a file with a finding travels as an empty name, as a `.env` does today.
  For a deploy, D4 decides.
- **In the API.** gitleaks, pinned and in the image, runs over the uploaded copy before
  the graph starts, with its values redacted. A finding the shared rules missed joins
  the same list. This is the deeper check, and in Phase 4 the swarm's first node.
- **The model.** `read_file` refuses a file with a finding and says why; `list_files`
  shows its name. The model may still say something looks like a secret, never as the
  only check.
- **The developer** sees the file, the line and what kind of value it looks like, never
  the value, and how to move it: `sealeye settings set`, or Settings in the portal. The
  words live in `core/` so both surfaces say the same thing.
- **Allowing a line.** `.sealeye-allow` lists file, line and rule for a value that is
  not a secret (a test key, a public identifier). Evidence lists what was allowed.
- **Tests**, with fixtures that hold only documented fake keys: both rules and gitleaks
  find them, the interview never reads them, a deploy follows D4, the portal says the
  same as the command (Playwright), and no trace or log holds a value.
- **The sample apps and WELCOME.md** pass the scanner as they are, or are fixed, before
  the second-person test uses them.

High stakes: an independent review before the pull request.

### Step 3. A cap on every run (D2, D5)

Built Wed Oct 14, at 2.26.0 (DESIGN.md, "The cap on every run"). Measured first on a real
app, hagopj13/node-express-boilerplate: 6 turns and $0.152, well under a third of the
dollar, so the cap stands.

- The graph adds each turn's `usage` into the run's state and prices it from a small
  table of model prices in the platform's config. The table is the only source the cap
  enforces from: never LangFuse, which is optional and after the fact, and never a
  network call. It carries the date its prices were last checked against the
  providers' own pages.
- A model with no price in the table is refused: the interview does not start, and says
  the platform has no price for that model. Without this, setting `SEALEYE_MODEL` to a
  new model would run it with no cap at all.
- `release.sh` warns when the prices were last checked more than 90 days ago. The cap is
  close, not exact (DESIGN.md, "A run's cap is close, not exact"): a stale price and the
  call that crosses the cap both let a run spend past it.
- At the cap the run stops with status `stopped`, the same as `MAX_TURNS` today, and a
  sentence for both surfaces: the run reached its spending limit, nothing was built, and
  what to do next. The trace is scored with the reason.
- The cap is a setting (`SEALEYE_RUN_CAP`), $1.00 by default (D5). The counter is keyed by worker
  as well as run, so Phase 4's workers each get one without a new design.
- Test: a fake client that asks for tools forever is stopped by the cap before
  `MAX_TURNS`, on both surfaces. This is the first half of the "done when". Also: a
  model missing from the table is refused, and the eval flags a run whose own count
  differs from LangFuse's cost by more than five percent.

## Part B: the gateway

### Step 4. Prove the route (D6, D7)

In `deploy/spikes/agentgateway/`, before anything is built:

*Status (Oct 14): done for the Anthropic route. Run on Greg's Mac against a stand-in
model (26 of 26) and against Anthropic (8 of 8), with memory measured (14 to 21 MiB).
DESIGN.md, "agentgateway, read and run (Step 4)", has what it showed. Still to run:
Bedrock, which waits on the account's access, and is not needed for Step 5 (D6 keeps
the Anthropic API as the pilot's route).*


- The Anthropic SDK, with `SEALEYE_MODEL_URL` set, reaches the Anthropic API through
  agentgateway with tool use, prompt caching and the interview's timeouts unchanged.
- The same call reaches Claude on Bedrock through the gateway, in Greg's account, if
  the gateway turns the Anthropic format into Bedrock's; if it does not, say so and
  what it would take.
- `jwtAuth` with a key file accepts the API's token and refuses a missing, expired or
  wrongly signed one; log fields and trace attributes read its claims.
- A budget on the API's key refuses the call after the one that crosses it, and what
  database the budget needs (it refuses to start without one). Whether the budget
  counts tokens or money, and if money, where its prices come from: a budget in tokens
  does not drift when prices change.
- The access log holds no request or response bodies.
- How much memory it uses on arm64 next to the API, Postgres and Caddy (D7).

Record what it found in DESIGN.md. If any of these fails, stop and bring it to Greg
before Step 5.

### Step 5. agentgateway on the server (D7)

*Status (Oct 14): done and live. The API calls the model only through the gateway, which
holds the model key; DESIGN.md, "The model gateway on the server". The release steps
are in deploy/README.md, "Once: the model gateway".*

- A service in `deploy/compose.yaml`, image pinned by digest, on the internal network
  only, with no published port. Its configuration is a file in `deploy/`, applied by
  `release.sh` the way the Caddyfile is.
- The model key moves from the API's environment to the gateway's, so the API no longer
  holds it. The API gets its own gateway key from the server's settings.
- `SEALEYE_MODEL_URL` points the API at the gateway. Unsetting it is the rollback, and
  deploy/README.md says how, with exact commands.
- Release steps for Greg, from the repo root, with what success looks like.

### Step 6. Who is calling (D1)

*Status (Oct 14): built; DESIGN.md, "A token on every model call". The gateway's log
names each call's person, team, run, worker, surface and trace id. The gateway's own
span in the run's LangFuse trace (once Step 6b) moved to Phase 4 on Oct 14, to be built
with self-hosted LangFuse (DESIGN.md, "The gateway's span waits for LangFuse in
Canada").*

- The API signs a token for each model call, from a key in the server's settings; the
  gateway's configuration holds only the public half, written at release.
- The gateway requires the token, and writes `sub`, `team`, `run`, `worker` and the
  route into its log and its span. Both join the run's trace in LangFuse.
- Tests: the token's claims for an interview started from the command and from the
  portal; a call with no token, an old one or a forged one is refused (in the spike's
  harness, since CI does not run the gateway).

High stakes: an independent review before the pull request.

### Step 7. The outer limit (D5)

- A budget of $20 on the API's gateway key for each 30-day period (D5), and a token
  rate limit keyed on `jwt.run`, so one run cannot starve the rest.
- When the gateway refuses, the interview stops and says plainly that seaLeye's model
  budget is used up for now and to ask the platform administrator; it never retries into
  the refusal. The refusal is in the gateway's log, so the administrator can see it.
- Shown once on the server, on purpose, with a tiny budget. This is the second half of
  the "done when".
- **A record of model calls that outlives a restart** (added Oct 14, at Greg's request).
  The gateway's log lives only as long as its container, and each release that changes
  the gateway starts a new one, so who called the model is lost at every such release.
  The gateway already keeps each call in its own SQLite file (`gateway-data`), with no
  prompt or reply (`database.llm: metadata`). `deploy/server.sh gateway-calls` reads it:
  one line per call (time, person, team, run, worker, surface, model, tokens, cost,
  status), narrowed to a run or a person, never a prompt, reply, token or key.
  First, in the spike: whether the stored rows carry the token's claims or need fields
  of their own, how to read the file while the gateway writes it, and how long rows
  are kept. Then a retention to set, written in DESIGN.md.

*Status (Oct 14): done. DESIGN.md, "The outer limit, and a record of calls kept 90
days". Shown on the server the same evening: with the budget below what the period had
spent, an interview was refused in plain words, and then worked again once the budget
was put back.*

### Step 8. Routing (D6; DESIGN.md, "Inference from Canada")

- Named routes in the gateway: the frontier model for plans (the interview today), a
  small model for bulk reading (defined now, first used by Phase 4's workers), and an
  in-account route to Claude on Bedrock.
- A data class in the platform's config. When it says an organization's code may only
  go to its own account, the gateway refuses every other route for that organization's
  calls.
- The pilot stays on the Anthropic API route (D6). The Bedrock route is proven in
  Greg's account; the server's role gains Bedrock permission in its own stack change.
  It uses `us.anthropic.claude-sonnet-5`, the interview's own model, read in Greg's
  account on Oct 14 (DESIGN.md, "Inference from Canada"): no change of model, and no
  global profile.
  The permission names the profile and the foundation model in each region it may
  send to (ca-central-1, us-east-1, us-east-2, us-west-2); a policy naming only the
  profile is refused. The price table gains Bedrock's name for the model.
- Where inference runs is disclosed, as Greg decided on Oct 14: the evidence for a
  deployment names the route its interview took and the regions a call on it may run
  in, read from the gateway's configuration, never typed in (principle 7).
- Each span names its route: the last line of the "done when".

### Step 9. Write it down

*Status (Oct 14): done, apart from what waits on Step 8. ARCHITECTURE.md has the
gateway in its containers, deployment and security model, and a new flow, "One model
call". CLAUDE.md has principle 11. deploy/README.md's "Model prices" covers the
gateway's own price table. BUILD-OUT.md marks what is built. Ticking Phase 3 in
ROADMAP.md, and every call naming its route, wait on Step 8.*

DESIGN.md entries for each decision; ARCHITECTURE.md's containers, security model and a
new sequence for one model call; CLAUDE.md's invariants (no gateway logs with bodies;
every call names its caller); deploy/README.md, with a "Model prices" section: where the
table is, how to check it, and that it is checked before any organization starts using
seaLeye and before a release that changes the model; the Phase 3 picture in BUILD-OUT.md
marked built; and ROADMAP.md's Phase 3 ticked.

## Order and rough effort

| Steps | What | Effort |
|---|---|---|
| 1 | Measure a run | half a day |
| 2 | The secret scanner, on both surfaces and in the API | three to four days |
| 3 | A cap on every run | one day |
| 4 | Prove the route | one day |
| 5 | agentgateway on the server | one to two days |
| 6 | Who is calling | two days |
| 7 | The outer limit | one day |
| 8 | Routing | one to two days |
| 9 | Write it down | one day |

About twelve to fifteen days in all. Steps 2 and 6 decide what leaves a developer's
machine and who a call is said to come from: review those diffs line by line.

**What a developer notices.** Almost nothing, by design: a refused file says why, a
stopped run says why, and the interview is no slower than one hop on the same server.
The scanner (D4) is the one change a developer can feel, and the allow file is the way
around a false finding.

## Owed after this plan

| Item | Where it stands | Bring it forward when |
|---|---|---|
| **LangFuse in Canada** (Q13's answer) | LangFuse Cloud; tracing off for any pilot on real code. Moved to Phase 4 on Oct 13. | Before the first discovery run reads an organization's code, or any pilot that wants traces on real code. |
| **Inference in Canada** | Decided Oct 14: disclosed, not kept in Canada (US profile: Canada or the US). | A bank that will not grant an exception: then a Canadian profile, or a model of the organization's own (Phase 7). |
| **Agents as callers** (Phase 6) | The token in D1 has room for a second issuer. | Phase 6, after Cognito (Phase 5). |
| **The small model** | Routed (Step 8), not used. | Phase 4's workers. |
| **Checking prices against the bill** | The cap's prices are checked by hand and dated (Step 3); the eval compares them with LangFuse's. A monthly script comparing a month of the platform's own totals with Anthropic's Cost API (an Admin key, kept off the server) and, once Bedrock carries traffic, Cost Explorer. It only finds drift where there is traffic. | Once an organization is using seaLeye every week. |
| **Telling an organization what a cap guarantees** | Worded in DESIGN.md, "A run's cap is close, not exact". | In the material the first organization reads before it starts (Phase 4's first paid discovery run, or the first pilot, whichever comes first). |
| **PHASE2-PLAN's owed list** | Unchanged by this plan; it still stands. | As it says. |
