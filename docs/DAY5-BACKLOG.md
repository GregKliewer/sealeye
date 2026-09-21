# Day 5 polish backlog

Items noticed while building and while scoring `sealeye init` (see INIT-SCORING.md), parked so
they do not interrupt the day they came up. Each one is demo-visible; none is a refactor.
Ordered by what the panel would notice. Cut from the bottom if Day 5 runs long.

Scoring context: A/B/D/F all came in at 4 or 5 and need nothing. The two low scores were
**C. Developer experience = 2** and **E. Recommendation clarity = 3**, and items 1 and 2 below
are the whole of that gap.

---

## 1. Show that the platform is working while it waits

**Effort.** ~1.5 h. Small module in `deployme/src/brand.js`, five call sites.

**Why.** The C=2 score. "It is easy to conclude that sealeye is frozen." Correct, and the cause
is not what it looks like. The tool narration is already there: `loop.js` calls `onStep` after
every `list_files` and `read_file`, which is where `Looking at .` and `Reading index.js` come
from. The silence is not between commands, it is *inside* them. Each of those lines is preceded
by a six to ten second model round-trip with nothing on screen, so the gaps sit between lines
that do eventually appear. Adding more lines cannot fix it. Only something moving during the
wait can.

**What.** A spinner that owns the current line and is overwritten by the real line when it
lands:

    ⠋ reading your app  8s          ->  Reading index.js

Requirements:

- Frames rewritten with `\r`, dim palette, no new colours.
- A no-op when `!process.stdout.isTTY`, when `NO_COLOR` is set, or in `--json` mode. Never write
  spinner frames into piped output or a transcript.
- Elapsed seconds after about three seconds, not from zero. A counter that appears only when
  the wait is real is reassuring; one that always runs is noise.
- Cleared properly on Ctrl+C, so the interrupt path still prints a clean line.

Call sites, all currently silent:

1. Between `Reading your app` and the first `onStep` line (the first model turn).
2. Between each tool line and the next (every subsequent model turn).
3. Between the last tool line and the first question appearing.
4. After `Deploy this? y`, while `runDeploy` hands off.
5. The `destroy` poll loop. CloudFormation delete runs about 31 s with almost no step changes.
6. The `watch` poll loop, same reason.

**Keep the tool lines.** A bare spinner would be cheaper and would be a mistake. `Reading
index.js` / `Reading package.json` arriving one at a time is the most persuasive thing in the
whole demo, because the panel watches the agent read the folder rather than taking our word for
it. The spinner fills the gaps between those lines. It does not replace them.

**Done when.** A full `sealeye init` run has no stretch longer than about a second with a static
screen, `sealeye init --json` output is byte-identical to today's, and piping to a file produces
no escape sequences.

---

## 2. Render the decision card from the plan, not from the model's prose

**Effort.** ~2 h. New renderer in `deployme/src/interview/render.js`, one call site in
`bin/deployme`, one section move in `prompts/plan-template.md`.

**Why.** This is both the E=3 score ("the single-paragraph prose readout is a lot of text") and
the other half of C ("I would like to see the deployment plan markdown before saying yes").
They are the same defect. Today the terminal prints the model's free-form `summary` and the
structured plan goes only to a file the developer does not see before deciding. So the wall of
text is the decision surface and the structured artifact is not.

There is a second reason, and it is the one worth saying out loud on Oct 2. Prose from the model
is the model's *description* of what it decided. A card rendered from the validated plan is the
artifact that will actually execute. What the developer approves should be rendered from the
thing that runs, not from the model's account of it. The api-1 and api-2 transcripts prove the
point: identical plans, noticeably different wording, because free-form prose varies run to run
and a renderer does not.

**What.**

- New `decisionCard(plan)` in `render.js`, rendering from the *validated* plan object, roughly
  ten to twelve lines. Group as: what it is, what will run it, what you get back, what is
  switched off. Reuse `module-catalog.yaml` for every word about a module, exactly as the file
  renderer already does, so the card and the file can never describe a module two ways.
- `bin/deployme` prints the card where it currently prints `submission.summary`, then the two
  `Wrote ...` lines, then `Deploy this? [y/N]`.
