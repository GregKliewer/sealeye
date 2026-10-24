#!/usr/bin/env bash
#
# seaLeye.run panel demo -- scripted with demo-magic
#
# HOW TO RUN
#   cd ~/dev/deployme-demo/qa/demo-magic
#   bash demo.sh
#
# HOW IT BEHAVES
#   Each command below types itself out, then waits for Enter, then waits
#   for Enter again before it actually runs. Two key presses per line: one
#   to reveal, one to commit. Nothing here is faked, it is the real sealeye
#   CLI, for real.
#
#   demo-magic only controls the TERMINAL. It knows nothing about VS Code
#   or the browser. Use the cue list below, read it before you start, not
#   during, to know when to alt-tab away and back on your own.
#
#   The moment a line launches sealeye itself, demo-magic steps out of the
#   way completely. sealeye own questions, like What is this for, or
#   Deploy this y or N, are real prompts waiting on your real keyboard.
#   Type an actual answer, then Enter once. Do not reflexively double
#   Enter through those the way you do on the scripted lines above them.
#   A blank Enter reads as a blank answer and sealeye just stops.
#
# CUE LIST, not shown on screen, know these going in
#   1. After the first sealeye run hands back control: switch to VS Code,
#      show index.js and DEPLOYMENT_PLAN.md, then come back.
#   2. After the URL shows up in sealeye list: switch to the browser and
#      hit the live endpoint, e.g.
#        https://ID.execute-api.ca-central-1.amazonaws.com/beneficiaries/BEN-4417-2298
#   3. Before the second sealeye run in Act 1: make the code change first,
#      so the app reads PAYMENTS_SOR_URL and CACHE_MAX_AGE_MINUTES. Then run
#      it. When it asks, a plan already exists, reuse it r, start over s,
#      answer s so it picks up the change. Expect about 40 seconds of the
#      model working before the plan appears, so have something to say.
#   4. On sealeye run team-context in Act 2: answer prod to the what is
#      this for question, y to the plan, skip at the ticket prompt.
#   5. After that: switch to the browser, sealeye.online, Environments,
#      click Cindy payment-events-processor row, PLAT-1042 detail.
#
###############################################################################

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/demo-magic.sh"

# ---- demo-magic options ----
TYPE_SPEED=20
NO_WAIT=false
PROMPT_TIMEOUT=0
DEMO_PROMPT="${GREEN}==> ${CYAN}\W${COLOR_RESET} $ "
DEMO_COMMENT_COLOR=$GREY

APP1=~/dev/deployme-demo/qa/beneficiary-lookup-api
APP2=~/dev/deployme-demo/qa/payment-events-processor

clear

###############################################################################
# ACT 1 -- beneficiary-lookup-api: happy path, background deploy
###############################################################################

pe "cd $APP1"
pe "ls"

# sealeye run -- answer the plan is headed to production, y to plan.
# then switch to VS Code, cue 1
pe "sealeye run"

pe "code ."
pe "sealeye list"
pe "sealeye list"

# switch to browser and hit the live URL, cue 2

# free-typing breakpoint, run anything you want here, type exit to continue
repl

# make the code change first, then re-run, answer s, cue 3
pe "sealeye run"

###############################################################################
# ACT 2 -- payment-events-processor: refusal, team-context, dashboard
###############################################################################

pe "cd $APP2"
pe "ls"

# answer prod, y, then skip at the ticket prompt, cue 4
pe "sealeye run --team-context"

# free-typing breakpoint, same idea as above, type exit to continue
repl

# switch to browser, sealeye.online, Cindy ticket, cue 5
