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

### Q16. How does Cognito sign-in replace tokens?

Cognito was chosen for sign-in on Oct 9, 2026 (DESIGN.md, "Phase 1: who it is for").
Until it is built, each person has a token issued by the administrator, and the portal
trades it for a session (DESIGN.md, "Every caller has a token, until sign-in"). Still to
decide: how `sealeye login` signs in through the browser and what it keeps; whether
tokens survive for automation; how a person's team and an organization-wide scope
(PHASE2-PLAN D1) come from Cognito groups; and how existing token holders move over.
**Leaning:** its own plan, once seaLeye goes past a handful of people or to a bank.
Deferred past PHASE2-PLAN. Blocks a wider pilot, not the friendly team.

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
