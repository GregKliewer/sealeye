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

### Q11. Where do the marketing sites live?

seaLeye.run, seaLeye.online and seaLeye.com are in `archive/`. When the portal becomes
real it should start from the seaLeye.online mock-up's design, but in its own folder.
The two marketing sites may belong in a separate repository.
