# Phase 2 plan: a team release, the secret store, then day-two parity

Written Sun Oct 11, 2026, after PHASE1-PLAN Steps 8 to 14 shipped (pull requests #8 to
#16). Nothing in it is built yet.

The plan has three parts, in the order the dependencies force.

- **Part A** (Steps 1 to 6) finishes Phase 1 for a friendly team. Each team sees only its
  own environments, and two teams can each have an app of the same name. Then come the three
  pieces of preparation for the second-person test, and the test itself (PHASE1-PLAN
  Step 15).
- **Part B** (Steps 7 to 12) is ROADMAP Phase 1 item 10, the one item owed: setting
  values move to the organization's secret store.
- **Part C** (Steps 13 to 20) is ROADMAP Phase 2: it closes the parity table for every
  operation that exists, and builds the day-two operations that do not exist yet.

What this plan deliberately leaves for later, and what should bring each item forward,
is at the end under "Owed after this plan". Read that section before offering seaLeye to
anyone beyond a friendly team.

## What the code looks like today

These facts shape every step below.

- **Visibility stops at the organization.** `canSee` in `api/server.js` compares only the
  record's organization with the caller's. Every token and every record is organization
  `default`, so anyone with a token sees every environment, its history and evidence,
  and can tear it down. Tokens already carry a team (`checkHolder` in `api/tokens.js`),
  and every record made since Step 13 carries `teamId`. Records imported from Greg's
  laptop are team `default`.
- **One app name is one environment, whoever owns it.** Stacks are `sealeye-<app>`
  (`stackNameFor` in `api/executor/compose.js`), with no team or person in the name.
  `POST /deployments` never checks who owns a live environment of that name. A tester
  who deploys `apps/static-website` while Greg has one live updates Greg's environment.
  Both records then point at one stack, and tearing down either removes both. This must
  be fixed before Step 15, because the welcome note sends the tester to the sample apps.
  The app name also becomes the function, log group and static site bucket names (the
  templates take it as `AppName`), so every one of those collides the same way.
- **Interviews are already personal.** An interview is its starter's, and anyone else
  gets "not found" for it. Nothing changes there.
- **The needs ledger is organization-wide on purpose.** It is the platform team's view of
  what drafted plans wait on (`api/needs.js`), and it names apps and needs, not people.
- **`sealeye doctor` still checks a laptop API.** It wants the AWS CLI, AWS credentials,
  `SEALEYE_BUCKET` and the adapter layer. A tester on the hosted API will see failures
  that mean nothing for them.
- **Setting values are decided in one place.** `settingValues` in
  `api/executor/settings.js` takes them from the deploy request (`sent`), a `.env` the
  API can read, or the plan's placeholder. A record keeps each setting's name and
  source, never its value. Item 10 adds a source there; the rest of the executor does not
  change.
- **The injected start script is one line.** `templates/run.sh` is `exec node <entry>`.
  Item 10 makes it read the values first, so the app is still not modified.
- **The packaged artifact outlives the upload.** The uploaded folder is deleted when a
  deployment finishes, but the packaged zip stays in the artifact bucket at
  `<app>/<deploymentId>.zip`. Once values come from the store, a re-run can redeploy that
  artifact with no folder at all, which is what the portal needs (Step 14).
- **The deploy role cannot yet read what day-two needs.** `deploy/deploy-role.yaml` has
  no permission to read logs, read metrics, set a function's concurrency, read costs or
  touch a parameter store. Each day-two step adds only what it needs, in the same commit.

## Decisions this plan needs from Greg

Per CLAUDE.md, nothing is built past an open question. These are the calls, each with a
recommendation. Each answer goes in DESIGN.md with its date and reason, and the
"Decided" column is filled in here.

| # | Decision | Recommendation | Needed by | Decided |
|---|---|---|---|---|
| D1 | Who sees what | A person sees their own team's environments. A token marked organization-wide (Greg's) sees them all. The needs ledger stays organization-wide. | Step 1 | As recommended (Sun Oct 11) |
| D2 | Two teams, one app name | Each team's environment gets an internal name, `<team>-<app>`, and every name in AWS comes from it. The developer still sees only the app name. | Step 2 | Two teams can each have an app of the same name. Within a team, one app name is one dev environment and one path to production. Organizations are not considered, since each will run in its own account. (Sun Oct 11) |
| D3 | Which secret store | Parameter Store, SecureString, under `/sealeye-apps/<team>/<app>/`, in the team's account and region | Step 7 | |
| D4 | How the app reads its values at start | The start script runs a small reader before the app, using the AWS SDK that ships in the Node 20 runtime. Confirm it in Step 7 before building. | Step 7 | |
| D5 | Apps already deployed with sent values | Not moved automatically. Their next `sealeye run` offers to store what `.env` holds. A list for Greg shows who is still on sent values. | Step 11 | |
| D6 | Where the portal's interview gets the app | A folder chosen in the browser, zipped there under the same rules as the command's upload. Connecting a repository comes later. | Step 15 | |
| D7 | What pause means | API apps only, for now: the function stops taking requests, and resume undoes it. A static site says plainly it cannot be paused. | Step 17 | |
| D8 | Integrations | Move it to Phase 4, where ServiceNow, Jira and Teams are. Drop it from Phase 2. | Step 13 | |

