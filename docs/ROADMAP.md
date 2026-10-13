# seaLeye: roadmap

The phases in order, then the parity backlog: every operation, with where it stands in
the API, the command and the portal. Pick work from the current phase. Update a row in
the same commit as the work that changes it. Questions that block a phase are in
OPEN-QUESTIONS.md.

**Plans.** `docs/PHASE1-PLAN.md` built Phase 1 up to the second-person test (done Oct
11, 2026). `docs/PHASE2-PLAN.md` finished Phase 1 for a friendly team, item 10 and Phase
2 (done Oct 12, 2026, all but Step 6, the second-person test); its last section, "Owed
after this plan", still stands. `docs/PHASE3-PLAN.md` is current: Phase 3, with the
second-person test alongside.

**Renumbered Oct 13, 2026.** Phase 3 (governed backbone) and Phase 6 (seaLeye for agents)
are new; the old Phases 3, 4 and 5 are now 4, 5 and 7. DESIGN.md entries and the two
PHASE plans written before then use the old numbers (DESIGN.md, "The roadmap gains a
governed backbone and a door for agents"). [BUILD-OUT.md](BUILD-OUT.md) draws each phase.

## Phases

### Phase 0: Foundation (done Oct 8, 2026)

The demo becomes a product repo.

- [x] Demo frozen at tag `demo-2026-10-02`. Repo renamed to `sealeye`.
- [x] One package at the root, split into `cli/`, `api/`, `core/`, with the import
      boundary enforced by a test.
- [x] `deployme` renamed to `sealeye` for everything a developer sees; the old names
      still read for one release (2.17.0).
- [x] `npm test`: nineteen checks, no AWS, no model calls.
- [x] CLAUDE.md for the product; VISION, ROADMAP, OPEN-QUESTIONS.

### Phase 1: Team release

**Goal:** someone other than Greg, on their own machine, can use seaLeye, and the portal
shows what is really there.

**Done when:**
- A second person signs in, runs `sealeye run` in their own app folder against the
  hosted API, and gets a URL.
- seaLeye.online shows that environment from live API data, and they can tear it down
  from either surface.
- Records live in a database, separated by organization and team. Nobody sees another
  team's environments without the rights to.
- `npm test` runs on every push.

*Status Oct 13, 2026:* the second and fourth lines are met. Each team now sees only its
own environments, and an organization-wide token sees every team's (PHASE2-PLAN Step 1).
Each team's environments also have names of their own, so two teams can use the same
app name (Step 2). The second-person test (PHASE2-PLAN Step 6) is ready, and runs
alongside Phase 3 rather than before it (decided Oct 13, 2026); the first and third
lines stay open until it does.

**Work:**
1. **The app reaches the API without a shared disk.** Today `POST /deployments` takes an
   `appPath` on the API's own machine. A hosted API cannot read the developer's laptop,
   so the CLI uploads a snapshot of the folder (or the API reads a connected repo; see
   OPEN-QUESTIONS Q1) and packaging works from that. *Done Oct 10, 2026: the
   interview and the packager each read an uploaded copy, and setting values travel
   with the deploy request (DESIGN.md, "Deployments package an uploaded copy").*
2. **Host the API** behind seaLeye.online (Q2). *Done Oct 10, 2026: the pilot server
   answers at https://api.sealeye.online (DESIGN.md, "One small server in
   ca-central-1"; deploy/README.md).*
3. **Sign-in**: the portal signs in through an identity provider; the CLI gets a
   `sealeye login` that does the same and stores a token in `~/.sealeye/` (Q3). Every
   record carries who did it and from which surface. *Stand-in done Oct 11, 2026: a
   token per person, issued by an administrator, kept by `sealeye login`; every record
   and interview carries the token's person, organization and team (DESIGN.md, "Every
   caller has a token, until sign-in"). The identity provider is Cognito (DESIGN.md,
   "Phase 1: who it is for"); how it replaces tokens is Q16. Deferred past
   PHASE2-PLAN, until more than a handful of people or a bank pilot. Moved to Phase 5
   on Oct 13, 2026.*
