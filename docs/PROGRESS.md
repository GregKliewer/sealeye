# Progress — deployme demo

Panel: Fri Oct 2, 2026. Code freeze: Sun Sept 27, 2026.
Last updated: Sun Sept 20, 2026 (end of Day 2).

## Done

**Planning artifacts** (commit `8b79a3a`)
- `CLAUDE.md` — hard rules for the build.
- `docs/SCOPE.md` — in/out list and the drop order if a day slips.
- `prompts/plan-contract.yaml`, `prompts/plan-template.md`.

**Single backend + CLI fixes** (commit `36c0efc`)
- `deployme/bin/deployme` — usage, examples, and the `--backend` default all moved
  from `terraform` to `cloudformation`.
- Removed a stray `return;` that was swallowing the unknown-command error path, so a
  bad command exited 0 silently. It now prints the error and exits 1.
- `deployme/src/server.js` — backend allowlist and error message are cloudformation-only.
- `deployme/package.json` — added a `cli` script.

**seaLeye.run brand + sample apps** (commit `d87cdd8`)
- `brand/BRAND.md`, `deployme/src/brand.js`, `prompts/banner.txt`, `prompts/report.md`.
- `apps/sample-expressjs` and `apps/static-website` tracked as real files.

**Day 2 — both CloudFormation templates written and deployed by hand** (commit `06c0a3c`)

Not wired to any code yet. Everything below was run from the shell; the exact commands,
timings and gotchas are in `docs/DAY2-COMMANDS.md`, which is the spec the executor gets
turned into on Tuesday.

- `templates/http_api_serverless.yaml` — log group, IAM role
  (`AWSLambdaBasicExecutionRole` only), Lambda (nodejs20.x, x86_64, 512 MB, 30 s), HTTP
  API with `Target` pointed straight at the function (no explicit route/integration/stage
  resources), and the `lambda:InvokeFunction` permission. Parameters: `AppName`,
  `ArtifactBucket`, `ArtifactKey`, `RetentionDays`, `AdapterLayerVersion`.
  Outputs: `ApiUrl`, `FunctionName`, `LogGroup`.
- `templates/static_site_edge.yaml` — S3 bucket named `${AppName}-${AWS::AccountId}`,
  website config (`index.html` for both index and error), `BucketOwnerEnforced`
  ownership, all four public-access blocks off, and a public `s3:GetObject` bucket
  policy. Parameters: `AppName`. Outputs: `WebsiteUrl`, `BucketName`.
  No CloudFront, per the hard rules — so the URL is `http://`, not `https://`.
- `templates/run.sh` — two lines, `exec node index.js`. Injected into the artifact.

### Adapter, not shim

The path taken is the **Lambda Web Adapter**, not a handwritten handler shim. The
Express app is deployed byte-for-byte unmodified: the adapter layer
(`LambdaAdapterLayerX86`, version 28, account `753240598075`) is attached to the
function, `AWS_LAMBDA_EXEC_WRAPPER=/opt/bootstrap` and `PORT=8080` are set, the Lambda
`Handler` is `run.sh`, and the adapter translates HTTP API events into real HTTP
requests against the app's own listener.

Why this matters for the demo: "we did not touch your code" is literally true and can be
shown on stage by diffing the app folder. A shim would have meant injecting a
`handler.js` that wraps the Express app, which is more code, more explaining, and one
more thing that can break in front of the panel.

Version 28 is pinned as `DEPLOYME_LWA_VERSION` in `.env` because
`list-layer-versions` is denied on the public layer — there is no way to discover the
latest version at runtime, so the executor must carry the number.

### Packaging (works, and is the sequence the executor must reproduce)

Staged copy → prod install → inject `run.sh` → zip → upload. Full commands in
`docs/DAY2-COMMANDS.md`. Two things that cost time today and must survive into code:
- `rsync` excludes `node_modules`, `.git`, `.do`, `.github`; `npm install --omit=dev`
  runs in the *stage* directory, so the developer's `node_modules` is never read or
  written.
- `chmod +x run.sh` **before** zipping. `zip` preserves the executable bit; losing it
  gets "Permission denied" in the Lambda logs and nothing else useful.

### Timings measured today

| Operation | Time |
|---|---|
| API stack — first create (`cloudformation deploy`) | 1:06 |
| API stack — delete (+ `wait stack-delete-complete`) | 31 s |
| Static stack — create | 37 s |

Not timed: the second create, and the in-place update (`v2.zip` redeploy). The
update-keeps-the-same-URL behaviour was reasoned about and the commands are written
down, but the run was not recorded — `docs/DAY2-COMMANDS.md` still has the `<fill in>`
placeholders. **Confirm this on Tuesday before relying on it**, because the "edit your
app, deploy again, same URL" beat is a good one for the panel and it is currently
unverified.

Against the 5-minute definition of done, 1:06 for the stack leaves plenty of room for
the interview and the packaging. Nothing here is a timing risk.

### Failure states seen, and what they meant

- `{"message":"Not Found"}` after a delete-and-redeploy: **stale URL**, not a routing
  bug. A recreated stack gets a new API id. The executor must read outputs fresh after
  every deploy and never cache a URL across a destroy.
- The static bucket must be emptied (`s3 rm --recursive`) before the stack will delete.
  This is a hard requirement on `destroy`, not a nicety.
- Account-level S3 Block Public Access needed no change; the bucket-level settings in
  the template were enough.

