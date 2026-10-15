# seaLeye: open questions

Decisions not yet made. Each has why it matters, the options, a leaning where there is
one, and what it blocks. When one is answered, record the answer in DESIGN.md with its
date and reason, and delete it from here.

## Blocking Phase 5

### Q16. How does Cognito sign-in replace tokens?

Cognito was chosen for sign-in on Oct 9, 2026 (DESIGN.md, "Phase 1: who it is for").
Until it is built, each person has a token issued by the administrator, and the portal
trades it for a session (DESIGN.md, "Every caller has a token, until sign-in"). Still to
decide: how `sealeye login` signs in through the browser and what it keeps; whether
tokens survive for automation; how a person's team and an organization-wide scope
(PHASE2-PLAN D1) come from Cognito groups; and how existing token holders move over.
**Leaning:** its own plan, once seaLeye goes past a handful of people or to a bank.
Moved to Phase 5 on Oct 13, 2026. Blocks a wider pilot, not the friendly team.

### Q20. How does a plan name a different module for a later stage?

Raised Oct 15, 2026, building the made-up organization (PHASE4-PLAN Step 4). A plan names
one set of modules, and its profile says which patterns later stages apply to them. Real
libraries also change the module itself on the way to production: Juniper Mutual's
`postgres` is for dev, sit and uat only, and from staging up the same app's database is
a `postgres-cluster`, which takes the same inputs. Today's contract cannot say that, so
a plan written in dev is either wrong for production or not buildable in dev.

**Options:**
- **One module per need, a stage map in the catalog.** The plan names what the app
  needs ("a relational database") and the catalog says which module serves it at each
  stage. Plans stay short and stage-free; the catalog carries the rule, which is where
  the platform team wrote it.
- **Modules per stage in the plan.** A plan lists, for each module, which stages it is
  for. Explicit and reviewable, but every plan repeats the platform team's rule, and a
  rule that changes means every plan changes.
- **A plan per stage.** Promotion writes the next stage's plan from the last one. Each
  plan stays as simple as today's, but a developer's one plan becomes several, and
  what was approved in dev is no longer what reaches production word for word.

**Leaning:** the first: the rule is the platform team's, and it belongs in their
catalog; the plan the developer approved stays the plan that is promoted. It changes
the plan contract, so it is a DESIGN.md decision when it is made. Blocks Phase 5
(`sealeye promote`), not Phase 4: until then, plans are for dev.

## Later

### Q7. Windows

The pitch said yes. Today the CLI assumes a POSIX shell, the AWS CLI on the path, and
macOS notifications. **Leaning:** support it once the interview and packaging run behind
the API, because then the CLI is a thin client with little platform-specific code left.
Phase 7.

### Q10. When does the CLI get published?

Today it is installed from seaLeye.run (`curl -fsSL https://sealeye.run/install | sh`),
which runs `npm install -g` on a package that site serves. That is enough for the
friendly team. **Options:** keep that; a public npm package; a single binary. Matters
once people outside a friendly team install it.

### Q11. Where do the marketing sites live?

seaLeye.run, seaLeye.online and seaLeye.com are in `archive/`. When the portal becomes
real it should start from the seaLeye.online mock-up's design, but in its own folder.
The two marketing sites may belong in a separate repository.
