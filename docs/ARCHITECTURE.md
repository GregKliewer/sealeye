# seaLeye: architecture

First written Oct 12, 2026, at 2.20.0 (main at PR #31); brought up to date Oct 22,
2026, at 2.46.9, as Phase 4's build ended (PHASE4-PLAN Step 11); diagrams redrawn Oct 23,
2026, at 2.48.1, for the Terraform executor, connected modules and the private network.
This file describes the
system as it is built today. Why each part is the way it is lives in [DESIGN.md](../DESIGN.md);
where it is going lives in [VISION.md](VISION.md) and [ROADMAP.md](ROADMAP.md). When a
change makes a diagram here wrong, fix the diagram in the same commit.

The diagrams are Mermaid, so GitHub draws them and a change to one is a change to text.
The C4 views are drawn as Mermaid flowcharts in the C4 style rather than with Mermaid's
own C4 syntax, which GitHub still draws poorly.

## Contents

1. [The system in one paragraph](#1-the-system-in-one-paragraph)
2. [Goals and constraints](#2-goals-and-constraints)
3. [Context (C4 level 1)](#3-context-c4-level-1)
4. [Containers (C4 level 2)](#4-containers-c4-level-2)
5. [Inside the API (C4 level 3)](#5-inside-the-api-c4-level-3)
6. [Deployment](#6-deployment)
7. [Key flows](#7-key-flows)
8. [Data](#8-data)
9. [Security model](#9-security-model)
10. [Cross-cutting concerns](#10-cross-cutting-concerns)
11. [Decision index](#11-decision-index)
12. [Known limits and where they go next](#12-known-limits-and-where-they-go-next)

## 1. The system in one paragraph

A developer brings an app. The `sealeye` command (seaLeye.run) or the web portal
(seaLeye.online) uploads a filtered copy of it to the seaLeye API. The API runs an
interview, a LangGraph graph around a Claude model, that reads the copy, asks the
developer at most four questions and submits a plan. The API checks the plan against the
plan contract: a plan whose app needs something the platform cannot build is saved as a
draft and refused, with evidence; a ready plan, once the developer says yes, is
packaged and built through a role that can build nothing else: from one of seaLeye's
own CloudFormation templates, or, for an organization whose own Terraform library
discovery has read into a live catalog, from that organization's modules with
OpenTofu. The API keeps the record, mirrors the real status, and serves every day-two
operation (settings, logs, performance, costs, pause, evidence, tear down) to both
surfaces through the same endpoints. A platform team runs discovery over its library,
approves the catalog it drafts, and reads a gap report of what developers asked for
that the catalog cannot build.

## 2. Goals and constraints

| Goal | What it means for the architecture |
|---|---|
| **Parity** | One API; the command and the portal are thin clients of it. An operation is an endpoint first. |
| **Only the certified platform** | The API builds only from `templates/` (CloudFormation) or the organization's own released modules in a live catalog (OpenTofu), each through a role scoped to seaLeye's names and a permissions boundary on every function. |
| **Refuse, never shrink** | The plan contract (`core/schema.js`) decides ready or drafted; the API refuses drafted plans itself, whatever the client says. |
| **Real status** | A deployment's status mirrors its stack, polled by the API every few seconds; pause state, logs, readings and costs are read from AWS when asked. Nothing is assumed. |
| **No secrets anywhere** | Secret files never leave the developer's machine with contents; setting values go to the organization's store and are never kept, logged or shown. |
| **The developer's code is theirs** | The app is never changed. What the platform needs is injected into the packaged copy. |
| **Cheap to run and to change** | One small server, plain SQL migrations, the AWS CLI instead of an SDK, tests that need no AWS and no model. |

Constraints today: one cloud (AWS), one region (ca-central-1), two backends
(CloudFormation for the starter's modules, OpenTofu for an organization's own), one stage
(dev), one runtime (Node 20), one API process.

## 3. Context (C4 level 1)

Who uses seaLeye and what it depends on.

```mermaid
flowchart TB
  dev["<b>Developer</b><br/>[Person]<br/>Brings an app, wants an environment"]
  admin["<b>seaLeye administrator</b><br/>[Person]<br/>Issues tokens, releases seaLeye,<br/>parks and unparks the pilot"]
  platform["<b>Platform team</b><br/>[Person, organization-wide token]<br/>Runs discovery, approves and makes<br/>catalogs live, sets platform values,<br/>reads the gap report"]
  control["<b>Control partners</b><br/>[Person]<br/>Read evidence and records"]

  sealeye["<b>seaLeye</b><br/>[Software system]<br/>Interviews the app, plans, refuses or builds,<br/>and manages the environment over time"]

  aws["<b>The organization's AWS</b><br/>[External system]<br/>Where environments are built,<br/>Terraform state is kept<br/>and app settings are stored"]
  anthropic["<b>Anthropic</b><br/>[External system]<br/>The model behind the interview"]
  langfuse["<b>LangFuse</b><br/>[External system]<br/>Interview traces and scores<br/>(optional)"]
  github["<b>GitHub</b><br/>[External system]<br/>Source, tests, image builds"]
  library["<b>The organization's platform library</b><br/>[External system, on GitHub]<br/>Its Terraform modules, released by tag,<br/>and its pipeline"]

  dev -- "sealeye run, or the portal" --> sealeye
  admin -- "tokens, releases" --> sealeye
  platform -- "sealeye discover, catalog, platform,<br/>gaps, or the portal" --> sealeye
  control -- "evidence, history" --> sealeye
  sealeye -- "builds and reads environments" --> aws
  sealeye -- "model calls" --> anthropic
  sealeye -. "traces, no file contents" .-> langfuse
  github -- "tested image" --> sealeye
  sealeye -- "reads one commit or a module's release,<br/>read-only (discovery and every build)" --> library

  classDef person fill:#08427b,stroke:#052e56,color:#fff
  classDef system fill:#1168bd,stroke:#0b4884,color:#fff
  classDef external fill:#999,stroke:#6b6b6b,color:#fff
  class dev,admin,platform,control person
  class sealeye system
  class aws,anthropic,langfuse,github,library external
```

## 4. Containers (C4 level 2)

The deployable parts. Every arrow into the API is HTTPS with a token or the portal's
session cookie.

```mermaid
flowchart TB
  dev["<b>Developer</b><br/>[Person]"]

  subgraph laptop["Developer's machine"]
    cli["<b>sealeye command</b><br/>[Node 20 CLI, cli/ + core/]<br/>Uploads the app, streams the interview,<br/>writes DEPLOYMENT_PLAN.md and the report"]
  end

  subgraph browser["Browser"]
    portal["<b>seaLeye.online portal</b><br/>[React, TypeScript, Vite, portal/]<br/>Every operation the command has,<br/>as pages"]
  end

  subgraph server["Pilot server (one EC2 instance)"]
    caddy["<b>Caddy</b><br/>[Reverse proxy]<br/>TLS for every domain; serves the portal,<br/>seaLeye.run and the installer"]
    api["<b>seaLeye API</b><br/>[Node 20, Express, api/ + core/,<br/>OpenTofu in the image]<br/>Interview, discovery, plan contract,<br/>both executors, day-two operations"]
    pg[("<b>Postgres 16</b><br/>[Database]<br/>Records, tokens, sessions,<br/>setting changes, interviews")]
    gw["<b>Model gateway</b><br/>[agentgateway, deploy/gateway.yaml]<br/>Holds the model key; the API's key<br/>and the 30-day money budget"]
  end

  subgraph aws["The organization's AWS account"]
    cfn["<b>CloudFormation</b><br/>One stack per starter environment"]
    s3a[("<b>Artifact bucket</b><br/>Packaged app zips;<br/>tofu-state/org/environment.tfstate<br/>and its lock file")]
    ssm[("<b>Parameter Store</b><br/>App setting values,<br/>/sealeye-apps/team/app/")]
    envs["<b>Starter environments</b><br/>Lambda + HTTP API,<br/>or an S3 static site"]
    subgraph net["Foundation network (platform-sealeye-foundation)"]
      tfenvs["<b>Environments from the organization's modules</b><br/>The app's module (an API or a site)<br/>and the parts it uses: table, bucket,<br/>queue, Postgres with IAM sign-in"]
      vpce["<b>Private endpoints</b><br/>tables and buckets (free, foundation);<br/>Secrets Manager (platform-sealeye-endpoints)"]
    end
    cw["<b>CloudWatch, Cost Explorer</b><br/>Logs (the app's, the front door's,<br/>the database's), readings, costs"]
  end

  anthropic["<b>Anthropic API</b>"]
  langfuse["<b>LangFuse</b>"]
  libgh["<b>Platform library on GitHub</b>"]

  dev --> cli
  dev --> portal
  cli -- "HTTPS, Bearer token<br/>api.sealeye.online" --> caddy
  portal -- "HTTPS, session cookie<br/>sealeye.online/api" --> caddy
  caddy -- "HTTP :3000" --> api
  api -- "SQL" --> pg
  api -- "AWS CLI, as the deploy role" --> cfn
  api -- "tofu init, plan, apply, destroy,<br/>as the Terraform role" --> tfenvs
  api -- "upload; Terraform state" --> s3a
  api -- "put, list names" --> ssm
  api -- "read" --> cw
  cfn -- "creates" --> envs
  envs -- "read own settings at start" --> ssm
  tfenvs -- "no NAT: through" --> vpce
  api -- "model calls, the API's key<br/>and a token it signs per call" --> gw
  gw -- "model calls, the model key" --> anthropic
  api -. "traces" .-> langfuse
  api -- "one commit or a module's release<br/>as an archive, GitHub App<br/>or read-only token" --> libgh

  classDef person fill:#08427b,stroke:#052e56,color:#fff
  classDef container fill:#438dd5,stroke:#2e6295,color:#fff
  classDef store fill:#438dd5,stroke:#2e6295,color:#fff
  classDef external fill:#999,stroke:#6b6b6b,color:#fff
  class dev person
  class cli,portal,caddy,api,gw container
  class pg store
  class cfn,s3a,ssm,envs,tfenvs,vpce,cw,anthropic,langfuse,libgh external
```

| Container | Code | Talks to | Notes |
|---|---|---|---|
| `sealeye` command | `cli/`, `core/` | the API only | Holds a token (`~/.sealeye/config`, 0600), never a model key or AWS credentials for deploying. Installed from seaLeye.run. |
| Portal | `portal/` | the API only, at `/api` on its own origin | Imports a few browser-safe `core/` files so both surfaces say the same words. Every value on a page comes from an API call. |
| Caddy | `deploy/Caddyfile` | the API, static files Certificates for sealeye.online, api.sealeye.online and sealeye.run (sealeye.org is GitHub Pages). Passes the interview's event stream through unbuffered. |
| API | `api/`, `core/`, `prompts/`, `templates/` | Postgres, AWS (CLI and OpenTofu), the model gateway, LangFuse, GitHub | The only part that reaches AWS: the AWS CLI as the deploy role for the starter's templates, `tofu` (pinned in the image, providers from the image only) as the Terraform role for an organization's modules. One process. On the server it holds a key for the gateway, not a model key; on a laptop, with no `SEALEYE_GATEWAY_KEY`, it calls Anthropic with its own key. |
| Model gateway | `deploy/gateway.yaml`, `deploy/gateway.sh` | Anthropic | agentgateway, pinned by digest. The only part on the server that holds the model key. Lets through only the API's key with a token the API signed for that call (person, team, run, worker, surface), and logs those names; keeps a money budget for each 30-day period and a record of every call (90 days, read by `deploy/server.sh gateway-calls`) in its own SQLite file, and a per-run token limit in memory; logs no prompts or replies. On a network of its own that only the API joins; no published port. |
| Postgres | `api/migrations/` | | Reachable only from the API, on the server's own network. |

## 5. Inside the API (C4 level 3)

```mermaid
flowchart LR
  subgraph api["seaLeye API (api/)"]
    server["<b>server.js</b><br/>Routes, auth, scoping<br/>by organization and team"]
    tokens["<b>tokens.js</b><br/>Tokens and portal sessions,<br/>stored as hashes"]
    interview["<b>interview/</b><br/>graph.js, model.js, tools.js,<br/>service.js, pgstore.js"]
    discovery["<b>discovery/</b><br/>library, terraform, readers,<br/>draft, service, store"]
    validate["<b>validate.js, needs.js</b><br/>The plan contract,<br/>the needs ledger"]
    gaps["<b>gaps.js, self-test.js</b><br/>The gap report;<br/>a catalog's self-test"]
    catalogs["<b>catalogs.js</b><br/>Each organization's catalog,<br/>or the starter"]
    executor["<b>executor/</b><br/>compose, package, uploads,<br/>settings, report, evidence, resume"]
    terraform["<b>executor/terraform/</b><br/>the organization's module,<br/>root module, OpenTofu"]
    platform["<b>platform.js</b><br/>Each organization's<br/>platform values"]
    cfn["<b>executor/cfn.js</b><br/>Every AWS call but the<br/>artifact upload"]
    dayTwo["<b>logs, performance, costs,<br/>pause, team, setting-changes</b>"]
    store["<b>store.js, db.js</b><br/>Records in memory,<br/>written through to Postgres"]
    scan["<b>secret-scan.js</b><br/>The shared rules again,<br/>then gitleaks"]
  end

  core["<b>core/</b><br/>schema, catalog, names, upload rules,<br/>secrets, secret scan rules, tracing,<br/>plan, gap and platform-line words"]
  prompts["<b>prompts/, templates/</b><br/>System prompt, contract,<br/>module catalog, CloudFormation"]

  server --> tokens
  server --> interview
  server --> discovery
  discovery --> scan
  discovery --> catalogs
  discovery --> store
  discovery --> prompts
  server --> validate
  server --> gaps
  gaps --> validate
  gaps --> catalogs
  gaps --> platform
  server --> catalogs
  validate --> catalogs
  executor --> catalogs
  catalogs --> store
  catalogs --> prompts
  server --> executor
  server --> dayTwo
  server --> scan
  interview --> scan
  interview --> validate
  executor --> cfn
  executor --> terraform
  terraform --> cfn
  terraform --> discovery
  terraform --> platform
  validate --> platform
  server --> platform
  platform --> store
  dayTwo --> cfn
  executor --> store
  dayTwo --> store
  tokens --> store
  interview --> core
  validate --> core
  executor --> core
  interview --> prompts
  executor --> prompts
```

**The import boundary.** `cli/` and `api/` import from `core/` and never from each
other; `core/` imports only from `core/`; the portal may import a `core/` file only if it
runs in a browser. `test/boundaries.test.js` enforces it.

**The interview graph.** Each pause for the developer is a node of its own with no model
call before it, so resuming after a restart never repeats a model call.

```mermaid
stateDiagram-v2
  [*] --> begin
  begin --> model_turn
  model_turn --> tools: model used a tool
  model_turn --> ask: model asked a question
  model_turn --> model_turn: nudge (for example, no questions left)
  model_turn --> [*]: stopped (no plan, out of turns,<br/>or the run reached its spending cap)
  tools --> model_turn: list_files, read_file results,<br/>or contract errors (two retries)
  tools --> approve: submit_plan passed the contract check
  tools --> [*]: retries used up
  ask --> model_turn: the developer's answer
  approve --> [*]: yes or no
  note right of ask: interrupt() a question
  note right of approve: interrupt() "Deploy this? [y/N]"
```

## 6. Deployment

What runs where, and how a change reaches production.

```mermaid
flowchart TB
  subgraph gh["GitHub (GregKliewer/sealeye)"]
    actions["<b>GitHub Actions</b><br/>npm test with Postgres,<br/>portal Playwright tests;<br/>on main, builds the arm64 image"]
  end

  subgraph mac["Administrator's Mac"]
    release["<b>deploy/release.sh</b><br/>Builds the portal and package,<br/>sends the release"]
    serversh["<b>deploy/server.sh</b><br/>backup, restore-check, import,<br/>restart, logs, token add/revoke/list,<br/>gateway-restart, gateway-logs,<br/>gateway-calls"]
  end

  subgraph acct["AWS account, ca-central-1"]
    dns["<b>Route 53</b><br/>sealeye.online, sealeye.run,<br/>sealeye.org (to GitHub Pages)"]
    ecr[("<b>ECR</b><br/>sealeye-api images,<br/>immutable tags")]
    config[("<b>Config bucket</b><br/>server config, sites,<br/>nightly backups (30 days)")]
    ssmp[("<b>Parameter Store /sealeye/</b><br/>API settings and secrets;<br/>gateway/ holds the model key")]
    subgraph ec2["EC2 t4g.small, elastic IP, no SSH port"]
      subgraph compose["Docker Compose"]
        c1["caddy :80 :443"]
        c2["api :3000"]
        c3[("postgres :5432")]
        c4["gateway :4000<br/>(network: model)"]
      end
    end
    deployRole["<b>sealeye-deploy-pilot</b><br/>role + function permissions boundary"]
    stacks["<b>Environment stacks</b><br/>sealeye-team-app-hash"]
  end

  c1 -- "HTTP" --> c2
  c2 -- "SQL" --> c3
  c2 -- "HTTP, the API's key" --> c4
  actions -- "OIDC role, main only" --> ecr
  release -- "image (from CI when present)" --> ecr
  release -- "sites, scripts" --> config
  release -- "SSM Run Command: update.sh" --> ec2
  serversh -- "SSM Run Command" --> ec2
  ec2 -- "pull" --> ecr
  ec2 -- "fetch config, write backups" --> config
  c2 -- "read settings at start,<br/>never gateway/" --> ssmp
  ec2 -- "gateway.sh: model key,<br/>gateway key, budget" --> ssmp
  c2 -- "assume role" --> deployRole
  deployRole -- "create, update, delete" --> stacks
  dns -- "A records" --> ec2
```

- **Platform stacks** are named `platform-sealeye-*` (server, deploy role, CI role, one
  DNS stack per domain). The deploy role cannot touch them.
- **The server's own role** can read its settings, pull its image, use its config
  bucket and assume a `sealeye-deploy-*` role. It cannot build anything itself.
- **The API's settings** come from Parameter Store under `/sealeye/` at start
  (`deploy/settings.mjs`), including LangFuse keys, the key it calls the model gateway
  with and the database password. The API then drops the database password from its
  own environment. The model key is under `/sealeye/gateway/`, which the API never
  reads; `deploy/gateway.sh` hands it to the gateway alone.
- **Releasing is manual.** GitHub tests every change and builds the image on main;
  `deploy/release.sh` uses that image and rolls it out. `deploy/README.md` has every
  server operation.
- **Backups** run nightly to the config bucket and are checked with
  `deploy/server.sh restore-check`.

## 7. Key flows

### 7.1 `sealeye run`: interview, plan, deploy

```mermaid
sequenceDiagram
  autonumber
  actor Dev as Developer
  participant CLI as sealeye command
  participant API as seaLeye API
  participant M as Anthropic model<br/>(through the gateway on the server)
  participant DB as Postgres
  participant AWS as AWS (as deploy role)

  Dev->>CLI: sealeye run (in the app folder)
  CLI->>API: GET /deployments (is this app already live?)
  CLI->>CLI: zip the folder for the interview: no .gitignore'd files,<br/>secret files as empty names,<br/>each line that holds a secret replaced by one that says why
  CLI->>API: POST /interviews { app, zip, findings (file, line, rule) }
  API->>API: scan what arrived again (shared rules, gitleaks),<br/>empty any file with a finding
  API->>DB: interview record, checkpoint
  API-->>CLI: interviewId, findings
  CLI->>Dev: which files look like they hold a secret, and that a deploy will be refused
  CLI->>API: GET /interviews/{id}/events (server-sent events)
  loop until a plan is submitted
    API->>M: model turn
    M-->>API: list_files / read_file, or a question
    API-->>CLI: event: step or question
    CLI->>Dev: one plain-language line, or the question
    Dev->>CLI: answer
    CLI->>API: POST /interviews/{id}/answers
  end
  M-->>API: submit_plan(plan, summary, assumptions)
  API->>API: contract check (core/schema.js), up to two retries
  API-->>CLI: event: plan (summary, files)
  CLI->>CLI: write DEPLOYMENT_PLAN.md and sealeye.yaml, work out the needs
  CLI->>Dev: the plan card (and "This plan is drafted" if it has needs)<br/>Deploy this? [y/N]
  Dev->>CLI: y
  CLI->>API: POST /interviews/{id}/answers { y }
  CLI->>API: GET /apps/{app}/settings (which settings the store already has)
  CLI->>CLI: zip again for the deploy: no node_modules, .git,<br/>.github, .do, and no secret files at all.<br/>A value that looks like a secret refuses it here
  CLI->>API: POST /deployments { plan, zip, settings not in the store }
  alt plan has needs (drafted)
    API->>DB: save the record as drafted
    API-->>CLI: refused: UNSUPPORTED_NEEDS, with evidence
    CLI->>Dev: the needs and the code that shows each, and nothing is built
  else the code looks like it holds a secret (shared rules or gitleaks)
    API-->>CLI: refused: SECRETS_FOUND, file, line and rule, nothing kept
    CLI->>Dev: each line, and how to move the value into a setting or allow it
  else plan is ready
    API->>DB: record: queued
    API-->>CLI: 201, deploymentId
    par in the API, in the background
      API->>API: packaging: npm install --ignore-scripts<br/>in dist/stage, add run.sh, zip
      API->>AWS: s3 cp the artifact, then cloudformation deploy
      loop every 5 seconds until final
        API->>AWS: describe-stacks
        API->>DB: record: running, then succeeded or failed, with outputs
      end
    and in the command
      CLI->>API: GET /deployments/{id}, for a few seconds
      CLI->>Dev: the terminal back (or the live panel, with --watch)
      CLI->>CLI: a background notifier keeps polling, writes<br/>DEPLOYMENT_REPORT.md and notifies with the URL
    end
  end
```

A static site follows the same path without the package: the stack makes the bucket and
the API copies the files into it before calling the deploy a success. On a re-run, the
first call finds the live environment, and the plan card is a difference against it.

The portal's New environment page runs the same flow from a folder chosen in the
browser, using the same upload rules (`core/upload-rules.js`). An interview started on
one surface can be finished on the other.

### 7.2 Portal sign-in

```mermaid
sequenceDiagram
  autonumber
  actor P as Person
  participant B as Browser (portal)
  participant C as Caddy
  participant API as seaLeye API
  participant DB as Postgres

  P->>B: paste token (once)
  B->>C: POST /api/sessions { token }<br/>x-sealeye-portal: 1
  C->>API: POST /sessions
  API->>DB: find token by SHA-256 hash, not revoked
  API->>DB: insert session (hash only), expires in 12 hours
  API-->>B: Set-Cookie __Host-sealeye_session<br/>HttpOnly, Secure, SameSite=Strict
  B->>C: GET /api/deployments (cookie)
  C->>API: GET /deployments
  API->>DB: session hash -> token -> person, team, scope
  API-->>B: this team's records (or the organization's, for an org-wide token)
  B->>C: GET /api/deployments/events (cookie), held open
  C->>API: GET /deployments/events
  Note over B,API: a deployment this person can see changes (from either surface)
  API-->>B: event: changed { deploymentId }
  B->>C: GET /api/deployments, read again
  Note over B,API: The stream ends after five minutes and the browser opens the next, checked again
  Note over B,API: Any change made with the cookie must also carry x-sealeye-portal: 1
```

### 7.3 An app reads its settings when it starts

```mermaid
sequenceDiagram
  autonumber
  participant L as Lambda (the app's function)
  participant R as run.sh + sealeye-settings.mjs<br/>(injected by seaLeye)
  participant S as Parameter Store
  participant A as The developer's app

  L->>R: cold start
  R->>S: get its own folder /sealeye-apps/team/app/<br/>(request signed by the function's role)
  S-->>R: values (the function may read only its own folder)
  R->>A: start the app with the values as environment variables
  Note over R,A: The app's code is unchanged: it reads process.env as it always did
```

### 7.4 One model call

Every turn of an interview is one of these (PHASE3-PLAN Steps 3 to 7). On a laptop, with
no gateway key, the API calls Anthropic directly with its own key and steps 2 to 4 and
6 to 7 do not happen.

```mermaid
sequenceDiagram
  autonumber
  participant G as Interview graph
  participant API as API (model.js, gateway-token.js)
  participant GW as Model gateway
  participant DB as Gateway's SQLite
  participant M as Anthropic

  G->>G: is the run under its own cap? (core/model-prices.js)<br/>if not: stopped, spending_limit, nothing sent
  G->>API: one turn
  API->>API: sign a token for this call:<br/>person, org, team, run, worker, surface, trace (one minute)
  API->>GW: POST /v1/messages<br/>x-sealeye-gateway-key and Authorization: Bearer token
  GW->>GW: API key known? token signed by the API's key,<br/>not expired, right issuer and audience?
  GW->>DB: budget for this 30-day period spent?<br/>(refused: 429 budget_exceeded)
  GW->>GW: this run's tokens for the day used?<br/>(refused: 429, plain text)
  GW->>M: the same request, with the model key<br/>(the caller's key and token removed)
  M-->>GW: the reply, with usage
  GW->>DB: the call's record: who, run, tokens, cost (never content),<br/>and its spend added to the budget
  GW-->>API: the reply, unchanged
  API->>G: the reply, priced from seaLeye's table and added to the run's spend
  Note over API,G: A refusal is never retried. The developer reads that the run reached<br/>its limit, or that seaLeye has used its model budget for this period.
```

### 7.5 Release

```mermaid
sequenceDiagram
  autonumber
  actor G as Administrator
  participant GH as GitHub
  participant ECR as ECR
  participant Mac as release.sh
  participant S as Pilot server

  G->>GH: merge the pull request
  GH->>GH: npm test, portal tests
  GH->>ECR: build and push the arm64 image (OIDC, main only)
  G->>Mac: pull main, then run deploy/release.sh
  Mac->>ECR: use GitHub's image for this commit
  Mac->>Mac: build the portal and the command's package
  Mac->>S: sites and scripts to the config bucket,<br/>then SSM Run Command runs update.sh
  S->>ECR: pull the image
  S->>S: docker compose up, then wait for /health
```

**The discovery run.** Plain code reads the library and lists its modules; the readers
run in parallel and never wait on a person; the supervisor writes the draft, with the
words a developer reads, the planner's guidance and which needs each module meets
(`meets`). A question goes out the moment a reader raises it, and an answer is used
whenever it comes: before the entries are written it is simply read, after, it re-writes
only what it touches. A run compares the library with the run behind the live catalog:
modules whose code is unchanged keep their finding and their entry as approved, with
their questions, so only what changed is read and written again (`--all` reads
everything; DESIGN.md, "Discovery reads again only what changed"). The live catalog then feeds the interview, the executor and the
gap report, which judges every drafted plan's needs against it.

```mermaid
flowchart LR
  read["read: one commit per repository,<br/>scanned, flagged lines replaced"] --> plan["plain code: each module folder,<br/>its inputs from its variables"]
  plan --> keep["unchanged since the live<br/>catalog's run: kept as approved"]
  keep --> sup
  plan --> w1["worker per module that changed<br/>(small route)"]
  plan --> lib["library reader: README, pipeline<br/>(small route)"]
  w1 --> sup["supervisor writes the draft<br/>(frontier route)"]
  lib --> sup
  w1 -. "question, with a guess" .-> q[("questions")]
  lib -. "question" .-> q
  sup -. "question" .-> q
  q -. "answer, any time" .-> sup
  sup --> draft[("draft catalog")]
  draft --> test["self-test: plain code<br/>(api/self-test.js)"]
  test --> approve["approved, by an<br/>organization-wide token"]
  approve --> test2["self-test again,<br/>and no environment dropped"]
  test2 --> live[("live catalog")]
  live --> interview["the interview<br/>plans from it"]
  live --> gapreport["the gap report:<br/>drafted needs no built<br/>module meets"]
  ledger[("needs ledger:<br/>drafted plans")] --> gapreport
```

## 8. Data

### 8.1 Postgres

`api/migrations/` holds plain SQL applied in name order at start and recorded in
`schema_migrations`. The `interview_state` schema is made at every start instead,
because the nightly backup leaves it out (it holds interviews in progress, which include
the developer's code, and lives a day at most).

```mermaid
erDiagram
  TOKENS ||--o{ SESSIONS : "signs in as"
  TOKENS {
    text token_id PK
    text token_hash UK "SHA-256, never the token"
    text email
    text name
    text org_id
    text team_id
    text scope "team or org"
    timestamptz created_at
    timestamptz revoked_at
    timestamptz last_used_at
  }
  SESSIONS {
    text session_hash PK "SHA-256 of the cookie"
    text token_id FK
    timestamptz created_at
    timestamptz expires_at "12 hours"
  }
  DEPLOYMENTS {
    text deployment_id PK
    text org_id
    text team_id
    text created_by "the token's person"
    text surface "cli or portal"
    text trace_id
    text app
    text status
    timestamptz started_at
    timestamptz updated_at
    jsonb record "the whole record"
  }
  SETTING_CHANGES {
    bigserial id PK
    text org_id
    text team_id
    text app
    text name "never the value"
    text action "set or removed"
    text by_email
    text by_name
    text surface
    timestamptz at
  }
  CATALOGS {
    text org_id PK
    integer version PK
    text status "draft, approved, live or retired"
    jsonb document "modules, need kinds, profiles, patterns"
    text created_by
    timestamptz created_at
    text approved_by
    timestamptz approved_at
    text made_live_by
    timestamptz made_live_at
  }
  INTERVIEWS {
    text interview_id PK "schema interview_state"
    jsonb record
    timestamptz created_at
    timestamptz updated_at
  }
  INTERVIEW_EVENTS {
    text interview_id PK, FK
    integer seq PK
    jsonb event
  }
  INTERVIEWS ||--o{ INTERVIEW_EVENTS : "streams"
  DISCOVERIES {
    text id PK
    text org_id
    text status "running, finished, stopped or failed"
    jsonb record "commits read, each module's finding, the draft's version, spend"
    timestamptz created_at
    timestamptz updated_at
  }
  DISCOVERY_QUESTIONS {
    text id PK
    text discovery_id FK
    text org_id
    jsonb question "the question, its evidence, the guess, the answer and who gave it"
    timestamptz answered_at
    timestamptz created_at
  }
  DISCOVERIES ||--o{ DISCOVERY_QUESTIONS : "asks"
  PLATFORM_VALUES {
    text org_id PK
    text stage PK "dev, sit, uat, staging, perf or prod"
    text name PK "an input's name, or module.input"
    jsonb value "a word or a list of words: ids, never a secret"
    text set_by
    timestamptz set_at
  }
```

`PLATFORM_VALUES` holds what only an organization's platform team can give a Terraform
module (PHASE4-PLAN Step 9): read beside a catalog to say what it builds, never stored in
one. A Terraform environment's state is in S3, `tofu-state/<org>/<environment>.tfstate`
in the platform's bucket, with OpenTofu's lock file beside it.

`DEPLOYMENTS` and `SETTING_CHANGES` are joined to people through `org_id`, `team_id`
and the person's email, not by a foreign key, so a record outlives a revoked token.
`CATALOGS` holds each organization's catalogs (PHASE4-PLAN Step 1), one live at most;
an organization with none plans against the starter catalog,
`prompts/module-catalog.yaml`, which is not a row. A draft goes live in two steps, the
self-test at each (Step 7): approved, by whom and when, then made live, by whom and
when; a retired catalog may go live again. `DISCOVERIES` and
`DISCOVERY_QUESTIONS` hold each discovery run and what it asked (PHASE4-PLAN Step 6): a
finding is lines and evidence pointers (a file and what it shows), never a file's
contents; the draft a run writes is a `CATALOGS` row.
LangGraph's own checkpoint tables also live in `interview_state`.

### 8.2 Outside Postgres

| What | Where | Kept for |
|---|---|---|
| App setting values | Parameter Store, `/sealeye-apps/<team>/<app>/` | until unset; never copied into seaLeye |
| Packaged app zips | artifact bucket, `<name>/<deploymentId>.zip` | reused by Deploy again |
| Uploaded copies | `~/.sealeye/deploy-uploads/<deploymentId>/` on the server | until the deployment ends |
| Interview scratch folders | on the server | until the interview ends, or a day |
| Backups | config bucket, `backups/` | 30 days |
| Traces | LangFuse, when keys are set | LangFuse's retention (self-hosted from Phase 4) |
| The developer's files | the app folder: DEPLOYMENT_PLAN.md, sealeye.yaml, DEPLOYMENT_REPORT.md, DEPLOYMENT_EVIDENCE.md | the developer's |

### 8.3 The plan contract

planVersion 0.5, in `core/schema.js` (`contractSchema`). A plan names the catalog it
was written against (`catalog: starter`, or the version of one of the organization's
own that is or was live), and its module ids and need kinds are checked against that
catalog (`schemaFor` in `core/catalog.js`, `api/validate.js`). A module is buildable
when the catalog marks it available and the platform has an executor for what its
`builds_with` names: today CloudFormation, which builds the starter's four
(`static_site_edge`, `http_api_serverless`, `observability_basic`, `config_basic`).
Anything else an app needs is a NEED from that catalog's need kinds, or `unlisted`,
with evidence naming the file. A plan with needs is `drafted`; a plan without is
`ready`. 0.2, 0.3 and 0.4 plans are read as 0.5 against the starter. The interview plans
against the organization's live catalog from when it started: its model writes the 0.4
shape with that catalog's modules, and the platform stamps the plan 0.5 with the
catalog. A record keeps the plan's catalog, and a
deploy whose plan names a replaced catalog that no longer builds a module it uses is
refused (CATALOG_CHANGED).

## 9. Security model

```mermaid
flowchart LR
  subgraph dev["Developer's machine (untrusted input)"]
    files["App folder"]
  end
  subgraph edge["Internet edge"]
    caddy["Caddy: TLS for every domain,<br/>security headers on the portal"]
  end
  subgraph core["seaLeye API (trusted)"]
    auth["Token or session check,<br/>team and org scoping"]
    sandbox["Interview tools: read-only,<br/>inside the copy, secret files and<br/>files with a finding refused"]
    pkg["Packaging: --ignore-scripts,<br/>scrubbed environment"]
  end
  subgraph cloud["AWS"]
    role["Deploy role: seaLeye's templates<br/>and names only"]
    boundary["Function boundary: logs<br/>and its own settings only"]
  end
  subgraph modelside["Model gateway (its own network)"]
    gw["Only the API's key and a token<br/>the API signed; budget and run limit;<br/>holds the model key; logs no content"]
  end
  files -- "filtered zip" --> caddy --> auth --> sandbox
  auth --> pkg --> role --> boundary
  sandbox -- "model calls" --> gw
```

| Boundary | Control |
|---|---|
| The developer's folder to the API | Two uploads, one walk (`core/upload-rules.js`). For the interview: what `.gitignore` leaves out stays behind, and secret files (`core/secrets.js`) travel as empty names, as do archives and files that are not text, which no scanner sees into (the API empties any that arrive with contents). For the deploy: no `node_modules`, `.git`, `.github` or `.do`, and no secret file at all. Every file that travels is scanned for values that look like secrets (`core/scan.js`): for an interview, each such line travels as a line that says why (a private key, over many lines, sends its file as an empty name), and a deploy with one is refused, unless `.sealeye-allow` names the line. |
| What arrives at the API | Scanned again, because the client cannot be trusted: the shared rules and gitleaks (`api/secret-scan.js`), always with seaLeye's own configuration, so nothing in the folder can switch it off. An interview's flagged lines are replaced, or a file with a private key emptied, before the graph starts; a deploy with one is refused (`SECRETS_FOUND`) and nothing is kept. If gitleaks is installed and cannot finish, neither goes ahead (`SCAN_FAILED`). |
| A platform library to discovery | One commit of each named repository, fetched read-only from GitHub's API (`api/discovery/`) with a GitHub App's token narrowed to that repository and to reading it, or a read-only personal token; the credential goes to GitHub's API and nowhere else. Walked by the same rules as an upload (purpose `discovery`: `.github` is read, `.gitignore` followed, secret files as empty names), then scanned with the shared rules and gitleaks; each flagged line is replaced, a private key's file emptied, before any worker reads it. Archives and files that are not text, which neither scanner sees into, are kept as names only. A library's `.sealeye-allow` is not read and its `.gitleaksignore` is left out. An app's token is revoked once the archive is read. |
| The model reading the app | `list_files` and `read_file` are read-only, inside the copy and capped in size. `read_file` refuses secret files and files with a finding, and says which line and what kind; `list_files` shows only their names. LangSmith tracing stays off. |
| Callers to the API | One token per person, stored only as a hash, issued on the administrator's machine. The portal trades it for an HttpOnly, `SameSite=Strict`, `__Host-` cookie; changes also need `x-sealeye-portal: 1`. An API with a database cannot run with auth off. |
| Team to team | A record is its team's; an organization-wide token sees every team's; nobody sees another organization's. Each team's environments have names of their own. |
| The app's own code at build time | Dependencies install with `--ignore-scripts` and an environment holding only what npm needs. |
| The API to AWS | The server role can only assume `sealeye-deploy-*`. The deploy role builds only seaLeye's resources, and can create a function role only with the permissions boundary on it. |
| The built app at run time | The boundary allows logs and reading `/sealeye-apps/`; each function's role narrows that to its own folder. |
| Reading an organization's environment back | Through the Terraform role, whose log permissions are a managed policy of their own: its app logs, its front door's record and its database's own log and refused sign-ins (`logs:FilterLogEvents` on groups named `/aws/lambda/sealeye-*`, `/aws/vendedlogs/apigateway/sealeye-*` and `/aws/rds/instance/sealeye-*` only; the API asks only for the groups its modules named, believed only when named for the environment, `<name>-dev` then `-` or `/`, and never the database setup function's); a failed database setup step's last lines, from that environment's own function only, any line that looks like a secret replaced; and the detached network interfaces its functions left, deleted only when detached and named for its functions. A database's lines never show what the app sent it (a failed query, the values that broke a rule). |
| The front door's log delivery | `logs:CreateLogDelivery` and its relatives, with `logs:PutResourcePolicy`, on `*`, as AWS documents for an HTTP API's access log; the record goes under `/aws/vendedlogs/` so the account's log resource policy does not grow with each app; a module that writes that policy itself is not built. |
| Secrets in output | Setting values never appear in records, evidence, logs, the terminal or the portal; logs pass through the same masking traces do. |
| Traces | Shapes of turns, file paths and sizes; never file contents. Off without LangFuse keys, or with `--no-trace`. |
| The API to the model | On the server the API holds no model key: the model key is the gateway's alone (`/sealeye/gateway/`, which the API never reads). The gateway lets through only the API's key with a token the API signed for that call, checked against the public half only. It is on a network only the API joins, with no published port. |
| Spending | Each run stops at its own cap (a dollar by default); the gateway refuses once its budget for the period is spent, and refuses a run past its daily token limit. Every refusal is told in plain words and never retried. |
| The gateway's log and record | Who, which run, tokens, cost and status; never a prompt, a reply, a token or a key (principle 11 in CLAUDE.md). The record keeps 90 days. |

Open security decisions are in [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md): Q16
(identity-provider sign-in replacing tokens). Where an organization's traces live was
Q13, answered Oct 13, 2026: LangFuse self-hosted in ca-central-1, in ROADMAP Phase 4.

## 10. Cross-cutting concerns

- **Parity.** Each operation is an endpoint, a command and a page with one name. The
  table is in [ROADMAP.md](ROADMAP.md#parity-backlog).
- **Plain language.** Developers see no product names or one cloud's own nouns, no
  acronym left unspelled, no em dashes and no capacity numbers (`core/developer-words.js`).
  Shared wording lives in `core/plan-words.js`, `core/evidence-summary.js` and
  `core/plan-report-words.js`.
- **Status is real.** A record moves through queued, packaging, running, then succeeded
  or failed, mirroring the stack, and destroying then destroyed on tear down; a refused
  plan is drafted. Pause state, logs, readings and costs are read from AWS when asked.
- **Restarts.** At start the API picks up deployments still in flight
  (`api/executor/resume.js`) and interviews still open, from Postgres.
- **On a laptop.** With no `DATABASE_URL` the API keeps records in a JSON file and
  interviews in memory, and may run with `SEALEYE_AUTH=off`; a hosted API never can.
  `sealeye doctor` checks what the machine needs.
- **Spending.** A run is capped in seaLeye's graph, priced from `core/model-prices.js`;
  the gateway's budget and per-run limit are the outer limit. Both are close, not exact
  (DESIGN.md, "A run's cap is close, not exact").
- **Observability.** An interview is one LangFuse trace across its pauses, joined to the
  deployment and scored from fixed names in `core/tracing.js`. The gateway's log and
  `deploy/server.sh gateway-calls` name each model call's person, team and run, with the
  trace's id. `npm run eval:interview`
  grades the interview on the sample apps before and after any prompt change.
- **Testing.** `npm test` needs no AWS and no model; Postgres tests run when
  `SEALEYE_TEST_DATABASE_URL` is set. The portal has Playwright tests against the real
  API with sample records. GitHub runs both on every push and pull request.
- **Naming.** `sealeye-<team>-<app>-<hash>` for every environment resource,
  `platform-sealeye-*` for seaLeye's own.

## 11. Decision index

The decisions that shaped the architecture, by DESIGN.md heading.

| Area | DESIGN.md heading |
|---|---|
| Hosting | One small server in ca-central-1; Each domain has one job |
| The interview | The interview runs as a LangGraph graph; The interview runs in the API; The model's address is a setting; The interview reads the organization's catalog |
| Uploads and packaging | Deployments package an uploaded copy; One walk decides what travels, from the command and from the browser; The interview never reads secret files; Installing an app's dependencies runs none of its code; Secret files never go into the package |
| Data | Deployment records live in Postgres; The catalog is data, and every organization starts with the starter; A plan names its catalog (planVersion 0.5) |
| Identity | Every caller has a token, until sign-in; The portal signs in with a session cookie; Each team sees its own environments; Each team's environments have names of their own |
| Settings | Setting values travel with the deploy, for now; Settings live in the organization's store |
| Portal | The portal is a client of the API; The portal shares words with the command through core/ |
| Day two | Deploying again; An interview can be finished on the other surface; Pause and resume; Performance shows readings, not capacity; Configure is a deploy of the same code again; Logs pass through the masking traces do; Costs come from tags, a day behind |
| Delivery | GitHub tests every change and builds the image; A changed command is a new version |
| Tracing | Tracing the interview with LangFuse; Tracing stays in the product |
| Secrets in code | The secret scanner; The interview reads around a secret, not past the file |
| Spending | A run's cap is close, not exact; What a run costs, and a cap of a dollar; The cap on every run; The gateway's budget: $20 a period; The outer limit, and a record of calls kept 90 days |
| Learning the platform | Phase 4's decisions, and one reopened; The catalog is data, and every organization starts with the starter; A plan names its catalog (planVersion 0.5); The interview reads the organization's catalog; A module's name is found as code when it is an ordinary word; The made-up organization: Juniper Mutual; Discovery records which needs each module meets; The gap report; Discovery reads again only what changed |
| Building from the organization's modules | A Terraform executor builds an organization's own modules; Each module is built at the version its library released; Modules are connected through what the library offers; An app reaches a database in the private network; A tear-down waits for the private network, and sweeps what it leaves |
| What a developer sees of the platform | Logs are found by the command, never by a path; A Terraform environment's logs are read where its module says they are; What the platform saw, in the developer's words; The front door's and the database's lines, beside the app's; A failed setup step says its last lines |
| The model gateway | Phase 3's decisions, as recommended; agentgateway, read and run (Step 4); The model gateway on the server; A token on every model call; Inference from Canada: disclosed, on the US profile |

## 12. Known limits and where they go next

| Limit today | Why it is acceptable now | What changes it |
|---|---|---|
| One API process; the store reads from memory | One pilot server | Staged hosting (PHASE2-PLAN, "Owed after this plan"): a managed database, then containers when downtime matters |
| One shared AWS account and deploy role | The pilot is one organization | Phase 5: a role per team, in the team's account |
| Tokens instead of sign-in | A handful of people | Phase 5: Cognito (Q16) |
| An organization's environment is built at the dev stage, from one module that runs the app and the modules it uses, with no settings of its own | Developers deploy to dev; settings would be kept in plain text in state | Phase 5 for later stages; ROADMAP Phase 1 item 10 for settings |
| A module that only runs beside something else (a service that runs continuously, an internal front door) is not built | The executor builds what takes an app's code or offers it access | Each in its own step, as a gap report asks for them |
| Which needs a module meets is the model's judgment, fixed only by discovering again | A wrong one costs a wrong line in the gap report, never a build (Greg, Oct 22) | When a platform team needs to correct one by hand |
| ca-central-1, Node 20, no CloudFront from seaLeye's own templates | The pilot's scope | Phase 7 |
| Traces in LangFuse Cloud (US) | Sample apps and a made-up organization only; off for any pilot on real code | Self-hosted in ca-central-1, owed before the first customer's real code (ROADMAP Phase 4, PHASE4-PLAN "Owed after this plan") |
| No promotion past dev | Developers deploy to dev | Phase 5 |
| The gateway's own span is not in a run's trace | Traces are on LangFuse Cloud, which the gateway holds no keys to | With LangFuse in Canada (owed before the first customer's real code) |
| The interview and discovery send code to the Anthropic API, in the US, through the gateway | Sample apps, a made-up organization and public libraries | The Bedrock route, when the account has model access (Phase 3 Step 8, owed); disclosed, not kept in Canada (DESIGN.md, "Inference from Canada") |