### Still true from the May POC

- CLI: `validate`, `deploy`, `status`, `watch`.
- API: `POST /plans/validate`, `POST /deployments`, `GET /deployments/{id}`.
- `deployme/src/schema.js` — planVersion 0.2 schema, five modules, frozen.

## Not started

- `deployme/src/executor/` — does not exist.
- `deployme/src/mappings.js` — still points at `cfn/*.yaml`. The real files are
  `templates/http_api_serverless.yaml` and `templates/static_site_edge.yaml`. The paths
  are wrong and the dead `terraform:` block is still there.
- `prompts/` — has contract, plan template, banner, report template; missing the
  interview system prompt.
- CLI `init` and `destroy`.
- **Real status.** `POST /deployments` still fakes the lifecycle: a `setTimeout` flips
  status to `running` at 10 s and `succeeded` at 20 s, and `public_url` is hardcoded to
  `https://your-app-name.platform.app`. This contradicts the "status must be real, never
  fake success" rule and is the main thing the executor has to delete.

## Next — Tuesday

Build `deployme/src/executor/`. It turns the exact commands in `docs/DAY2-COMMANDS.md`
into code behind the existing endpoints. Nothing new is being designed; this is
transcription plus error handling.

1. **Fix `mappings.js`** to the real template paths under `templates/`, and drop the
   dead `terraform:` block while the file is open.
2. **Compose** — pick templates from the plan's enabled modules and resolve parameters
   (`AppName`, `ArtifactBucket` from `DEPLOYME_BUCKET`, `ArtifactKey`,
   `AdapterLayerVersion` from `DEPLOYME_LWA_VERSION`, `RetentionDays`).
3. **Package** — the staged-copy sequence above, in Node. Artifact key moves from
   today's `<app>/v<n>.zip` to `<app>/<deploymentId>.zip` so every deployment is its own
   object and a redeploy always changes `S3Key` (otherwise CloudFormation sees no diff
   and skips the function update). The developer's folder stays untouched.
4. **Deploy** — `CreateStack` / `UpdateStack` against `sealeye-<app>` (see the decision
   below), `CAPABILITY_NAMED_IAM` on the API stack.
5. **Poll** — `DescribeStacks` for status, mapped as:
   `CREATE_IN_PROGRESS` / `UPDATE_IN_PROGRESS` → `running`;
   `CREATE_COMPLETE` / `UPDATE_COMPLETE` → `succeeded`;
   anything containing `ROLLBACK` or `FAILED` → `failed`, surfacing the first
   `CREATE_FAILED` reason from `DescribeStackEvents`;
   `DELETE_IN_PROGRESS` → `destroying`.
   Then **delete the `setTimeout` simulation from `server.js`.**
6. **Report** — read `DescribeStacks` outputs fresh (`ApiUrl` / `WebsiteUrl`,
   `FunctionName`, `LogGroup`) and render `prompts/report.md` into
   `DEPLOYMENT_REPORT.md`.
7. **`DELETE /deployments/:id` + `sealeye destroy`** — for static, empty the bucket
   first; then `DeleteStack` and poll to `DELETE_COMPLETE`. Real status here too: a
   destroy that fails must say so.

Then, in the scope doc's drop order: CLI `init`, `observability_basic` (dashboard),
`config_basic`, and the recorded end-to-end run as insurance.

Also on Tuesday, cheaply: run the v2 redeploy once and fill in the two `<fill in>`
lines in `docs/DAY2-COMMANDS.md`.

## Decisions taken today

- **Lambda Web Adapter over a handler shim.** Chosen so the app is deployed unmodified
  and the "we never touched your code" claim is demonstrable on stage, not just stated.
  Cost: a pinned layer version (`DEPLOYME_LWA_VERSION=28`) that the executor carries as
  config, because the public layer will not let us list its versions.
- **HTTP API with `Target`, not explicit routes.** One `AWS::ApiGatewayV2::Api` with
  `Target` pointed at the function replaces the route + integration + stage + deployment
  resources, and gives the app the whole path space (which is what a "deploy my app"
  product should do). Fewer resources also means a faster create — part of the 1:06.
- **No CloudFront on the static path**, per the hard rules. Accepted consequence: the
  static site URL is `http://`, and the demo narration has to not stumble over that.
- **Public bucket at the bucket level, not by changing account settings.** The template
  is self-contained; running the demo does not require touching account-wide S3
  settings.
- **Templates were deployed by hand before any executor code was written.** Every
  command is recorded in `docs/DAY2-COMMANDS.md`. The point is that Tuesday's executor
  is transcribing a sequence that is known to work against real AWS, rather than
  debugging CloudFormation and JavaScript at the same time.
- **Day 1's open question is resolved: executor first, `init` second.** Today settled
  the shape of what the executor consumes — app name, module, artifact — which is small
  and stable enough that `init` can be written against it later without the executor
  being built on a guess.

## Open question

Stack naming. `CLAUDE.md` says stacks are `sealeye-<app>`; today's hand-run stacks are
`dep-sample-expressjs` and `dep-static-website`. The rule wins and the executor should
create `sealeye-<app>`, but that means the stacks currently in the account are named
something the code will never look up. Decide Tuesday whether to delete the `dep-*`
stacks first or just leave them and let the executor create fresh ones — either way,
they are stray AWS resources that should not still exist on Oct 2.
