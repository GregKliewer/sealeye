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

## 6. One row per environment, not one row per deploy

**Effort.** ~60 min. `bin/deployme` (list, destroy), `src/server.js` (the destroy completion
path). No change to the contract, the executor or the store's shape.

**Why.** Found on Sept 21 during the Step 5 runs. Three deployments of
`beneficiary-lookup-api` produced three rows in `sealeye list`, all `succeeded`, all with the
same URL. They are not three environments. They are one environment and three deployment
events: the stack is named `sealeye-<app>`, so the second and third runs updated the stack the
first one created. CloudFormation agrees, created 16:32:22 and updated 16:45:15.

The underlying behaviour is correct and worth keeping. A developer who ships the same app twice
should get the same URL both times; a platform that hands out a new address on every deploy is
one nobody can put in a config file. What is wrong is the reporting. That table tells a
developer they have three things running and three things to tear down, and they have one of
each.

There is a live failure behind it. `startDestroy` only ever touches the record it was given;
nothing updates the siblings sharing a `stackName`. Destroy one and the other two still read
`succeeded` with a URL that now 404s. The second destroy recovers gracefully, because the
executor checks `describe(stackName)` first and reports the stack already gone, so nothing
crashes. But between the two destroys the list is showing live environments that do not exist,
and that window is exactly when a list gets put on screen. CLAUDE.md says never fake a
transition. A row that says `succeeded` about a stack that was deleted is the same offence in a
different place.

**The real gap is a missing noun.** There are deployments and there are no environments. The
environment is the thing that exists, holds the URL and costs money; the deployment is the
event that created or changed it. One environment, many deployments. Heroku has apps and
releases, Vercel has projects and deployments, Kubernetes has deployments and rollouts. seaLeye
collapses both into one record, which is why the list cannot tell the truth.

**Scope: fix the reporting, not the model.** Introducing a real environment entity means a
second store, ids, and a migration, and it is not a sensible thing to start eleven days before
the panel. Group the view by `stackName`, make destroy honest about siblings, and keep the
record shape exactly as it is. The full noun is a talking point for Day 6, not a build item:
"the shipping version separates environments from deployments, and here is why" is a stronger
line than half of it built.

**What.**

- `sealeye list` groups by `stackName` and prints one row per environment: app, status, URL,
  deploy count, last deployed. The environment's status and URL come from its most recent
  deployment.
- `sealeye list --deployments` prints today's flat per-deployment view, unchanged. `--all`
  keeps its current meaning, include torn-down, and composes with both.
- When a destroy completes, every other record sharing that `stackName` is marked destroyed
  too, with a note naming the deployment that tore it down. Traceable, not silently rewritten.
- `sealeye destroy` accepts an app or stack name as well as a deployment id. Typing
  `sealeye destroy beneficiary-lookup-api` in front of three people beats pasting a hex string,
  and it is the argument that matches how the developer thinks about what they are deleting.

**Done when.** Three deploys of one app show one row in `sealeye list` and three in
`sealeye list --deployments`; one destroy leaves no row anywhere claiming `succeeded` for that
stack; `sealeye destroy <app-name>` works; and `sealeye list --all` still shows the history.

**The demo value.** This converts the worst moment in the run into one of the best. "Why do
those three rows have the same URL?" gets answered with: this platform updates in place, so
your address is stable across deploys, and here is the environment view that says so. That is a
platform answer to a platform question, and it is the question the infrastructure person on the
panel is most likely to ask.

## 7. `sealeye init` on an app that already has a live environment

**Effort.** Three separable pieces, in order. Estimates are at the recalibrated rate (about a
quarter of the original novice estimates, per Sept 21): 7a about 15 min, 7b about 30 min, 7c
about 15 min. Stop after any of them and the tool is still better than it was.