**Why D1 has an organization-wide token rather than real roles.** Real roles belong to
sign-in (Q3, Cognito groups). A token is either team-scoped or organization-wide, set when
it is issued, and that is enough for a pilot run by one administrator. The shape is
`req.caller.scope`, which a Cognito group can fill later without changing the checks.

**Why D2 names environments by team rather than refusing a second team.** The first
recommendation was to refuse a second team's deploy while the first team's environment
was live. Greg chose otherwise on Oct 11: common names such as `test-app` would collide
often, and a developer should not have to rename their app because of a team they cannot
see. It costs about a day more than the refusal. No migration is needed, because every
record already keeps its `stackName`: existing environments keep their names, a re-run
uses the name on the team's latest record for that app, and only new environments get
the new names. The organization is left out of the name, because each organization will
deploy into its own account (item 5), where names only need to be unique within that
account. If two organizations ever share one account before then, the rule gains the
organization in one line.

**Why D3 is Parameter Store and not Secrets Manager.** Standard SecureString parameters
cost nothing to store, encrypt with the account's KMS key, live in ca-central-1, and can
be read by path, so a function's role can be limited to its own app's folder. Secrets
Manager costs about $0.40 per secret a month and adds rotation, which these values do not
need yet. A bank that already runs Secrets Manager or Vault is a new source in
`settingValues`, not a rewrite. The prefix is `/sealeye-apps/`, not `/sealeye/`, because
`/sealeye/` holds seaLeye's own keys and no app may ever be able to read them.

**Why D4 needs a check first.** CloudFormation can resolve a parameter into a property,
but `ssm-secure` references are not accepted for a function's environment variables, and
a resolved Secrets Manager reference leaves the value in the function's configuration for
anyone with read access to see. So the value has to be read when the app starts. The two
ways are the SDK that ships in the runtime, or AWS's Parameters and Secrets extension
layer, called over localhost. The SDK route adds no layer and nothing for the developer
to see. Step 7 proves it on the beneficiary-lookup sample before anything else is built.
The executor's "no AWS SDK" rule is about seaLeye's own process. This runs inside the
developer's function, so it is a separate decision for DESIGN.md.

## Part A: finish Phase 1 for a friendly team

Branch from `main`. Steps 1 and 2 are one pull request, reviewed by an independent agent
before it is opened, because they decide who can see and destroy whose environments.
Steps 3 to 5 are documents and can share a second pull request.

### Step 1. Each team sees its own environments (D1)

*Built Sun Oct 11, 2026 (DESIGN.md, "Each team sees its own environments"). Evidence
history also stays within the record's team, so another team's draft of the same app
name never shows in it. The needs ledger leaves out another team's evidence and
deployment ids, as Greg decided after the independent review.*

