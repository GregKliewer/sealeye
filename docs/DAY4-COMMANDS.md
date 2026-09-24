# Progress - day 4 commands

Panel: Fri Oct 2, 2026. Code freeze: Sun Sept 27, 2026.
Last updated: Mon Sept 21, 2026 (Day 4, the interview).

Day 3 ended with an executor that turns a plan into a URL. Day 4 is where the plan stops
being a YAML file somebody wrote by hand. The developer runs one command in their own
folder, answers a question, and the plan writes itself. Everything below was run against
the real Anthropic API and real AWS.

## Setup (once per session)

```
node deployme/src/server.js            # the platform API, port 3000
```

`init` needs the API for one thing only: `POST /plans/validate`. The interview does not get
its own validation path.

It also needs `ANTHROPIC_API_KEY`, resolved in this order, first hit wins:

1. the real environment
2. `.env` at the repo root
3. `~/.deployme/config`

Missing key, and `init` says so in one sentence and exits 1 before it asks anything. The key
is only required for the interview itself: reusing a plan that is already in the folder
deploys without one.

## The commands

```
sealeye run [--api <url>]
```

That is the whole of the new surface. `run` takes no `--file` and no `--app`: it runs in the
current folder, and that folder is the only one it ever touches. It has no `--json` either,
because it is a conversation.

The flags that matter around it, unchanged from Day 3:

```
sealeye validate -f deployme.yaml            # the plan run wrote
sealeye deploy   -f deployme.yaml            # what run does for you on y
sealeye watch    dep_<id>
sealeye destroy  dep_<id>
sealeye list [--all]
```

Two environment variables exist for the interview and neither is for the developer:

- `DEPLOYME_MODEL` - override the model id without touching code.
- `DEPLOYME_DEBUG` - print the underlying error when a model call is retried. Off in the demo:
  the developer sees `That is taking longer than it should, trying once more` and nothing else.

### What `init` does, in order

1. Refuses to run without a terminal, and says to use `sealeye deploy -f deployme.yaml` instead.
2. If `deployme.yaml` is already in the folder, asks whether to reuse it (`r`) or start over
   (`s`). A plan from a previous run belongs to the developer and is not ours to overwrite.
   Reuse re-validates it and skips straight to the confirmation.
3. Sends the model a folder digest: folder name, the top level, `package.json` name, main,
   scripts and dependencies, and whether there is an `index.html` at the root. The model starts
   the conversation already knowing what the folder can tell it.
4. Reads the app with `list_files` and `read_file`, printing one dim line per tool call after it
   runs: `Reading index.js`, `Looking at .do`.
5. Asks its questions, at most four, one per turn, each with a short line above it saying what
   the platform found.
6. Calls `submit_plan`, which goes to `POST /plans/validate`. Errors go back to the model as the
   tool result, in plain language, and it gets two corrections.
7. Writes `DEPLOYMENT_PLAN.md` and `deployme.yaml` into the folder, prints the summary, and asks
   `Deploy this? [y/N]`.
8. On `y`, hands the plan to the same `deploy` and `watch` code paths the CLI already had.
   `init` has no deployment logic of its own.

Ctrl+C and Ctrl+D are handled the same way at every point: one line saying where things stand
(`Nothing has been written to your folder`, or the plan is still there and nothing was deployed)
and exit 130.

## The definition-of-done run

From a clean copy of `apps/sample-expressjs`, in `/private/tmp/dod`:

```
cp -R apps/sample-expressjs /tmp/dod
cd /tmp/dod
sealeye init
```

One question, `y`, then `y` at the confirmation. Deployment `dep_5f044fea5304`.

| Moment | Time |
|---|---|
| `DEPLOYMENT_PLAN.md` and `deployme.yaml` written | 12:58:32 |
| deploy accepted by the API | 12:59:02 |
| `succeeded`, URL printed, `DEPLOYMENT_REPORT.md` written | 12:59:42 |
| Stack create, measured from the record | 39.7 s |
| **Whole run, `sealeye init` to a live URL** | **just under 3 minutes** |

**The definition of done is met.** Clean copy of the sample app to a working URL in under five
minutes, through `init`, with no plan written by hand. About two of the five minutes are spare.

`sealeye destroy dep_5f044fea5304` cleaned it up.

## The answers the developer gives

The interview asked **one** question, which is the behaviour the prompt is aiming at: look at
the folder first, and only ask what the folder cannot answer. The exact wording of the
definition-of-done run is not recoverable, because `watch` clears the screen before the
interview scrolls anywhere. It was a specific question about the Express app it had just read,
close to this one from the `api-2` run:

> I found `index.js`, a small Express server that calls `app.listen` on `process.env.PORT` and
> serves a sample "Hello World" page. `package.json` confirms the start script runs
> `node index.js` with `express` as the only dependency, and I do not see any other environment
> variables being read.
>
> Just to confirm: this app starts up and stays running, answering requests over HTTP, rather
> than running once and exiting. Is that right?

Across every run of the day the developer types the same short set:

| Run | Folder | Questions asked | Answers typed |
|---|---|---|---|
| `api-1` | `/tmp/try-api` | 1 | `y`, then `n` at the confirmation |
| `api-2` | `/tmp/try-api` | 1 | `y`, then `y` |
| `static-1` | `/tmp/try-static` | 1 | `y`, then `y` |
| definition of done | `/tmp/dod` | 1 | `y`, then `y` |

So the demo is: `sealeye run`, one `y` to confirm what the platform already worked out, one `y`
to spend money. Everything before the second `y` is a conversation and costs nothing.

The three scored runs are in `docs/transcripts/` with the questions verbatim, and the scores are
in `docs/INIT-SCORING.md`.

## File layout of `deployme/src/interview/`

Five files, all of them reachable only from `sealeye init`. Nothing in the executor changed.

| File | Lines | What it is |
|---|---|---|
| `loop.js` | 317 | The conversation. Owns the model client, the turn loop, the four-question rule, the two validation retries, and the error handling. Exports `runInterview`, `resolveApiKey`, `loadSystemPrompt`, `DEFAULT_MODEL`. |
| `tools.js` | 203 | `list_files` and `read_file`, read only, scoped to the app folder, plus `folderDigest` for the opening message. Every path is resolved (symlinks included) and refused if it leaves the folder or enters `node_modules`, `.git` or `.deployme`. 40 entries, 20 KB. |
| `schema.js` | 92 | The `submit_plan` input schema. The plan half is `planV02Schema` itself, not a copy, so the interview cannot drift from what `POST /plans/validate` accepts. `splitSubmission` drops `summary` and `assumptions` before the plan is validated or deployed. |
| `render.js` | 272 | The only writer into the developer's folder: `DEPLOYMENT_PLAN.md` from `prompts/plan-template.md` and `deployme.yaml` from the plan as submitted. Every plain-language sentence about a module comes from `prompts/module-catalog.yaml`, so the prompt and the renderer cannot describe the same module two different ways. |
| `explain.js` | 92 | Contract validation errors in the developer's language. `/modules/0 must NOT have additional properties` becomes a sentence about their plan, with the allowed values named. Used by `init`, by the reuse path and by `sealeye validate`. |

The loop is written by hand rather than handed to the SDK's tool runner, because two of the
three tools are not code: a question goes to a human at a terminal, and `submit_plan` only ends
the conversation if the platform API says the plan is valid.

Supporting changes outside that folder:

- `deployme/bin/deployme` - the `init` command, the reuse prompt, `askLine`/`askChoice`, the
  interrupt handling, and `plainValidationErrors` wired into `validate` as well.
- `deployme/src/executor/env.js` - `loadUserConfig` for `~/.deployme/config`, so the key has a
  home outside the repo.
- `prompts/interview-system.md` (11.5 KB) and `prompts/module-catalog.yaml` - the prompt and the
  one place module language lives.

## Prompt changes made after scoring

**None.** `git diff 4f03e89 HEAD -- prompts/` is empty: the prompt has not been touched since the
commit that predates all three scored runs.

That is the finding, not an omission. All three runs chose the correct modules, and the scores
that came back low are not prompt problems:

- **C, developer experience, 2/5.** "It is easy to conclude that sealeye is frozen when reading
  the app as there is no visual feedback while that runs," and a wish to see the deployment plan
  markdown before saying yes. Both are CLI presentation. Parked for Day 6.
- **E, recommendation clarity, 3/5.** "The single-paragraph, prose readout is a lot of text; we
  could try bullet-form instead." This one *is* reachable from the prompt (the `summary` argument
  of `submit_plan` is where the paragraph comes from) but it is a presentation choice, and it is
  better decided against the dressed-up app on Day 5 than against the sample.

The only prompt change of the day came *before* scoring, in the job 2 commit: `PORT` and
`NODE_ENV` do not count as configuration, so an app that reads `process.env.PORT` and nothing
else must not be asked about environment variables. Every run since has left `config_basic`
correctly disabled.

## What Day 4 could not capture

- **The interview scrolls away.** `watch` redraws the screen, so on a `y` the questions and the
  summary are gone. It cost the exact wording of the definition-of-done question, and at the
  panel it will cost the audience the best part of the demo. Day 6.
- **Only one shape of question has been seen.** Four runs, four single-question interviews, all
  on apps the folder nearly explains by itself. The dressed-up app on Day 5 is the first real
  test of whether the model asks a second question when it should.
