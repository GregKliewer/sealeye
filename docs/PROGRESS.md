# Progress — deployme demo

Panel: Fri Oct 2, 2026. Code freeze: Sun Sept 27, 2026.
Last updated: Mon Sept 21, 2026 (end of Day 5).

Day 4 turned the "Interview rules" in `CLAUDE.md` into `deployme/src/interview/`. A developer
now runs one command in their own folder and the plan writes itself. The commands, the timings
and the file layout are in `docs/DAY4-COMMANDS.md`.

Day 5 was the polish the scoring asked for, plus the two real bugs the polish uncovered. Nothing
about the plan contract changed, and the executor changed in one place only.

## The definition of done is met

From a clean copy of `apps/sample-expressjs` (dressed and renamed on Day 5 to
`apps/beneficiary-lookup-api`), `sealeye init` -> one question -> `y` -> `y` -> a
live URL in **just under 3 minutes**, against a 5-minute budget. `sealeye destroy` cleaned it up.
Deployment `dep_5f044fea5304`, the stack create itself 39.7 s of the three minutes. No plan was
written by hand at any point.

That is the demo. Everything after this is making it hold up in front of people.

## Day 5

Commits `3af5348`, `bffceea`, `c06dae4`, `48508ea`, `7bc07e5`, `d372814`, `aa1f5b3`, `74fac20`.

### What changed

- **Something moves during every wait.** `deployme/src/brand.js` has a spinner: braille frames in
  the dim palette, an elapsed count after three seconds of the same label, silent with no TTY,
  with `NO_COLOR`, on a dumb terminal and under `--json`. It covers every model round trip in the
  interview, the handoff after `y`, and the destroy and watch polls. That is the C=2 score: the
  silence was never between commands, it was inside them.
- **`watch` stops clearing the screen.** The panel is redrawn on top of itself now, so the
  interview the developer just had, and every command before it, stay on the screen and in the
  scrollback. Clearing was throwing all of it away at the exact moment the demo became
  interesting.
- **The decision card.** `sealeye run` prints a card rendered from the validated plan rather
  than the model's prose: what the app is, what will be provisioned, what comes back, in a box,
  with the values the developer gave or confirmed in the phosphor accent. The prose moved to the
  Notes section of `DEPLOYMENT_PLAN.md`. That is the E=3 score and the other half of C.
- **`run.sh` runs the entry point the plan names.** It was hardcoded to `node index.js`, and the
  executor never read `entry_point`. An app starting from `server.js` would have deployed to
  `CREATE_COMPLETE` and then failed on every request. Packaging now also refuses a plan naming a
  file the folder does not have, before anything is created.
- **The demo app is a bank service.** `apps/beneficiary-lookup-api` is Northline Bank's
  beneficiary lookup: a small JSON payload, three hard-coded records behind a path parameter, a
  404 shape, a five-line README in business terms. No dependencies added, no build step, no
  tests. The DigitalOcean startup banner, `.do/` and `.github/` are gone; the interview used to
  read them and say "this is the DigitalOcean sample Express app" out loud.
- **One row per environment.** `sealeye list` groups by stack and shows app, status, URL, deploy
  count and last deployed; `--deployments` keeps the old per-deploy view. Destroying one deploy
  now closes its siblings with a note naming the deployment that did it, so no row is left
  claiming `succeeded` for a stack that was deleted. `sealeye destroy` takes an app name.
- **`init` knows when the app already has a live environment.** It says so before asking
  anything, with the URL and the modules read from the record, and waits for a `y`. The card
  becomes a diff against the deployed plan, marked unchanged, changed, new or removed, collapsing
  to "Nothing changes" when the environment already matches. The interview gets the deployed plan
  as context and asks nothing at all when the folder has not moved.
- **Smaller.** `GET /health` returns `{ ok, version, deployments }` with the version read from
  the package and the count read from the store. `sealeye run --answers <file>` feeds a
  rehearsal one line per question, never the `Deploy this?` boundary. Three em dashes left
  developer-facing copy.

### Timings

