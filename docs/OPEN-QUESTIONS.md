# seaLeye: open questions

Decisions not yet made. Each has why it matters, the options, a leaning where there is
one, and what it blocks. When one is answered, record the answer in DESIGN.md with its
date and reason, and delete it from here.

## Blocking Phase 4

### Q19. How does a discovery run settle what it cannot decide alone?

Discovery (PHASE4-PLAN Step 6) meets things a platform engineer must settle: two
modules that overlap, a usage rule that contradicts a README, a module that may be
deprecated. The plan's first answer (D7) paused the run with `interrupt()` until an
engineer answered, as the interview does. Greg, Oct 14, 2026: a run that waits on a
person stalls until someone notices, so discovery would need watching. Look first at
ways a whole run finishes quickly without pausing.

**Options:**
- **Pause and wait** (D7 as first written). Simple, and the interview already does it;
  but a run is only as fast as the slowest answer, and a worker's context is held open.
- **Finish, and leave the questions on the draft.** The run never pauses. Each question
  becomes an open item on the draft catalog with the evidence and a provisional best
  guess, marked as a guess; the entry it touches cannot go live until it is answered.
  An answer re-runs only the entries it touches. Engineers answer when they like, on
  either surface.
- **Finish, and refuse what is uncertain.** No guesses: an entry with an open question
  is written as not buildable until answered. Safest, and the catalog is smaller at
  first.
- **Rules decided up front.** The platform team states its tie-breaks before a run
  (prefer the newest module, a README outranks a comment); the run applies them and
  lists what it applied. Fewer questions, but only for kinds foreseen.

**Leaning:** the second, with the third's rule for anything that would let a developer
build something no one approved: a provisional guess never goes live. Up-front rules
can be added later to shrink the list. Blocks Step 6, not Part A.

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
