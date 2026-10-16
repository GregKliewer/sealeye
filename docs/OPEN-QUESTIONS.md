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

## Before the first customer

### Q21. How strict is "no platform words", and can a developer ask what a term means?

Raised Oct 16, 2026, by Greg, after Juniper Mutual's first draft was refused for "outside
Terraform" in one line: "developers ARE familiar with a lot of the jargon". Principle 8
and the self-test's word check (`core/developer-words.js`) treat every cloud term the
same way. "Lambda" and "CloudFormation" are seaLeye's business, not a developer's, but
"bucket", "subnet", "queue", "log group" and "Terraform" are words many developers use
every day. Blocking them makes catalogs read stiffly and refuses drafts a reviewer would
pass. Greg also asked whether the interview should answer "what does that mean?" when a
platform term overlaps with ordinary developer language.

**Options:**
- **Tiers in the word list.** Product names and the platform's own machinery (Lambda,
  CloudFormation, IAM, ARN, a region's name, sizes and counts) are always refused. Common
  developer vocabulary (bucket, queue, subnet, Terraform, log group) is allowed, and a
  catalog may use it. This is small, in one file, and changes principle 8's wording.
- **Each organization's own list.** The platform engineer marks the terms their
  developers know, in the catalog (`plain_terms`), and the check allows them. This fits
  how organizations differ, but is one more thing to set before a first approval.
- **A glossary the interview can explain from.** Each catalog carries short definitions
  of the terms its modules use, written by discovery and editable like any entry's
  words. A developer can ask "what does that mean?" at any question, and the interview
  answers from the glossary, never from the model's general knowledge. This is the
  larger change: an interview turn that answers rather than asks, inside the
  four-question limit or outside it, and an eval case for it.

**Leaning:** tiers now, since it is a day at most and it ends refusals over words a
reviewer would pass. The glossary later, when the interview is next changed (Phase 4
Step 8), because it needs its own eval cases. Either way it changes principle 8, so it
is a DESIGN.md decision when it is made. It blocks nothing yet: until then, a draft's
words can be edited before approval (`sealeye catalog edit`).

### Q22. How does a platform engineer see what blocks approval, and fix it, in the command line?

Raised Oct 16, 2026, by Greg, after putting Juniper Mutual's catalog 1 right by hand:
the path works, but it is a hard one to follow. Today it takes three commands, and the
person carries what connects them. `sealeye catalog test 1` lists each problem as a
sentence (`secrets: line says Terraform, ...`). They then read the module's name and the
place out of that sentence and work out the field (the place "short line" is the field
`short-line`, the place "input secret_names" is `input:secret_names`). `sealeye catalog
edit 1 secrets` lists every field, with nothing to say which ones fail. Then `sealeye
catalog edit 1 secrets line "..."` changes one field, and the whole self-test prints
again. Only word problems can be fixed this way, and nothing says so: a failed refused,
accepted or shape check has no edit that fixes it.

**Options:**
- **Mark and point.** Smallest. `catalog test` ends with what to do next, one command line
  per field that fails (`sealeye catalog edit 1 secrets line`), and says which problems
  no edit can fix and what can (answering a question, a new run). `catalog edit 1
  secrets` marks the fields that fail. Words come from `core/discovery-words.js`, and the
  portal's Edit words marks the same fields. Half a day.
- **A fix-up walk.** `sealeye catalog fix 1` (a new operation, so a portal page too, by
  parity) goes through each field that fails, one at a time: it shows the module, the
  field, its words now and the words to avoid, and asks for new words, prefilled, as
  `catalog edit` does. Enter keeps the words and moves on. When it is done, it runs the
  self-test and offers to approve. One command from refused to approved. The portal's
  match is a "Fix what blocks approval" view on the Discovery page. A day or two.
- **Fix from the refusal.** `catalog approve 1`, when the self-test fails on words alone,
  asks "Fix these now? [y/N]" and runs the walk above, then tries the approval again. The
  walk's shortest path, but it puts editing inside approving, so `approve` no longer
  only approves.

**Leaning:** mark and point now, since every person who meets a refusal needs it and it
is small. Then the walk, built on it, for the rough-edges step after Step 7. Not the
refusal prompt: one operation, one thing. It blocks nothing: the path today works.

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
