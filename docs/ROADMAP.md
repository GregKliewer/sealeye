# seaLeye: roadmap

The phases in order, then the parity backlog: every operation, with where it stands in
the API, the command and the portal. Pick work from the current phase. Update a row in
the same commit as the work that changes it. Questions that block a phase are in
OPEN-QUESTIONS.md.

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

**Work:**
1. **The app reaches the API without a shared disk.** Today `POST /deployments` takes an
   `appPath` on the API's own machine. A hosted API cannot read the developer's laptop,
   so the CLI uploads a snapshot of the folder (or the API reads a connected repo; see
   OPEN-QUESTIONS Q1) and packaging works from that.
2. **Host the API** behind seaLeye.online (Q2).
3. **Sign-in**: the portal signs in through an identity provider; the CLI gets a
   `sealeye login` that does the same and stores a token in `~/.sealeye/` (Q3). Every
   record carries who did it and from which surface.
4. **A real store**: records move from `~/.sealeye/deployments.json` to a database, with
   organization and team on every record (Q2).
5. **AWS access per team**: the API acts in each team's account through a role it
   assumes, not with one person's credentials (Q4).
6. **The model key**: the API holds it, not each developer (Q8).
7. **The portal becomes a client**: the mock-up's Environments, Catalog and Control pages
   read from the API for the operations that exist today (Q9).
8. **CI**: `npm test` on every push and pull request.
9. **Observability**: every interview is a LangFuse trace, joined to the deployment it
   produced and scored on how it turned out (`core/tracing.js`, DESIGN.md "Tracing the
   interview with LangFuse"). Built on the `langfuse-tracing` branch for one machine;
   it moves to the API with the interview (work item 6), and where an organization's
   traces live is Q13.

### Phase 2: Day-two parity

**Goal:** close the parity table below for everything that exists.

- In the command: `config`, `logs`, `perf`, `costs`, `pause`/`resume`, `catalog`,
  `team`, `integrations`.
- In the portal: New environment (the interview), re-run on an existing environment,
  Evidence, the needs ledger, Health.
- Each starts as an API endpoint.

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

### Phase 5: Delivery and breadth

- Single-tenant and in-network deployment; a model the organization runs.
- More regions, runtimes and clouds.
- The command on Windows (Q7).

## Parity backlog

`built` works today. `mock-up` is drawn in the archived seaLeye.online with sample data
and does nothing real. A blank is not started.

| Operation | Command | API | CLI | Portal | Phase |
|---|---|---|---|---|---|
| Plan and deploy (interview) | `sealeye run` | validate + deployments | built | mock-up (button only) | 1 (API), 2 (portal) |
| Deploy an existing plan | `sealeye deploy -f` | `POST /deployments` | built | | 2 |
| Re-run on a live environment | `sealeye run` | `POST /deployments` | built | | 2 |
| Validate a plan | `sealeye validate` | `POST /plans/validate` | built | | 2 |
| List environments | `sealeye list` | `GET /deployments` | built | mock-up | 1 |
| Status and watch | `sealeye status`, `watch` | `GET /deployments/{id}` | built | mock-up | 1 |
| Tear down | `sealeye destroy` | `DELETE /deployments/{id}` | built | mock-up | 1 |
| Evidence | `sealeye evidence` | `GET /deployments/{id}/evidence` | built | | 2 |
| Needs ledger | `sealeye needs` | `GET /needs` | built | mock-up (in Catalog) | 1 |
| Health check | `sealeye doctor` | `GET /health` | built | | 2 |
| Catalog | `sealeye catalog` | | | mock-up | 2 |
| Pause and resume | `sealeye pause`, `resume` | | | mock-up | 2 |
| Configure | `sealeye config` | | | mock-up | 2 |
| Logs | `sealeye logs` | | | mock-up | 2 |
| Performance | `sealeye perf` | | | mock-up | 2 |
| Costs | `sealeye costs` | | | mock-up | 2 |
| Team and access | `sealeye team` | | | mock-up | 2 |
| Integrations | `sealeye integrations` | | | mock-up (report) | 2 |
| Sign in | `sealeye login` | | | | 1 |
| Onboard and ingest | `sealeye admin ingest` | | | | 3 |
| Promote | `sealeye promote` | | | | 4 |
| Raise a gap ticket | `sealeye needs --request` | | prints text only | | 4 |

Command names not yet built are proposals; settle each one in DESIGN.md before
building it.
