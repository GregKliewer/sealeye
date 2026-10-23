# Second-person test: what to watch for

PHASE2-PLAN Step 6 (PHASE1-PLAN Step 15). One page, filled in while you watch. Watch;
do not help. When they are stuck, note what they tried before you say anything, and
say as little as gets them moving.

**Tester:** ______________  **Team:** ______________  **Date:** __________
**Machine:** Mac / Linux, Node ______  **Started at:** ______

## Time to each milestone

| Milestone | Clock time | Notes |
|---|---|---|
| Installed (`sealeye --help` works) | | |
| Signed in (`sealeye login` says their name and team) | | |
| First question from the interview | | |
| Plan shown | | |
| Said yes | | |
| Address works in a browser | | |
| Static site deployed | | |
| Refusal seen (`payment-events-processor`) | | |
| Signed in to sealeye.online, environments shown | | |
| Torn down from the website | | |
| Torn down from the command line | | |

## While they work

**Hesitated, reread, or asked** (step, and their exact words):

-
-
-

**Messages that were wrong, unclear, or used a word a developer would not use**
(command or page, and the words):

-
-

**Did they read the plan before saying yes?** Yes / skimmed / no. What did they say
about it?

**Did they trust it?** What would they want to see before using it on their own app?

**The refusal:** did it read as a refusal with a reason, or as an error?

**What they expected the website to do that it does not:**

-
-

## After

- Deployment ids (`sealeye list --deployments --all`, since torn-down and drafted ones
  are hidden without `--all`), and interview ids (`int_...`, the run column of
  `deploy/server.sh gateway-calls <their email>`):
- LangFuse traces for their runs (sample apps only, so tracing stays on):
- Their one-sentence verdict, in their words:
- **Phase 1 met?** They ran `sealeye run`, got an address, saw it on sealeye.online,
  and tore it down from the website, on their own machine, with only the token and the
  installer. Yes / no, and what was missing:

Then: fix what blocked them, add the rest to `docs/ROADMAP.md`, and date the Phase 1
"done when" lines there.
