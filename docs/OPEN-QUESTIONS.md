# seaLeye: open questions

Decisions not yet made. Each has why it matters, the options, a leaning where there is
one, and what it blocks. When one is answered, record the answer in DESIGN.md with its
date and reason, and delete it from here.

## Blocking Phase 1

### Q13. Where do traces live for an organization?

Every interview can be traced to LangFuse (DESIGN.md, "Tracing the interview with
LangFuse"). A trace holds no file contents, but it does hold a developer's questions
and answers, the plan, the app's name and file names, and who ran it. Today that goes to
LangFuse Cloud in the US region, which is fine for the sample apps in `apps/` and not for
a bank's code: LangFuse Cloud has no Canadian region.

**Options:**
- **LangFuse inside the organization's network.** Keeps everything in-house. Self-hosting
  needs Postgres, ClickHouse, Redis and S3, and LangFuse documents its single-machine
  setup as for testing only, so this is real platform work (roadmap Phase 5,
  "in-network").
- **LangFuse Cloud under a regional or contractual arrangement** the organization's
  risk team accepts.
- **Tracing off.** It is already off whenever LangFuse keys are not set, or with
  `SEALEYE_TRACING=off` (every run) or `sealeye run --no-trace` (one run), and the
  interview works the same without it. The cost is the evaluation it gives: no scores,
  no regression comparisons on real apps.

**Leaning:** tracing off for any pilot with real code until one of the first two is
agreed with the organization, and LangFuse in their network for a bank. Blocks any
Phase 1 pilot on real code with tracing on.

### Q15. Where do an app's setting values come from when the API is hosted?

When the API deploys an app with the config_basic module, it reads each setting's value
from the developer's `.env` in the app folder (`api/executor/compose.js`), and passes
it to the function as a NoEcho parameter. That works while the API runs on the same
machine as the folder. A hosted API has only the upload, and the upload carries `.env`
as an empty name (DESIGN.md, "The interview runs in the API"), so it would deploy with
the plan's placeholders instead.

**Options:**
- **The CLI sends the values of the settings the plan names**, and only those, with the
  deploy request. Used once for the parameters, never stored, never logged. Simple, but
  values leave the laptop, which the upload was designed not to do.
- **Values live in the organization's secret store** (SSM Parameter Store or Secrets
  Manager in the team's account), and the plan names where each is. Nothing secret
  travels through seaLeye; it is more for the developer to set up.
- **A hosted deploy uses the placeholders** until one of the above is decided, and the
  report says which settings were left unset.

**Leaning:** none yet. Blocks Step 9 (a hosted API deploying apps with settings), not
Step 8, whose deploys still read the folder.

## Later

### Q6. How are hardcoded secrets detected during ingestion?

Asked in the dry run, and deferred. **Leaning:** a deterministic scanner (gitleaks or
similar) runs before any file reaches the model, and a file with a finding is never
sent. The model can flag what looks like a secret, but never as the only check. Blocks
Phase 3.

### Q7. Windows

The pitch said yes. Today the CLI assumes a POSIX shell, the AWS CLI on the path, and
macOS notifications. **Leaning:** support it once the interview and packaging run behind
the API, because then the CLI is a thin client with little platform-specific code left.
Phase 5.

### Q10. When does the CLI get published?

Today it is installed with `npm link` from a clone. **Options:** a private npm package;
a public one; a single binary. Matters once anyone outside the repo uses it (Phase 1 if
Q5 is users).

### Q14. Does seaLeye run an AI gateway of its own in front of the API?

Agent Gateway (agentgateway.dev, open source, in the Agentic AI Foundation) could sit on
the server between the API and Anthropic. It would give per-person keys and spending caps,
cost broken down by person (a refused run costs about three times a deployed one), a rate
limit that stops a looping interview, and OpenTelemetry that LangFuse can read. It does not
replace the hand-written trace spans, which follow the interview's steps and decide what a
trace may contain; the gateway only sees individual requests.

**Options:** add it on the pilot server; add it when a second team uses the API; never,
and rely on the organization's own gateway through `SEALEYE_MODEL_URL` (PHASE1-PLAN
Step 8). **Leaning:** not for the pilot, since it is one more part to configure on a single
box. Revisit when a second team uses the API and spend per person matters. Offering
seaLeye's tools as an MCP server behind a gateway is a separate, later idea (Phase 2 or 3).
Blocks nothing in Phase 1.

### Q11. Where do the marketing sites live?

seaLeye.run, seaLeye.online and seaLeye.com are in `archive/`. When the portal becomes
real it should start from the seaLeye.online mock-up's design, but in its own folder.
The two marketing sites may belong in a separate repository.