- `api/migrations/004_token_scope.sql` adds `scope` to `tokens` (`team` or `org`, default
  `team`). `fromRow` and the file store read it; a token without one is `team`.
- `deploy/server.sh token add` takes `--org-wide`. `token list` shows the scope.
- `canSee` in `api/server.js` becomes: same organization, and either the same team or an
  organization-wide caller. It already guards list, status, evidence and tear down, so
  those four change together. With `SEALEYE_AUTH=off` (a laptop API) it is unchanged.
- `GET /needs` keeps reading every record in the organization, on purpose (see "What the
  code looks like today"). A comment says why, so nobody narrows it later by mistake.
- `GET /whoami` returns the scope. `sealeye whoami` and `sealeye doctor` say "team
  pilot-2" or "the whole organization". The portal's header says whose environments you
  are looking at.
- Greg's records imported from his laptop are team `default`. His own token is reissued
  as organization-wide, so he keeps seeing everything.
- Tests: a team token sees only its team on all four routes, and gets "not found"
  rather than "forbidden" for another team's record, as interviews already do. An
  organization-wide token sees everything. A token issued before this change is `team`.

**Done when:** two tokens on two teams each see only their own environments in
`sealeye list` and in the portal, and Greg's organization-wide token sees both.

### Step 2. Each team's environments have names of their own (D2)

*Built Sun Oct 11, 2026 (DESIGN.md, "Each team's environments have names of their
own"). Some things differ from the plan below, and DESIGN.md says why: the name always
ends in a short hash; the deploy role keeps "any function" until no environment from
before this is left; a stack two teams already share stays with the team that deployed to it
last; and an organization-wide token's views say whose each environment
is.*

About a day and a half to two days. Today the app name becomes these names in the one
shared account, and the first four collide between teams:

| What | Named before this step | Named after it |
|---|---|---|
| Stack | `sealeye-<app>` | `sealeye-<team>-<app>-<hash>` |
| Function | `<app>` | the same name |
| Log group | `/aws/lambda/<app>` | `/aws/lambda/<the same name>` |
| Static site bucket | `<app>-<account>` | `<the same name>-<account>` |
| API | `<app>` | the same name (API names need not be unique; this is for clarity) |
| Uploaded artifact | `<app>/<deploymentId>.zip` | `<the same name>/<deploymentId>.zip` |

- `environmentName` in `core/names.js` is the one rule: the team, the app, and six hex
  characters of a hash of the organization, team and app, which keeps names that
  hyphens make ambiguous apart. The readable part stops at 34 characters, so a name is at
  most 49, inside the 64-character limit on function names and 63 on bucket names. Team
  ids are already lowercase letters, digits and hyphens (`checkHolder`).
- `api/executor/compose.js` gives both templates that name as `AppName` instead of the
  bare app name. The deploy role needs no change: its patterns already match.
- **No migration.** `namingFor` reuses the names on the caller's team's latest record for
  the app, unless it was torn down, so Greg's existing environments keep their old names.
  Only a first deploy gets the new name. Tests cover both.
- **Within a team, one app name is one environment.** A teammate's `sealeye run` in their
  copy of the app updates the team's environment, and the record says who did it, as
  today.
- `sealeye run` finds a folder's environment by its app name rather than by
  `sealeye-<app>`. `sealeye destroy`, `status`, `watch` and `evidence` given an app name
  already match it, among the environments the caller can see (Step 1). Both surfaces
  group a draft by team and app. The needs ledger counts the same app name on two teams
  as two apps.
- The developer sees only the app name, in the command, the portal and every file
  seaLeye writes. The one place the team shows is a static site's address, which comes
  from its bucket's name.
- Check it for real after the release: deploy one static site and one API on two teams
  with the same app name, then tear each down from the other surface.

**Done when:** the tester deploys a sample app Greg also has live, both environments
work side by side, and tearing down either leaves the other untouched.

### Step 3. The welcome note

`docs/WELCOME.md`, sent to the tester by email with their token. Plain language, no AWS
terms, no em dashes, and nothing a token holder could not already see.

- What seaLeye is, in three sentences.
- Install: `curl -fsSL https://sealeye.run/install | sh`, and what the installer needs
  (Node 20 or later).
- Sign in: `sealeye login`, then paste the token. Never put it on the command line.
  `sealeye whoami` shows who you are.
- A first run: copy a sample app out of the repo (they get a zip of `apps/`, since the
  repo is private), then `sealeye run` in that folder. The name can stay as it is, since
  another team's app of the same name is a separate environment (Step 2). Expect up to four questions, a plan, and "Deploy this?".
- The portal: sign in at https://sealeye.online with the same token, find the
  environment, then tear it down from Control.
- Try `apps/payment-events-processor` too, to see a refusal with evidence.
- What to do when something goes wrong: send Greg the deployment id and a screenshot.
  Don't run `sealeye doctor` yet, since some of its checks are for a laptop setup (see
  Step 5).

**Done when:** Greg has read it as if he had never seen seaLeye, and it asks nothing he
would have to explain.

### Step 4. Greg's observation checklist

`docs/STEP15-CHECKLIST.md`: one page to fill in while watching, not helping.

- Time to each milestone: installed, signed in, first question, plan shown, URL working,
  seen in the portal, torn down.
- Every place they hesitated, reread, or asked a question, with the exact words.
- Every message that was wrong, unclear, or used a term a developer would not use.
- Whether they trusted the plan, and whether they read it before saying yes.
- What they expected the portal to do that it doesn't.
- After the test: the deployment and interview ids, and the LangFuse trace for the run
  (sample apps only, so tracing stays on).

**Done when:** it fits on one page and Greg can fill it in without looking at the
screen he is watching.

### Step 5. What is owed before a wider team

Greg reviews "Owed after this plan" below with Claude, and decides for each item whether
it blocks the friendly team, blocks a wider team, or neither. Two small items are
candidates to fix before Step 6, and are his call:

- `sealeye doctor` checks only what a developer using the hosted API needs (Node, the
  API, the token) unless `SEALEYE_API` points at a laptop API. About two hours.
- The `--ignore-scripts` decision ("Installing an app's dependencies runs none of its
  code") was raised and never confirmed. Confirm it or reverse it.

**Done when:** each item in that section has a decision written next to it.

*Prepared Oct 11, 2026: docs/WELCOME.md (Step 3), docs/STEP15-CHECKLIST.md (Step 4), and
recommendations under "Step 5: recommendations, for Greg to decide".*

### Step 6. The second-person test (PHASE1-PLAN Step 15)

- Release Steps 1 and 2 (`deploy/release.sh`). Reissue Greg's token as organization-wide.
- Issue the tester a token on a team of their own:
  `deploy/server.sh token add <their email> "<their name>" pilot-2`.
- Send the welcome note and the token separately.
- Watch, with the checklist. Do not do anything for them.
- Afterwards: fix what blocked them, file the rest as rows in ROADMAP, and mark the
  Phase 1 "done when" lines met in ROADMAP.md with the date.

**Done when:** the tester ran `sealeye run`, got a URL, saw it on seaLeye.online and tore
it down from the portal, on their own machine, with only the token and the installer.

## Part B: the secret store (ROADMAP Phase 1 item 10)

Due before any pilot that deploys an organization's real secrets. It also comes before
Part C, because three Part C steps (re-run from the portal, the portal interview, and
Configure) would otherwise be built on sent values and then rebuilt. Steps 7 to 12 are one
branch. Have an independent agent review it before the pull request, as with sign-in.

### Step 7. Prove the read path (D3, D4)

Half a day, before anything else in Part B.

- By hand, in the pilot account: put one SecureString under
  `/sealeye-apps/default/beneficiary-lookup-api/`, deploy the sample with a start script
  that reads its folder and exports the values, and check that the app sees them.
- Check the cold start cost. Check that a role limited to that folder cannot read
  `/sealeye/` or another app's folder.
- If the runtime SDK route fails, fall back to the extension layer, and record why.

**Done when:** D3 and D4 are in DESIGN.md with what Step 7 measured.

### Step 8. Putting values in, on both surfaces

- API: `PUT /apps/{app}/settings/{name}` with `{ value }`, and `GET /apps/{app}/settings`
  returning names, whether each is set, and when, never values. The API writes through
  the deploy role, to the caller's team folder only. Values never reach a record, a log,
  a trace or a response.
- Command: `sealeye secrets set <NAME>` reads the value without echoing it, or from a
  pipe, never as an argument (the `sealeye login` pattern). `sealeye secrets` lists the
  names and whether each is set.
- Portal: a Settings tab in Control with names, "set" or "not set", and a field to set
  one. It never shows a value back.
- The deploy role gets `ssm:PutParameter`, `ssm:GetParametersByPath` and
  `ssm:DeleteParameter` on `/sealeye-apps/*` only, and the KMS permission to encrypt.
- Settle the command name in DESIGN.md first, as ROADMAP asks.

### Step 9. The plan says where each value lives

- planVersion 0.5: each `config_basic` variable says where its value comes from (`store`
  or `plan`). 0.4 plans still load, with every variable read as before.
- The interview prompt and the plan contract change, so run `npm run eval:interview`
  before and after.
- `core/schema.js` is the only file that knows 0.4.

### Step 10. The app reads its values when it starts

- `templates/run.sh` runs the reader from Step 7, then `exec node <entry>`. The
  developer's folder is still untouched.
- The function's role may read only `/sealeye-apps/<team>/<app>/`.
- `settingValues` gains the `store` source. A deploy then sends names only, and a record
  says the value came from the store.

### Step 11. Moving apps over (D5)

- On the first `sealeye run` of an app whose `.env` holds values the plan wants, the
  command offers once to store them, and lists the names it would store.
- `sealeye run` says once, in one line, that deployed settings come from the store and
  not from `.env`.
- `deploy/server.sh settings-sources` lists the live environments whose records still say
  `sent` or `.env`, for Greg to follow up.
- The `sent` path stays for a laptop API and the sample apps.

### Step 12. Write it down

- DESIGN.md: the store, the read path, the migration, and what the `sent` path is still
  for.
- CLAUDE.md "Current limits": replace the sent-values paragraph.
- ROADMAP: item 10 done, with the date. The parity row "Settings in the secret store"
  moves to `built`.

**Done when (Part B):** a sample app deployed after this reads its values from the store,
no value appears in any record, log, trace, report or portal page (check by searching the
database dump and the trace for a known test value), and an app on sent values still
deploys.

## Part C: day-two parity (ROADMAP Phase 2)

Each operation starts as an API endpoint, then gets a command and a portal page with the
same name, inputs and outputs (CLAUDE.md, principle 1). Each new command name is settled
in DESIGN.md before it is built. The parity table row moves in the same commit.

Part C is ordered cheapest first. The API already exists for Steps 13 to 14, and
the operations in Steps 16 to 20 need new endpoints and new permissions.

### Step 13. Portal pages for operations the API already has

About two to three days.

- **Evidence:** a tab in Control that renders `GET /deployments/{id}/evidence`, with the
  same content `sealeye evidence` writes, and a download of the markdown. It changes
  nothing and creates nothing.
- **Health:** a page showing `GET /health` and `GET /whoami`, the portal's
  `sealeye doctor`.
- **Validate a plan:** paste or drop a `sealeye.yaml` and see `POST /plans/validate`'s
  answer, needs included.
- **Deploy an existing plan:** from a validated plan, deploy it with the app's last
  packaged artifact (Step 14 adds the endpoint input).
- Integrations moves to Phase 4 if D8 says so. ROADMAP's Phase 2 list and the parity row
  change in the same commit.

### Step 14. Re-run on a live environment from the portal

About a day, and only after Part B.

- `POST /deployments` accepts `fromDeployment` (an id the caller can see) instead of a
  zip. The API redeploys that deployment's packaged artifact with the plan given, and
  settings come from the store. This is a new input; existing calls are unchanged.
- Control gets "Deploy again". The record says it came from the portal.

### Step 15. A new environment from the portal (the interview) (D6)

About four to six days. The headline portal feature.

- The browser zips a chosen folder under the same rules as `core/upload.js`: respect
  `.gitignore`, never send `node_modules` or `.git`, and send secret files as names only.
  The rules move into a part of `core/` that runs in a browser as well as Node (the
  `secretFileReason` list and the ignore rules), so there is one list, not two. A test
  runs both against the same folder.
- A New environment page drives `POST /interviews`, renders `GET /interviews/{id}/events`
  (steps, questions, the plan, the files), sends answers, and ends at the same "Deploy
  this?" boundary. A no saves the plan, as the command does.
- An interview the command started can be finished in the portal by the same person,
  since LangGraph keeps it by id (PHASE1-PLAN D8). Test it.
- Playwright tests run against the test API with a stand-in model.

### Steps 16 to 20. Operations that do not exist yet

Each one is an endpoint, a command and a portal page, with the deploy role permission it
needs added in the same commit. Greg rolls out each role change on his Mac.

| Step | Operation | What it reads or changes | Permission added | Effort |
|---|---|---|---|---|
| 16 | **Logs** | The function's log group, most recent first, with a time window. A static site has none and says so. | `logs:FilterLogEvents` on `/aws/lambda/*` | 1.5 to 2 days |
| 17 | **Pause and resume** (D7) | The function's reserved concurrency set to zero and back. Status is read back from AWS, never assumed. | `lambda:PutFunctionConcurrency`, `lambda:DeleteFunctionConcurrency` | about 1.5 days |
| 18 | **Configure** | Setting values (through Part B's store) and log retention. A retention change is a redeploy and says so. | none new | 1 to 2 days |
| 19 | **Team** | The people on your team, from the tokens table: name, email, issued, last used. No hashes. Issuing stays on the administrator's Mac. | none | about a day |
| 20 | **Performance**, then **Costs** | Requests, errors and response times from metrics; then cost by environment from billing data, with its one-day lag stated. | `cloudwatch:GetMetricData`; then `ce:GetCostAndUsage` | 2 days, then 2 days |

Notes on these:

- **Logs are the developer's own output, and may hold anything.** They pass through the
  same masking as traces (`core/tracing.js`) before they reach either surface. This is a
  principle-6 decision for DESIGN.md, not a detail.
- **Performance shows readings, not capacity.** Principle 8 bans sizes, counts and
  capacity in plans, cards and files. Measured requests and response times are a
  different thing, and a DESIGN.md entry should say so before the page is built.
- **Costs need tags first.** Stacks get a `sealeye:app` and `sealeye:team` tag at deploy,
  and Greg activates them as cost allocation tags in the billing console (a one-time
  step, about a day before data shows). Each billing request costs about one cent, so the
  API caches answers for an hour.

## Order and rough effort

| Steps | What | Effort |
|---|---|---|
| 1 to 2 | Team visibility, environment names per team | two to three days |
| 3 to 5 | Welcome note, checklist, review of what is owed | half a day |
| 6 | **The second-person test.** Phase 1 "done when" | an hour to watch, then fixes |
| 7 | Prove the read path | half a day |
| 8 to 12 | The secret store, on both surfaces | three to five days |
| 13 to 14 | Portal pages for existing operations, re-run | three to four days |
| 15 | The interview in the portal | four to six days |
| 16 to 20 | Logs, pause, configure, team, performance, costs | eight to ten days |

Steps 1, 2 and 8 to 10 are where the safety of this plan is decided: who can see and
destroy what, and where secret values go. Review those diffs line by line.

## Owed after this plan

Not in this plan, on purpose. Each is still owed, with what should bring it forward.
Step 5 records a decision next to each.

| Item | Where it stands | Bring it forward when |
|---|---|---|
| **ROADMAP Phase 1 item 5: AWS access per team** | Every deploy goes through `sealeye-deploy-pilot` in the one pilot account. It is designed for a role per team account (DESIGN.md, "Phase 1: who it is for"), so adding one is configuration, not a rewrite. | A team brings its own AWS account, or any bank pilot. |
| **ROADMAP Phase 1 item 3: real sign-in** | Cognito was chosen on Oct 9 (DESIGN.md, "Phase 1: who it is for"). How it replaces tokens and portal sessions is open (OPEN-QUESTIONS Q15). Tokens fill `req.caller` in the shape Cognito will. | More than a handful of people, anyone outside Greg's reach to issue a token by hand, or any bank pilot. It gets its own plan. |
| **Q10: publishing the command** | Installed from a tarball on sealeye.run. | Someone needs to pin a version, or the pilot grows past people Greg sends the link to. |
| **Q13: where traces live** | Tracing is fine on the sample apps. The leaning is tracing off for real code. | Any pilot on real code with tracing on. |
| **The database moves to RDS** (DESIGN.md stage 2) | Postgres in a container, with a nightly dump that has been tested once. | Someone else's data matters: arguably the first team that deploys its own app, not the Step 15 tester on sample apps. |
| **ECS Express Mode** (DESIGN.md stage 3) | One small server. | Downtime becomes the problem: a second team, or anyone who expects it to stay up. |
| **Q14: an AI gateway** | Not for the pilot. | A second team uses the API and spend per person matters. |
| **Install scripts** | Dependencies install with `--ignore-scripts`. Raised to Greg, not confirmed. | Step 5. |
| **Small gaps** | Expired portal sessions are cleared only at sign-in. A race between token writes in file mode is narrowed, not removed. The package still installs the API's dependencies. `sealeye doctor` checks laptop AWS tools (unless Step 5 fixes it). The pages ask not to be indexed. | Any of them causing trouble, or the end of the pilot. |
| **Narrow the deploy role to `sealeye-*` functions** | Functions made since Step 2 are `sealeye-*`; older ones are named after the bare app, so the role still allows any function in the account. | No environment from before Step 2 is left: tear down and redeploy Greg's older API environments. |
| **Old remote branches** | Merged branches are still on GitHub. These sessions cannot delete them. | Greg prunes them when convenient. |

### Step 5: recommendations, for Greg to decide

For each item: does it block the friendly team (Step 6, sample apps), a wider team (more
people, their own apps, still in the pilot account), or neither yet? Greg fills in
"Decided". Part B (the secret store) is not in this list because it is planned: it is
due before any team deploys real secrets.

| Item | Friendly team | Wider team | Recommendation | Decided |
|---|---|---|---|---|
| Item 5: AWS access per team | no | no, unless a team brings its own account | Leave until a team or a bank brings an account. | |
| Item 3: real sign-in | no | yes, past a handful of people | Its own plan, started before the wider team. Tokens are fine for the friendly team. | |
| Q10: publishing the command | no | no | Leave. The installer works; publish when someone needs to pin a version. | |
| Q13: where traces live | no (sample apps) | yes, once a team runs its own code | Before a team runs its own code, set tracing off on the server, or answer Q13 first. | |
| RDS for the database | no | yes | Before the first team deploys its own app: its records then matter, and RDS gives restore to a point in time. About half a day. | |
| ECS Express Mode | no | no | Leave until downtime matters. | |
| Q14: an AI gateway | no | no | Leave. | |
| Install scripts stay off | no | no | Confirm (DESIGN.md, "Installing an app's dependencies runs none of its code"): unreviewed install scripts never run on the server, which can reach its role and database. The cost: a package that builds native code at install (such as `bcrypt` or `sharp`) is not built, so an app that needs one will not work, and nothing says why yet. | |
| `sealeye doctor` for the hosted API | yes, mildly | yes | Fix before Step 6, about two hours, and drop the "do not run doctor" line from docs/WELCOME.md. A tester will run it. | |
| Other small gaps | no | no | Leave. | |
| Old remote branches | no | no | Prune when convenient. | |
