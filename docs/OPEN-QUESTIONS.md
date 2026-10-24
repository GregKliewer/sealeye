# seaLeye: open questions

Decisions not yet made. Each has why it matters, the options, a leaning where there is
one, and what it blocks. When one is answered, record the answer in DESIGN.md with its
date and reason, and delete it from here.

## Blocking Phase 5, or a wider pilot

### Q16. How does Cognito sign-in replace tokens?

Cognito was chosen for sign-in on Oct 9, 2026 (DESIGN.md, "Phase 1: who it is for").
Until it is built, each person has a token issued by the administrator, and the portal
trades it for a session (DESIGN.md, "Every caller has a token, until sign-in"; "The
portal signs in with a session cookie"). Still to decide: how `sealeye login` signs in
through the browser and what it keeps; whether tokens survive for automation; how a
person's team and an organization-wide scope (PHASE2-PLAN D1) come from Cognito groups;
how existing token holders move over; and whether the person who approves a catalog may
be the one who started its discovery run (DESIGN.md, "A catalog goes live through a
self-test, approved and made live apart").
**Leaning:** its own plan, once seaLeye goes past a handful of people or to a bank.
Moved to Phase 5 on Oct 13, 2026. PHASE5-PLAN Part E plans it, waiting on a bank pilot;
nothing is built. Blocks a wider pilot, not the friendly team or the rest of Phase 5.

### Q25. How does an organization's pipeline get what to build a stage from?

Raised Oct 24, 2026, when seaLeye was widened to every stage (DESIGN.md, "seaLeye builds
every stage, the way the organization chose for each"). Where a stage is applied by the
organization's own pipeline (PHASE5-PLAN 5b), the pipeline needs the stage's root module
(the plan resolved for that stage, its modules at their releases, the stage's values)
and the package. seaLeye does not know an app's repository today: an app reaches it as
an uploaded folder. Juniper Mutual's library keeps each stage's root module in the app's
repository, under `stages/<stage>/`.

**Options:**
- **A pull request into the app's repository**, which the team merges before the run.
  The root module lives in version control, as many auditors expect, and the developer's
  code is changed only by the team's own merge. But seaLeye must learn each app's
  repository and be allowed to open pull requests there, and the run waits on a merge.
- **An artifact handed to the run.** seaLeye writes the root module and the package's
  checksum to a place the run fetches from (named in its inputs, readable only with a
  short-lived credential), and keeps it on the promotion's record. Nothing touches the
  app's repository; the record, not the repository, is the history.
- **The run asks seaLeye for it.** The pipeline's first step calls the API with the
  promotion's id and gets the root module. Close to the third way (the pipeline calling
  seaLeye's executor), and needs a token for the pipeline.

**Leaning:** none yet (Greg, Oct 24: to discuss while the plan is revised). The artifact
keeps principle 5 whole and needs no repository; a pull request is likely what a
strong platform's auditors ask for. Blocks PHASE5-PLAN Step 12 (5b), not 5a.

## Later

### Q7. Windows

The pitch said yes. Today the command talks to the hosted API and needs only Node.js;
it needs the AWS CLI, zip and rsync only against a local API, and the notice when a
deploy finishes is macOS only. The interview and packaging already run behind the API,
so what is left is the installer (a POSIX shell script) and notifications. Phase 7.

### Q10. When does the CLI get published?

Today it is installed from seaLeye.run (`curl -fsSL https://sealeye.run/install | sh`),
which unpacks the package that site serves into `~/.sealeye/command/<version>`,
installs it there with `npm ci` from the tested lock file, and puts that folder on the
PATH with npm. That is enough for the friendly team. **Options:** keep that; a public npm package; a single binary. Matters
once people outside a friendly team install it.

### Q11. Do the archived marketing sites leave the repository?

seaLeye.run's and seaLeye.org's pages are in `sites/` (DESIGN.md, "Each domain has one
job") and the portal is in `portal/`. The demo's seaLeye.run, seaLeye.online and
seaLeye.com sites remain in `archive/`, read-only. **Leaning:** keep them there as the
record of the demo.

### Q24. Do Configure and Performance keep commands of other names?

The portal's Configure is `sealeye config` and its Performance is `sealeye perf`.
Principle 1 asks for one name; a label and a command may differ only where one names a
page and the other an action, and these two pairs were left for Greg on Oct 14, 2026
(DESIGN.md, "One list of words for both surfaces"). **Options:** rename the labels;
rename the commands, keeping the old ones as hidden aliases; or record both as allowed
exceptions. Blocks nothing; renaming is one edit in `core/operations.js`.
