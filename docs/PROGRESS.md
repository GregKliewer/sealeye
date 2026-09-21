# Progress — deployme demo

Panel: Fri Oct 2, 2026. Code freeze: Sun Sept 27, 2026.
Last updated: Sun Sept 20, 2026 (end of Day 3).

Day 3 turned `docs/DAY2-COMMANDS.md` into `deployme/src/executor/`. The simulation is gone.
Both app kinds go from a plan to a working URL and back to nothing, through the CLI, against
real AWS. Timings and the exact commands are in `docs/DAY3-COMMANDS.md`.

## What works

**The full lifecycle, both app kinds.** Commits `6c68784`, `7c2e913`, `6a79b76`, `df1f90e`,
`33eae2d`.

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
- **Status is real.** It mirrors `describe-stacks` and nothing else. The `setTimeout` that
  faked `running` at 10 s and `succeeded` at 20 s is deleted, and so is the hardcoded
  `https://your-app-name.platform.app`.
- **Report** — `prompts/report.md` header plus sections built from the record: what was
  created, the URL, logs, redeploy, tear down, and the assumptions carried from the plan. On
  the static path it explains that the address is `http://` and why.
- **Brand** — every command prints `prompts/banner.txt` first; colours come only from
  `deployme/src/brand.js`. Nothing the developer sees says "deployme".
- **Node.js API path** — verified repeatedly: create ~45 s, update in place ~23 s, same URL
  across an update.
- **Static path** — verified three times end to end after the file sync landed this evening:
  ~28 s from `deploy` to a served page.

### Timings

| Operation | Time |
|---|---|
| API — first create | ~45 s |
| API — update in place | ~23 s |
| Static — create + file sync | ~28 s |

Roughly four minutes of the 5-minute budget is left for the interview.

## Known gaps

- **Destroy is not measured.** The record stamps `destroyedAt` but never when the destroy
  began, so there is no real destroy timing. Add `destroyStartedAt`.
- **An interrupted record never resolves.** The poll loop lives in the API process; restart
  the server mid-deploy and the record sits at `running` forever while CloudFormation carries
  on. `list` flags it, `watch` spins. Do not restart the API mid-demo.
- **A successful deploy does not mean a working app.** An Express app with `index.js` deleted
  deployed to `succeeded` in 44.6 s with a URL that errors. The status mirrors CloudFormation,
  and CloudFormation does not know whether the code in the zip runs. Both failure states are
  written up in `docs/DAY3-COMMANDS.md`.
- **The report gets published on static redeploys.** `watch` writes
  `DEPLOYMENT_REPORT.md` into the app folder, and the static sync uploads that folder. One
  more `--exclude` fixes it.
- **Stray stacks.** Day 2's hand-run `dep-sample-expressjs` and `dep-static-website` were
  named before the `sealeye-<app>` rule; the code will never look them up. Every `sealeye-*`
  stack from today has been destroyed. Confirm the `dep-*` pair is gone before Oct 2.

## Not started

- CLI `init` — the interview. Nothing written; deliberately no code yet.
- `prompts/` — has the contract, plan template, banner and report template; **missing the
  interview system prompt.**
- `config_basic` and `domain_public` — ignored by the executor, per the hard rules.

## Next — Wednesday: `sealeye init`

The developer runs `sealeye init` in their app folder and answers questions. Nothing about
the executor changes; `init` produces the plan the executor already consumes.

1. **System prompt** — write `prompts/interview-system.md` from the POC1 rules in
   `docs/poc1` (`POC1 NodeJS App Run.docx`, `POC1 Static App Run.docx`, `POC1 Report.docx`).
   The plan shape is already there in `docs/poc1/# Deployment Plan.md` and is what
   `DEPLOYMENT_PLAN.md` must look like. The prompt is bound by the frozen contract in
   `prompts/plan-contract.yaml`: five modules, no new fields.
2. **Tools: `list_files` and `read_file`, scoped to the app folder.** The model looks at the
   app to ask better questions instead of asking the developer to describe their own code.
   Both tools resolve paths and refuse anything outside the folder, and both are read-only —
   the "we never touched your code" claim covers the interview too.
3. **Write `DEPLOYMENT_PLAN.md` and `deployme.yaml`** into the app folder. Note this widens
   what the platform writes there from one file to three; the report's closing line says the
   report is the only file written and will need to change.
4. **Validate via `POST /plans/validate`** — the same endpoint `sealeye validate` already
   uses. The interview does not get its own validation path. An invalid plan goes back to the
   model to fix rather than reaching the developer.
5. **Confirmation boundary.** `init` stops after writing the two files and prints the plan in
   plain language. Nothing reaches AWS until the developer answers `y`. This is the line the
   whole demo turns on: everything before it is a conversation and costs nothing, everything
   after it is real and costs money.
6. **Hand off to deploy + watch.** On `y`, call the same code path as `sealeye deploy` and
   then `watch`. `init` orchestrates existing commands; it does not get its own deployment
   logic.

Then, in the scope doc's drop order: `observability_basic` (dashboard), `config_basic`, and
the recorded end-to-end run as insurance.

## Decisions taken today

From CLAUDE.md "Executor rules", all now implemented:

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