| Operation | Time |
|---|---|
| API — first create | 45.0 s |
| API — update in place | 23.0 s |
| Static — create + file sync | 28.1 s |
| Static — update in place | 6.0 s |

Measured the way Day 3 measured, from the deployment records themselves
(`~/.deployme/deployments.json`, `startedAt` to `finishedAt`), over this evening's runs. The
static update is the interesting one: a redeploy that only syncs files is six seconds, which is
the "change a line, deploy again" beat in its fastest form. `docs/DAY5-COMMANDS.md` does not
exist yet; when it does, these four should be what it records.

## What works

### The interview. Commits `c8d8d0a`, `4f03e89`, `35337ae`.

- **`sealeye run`** — runs in the app folder, reads it with two read-only tools, asks at most
  four questions, submits a planVersion 0.2 plan, writes `DEPLOYMENT_PLAN.md` and `deployme.yaml`,
  and stops at `Deploy this? [y/N]`. On `y` it calls the existing deploy and watch paths and has
  no deployment logic of its own.
- **One question is the normal case.** Four runs, four single-question interviews, and the right
  modules every time. The folder digest (top level, `package.json`, whether there is an
  `index.html`) goes in the opening message, so the model never asks what the folder answers.
- **The developer's folder is read-only to the interview too.** Every tool path is resolved,
  symlinks included, and refused if it leaves the folder or enters `node_modules`, `.git` or
  `.deployme`. The "we never touched your code" claim covers the interview.
- **The contract cannot drift.** The `submit_plan` input schema embeds `planV02Schema` itself
  rather than a copy, and the submitted plan goes to the same `POST /plans/validate` that
  `sealeye validate` uses. Errors come back to the model in plain language; it gets two
  corrections; the developer never sees a schema path.
- **A plan already in the folder is the developer's.** `init` offers reuse (`r`) or start over
  (`s`) instead of overwriting, and reuse re-validates before deploying. Reuse needs no
  `ANTHROPIC_API_KEY`.
- **Nothing is written before it is valid**, and nothing reaches AWS before `y`. Ctrl+C and
  Ctrl+D at any point say where things stand and leave the folder as it was.
- **Failures are sentences.** A timeout, a dead connection, a refused key and a rate limit each
  get their own line and an action. One announced retry, not three silent ones.
- **Scored against the POC1 criteria** (`docs/INIT-SCORING.md`, transcripts in
  `docs/transcripts/`): question quality 4, relevance 4, cognitive load 5, adaptation 4.
  Developer experience 2 and recommendation clarity 3 were the two to fix, and both were CLI
  presentation rather than prompt. Day 5 is the fix; the second table in that file is where the
  after goes.

### The full lifecycle, both app kinds (Day 3). Commits `6c68784`, `7c2e913`, `6a79b76`, `df1f90e`, `33eae2d`.

- **`deploy`** — plan in, real CloudFormation stack out. Packaging is the Day 2 sequence in
  Node: staged copy, `npm install --omit=dev` in the stage dir, inject `run.sh`, zip, upload
  to `<app>/<deploymentId>.zip` so `S3Key` changes on every deploy. The developer's folder is
  never written to.
- **`watch`** — redraws the live record; on success prints the URL and writes
  `DEPLOYMENT_REPORT.md` into the app folder; on failure prints one plain sentence with the
  first `CREATE_FAILED` reason from `describe-stack-events`.
- **`status`** and **`list`** — `list` hides torn-down environments behind `--all` and marks
  records whose server died mid-deploy as `running (interrupted)`.
- **`destroy`** — empties the bucket first on the static path (CloudFormation will not delete
  a bucket with anything in it), deletes the stack, polls to gone, then removes the local
  stage dir and zip. A destroy that fails says so.
- **Status is real.** It mirrors `describe-stacks` and nothing else.
- **Report** — `prompts/report.md` header plus sections built from the record: what was
  created, the URL, logs, redeploy, tear down, and the assumptions carried from the plan.
- **Brand** — every command prints `prompts/banner.txt` first; colours come only from
  `deployme/src/brand.js`. Nothing the developer sees says "deployme".