4. **A real store**: records move from `~/.sealeye/deployments.json` to a database, with
   organization and team on every record (Q2). *Done Oct 10, 2026: Postgres on the
   server, with nightly backups; organization and team are "default" until sign-in
   fills them (DESIGN.md, "Deployment records live in Postgres").*
5. **AWS access per team**: the API acts in each team's account through a role it
   assumes, not with one person's credentials (Q4). *Designed for, not built: every
   deploy goes through `sealeye-deploy-pilot` in one shared account (DESIGN.md, "Phase
   1: who it is for"). Deferred past PHASE2-PLAN, until a team brings its own account
   or a bank pilot. Moved to Phase 5 on Oct 13, 2026.*
6. **The model key**: the API holds it, not each developer (Q8). *Done Oct 10, 2026:*
   the interview runs in the API as a LangGraph graph, and `sealeye run` streams it
   (DESIGN.md, "The interview runs in the API").
7. **The portal becomes a client**: the mock-up's Environments, Catalog and Control pages
   read from the API for the operations that exist today (Q9). *Done Oct 11, 2026: the
   portal in `portal/` signs in with a session cookie and shows Environments, Control
   and Catalog live, with tear down (DESIGN.md, "The portal is a client of the API").*
8. **CI**: `npm test` on every push and pull request. *Done Oct 10, 2026: GitHub runs
   the tests, with Postgres, on every push and pull request, and builds the server's
   image on main (DESIGN.md, "GitHub tests every change and builds the image").*
9. **Observability**: every interview is a LangFuse trace, joined to the deployment it
   produced and scored on how it turned out (`core/tracing.js`, DESIGN.md "Tracing the
   interview with LangFuse"). It moved to the API with the interview on Oct 10, 2026,
   one trace across the interview's pauses; where an organization's traces live is Q13.
10. **Setting values move to the organization's secret store.** *Done Oct 12, 2026
    (PHASE2-PLAN Part B; DESIGN.md, "Settings live in the organization's store").*
    Until then the command sent an app's setting values from its `.env` with each
    deploy (DESIGN.md, "Setting values travel with the deploy, for now"). Now each
    value lives in the organization's own store, the plan says so, the app reads its
    values when it starts without being modified, and `sealeye settings` and the
    portal's Settings page put values in. The sent-values path stays for dev and the
    sample apps.

### Phase 2: Day-two parity

**Goal:** close the parity table below for everything that exists.

- In the command: `config`, `logs`, `perf`, `costs`, `pause`/`resume`, `catalog`,
  `team`.
- In the portal: New environment, Evidence, Validate, Health and Deploy again are
  built (Oct 12); the needs ledger is in Catalog.
- Each starts as an API endpoint.
- Planned as PHASE2-PLAN Part C. Integrations moved to Phase 5 (D8, Oct 12; Phase 4 before the renumbering), where the
  tools it would connect to are.
- Polish (Oct 12): one change at a time per environment, refused in the API on both
  surfaces; a change under way shown on every page; replaced deploys say so; commands
  take the app's name, or the folder's.

### Phase 3: Governed backbone

Added Oct 13, 2026. **Goal:** every model call, and later every tool and agent call, goes
through one governed door before Phase 4 adds a swarm of agents.

- agentgateway (agentgateway.dev, open source, in the Agentic AI Foundation) on the
  API's network, in front of every model call. `SEALEYE_MODEL_URL` already points the
  interview at it (DESIGN.md, "The model's address is a setting").
- Identity per caller: every model call names its person, team, run and worker, so
  spend and traces say who did it. How it is carried is PHASE3-PLAN D1.
- Spend caps per run and per worker, held by seaLeye itself: the graph counts what each
  run has used and stops it at its cap, and a person is told why. agentgateway has no
  notion of a run; its budget per key and its rate limit are the outer limit behind
  seaLeye's cap (DESIGN.md, "Phase 3, settled after review").
- Routing by task and by data class: the frontier model for plans and rules, a small
  model for bulk reading, and an organization's code only to an endpoint in its own
  account (Claude on Bedrock). Bedrock serves Claude in Canada only through profiles
  that may run inference in other regions, so whether a call stays in Canada is Q18.
- Gateway spans join the run's trace in LangFuse Cloud, as today. Self-hosting
  LangFuse in Canada moves to Phase 4 (DESIGN.md, "Phase 3, settled after review");
  until then tracing stays off for any pilot on real code.
- The gateway logs no request bodies: file names, never contents, as for traces
  (DESIGN.md, "Tracing the interview with LangFuse").
- A deterministic secret scanner (answers Q6; brought forward from Phase 4 on Oct 13,
  2026). A key written into an app's code, not only a secret file, never reaches the
  model, a trace or the gateway: a file with a finding travels as a name only, and the
  developer is told which file and line. The same scanner becomes the discovery swarm's
  first node in Phase 4. Where it runs and what a finding does to a deploy are
  PHASE3-PLAN D3 and D4.

**Done when:** a looping run is stopped by seaLeye's own cap rather than by a person,
and told why; the gateway's budget refuses calls once it is crossed, as the outer limit;
every model call in a trace names its caller and its route; no trace or gateway log
holds file contents.

### Phase 4: Learn the platform

**Goal:** seaLeye builds from the organization's own modules, not only its four.

- Admin onboarding: identity provider, repositories, which automation is strategic.
- The discovery agent is a swarm, built on Phase 3 from the start: a LangGraph
  supervisor fans work out to parallel workers, one module each, gathers their findings,
  and pauses for a platform engineer (`interrupt()`) on anything ambiguous.
- Its first node is the secret scanner built in Phase 3: a file with a finding never
  reaches a model.
- Spend: small models read, the frontier model writes the usage rules; hard caps per run
  and per worker; only modules changed since the last run are read again.
- Where it runs: a new account opened for the prospect or customer, and the run is paid
  (decided Oct 13, 2026).
- LangFuse self-hosted in ca-central-1 (answers Q13; moved here from Phase 3 on Oct 13,
  2026), before the first discovery run reads an organization's code. It needs
  ClickHouse, Redis and blob storage beside Postgres, so it does not share the pilot's
  small server.
- What it learns is the organization's catalog: each module, what it is for, its usage
  rules and what must be refused. The front door agent plans from that catalog. No model
  is fine-tuned.
- Self-test: plans that must be refused, and are. It starts from the interview
  regression set (`npm run eval:interview`): three sample apps, each graded on its
  outcome, building blocks and needs, compared run against run in LangFuse. Phase 4
  grows it to the organization's own apps and modules, and a catalog goes live only
  when it passes.
- The catalog becomes the organization's, and a need becomes buildable when a module
  supports it.
- A second backend: Terraform, since that is what most platform libraries are.
- How the swarm reads the library is Q17.

### Phase 5: The path to production

**Goal:** a developer can ask to promote, and the organization's process decides.

- `sealeye promote` and the Promote button: check what the next stage is missing, then
  request it.
- Approvals through the organization's change tool (ServiceNow first). The interview
  graph waits on an approval as an `interrupt()` held in Postgres, for days if need be.
- Gap tickets from the needs ledger into the platform team's queue (Jira first).
- Notifications where people are (Teams and Slack).
- `sealeye integrations` and its portal page: which of these are connected (moved from
  Phase 2, PHASE2-PLAN D8).
- AWS access per team: the executor assumes a role in each team's account (Phase 1
  item 5, moved here Oct 13, 2026).
- Sign-in through Cognito replaces tokens (Phase 1 item 3 and Q16, moved here Oct 13,
  2026). Both wait on the same thing: a bank pilot.

### Phase 6: seaLeye for agents

Added Oct 13, 2026. **Goal:** a coding agent can ask seaLeye for an environment, and gets
exactly what a developer gets.

- seaLeye's operations (plan, validate, deploy, evidence) as an MCP server behind
  agentgateway: a third client of the same API endpoints, so no operation exists only
  for agents.
- The gateway decides which agent may call which tool. Agent-to-agent traffic (A2A)
  goes through it too.
- The same plan contract, the same human yes, the same evidence, with the agent named on
  the record and in the trace.
- The human yes is a queue in the portal: an agent's plan waits there until a person on
  its team approves or refuses it, and the agent is told which (decided Oct 13, 2026).
- It comes after Phase 5 so an agent gets the whole path, approvals included, not a
  side door to dev.

### Phase 7: Delivery and breadth

- Single-tenant and in-network deployment; a model the organization runs.
- More regions, runtimes and clouds.
- The command on Windows (Q7).

## Parity backlog

`built` works today. `mock-up` is drawn in the archived seaLeye.online with sample data
and does nothing real. A blank is not started.

| Operation | Command | API | CLI | Portal | Phase |
|---|---|---|---|---|---|
| Plan and deploy (interview) | `sealeye run` | `POST /interviews`, `/answers`, `/events`, then deployments | built | built (New environment) | 1 (API), 2 (portal) |
| Deploy an existing plan | `sealeye deploy -f`, or `deploy --again <app> -f` with code the platform has | `POST /deployments` (`fromDeployment`) | built | built (Validate, with code the platform has) | 2 |
| Re-run on a live environment | `sealeye run`, `sealeye deploy --again <app>` | `POST /deployments` (`fromDeployment`) | built | built (Deploy again, in Control) | 2 |
| Validate a plan | `sealeye validate` | `POST /plans/validate` (ready or drafted, with needs) | built | built (Validate) | 2 |
| List environments | `sealeye list` | `GET /deployments` | built | built (Environments) | 1 |
| Status and watch | `sealeye status`, `watch` (an app or an id) | `GET /deployments/{id}`; `step` in `GET /deployments` | built | built (Control, with the change under way across the top) | 1 |
| Tear down | `sealeye destroy` | `DELETE /deployments/{id}` | built | built (Control) | 1 |
| Evidence | `sealeye evidence` | `GET /deployments/{id}/evidence` | built | built (Evidence, in Control) | 2 |
| Needs ledger | `sealeye needs` | `GET /needs` | built | built (in Catalog) | 1 |
| Health check | `sealeye doctor` | `GET /health`, `GET /whoami` | built | built (Health) | 2 |
| Catalog | `sealeye catalog` | `GET /catalog` | built | built | 1 |
| Pause and resume | `sealeye pause`, `resume` | `GET /deployments/{id}/paused`, `POST .../pause`, `.../resume` | built | built (Pause, in Control) | 2 |
| Configure | `sealeye config` (and `sealeye settings`) | `POST /deployments` (`fromDeployment` with the plan changed); the settings endpoints | built | built (Configure and Settings, in Control) | 2 |
| Logs | `sealeye logs` | `GET /deployments/{id}/logs` | built | built (Logs, in Control) | 2 |
| Performance | `sealeye perf` | `GET /deployments/{id}/performance` | built | built (Performance, in Control) | 2 |
| Costs | `sealeye costs` | `GET /costs` (by tag, a day behind) | built | built (Costs) | 2 |
| Team and access | `sealeye team` | `GET /team` (issuing stays with the administrator) | built | built (Team) | 2 |
| Integrations | `sealeye integrations` | | | mock-up (report) | 5 |
| Sign in | `sealeye login` | tokens; `POST /sessions`, `DELETE /sessions` for the portal; `GET /whoami` | built | built (token paste, then a session) | 1 |
| Settings in the secret store | `sealeye settings`, `settings set`, `settings unset` | `GET /apps/{app}/settings`, `PUT` and `DELETE /apps/{app}/settings/{name}` | built | built (Settings, in Control) | 1 (item 10) |
| Onboard and ingest | `sealeye admin ingest` | | | | 4 |
| Promote | `sealeye promote` | | | | 5 |
| Approve an agent's plan | | | | | 6 (a queue in the portal) |
| Raise a gap ticket | `sealeye needs --request` | | prints text only | | 5 |

Command names not yet built are proposals; settle each one in DESIGN.md before
building it.
