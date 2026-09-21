# Progress — deployme demo

Panel: Fri Oct 2, 2026. Code freeze: Sun Sept 27, 2026.
Last updated: Mon Sept 21, 2026 (end of Day 4).

Day 4 turned the "Interview rules" in `CLAUDE.md` into `deployme/src/interview/`. A developer
now runs one command in their own folder and the plan writes itself. Nothing about the executor
changed: `init` produces the plan the executor already consumed on Day 3. The commands, the
timings and the file layout are in `docs/DAY4-COMMANDS.md`.

## The definition of done is met

From a clean copy of `apps/sample-expressjs`, `sealeye init` -> one question -> `y` -> `y` -> a
live URL in **just under 3 minutes**, against a 5-minute budget. `sealeye destroy` cleaned it up.
Deployment `dep_5f044fea5304`, the stack create itself 39.7 s of the three minutes. No plan was
written by hand at any point.

That is the demo. Everything after this is making it hold up in front of people.

## What works

### The interview. Commits `c8d8d0a`, `4f03e89`, `35337ae`.

- **`sealeye init`** — runs in the app folder, reads it with two read-only tools, asks at most
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
  Developer experience 2 and recommendation clarity 3 are the two to fix, and both are CLI
  presentation rather than prompt.

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

- **The interview scrolls away.** `watch` clears and redraws the screen, so the moment the
  developer answers `y` the questions and the summary are gone. It already cost the exact
  wording of the definition-of-done question, and at the panel it costs the audience the best
  part of the demo. Day 6.
- **No visual feedback while the model reads the app.** Scored 2 out of 5 for developer
  experience: "it is easy to conclude that sealeye is frozen". The tool lines appear only after
  each tool returns. Day 6, with the step messages.
- **The summary is one long paragraph.** Scored 3 out of 5 for recommendation clarity; bullets
  were asked for, and a short plan readout before `Deploy this?` was asked for with it. Decide it
  against the dressed-up app on Day 5.
- **A static deploy now publishes three platform files.** `s3 sync` excludes only `.git/*`, so
  `DEPLOYMENT_REPORT.md` was already being served, and `init` adds `DEPLOYMENT_PLAN.md` and
  `deployme.yaml` beside it. Three `--exclude` flags in `syncSite`.
- **Destroy is not measured.** The record stamps `destroyedAt` but never when the destroy began.
  Add `destroyStartedAt`.
- **An interrupted record never resolves.** The poll loop lives in the API process; restart the
  server mid-deploy and the record sits at `running` forever while CloudFormation carries on.
  `list` flags it, `watch` spins. Do not restart the API mid-demo.
- **A successful deploy does not mean a working app.** An Express app with `index.js` deleted
  deployed to `succeeded` in 44.6 s with a URL that errors. The status mirrors CloudFormation,
  and CloudFormation does not know whether the code in the zip runs. Both failure states are
  written up in `docs/DAY3-COMMANDS.md`.
- **Only one shape of interview has been seen.** Four runs, four single-question interviews, all
  on apps the folder nearly explains by itself. The dressed-up app is the first real test of
  whether a second question appears when it should.
- **No `GET /health` on the API.** Written up in `docs/DAY5-BACKLOG.md`.
- **Stray stacks.** Day 2's hand-run `dep-sample-expressjs` and `dep-static-website` were named
  before the `sealeye-<app>` rule; the code will never look them up. Confirm the `dep-*` pair is
  gone before Oct 2.

## Not started

- **The dressed-up app.** `apps/sample-expressjs` is DigitalOcean's sample and reads as one. The
  demo app should look like something a bank developer wrote.
- **`config_basic`** — in the plan contract and correctly disabled by the interview, still
  ignored by the executor.
- **`observability_basic`'s dashboard** — the log group is real, the dashboard is not.
- **`domain_public`** — ignored by design, per the hard rules.
- **The recorded end-to-end run**, the insurance for Oct 2.

## Next — the scope drop order

**Day 5: the dressed-up app and two clean end-to-end runs.** Replace the DigitalOcean sample with
an app that looks like the bank's, and run the whole thing twice from a clean copy, once API and
once static, with nothing hand-edited in between. That is where the interview meets an app it has
not seen, so it is also where the second question (and the bullets-versus-paragraph question)
gets decided. Cheap items from `docs/DAY5-BACKLOG.md` if the day allows.

**Day 6: `config_basic`, the dashboard, step messages, failure polish, terminal setup.** The two
remaining modules, then the presentation work the scoring asked for: keep the interview on the
screen, show something while the model is reading, say what the platform is doing at each step,
and make a failed deploy read like a sentence rather than an incident. Terminal setup is font,
size, colours and window, tested on the screen that will be in the room.

**Day 7: freeze and record.** Code freeze is Sun Sept 27. Record the end-to-end run as insurance
and stop changing things.

The scope doc's drop order still holds: dashboard, then `config_basic`, then the static path.
Never the Node API happy path and never the recording.

## Decisions taken on Day 4

From `CLAUDE.md` "Interview rules", all now implemented:

- **`sealeye init` runs in the app folder**, with the Sonnet id from the Day 1 curl test via
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