### Timings

| Operation | Time |
|---|---|
| **`sealeye init` to a live URL, end to end** | **just under 3 min** |
| API — first create | ~45 s |
| API — update in place | ~23 s |
| Static — create + file sync | ~28 s |

The interview is the variable part of the three minutes and the executor is not a timing risk.

## Known gaps

- **`config_basic` is now reachable and still ignored.** The interview switches it on when the
  folder reads environment variables, and the card shows it as new, but `compose()` maps nothing
  from it: the variables would not reach the function. Until Day 6 this is a plan that promises
  something the deploy does not do, which is the one kind of gap CLAUDE.md rules out. It only
  fires on an app that reads its environment, so the demo app is safe as it stands.
- **A static deploy still publishes three platform files.** `s3 sync` excludes only `.git/*`, so
  `DEPLOYMENT_REPORT.md`, `DEPLOYMENT_PLAN.md` and `deployme.yaml` are served with the site.
  Three `--exclude` flags in `syncSite`.
- **The interview still restates itself before a question.** Rule 3 now says to state what was
  found once, and a static run after the change produced the stutter anyway. The exemplar
  question at line 150 of the prompt carries its own finding and "How a run goes" step 3 asks for
  a separate line, so the rule is arguing with two examples. Fix the examples, not the rule.
- **Only `node <entry_point>`.** An app that needs its start script, with flags or an env prefix,
  has no field in the contract to say so.
- **The store is the only place seaLeye knows what is deployed.** If a colleague deployed the
  environment, or the store was cleared, `init` sees nothing and goes back to changing a live
  stack quietly. Fine for the demo; the answer if asked is that the shipping version reads
  environment state from the environment rather than from one laptop.
- **A record that failed before its stack existed still carries a stack name.** `compose()` runs
  before packaging, so `destroy` on such a record will happily delete the stack a different
  deployment created. Same stack name by design, but the record that created nothing can delete
  something.
- **Destroy is not measured.** The record stamps `destroyedAt` but never when the destroy began.
  Add `destroyStartedAt`.
- **An interrupted record never resolves.** The poll loop lives in the API process; restart the
  server mid-deploy and the record sits at `running` forever while CloudFormation carries on.
  `list` flags it, `watch` spins. Do not restart the API mid-demo.
- **A successful deploy still does not mean a working app.** The entry-point check closes the
  most common cause, but CloudFormation does not know whether the code in the zip runs.
- **Stray stacks.** Day 2's hand-run `dep-sample-expressjs` and `dep-static-website` were named
  before the `sealeye-<app>` rule; the code will never look them up. Confirm the `dep-*` pair is
  gone before Oct 2.

## Not started

- **`config_basic` in the executor** — Lambda environment variables from the plan. Now the most
  urgent of these, because the interview can already ask for it.
- **`observability_basic`'s dashboard** — the log group is real, the dashboard is not.
- **`domain_public`** — ignored by design, per the hard rules.
- **The recorded end-to-end run**, the insurance for Oct 2.

## Next — the scope drop order

**Day 6: `config_basic` in the executor, the dashboard, the prompt examples, failure polish,
terminal setup.** `config_basic` first, because the interview can now switch it on and the
executor would quietly ignore it. Then the dashboard, then the two prompt examples that are
teaching the stutter. Failure polish is making a failed deploy read like a sentence rather than
an incident. Terminal setup is font, size, colours and window, tested on the screen that will be
in the room, and it is also where the card's width is decided: the card is twelve lines at a
hundred columns and fifteen at eighty.

**Day 7: freeze and record.** Code freeze is Sun Sept 27. Record the end-to-end run as insurance
and stop changing things.

The scope doc's drop order still holds: dashboard, then `config_basic`, then the static path.
Never the Node API happy path and never the recording. Note that the order now argues with
itself: `config_basic` is below the dashboard in the drop order and above it in urgency, because
the interview reaching it changed what dropping it would mean.

## Decisions taken on Day 5

