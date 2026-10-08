# Progress - day 3 commands

Panel: Fri Oct 2, 2026. Code freeze: Sun Sept 27, 2026.
Last updated: Sun Sept 20, 2026 (evening — Day 3, the executor).

Day 2 drove CloudFormation by hand. Nothing below was run by hand: every line is the
`sealeye` CLI talking to the deployme API, which shells out to the AWS CLI. The point of
this file is that the commands a developer types are now the whole story.

## Setup (once per session)

```
node deployme/src/server.js            # the platform API, port 3000
```

The API must be running for any CLI command to work. Every command below was run from the
repo root unless the `--app` flag says otherwise.

## The Node.js API app

```
sealeye validate -f plans/api-plan.yaml
sealeye deploy   -f plans/api-plan.yaml --app apps/sample-expressjs
sealeye watch    dep_<id>
sealeye status   dep_<id>
sealeye list
sealeye destroy  dep_<id>
```

`deploy` returns as soon as the deployment is queued and prints the id; `watch` is what the
developer actually looks at. On `succeeded`, `watch` writes `DEPLOYMENT_REPORT.md` into the
folder that was deployed — the only file the platform writes there.

## The static site

```
sealeye deploy  -f plans/static-plan.yaml --app apps/static-website
sealeye watch   dep_<id>
sealeye destroy dep_<id>
```

Same commands, different plan. The developer sees no difference; the executor picks the
template from the plan's enabled module and takes a different path after the stack is up
(create bucket -> `s3 sync` -> only then `succeeded`).

## Timings

Measured from the deployment record itself (`~/.deployme/deployments.json`:
`startedAt` -> `finishedAt`), not from `time`. `startedAt` is stamped when the API accepts
the request, so these include packaging, upload and the CloudFormation wait — the whole of
what the developer waits through.

| Run | Kind | What it was | Deploy to `succeeded` |
|---|---|---|---|
| `dep_e1d360b3c0c8` | api | first create | 44.7 s |
| `dep_05716e135e01` | api | first create | 44.7 s |
| `dep_5dfbeb80bdf3` | api | first create | 44.6 s |
| `dep_114b10d6a3f5` | api | update in place | 23.1 s |
| `dep_93cf294e5607` | api | update in place | 23.2 s |
| `dep_d1cee34a401a` | static | create (before file sync existed) | 27.1 s |
| `dep_57918c0f84f8` | static | create + sync | 28.1 s |
| `dep_71d40acbe6cc` | static | create + sync | 28.4 s |
| `dep_c4a237fc84c6` | static | create + sync | 27.9 s |

Three numbers, and they barely move: **API create ~45 s, API update ~23 s, static ~28 s.**

Against the 5-minute definition of done that leaves roughly four minutes for the interview.
Nothing in the executor is a timing risk.

This also fills in the `<fill in>` left in `docs/DAY2-COMMANDS.md`: an in-place update is
~23 s through the executor, against 36.5 s for the hand-run `cloudformation deploy`. The
"edit your app, deploy again, same URL" beat is confirmed — the URL is a stack output and
an update does not replace the API id.

### Destroy timings are an upper bound, not a measurement

The record stores `destroyedAt` but never stamps when the destroy *started*, so the only
thing derivable is time-since-the-deploy-finished, which includes however long a human sat
there. The tightest observations: `dep_c4a237fc84c6` 19.3 s and `dep_71d40acbe6cc` 29.8 s
from deploy-finished to fully destroyed, both static.

**Gap to close:** add `destroyStartedAt` to the record. One field, and destroy becomes as
measurable as deploy. Worth doing before the panel, because "and it cleans up in N seconds"
is a question that will be asked.

## The two failure states seen today

Both are reconstructed from the deployment store and the filesystem, which is solid on
*what the platform recorded* — Greg to confirm the exact screen text.

### 1. An interrupted deployment — the record outlives the process

`dep_e8ebf3ca54d0` is still in the store with `status: running`, `stackStatus:
UPDATE_IN_PROGRESS`, `interrupted: true`, and no `finishedAt`. The API server was restarted
while that deploy was in flight. The poll loop lives in the server process, so when the
process went, the only thing that could ever move the record to a terminal state went with
it. CloudFormation carried on and finished the update regardless.