- The model's prose moves to the Notes section of `DEPLOYMENT_PLAN.md`, where prose belongs.
  It is good writing in the wrong place, not bad writing.
- Assumptions stay visible in the card if there are any. An assumption the developer cannot see
  is one they cannot correct, which is the whole point of showing them.

**Done when.** The card is under fifteen lines, contains no sentence longer than about twenty
words, names every enabled module and every disabled one, and two consecutive runs over the same
app produce identical cards.

---

## 3. `GET /health` on the deployme API

**Effort.** ~20 min.

**Why.** A platform control plane that cannot tell you it is alive is one nobody trusts. Expect
a panel question along the lines of "how would my SRE know this thing is up?" Answering it by
curling a real endpoint beats answering it with a sentence.

**What.** One route in `deployme/src/server.js`, above the `/plans/validate` handler:

    app.get("/health", (_req, res) => {
      res.json({ ok: true, version: pkg.version, deployments: store.count() });
    });

Read `version` from `deployme/package.json`, not a literal. The store count makes the endpoint
prove the persistent store is readable too, not just that Express is listening.

**Done when.** `curl -s localhost:3000/health` returns JSON with `ok: true` and a version, and
an unreachable API still gives the plain "the deployme API is not running" message rather than
`TypeError: fetch failed`.

**Noticed.** Sept 21, when `curl localhost:3000/health` returned an Express 404 page during the
post-restart check. The 404 proved the server was up, which is a confusing way to learn it.

---

## 4. Stop the interview restating itself before a question

**Effort.** ~15 min, prompt only. No code.

**Why.** Not scored, but visible in the static-1 transcript, which asks the same thing twice:

> This is clearly a static site: index.html, about.html, style.css, an images folder, and no
> server code or dependencies anywhere. I see index.html and about.html, with images and
> style.css and no server code. This looks like a static site. Is that right?

`splitQuestion()` puts everything before the final `?` line into the lead and prints it above
the amber prompt, so a model preamble that repeats the lead reads as a stutter. The rule exists
to give a question its context; the model is supplying the context twice.

**What.** One line in the interview rules in `prompts/interview-system.md`, beside the existing
"one question per turn" rule: state what you found once, then ask. Do not summarise your own
observation immediately before the question.

**Done when.** Three runs across the API app and the static app produce no question whose lead
and question say the same thing.

---

## 5. `--answers <file>` for rehearsals

**Effort.** ~45 min.

**Why.** Designed on Day 4 and never built. It does not matter for the definition-of-done run.
It matters on Oct 2, because without it the live demo depends on typing `y` at the right moment
with three people watching, and on the insurance recording being re-shot end to end every time
one line of copy changes.

**What.** `sealeye init --answers rehearsal.txt` feeds one line per question in order, still
printing questions and answers exactly as a live run does, so a rehearsal recording is
indistinguishable from a hand-typed one. Falls back to the terminal if the file runs out of
lines. Never usable for the `Deploy this?` boundary: that one stays a human keystroke, because
a demo that deploys without anyone approving it is a different and much worse demo.

**Done when.** A recorded `--answers` run and a hand-typed run produce the same transcript.

---

## Not doing: refactoring DEPLOYMENT_PLAN.md

The INIT-SCORING note asks whether the plan document is too busy to decide from, and whether it
should be refactored. It is not, and it should not.

Six sections, module inputs, what-will-be-created: that is the right shape for a record the
developer keeps, commits, and hands to whoever asks what this environment is. It reads as busy
today only because it is being asked to be the decision surface, which it was never shaped for.
Once item 2 exists, the file's job is the thing you keep and its density becomes a virtue.

Two surfaces, two jobs. Revisit only if the card lands and the file still feels wrong.

## Not an issue: the missing "Wrote ..." lines in static-1

The static-1 transcript shows no `Wrote ...` lines where api-1 and api-2 both do. The code path
is shared: `bin/deployme` calls `writeInterviewFiles()` and prints both lines after the
interview submits, with no branch on which core module was chosen. Almost certainly trimmed when
the transcript was pasted. Worth one glance on the next static run, not worth investigating.
