# seaLeye: roadmap

The phases in order, then the parity backlog: every operation, with where it stands in
the API, the command and the portal. Pick work from the current phase. Update a row in
the same commit as the work that changes it. Questions that block a phase are in
OPEN-QUESTIONS.md.

**Plans.** `docs/PHASE1-PLAN.md` built Phase 1 up to the second-person test (done Oct
11, 2026). `docs/PHASE2-PLAN.md` is current: it finishes Phase 1 for a friendly team
(Part A), builds item 10 (Part B), then Phase 2 (Part C). What it leaves for later, and
what brings each item forward, is its last section, "Owed after this plan".

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

*Status Oct 11, 2026:* the second and fourth lines are met. Each team now sees only its
own environments, and an organization-wide token sees every team's (PHASE2-PLAN Step 1).
Each team's environments also have names of their own, so two teams can use the same
app name (Step 2). Step 6, the second-person test, is ready and deferred: Greg runs it
later, and the first and third lines stay open until he does.

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
   PHASE2-PLAN, until more than a handful of people or a bank pilot.*
4. **A real store**: records move from `~/.sealeye/deployments.json` to a database, with
   organization and team on every record (Q2). *Done Oct 10, 2026: Postgres on the
   server, with nightly backups; organization and team are "default" until sign-in
   fills them (DESIGN.md, "Deployment records live in Postgres").*
5. **AWS access per team**: the API acts in each team's account through a role it
   assumes, not with one person's credentials (Q4). *Designed for, not built: every
   deploy goes through `sealeye-deploy-pilot` in one shared account (DESIGN.md, "Phase
   1: who it is for"). Deferred past PHASE2-PLAN, until a team brings its own account
   or a bank pilot.*
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
    (PHASE2-PLAN Part B; DESIGN.md, "Settings live in the organization's store"). The
    plan contract did not change: the platform asks the store at deploy time.* Decided Oct 10,
    2026 (DESIGN.md, "Setting values travel with the deploy, for now"): for now the CLI
    sends an app's setting values from its `.env` with each deploy. A bank will want
    them in its own secret store instead, with nothing secret passing through seaLeye.
    About three to five days:
    - the plan names where each value lives (a contract change, so a new planVersion,
      a prompt change and `npm run eval:interview`);
    - the injected `run.sh` reads the values from the store when the app starts, so
      the app is still not modified;
    - the function may read only its own entries, and the deploy role reads them in
      the team's own account;
    - `sealeye secrets set`, an endpoint and a portal page (parity) put values in, and
      the first deploy of an app offers to store what its `.env` holds;
    - `sealeye run` says once that deployed settings come from the store, not `.env`;
    - apps already deployed with sent values are moved: the records with a `sent` or
      `.env` setting source are the list.
    The sent-values path stays for dev and the sample apps. **Due before any pilot that
    deploys an organization's real secrets.** Planned as PHASE2-PLAN Part B, before
    Phase 2, so the portal's re-run, interview and Configure are built on the store.

### Phase 2: Day-two parity

**Goal:** close the parity table below for everything that exists.

- In the command: `config`, `logs`, `perf`, `costs`, `pause`/`resume`, `catalog`,
  `team`.
- In the portal: New environment (the interview), re-run on an existing environment,
  Evidence, the needs ledger, Health.
- Each starts as an API endpoint.
- Planned as PHASE2-PLAN Part C. Integrations moved to Phase 4 (D8, Oct 12), where the
  tools it would connect to are.

### Phase 3: Learn the platform

**Goal:** seaLeye builds from the organization's own modules, not only its four.

- Admin onboarding: identity provider, repositories, which automation is strategic.
- The discovery agent: ingest modules and pipelines, stop on hardcoded secrets (Q6),
  flag ambiguity for a person.
- Self-test: plans that must be refused, and are. It starts from the interview
  regression set (`npm run eval:interview`): three sample apps, each graded on its
  outcome, building blocks and needs, compared run against run in LangFuse. Phase 3
  grows it to the organization's own apps and modules.
- The catalog becomes the organization's, and a need becomes buildable when a module
  supports it.
- A second backend: Terraform, since that is what most platform libraries are.

### Phase 4: The path to production

**Goal:** a developer can ask to promote, and the organization's process decides.

- `sealeye promote` and the Promote button: check what the next stage is missing, then
  request it.
- Approvals through the organization's change tool (ServiceNow first).
- Gap tickets from the needs ledger into the platform team's queue (Jira first).
- Notifications where people are (Teams and Slack).
- `sealeye integrations` and its portal page: which of these are connected (moved from
  Phase 2, PHASE2-PLAN D8).

### Phase 5: Delivery and breadth

- Single-tenant and in-network deployment; a model the organization runs.
- More regions, runtimes and clouds.
- The command on Windows (Q7).

## Parity backlog

`built` works today. `mock-up` is drawn in the archived seaLeye.online with sample data
and does nothing real. A blank is not started.

| Operation | Command | API | CLI | Portal | Phase |
|---|---|---|---|---|---|
| Plan and deploy (interview) | `sealeye run` | `POST /interviews`, `/answers`, `/events`, then deployments | built | mock-up (button only) | 1 (API), 2 (portal) |
| Deploy an existing plan | `sealeye deploy -f` | `POST /deployments` | built | | 2 |
| Re-run on a live environment | `sealeye run` | `POST /deployments` | built | | 2 |
| Validate a plan | `sealeye validate` | `POST /plans/validate` | built | | 2 |
| List environments | `sealeye list` | `GET /deployments` | built | built (Environments) | 1 |
| Status and watch | `sealeye status`, `watch` | `GET /deployments/{id}` | built | built (Control) | 1 |
| Tear down | `sealeye destroy` | `DELETE /deployments/{id}` | built | built (Control) | 1 |
| Evidence | `sealeye evidence` | `GET /deployments/{id}/evidence` | built | | 2 |
| Needs ledger | `sealeye needs` | `GET /needs` | built | built (in Catalog) | 1 |
| Health check | `sealeye doctor` | `GET /health` | built | | 2 |
| Catalog | `sealeye catalog` | `GET /catalog` | built | built | 1 |
| Pause and resume | `sealeye pause`, `resume` | | | mock-up | 2 |
| Configure | `sealeye config` | | | mock-up | 2 |
| Logs | `sealeye logs` | | | mock-up | 2 |
| Performance | `sealeye perf` | | | mock-up | 2 |
| Costs | `sealeye costs` | | | mock-up | 2 |
| Team and access | `sealeye team` | | | mock-up | 2 |
| Integrations | `sealeye integrations` | | | mock-up (report) | 4 |
| Sign in | `sealeye login` | tokens; `POST /sessions`, `DELETE /sessions` for the portal; `GET /whoami` | built | built (token paste, then a session) | 1 |
| Settings in the secret store | `sealeye settings`, `settings set`, `settings unset` | `GET /apps/{app}/settings`, `PUT` and `DELETE /apps/{app}/settings/{name}` | built | built (Settings, in Control) | 1 (item 10) |
| Onboard and ingest | `sealeye admin ingest` | | | | 3 |
| Promote | `sealeye promote` | | | | 4 |
| Raise a gap ticket | `sealeye needs --request` | | prints text only | | 4 |

Command names not yet built are proposals; settle each one in DESIGN.md before
building it.