`watch` on an interrupted record never exits: it redraws `Status: running...` forever,
because it is faithfully reporting a record that nothing is updating any more. `list` is the
command that tells the truth here — it prints `running (interrupted)` in the failure colour.

Worth being deliberate about before the panel: **do not restart the API mid-demo.** The
status is real, which also means it is only as alive as the process holding it.

### 2. An app that deploys perfectly and still does not work

`dep_5dfbeb80bdf3`, deployed from `/private/tmp/broken` — a copy of `sample-expressjs` with
`index.js` deleted. It took 44.6 s and reached `succeeded`, with `ApiUrl`, `FunctionName` and
`LogGroup` all populated. `DEPLOYMENT_REPORT.md` was written into the folder at 19:18.

Everything the platform claimed was true: the stack really did reach `CREATE_COMPLETE`.
`watch` printed the success line and the URL. But the Lambda has nothing to start, so the URL
itself returns an error and the reason is only visible in the log group.

This is the honest limit of "status is real": the status mirrors CloudFormation, and
CloudFormation does not know whether the app inside the zip runs. The platform is reporting
on the environment, not on the application.

Two ways to go, to decide Wednesday:
- Leave it, and be able to say the sentence above out loud if asked. It is a defensible
  answer and it is the truth.
- Add one `curl` of the URL after `succeeded` and report the status code in the report. Small,
  and it makes the report about the app rather than the stack.

Recommend the first for the demo and the second only if Day 5 has room.

## Also observed

`apps/static-website/DEPLOYMENT_REPORT.md` now exists, because `watch` writes the report into
the deployed folder. The static path syncs that folder into the public bucket, so on the
*next* static deploy the report is uploaded and served at
`<site-url>/DEPLOYMENT_REPORT.md`. Harmless content, but it is platform output on the
developer's public site. One more `--exclude` in `syncSite()` closes it; not done, because
the exclude list was specified as `.git` only.

## File layout: `deployme/src/executor/`

Six files, one job each, in the order the lifecycle uses them.

| File | Job |
|---|---|
| `env.js` | `repoRoot`, `loadEnv()`, `requireEnv()`. Finds `.env` / `~/.deployme/config` so nothing else has to think about where config lives. |
| `compose.js` | Plan in, deployment out: which template, which stack name, which parameter overrides. Enforces one core module per deployment. Also owns `safeName()`, `stackNameFor()`, `artifactKeyFor()`. |
| `package.js` | Builds the Lambda artifact: staged copy -> `npm install --omit=dev` -> inject `run.sh` -> zip -> `s3 cp`. Returns the S3 key, or `null` for a static site, which has no artifact. Also `stagePaths()` and `cleanStage()`. |
| `cfn.js` | Every AWS CLI call, and the only file that spawns `aws`: `deploy`, `describe`, `firstFailure`, `deleteStack`, `emptyBucket`, `syncSite`. Never rejects on a non-zero exit — it resolves with the exit code and stderr and lets the caller decide. |
| `report.js` | Renders `DEPLOYMENT_REPORT.md` from the record and the plan, with the header from `prompts/report.md`. Pure string building; reads nothing from AWS. |
| `index.js` | The lifecycle. `mapStackStatus()`, `startDeployment()`, `startDestroy()`. The only file that writes deployment status, and the only one that loops. |

The shape to keep: `index.js` decides, `cfn.js` talks to AWS, everything else is a pure
transform. Wednesday's `init` should add an `interview/`, not a seventh file in here.

### The status rules, as implemented

- Terminal stack statuses are ignored until either the AWS CLI child has exited or an
  `IN_PROGRESS` status has been seen. Without that, a redeploy reports the *previous* run's
  `CREATE_COMPLETE` about a second after it starts.
- Outputs are re-read from `describe-stacks` on every poll and never cached across a destroy.
- A static deploy is not `succeeded` when the stack completes — only after `s3 sync` returns.
  An empty bucket is not a website.
- `ROLLBACK_COMPLETE` is deleted after the failure reason has been read, so the next deploy
  can create fresh. `UPDATE_ROLLBACK_COMPLETE` is deliberately left alone: that stack is the
  developer's previous environment, still up.
- The failure reason is always read *before* any cleanup. `describe-stack-events` disappears
  with the stack.
