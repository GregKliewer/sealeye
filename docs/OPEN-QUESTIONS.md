# seaLeye: open questions

Decisions not yet made. Each has why it matters, the options, a leaning where there is
one, and what it blocks. When one is answered, record the answer in DESIGN.md with its
date and reason, and delete it from here.

## Blocking Phase 1

### Q5. Who is the "wider team" for the first release?

**Why it matters:** it decides what Phase 1 must include. Engineers joining to build
seaLeye need a repo that sets up in minutes and good tests. Developers joining to use it
need a hosted API, sign-in and their own AWS access.

**Options:** (a) collaborators building seaLeye with you; (b) a pilot group using it to
deploy their apps; (c) both, in that order.

**Leaning:** (c). Phase 1 as written assumes users.

### Q1. Where does the API get the app from?

**Why it matters:** today `POST /deployments` takes a folder path on the API's own
machine. That stops working the moment the API is hosted, and the portal's "New
environment" has no folder at all.

**Options:**
- (a) The CLI uploads a snapshot of the folder; the portal accepts an upload.
- (b) The API reads the app from a connected Git repository and branch, for both.
- (c) Both: upload from the CLI, repository for the portal.

**Leaning:** (c) now, (b) later. Upload keeps today's "run it in your folder" promise;
a repository is what the portal and promotions will need anyway.

**Blocks:** Phase 1 work item 1.

### Q2. Where does the hosted API run, and on what store?

**Options:** a container service or Lambda in your own AWS account; a managed platform
(Fly, Render, Railway). Store: Postgres (RDS or managed), or DynamoDB.

**Leaning:** your AWS account, ca-central-1, a container service and Postgres. It keeps
everything in one account and one region, and the executor already shells out to the AWS
CLI, which suits a container better than Lambda.

### Q3. How do people sign in?

**Options:** GitHub OAuth (fast, and developers have it); Google; Amazon Cognito (can
front a bank's SAML later); an identity service such as Auth0 or WorkOS.

**Leaning:** something that speaks SAML and OIDC from the start, because every bank will
ask for its own identity provider. The CLI signs in through the browser and keeps a
token.

### Q4. Whose AWS account does a deployment land in?

**Options:** one shared seaLeye account for everyone (simplest, fine for a pilot); a
role in each team's own account that the API assumes (what a bank will require).

**Leaning:** design for (b), start with (a) and one team.

### Q8. Whose model key?

Today each developer needs ANTHROPIC_API_KEY. The vision prices model costs into the
product. **Leaning:** the interview runs behind the API with the API's key, and the CLI
streams it. That also keeps the system prompt off developers' machines.

### Q9. What is the portal built with?

Today it is static HTML with each page's data inlined as JSON. **Options:** keep it
plain (HTML, CSS, a little JavaScript fetching the API); a framework (React, Svelte).
**Leaning:** stay plain until a page needs real interaction (the interview will), then
decide. Whatever it is, it uses `brand/BRAND-ONLINE.md` and only the API.

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

### Q12. Provenance of the earliest code

The first commit resurrected May 2026 proof-of-concept code. Its documents were removed
from history on Oct 8. Before seaLeye is offered beyond you, confirm the code itself is
yours to share.