Most of today is visible in the diff. These are the ones that are not.

- **The spinner's elapsed count belongs to the label, not to the run.** A wait that keeps
  announcing progress never shows a counter; a wait that sits still always does. When a single
  wait passes thirty seconds the label escalates and the count keeps running through the change,
  because the developer is owed the whole wait, not the part of it that has been worrying.
- **"That is taking longer than it should" waits until it is true.** It used to fire on any
  retryable failure, including a rate limit that came back in under a second. A platform that
  says things are slow while they plainly are not is a platform nobody reads.
- **`watch` redraws in place rather than using the alternate screen.** The alternate screen was
  the smaller change and it restores scrollback for free, but a CLI that dies mid-deploy would
  leave the terminal on the alternate screen, and a recording of it does not read top to bottom.
  Redrawing in place keeps one continuous transcript, which is what Day 7 records.
- **The card is rendered from the plan, never from the model's prose.** Prose is the model's
  account of what it decided; the card is the artifact that will run. Two runs over the same app
  produce identical cards where two runs of prose did not.
- **No "switched off" list and no assumptions on the card**, and an invariant instead: anything
  the platform guesses that changes what gets built has to be a value on the card, not a line of
  prose under it. Both lists grow as the platform supports more, and of the six assumptions a run
  produced, four restated a value already on the card and the other two were about fields the
  executor never reads. Both still live in `DEPLOYMENT_PLAN.md`, which the card points at.
- **`entry_point` is validated, not trusted.** It is the one field in a plan that comes from what
  the model read in a folder rather than from the contract, and it ends up inside a shell script.
- **Packaging fails before CloudFormation is called** when the entry point is not in the folder.
  Forty-five seconds and a URL that errors is worse than a sentence.
- **A name given to `destroy` resolves to the environment's newest deploy**, because that record
  holds the current outputs, which the static path needs to empty the bucket before deleting it.
- **Closing sibling records writes a note naming the deployment that did it**, and adds no new
  fields. A record changing under a developer has to be traceable, and the record shape is not
  something to grow casually eleven days before a panel.
- **`--answers` only ever answers interview questions.** Not `Deploy this?`, not the reuse
  prompt, not the live-environment notice. A line eaten by a prompt that was not expecting one
  puts every later answer off by one, which would be a strange way to lose a rehearsal.
- **`init` now talks to the platform API before the interview starts**, to look for a live
  environment. An unreachable API therefore fails immediately rather than after the questions.
- **The demo app lost `.do/` and `.github/`.** They named `digitalocean/sample-expressjs`, the
  interview reads them, and in two runs today the model said "this is the DigitalOcean sample
  Express app" out loud.

## Decisions taken on Day 4

From `CLAUDE.md` "Interview rules", all now implemented:

- **`sealeye run` runs in the app folder**, with the Sonnet id from the Day 1 curl test via
  `@anthropic-ai/sdk`. `ANTHROPIC_API_KEY` from the environment, the repo `.env` or
  `~/.deployme/config`; a clear message and exit 1 if it is missing.
- **Two read-only tools**, `list_files` and `read_file`, resolved inside the app folder only,
  40 entries and 20 KB. `submit_plan` ends the interview, and its input schema is the frozen
  contract itself.
- **At most four questions, one per assistant turn**, developer language, no AWS terms, and look
  at the folder before asking anything the folder can answer.
- **Validation through `POST /plans/validate`**, errors returned to the model as the tool result,
  two retries, then stop with the errors shown.
- **Two files, rendered from `prompts/plan-template.md` and the plan as submitted**, and nothing
  else is written into the folder before the developer says yes.
- **The confirmation boundary.** Summary, files, `Deploy this? [y/N]`, and only `y` proceeds.
- **Every prompt line amber, every echoed answer phosphor, every platform action a dim step line.
  No em dash in anything the developer sees.**

Decided while building, beyond the written rules:

- **The loop is written by hand, not given to the SDK's tool runner.** Two of the three tools are
  not code: one goes to a human at a terminal, and `submit_plan` only ends the conversation if
  the platform API says the plan is valid. A tool runner would have owned that decision.