**Why.** Right now `sealeye init` on an app with a live environment silently modifies a running
service. A developer who believes they are creating something and is in fact changing what is
live is the worst failure mode a platform has. Item 6 made `list` honest about this; `init` is
where it actually costs something, so leaving it silent there would be strange.

**7a. The notice, before the interview starts.** Right after the banner, before "Reading your
app", look in the store for a live environment whose `stackName` is `sealeye-<app>`. If there
is one, say so and ask before spending the developer's time on questions:

    beneficiary-lookup-api already has a live environment.
      https://dorduygli3.execute-api.ca-central-1.amazonaws.com
      deployed 12 minutes ago, running http_api_serverless and observability_basic
    This run will update that environment. It will not create a second one.
    ? Continue? [y/N]

N exits with nothing written. The URL and the modules are read from the store, never guessed.
The app name comes from `package.json` (or the folder name for a static site), matched to
`stackName` the same way `destroy` resolves names in item 6.

**7b. The decision card becomes a diff.** When an environment exists, `decisionCard()` takes
the deployed plan as well as the new one, and every line is marked unchanged, changed, new or
removed, in the dim / accent / prompt colours already in `brand.js`. The heading changes from
"We will provision this infrastructure to run it" to "We will change this environment". When
nothing differs, the whole middle group collapses to one line:

    Nothing changes. Your environment already matches this plan; deploying updates your code only.

This is `terraform plan` / `cdk diff` / `kubectl diff` in the developer's language, and it is
the strongest second-run moment available: a card that says "nothing changes" proves the
platform knows what it already did. It also replaces the "tell them what is active, then tell
them what is recommended" shape with one surface, so the developer reads what changes instead
of computing it in their head.

Requires storing the plan on the deployment record (`plan` alongside `resolvedModules` in the
`POST /deployments` handler). Additive; old records without a `plan` field diff on
`resolvedModules` only, at module level, and say so in one dim line.

**7c. Fewer questions on a redeploy.** Pass the deployed plan into the interview as context,
after the folder digest: "This app already has a live environment with this plan: ...". One
rule in `prompts/interview-system.md`: on a redeploy, never re-ask anything the existing plan
answers; ask only where the folder contradicts it. Expected result: zero questions when the
folder is unchanged. "The first run asked one question; the second asked none" is a sentence
that lands, and it feeds the cognitive-load score directly.

**Report, do not recommend.** The instinct to have the platform suggest what to add on a redeploy
is the right instinct in the wrong shape. A recommendation is upsell-flavoured, and it is where
a wrong answer would be most visible: the model proposing `config_basic` for an app that reads
nothing from its environment, in front of the people judging whether the thing works. The
honest version is a finding grounded in the folder, surfaced through the diff card and the
assumptions: "your app now reads DB_HOST and API_KEY from its environment, so config_basic is
switched on." The platform noticed the app changed and adapted the plan, instead of asking the
developer to remember. That is the infinite-context argument in miniature, and it is one of
the five Part 1 questions, demonstrated rather than asserted. Put the rule in the prompt beside
7c: on a redeploy, name what changed in the folder and what that changes in the plan; never
propose a module the folder does not justify.

**Known gap, and the answer to it.** The only place seaLeye knows what is deployed is the local
store, which is the developer's own record. If a colleague deployed the environment, or the
store was cleared, `init` sees nothing and goes back to modifying a live stack silently. The
truthful source is the stack itself. Fine for the demo; the answer if asked is that the shipping
version reads environment state from the environment, not from the developer's machine, and it
is a better answer for being one already thought about. This is the "Cindy on her laptop"
question, and it belongs in the simulated segment of the demo, not the live one.

**Done when.** `sealeye init` on an app with a live environment prints the notice and waits;
N writes nothing; y runs the interview with zero questions on an unchanged folder; the card
says "Nothing changes"; changing the app so it reads an environment variable produces a card
with `config_basic` marked new and one grounded line saying why; and a fresh app with no
environment behaves exactly as it does today.

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
