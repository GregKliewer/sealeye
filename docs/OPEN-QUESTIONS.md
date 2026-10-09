# seaLeye: open questions

Decisions not yet made. Each has why it matters, the options, a leaning where there is
one, and what it blocks. When one is answered, record the answer in DESIGN.md with its
date and reason, and delete it from here.

## Blocking Phase 1

### Q12. Provenance of the earliest code

The first commit resurrected May 2026 proof-of-concept code. Its documents were removed
from history on Oct 8. Before seaLeye is offered beyond you, confirm the code itself is
yours to share.

**Now blocking:** A5 brings collaborators into the repo, so this is answered before
anyone else is invited.

### Q8. Whose model key?

Today each developer needs ANTHROPIC_API_KEY. The vision prices model costs into the
product. **Leaning:** the interview runs behind the API with the API's key, and the CLI
streams it. That also keeps the system prompt off developers' machines.

A8: Model calls move behind the API, including ANTHROPIC_API_KEY and any other configs needed to run model calls.

### Q9. What is the portal built with?

Today it is static HTML with each page's data inlined as JSON. **Options:** keep it
plain (HTML, CSS, a little JavaScript fetching the API); a framework (React, Svelte).
**Leaning:** stay plain until a page needs real interaction (the interview will), then
decide. Whatever it is, it uses `brand/BRAND-ONLINE.md` and only the API.

A9: React + TypeScript, built with Vite into plain static files, plus shadcn/ui for
buttons, tables and forms, plus Playwright tests.

- **Why React:** coding agents write it most reliably, because there is more React code
  than any other framework's. The interview page, with streamed progress, questions and
  answers, is the kind of live page React handles well.
- **Why TypeScript:** when an agent's change breaks how data flows between pages, or calls
  an API field that doesn't exist, the build fails with a clear error, without anyone
  reading the code.
- **Why Vite and static files:** no second server. Caddy serves the built files from the
  same machine as the API (A2), and the portal talks only to the API.
- **shadcn/ui:** its components are copied into the repo, not installed as a dependency,
  and they take their colours and type from `brand/BRAND-ONLINE.md`.
- **Playwright:** tests that pages load and work, so an agent can check its own change
  before it is merged. They run in CI next to `npm test`.
- **Starting point:** the archived seaLeye.online mock-up (`archive/sealeye-online/`) is
  the design reference. Rebuild it in `portal/`; don't copy its HTML.
- **Not chosen:** Next.js (a second server, or Vercel hosting), Svelte and Vue (agents
  have less to draw on, and Svelte 5 changed its syntax), staying plain (the interview
  page would mean a rewrite).
- **Cost:** $0. All of it is open source, and hosting adds nothing to the A2 server.

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