- **The contract is embedded, not copied.** `submitPlanInputSchema` reuses `planV02Schema`, so
  there is no second description of the contract to drift from the first. For the same reason
  every plain-language sentence about a module comes from `prompts/module-catalog.yaml`, used by
  both the prompt and the renderer.
- **`temperature` is not sent to the current generation.** Sampling parameters were removed on
  Sonnet 5 and a request carrying one returns 400. `CLAUDE.md` asks for 0.2, so it is still sent
  to any older id that accepts it.
- **One announced retry, not three silent ones.** The SDK's own retries are off and its ten
  minute timeout is cut to 120 s. In front of an audience, a line saying it is taking longer than
  it should beats a terminal that has apparently stopped.
- **A turn containing a question mark is a question**, not a turn ending in one. The model asked
  "...from the environment? (Not counting the port, that one is handled automatically.)" and a
  trailing-character test read that as the interview ending. Mistaking a stop for a question
  costs one odd prompt; mistaking a question for a stop ends the interview in silence.
- **A plan already in the folder is offered back, not overwritten**, and reuse does not need an
  API key. The developer may have edited it, and it is theirs.
- **Validation errors are translated before they are printed.** `/modules/0 must NOT have
  additional properties` is true and useless. `sealeye validate` prints the translated version
  too, so there is one voice for contract errors.
- **`PORT` and `NODE_ENV` are not configuration.** The platform supplies the port, so an app that
  reads `process.env.PORT` and nothing else must not be asked about environment variables. This
  was the only prompt change of the day, and it came before the scored runs; scoring produced no
  prompt changes at all.

## Decisions taken on Day 3

From `CLAUDE.md` "Executor rules", all implemented:

- **Shell out to the AWS CLI, no SDK dependency.** `child_process` + `--output json`.
  `cfn.js` is the only file that spawns `aws`, and it never rejects on a non-zero exit — it
  resolves with the code and stderr and lets the lifecycle decide what that means.
- **Deploy in the background, poll `describe-stacks` every 5 s.** The poll, not the child
  process, is the source of truth. Outputs are re-read fresh after every deploy and never
  cached across a destroy — a recreated stack gets a new API id, which is exactly the
  `{"message":"Not Found"}` from Day 2.
- **One template per deployment**, chosen from the plan's enabled core module.
  `observability_basic.retention_days` -> `RetentionDays`. `config_basic` and `domain_public`
  ignored until Day 6.
- **Stack `sealeye-<app>`, artifact `<app>/<deploymentId>.zip`.** A new key every deploy, so
  `S3Key` always changes and CloudFormation never skips the function update.
- **`POST /deployments` takes `{ plan, appPath }`.** Contract unchanged; `DELETE
  /deployments/:id` added for destroy.
- **The developer's folder is read-only to the API**, and `DEPLOYMENT_REPORT.md` is written by
  the CLI, not the API.
- **Never fake a transition.** The status map is the one in CLAUDE.md, implemented in
  `mapStackStatus()`.
- **Static destroy empties the bucket before `delete-stack`.**

Decided while building, beyond the written rules:

- **A terminal stack status is ignored until this deployment's own operation is visibly under
  way** (an `IN_PROGRESS` seen, or the AWS CLI child exited). Otherwise a redeploy reports the
  previous run's `CREATE_COMPLETE` a second after it begins — reading a real status about the
  wrong operation, which is its own kind of lying.
- **A static deploy is not `succeeded` when the stack completes**, only after `s3 sync`
  returns. The stack alone is an empty bucket, and calling that success would be the fake
  success the rules forbid.
- **`ROLLBACK_COMPLETE` is deleted, `UPDATE_ROLLBACK_COMPLETE` is not.** The first is a dead
  stack that blocks every future deploy; the second is the developer's previous environment,
  still up and still serving. Deleting that one because a redeploy had a bad parameter would
  destroy a working environment.
- **Failure reasons are read before any cleanup**, because `describe-stack-events` disappears
  with the stack.
