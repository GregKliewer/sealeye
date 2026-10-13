# seaLeye: the build-out, phase by phase

First written Tue Oct 13, 2026, at 2.21.0. One picture per phase of [ROADMAP.md](ROADMAP.md),
all on the same layout, so a reader can flip between them and see what each phase adds,
and under it the one flow that shows the phase at work. Parts new or changed in a phase
are drawn in blue. [ARCHITECTURE.md](ARCHITECTURE.md)
describes the system as built today; this file describes where it is going. Why each
change is made lives in [DESIGN.md](../DESIGN.md), "The roadmap gains a governed backbone
and a door for agents".

When ROADMAP.md changes what a phase holds, fix its picture here in the same commit.

## The phases at a glance

| Phase | Name | State | What it adds |
|---|---|---|---|
| 0 | Foundation | Done Oct 8, 2026 | The demo becomes a product repo: cli, api and core, tests, CLAUDE.md, the roadmap |
| 1 | Team release | Mostly done Oct 11, 2026 | Hosted API, tokens, Postgres, the live portal, CI. Open: the second-person test |
| 2 | Day-two parity | Built Oct 12, 2026 | Logs, performance, costs, pause, configure, the settings store and evidence, on both surfaces |
| 3 | Governed backbone | **New**, next | agentgateway in front of every model call, routing, spend caps, LangFuse self-hosted in ca-central-1 |
| 4 | Learn the platform | Planned | A discovery swarm reads the organization's library into its catalog, with must-refuse tests and Terraform |
| 5 | The path to production | Planned | Promote, approvals in ServiceNow, Jira gap tickets, team accounts, Cognito sign-in |
| 6 | seaLeye for agents | **New**, planned | seaLeye's tools as MCP behind the gateway, for coding agents |
| 7 | Delivery and breadth | Planned | In-network or single tenant, the organization's own model, more clouds and regions, Windows |

Phases 3 and 6 were added on Oct 13, 2026; the old Phases 3, 4 and 5 became 4, 5 and 7.

## Today: Phases 0 to 2, as built (v2.21.0)

Today one agent builds only from four certified templates. Phases 0 to 2, v2.21.0, built Sept 20 to Oct 12, 2026. One agent, one model, every run traced.

```mermaid
flowchart TB
  subgraph people["People and agents"]
    dev["<b>Developer</b><br/>brings an app,<br/>says yes to a plan"]
    admin["<b>Platform admin</b><br/>issues tokens,<br/>reads needs ledger"]
    control["<b>Control partners</b><br/>read evidence<br/>and records"]
  end
  subgraph surfaces["Surfaces"]
    cli["<b>sealeye command</b><br/>seaLeye.run<br/>interview, day two"]
    portal["<b>seaLeye.online</b><br/>same operations,<br/>as web pages"]
  end
  dev ~~~ cli
  subgraph api["seaLeye API: one small server in ca-central-1"]
    frontdoor["<b>Front door agent</b><br/>LangGraph interview,<br/>4 questions at most"]
    contract["<b>Plan contract</b><br/>refuse, never shrink<br/>human yes to build"]
    executor["<b>Executor</b><br/>4 certified templates<br/>scoped deploy role"]
    daytwo["<b>Day-two operations</b><br/>logs, perf, costs,<br/>pause, settings"]
    records["<b>Records</b><br/>Postgres, per team<br/>tokens, evidence"]
  end
  frontdoor ~~~ records
  cli ~~~ frontdoor
  subgraph backbone["Model access and tracing: direct today"]
    modelurl["<b>Model address</b><br/>SEALEYE_MODEL_URL<br/>a seam, no gateway"]
    langfuse["<b>LangFuse Cloud</b><br/>US region, samples<br/>names, never contents"]
  end
  records ~~~ modelurl
  subgraph outside["Outside seaLeye"]
    models["<b>Models</b><br/>Anthropic API<br/>Claude Sonnet 5"]
    cloud["<b>Cloud and IaC</b><br/>AWS, ca-central-1<br/>CloudFormation"]
  end
  modelurl ~~~ models
```

Key flow today: one `sealeye run`. A plan with needs is refused; only a ready plan is built. Every step is traced in LangFuse, file names but never contents.

```mermaid
flowchart LR
  run["<b>sealeye run</b><br/>in the app folder"] --> upload["<b>Filtered upload</b><br/>secret files as names"]
  upload --> agent["<b>Front door agent</b><br/>reads, asks 4 at most"]
  agent --> plan["<b>Plan submitted</b><br/>to the contract"]
  plan --> needs{"Any needs?"}
  needs -- none --> yes["<b>Deploy this? y</b><br/>a person says yes"]
  yes --> build["<b>Executor builds</b><br/>certified template"]
  build --> url["<b>Address and report</b><br/>status read from AWS"]
  needs -- needs --> refused["<b>Drafted, refused</b><br/>saved, nothing built"]
```

## Phase 3: Governed backbone

Phase 3 puts one governed door in front of every model call. Built before discovery, so the swarm runs on it from day one.

```mermaid
flowchart TB
  subgraph people["People and agents"]
    dev["<b>Developer</b><br/>brings an app,<br/>says yes to a plan"]
    admin["<b>Platform admin</b><br/>issues tokens,<br/>reads needs ledger"]
    control["<b>Control partners</b><br/>read evidence<br/>and records"]
  end
  subgraph surfaces["Surfaces"]
    cli["<b>sealeye command</b><br/>seaLeye.run<br/>interview, day two"]
    portal["<b>seaLeye.online</b><br/>same operations,<br/>as web pages"]
  end
  dev ~~~ cli
  subgraph api["seaLeye API: one small server in ca-central-1"]
    frontdoor["<b>Front door agent</b><br/>LangGraph interview,<br/>4 questions at most"]
    contract["<b>Plan contract</b><br/>refuse, never shrink<br/>human yes to build"]
    executor["<b>Executor</b><br/>4 certified templates<br/>scoped deploy role"]
    daytwo["<b>Day-two operations</b><br/>logs, perf, costs,<br/>pause, settings"]
    records["<b>Records</b><br/>Postgres, per team<br/>tokens, evidence"]
  end
  frontdoor ~~~ records
  cli ~~~ frontdoor
  subgraph backbone["Governed backbone: every model call goes through it"]
    gateway["<b>agentgateway</b><br/>one door to models,<br/>keys per person"]
    routing["<b>Model routing</b><br/>cheap for bulk work,<br/>bank code in-account"]
    caps["<b>Spend caps</b><br/>per run, per worker,<br/>rate limits"]
    langfuse["<b>LangFuse</b><br/>self-hosted, Canada<br/>traces, scores, evals"]
  end
  records ~~~ gateway
  subgraph outside["Outside seaLeye"]
    models["<b>Models</b><br/>frontier and small<br/>Claude on Bedrock"]
    cloud["<b>Cloud and IaC</b><br/>AWS, ca-central-1<br/>CloudFormation"]
  end
  gateway ~~~ models
  classDef new fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#111
  class caps,gateway,langfuse,models,routing new
```

Key flow: one model call through the backbone. Every model call is identified, budgeted and routed before it leaves.

```mermaid
flowchart LR
  agent["<b>seaLeye agent</b><br/>asks for a model call"] --> gw["<b>agentgateway</b><br/>who is calling?"]
  gw --> budget{"Under budget?"}
  budget -- no --> stop["<b>Run stopped</b><br/>a person is told why"]
  budget -- yes --> router["<b>Model routing</b><br/>task and data class"]
  router --> inacct["<b>In-account model</b><br/>for bank code"]
  router --> small["<b>Small model</b><br/>for bulk reading"]
  router --> frontier["<b>Frontier model</b><br/>for plans and rules"]
  gw -. trace .-> lf["<b>LangFuse</b><br/>span joins run trace"]
  classDef new fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#111
  class gw,budget,stop,router,lf new
```

## Phase 4: Learn the platform

Phase 4 teaches seaLeye the platform the organization already has. A discovery swarm reads the library overnight; the front door agent then works from what it found.

```mermaid
flowchart TB
  subgraph people["People and agents"]
    dev["<b>Developer</b><br/>brings an app,<br/>says yes to a plan"]
    admin["<b>Platform admin</b><br/>runs discovery,<br/>answers its questions"]
    control["<b>Control partners</b><br/>read evidence<br/>and records"]
  end
  subgraph surfaces["Surfaces"]
    cli["<b>sealeye command</b><br/>seaLeye.run<br/>interview, day two"]
    portal["<b>seaLeye.online</b><br/>same operations,<br/>as web pages"]
  end
  dev ~~~ cli
  subgraph api["seaLeye API: one small server in ca-central-1"]
    frontdoor["<b>Front door agent</b><br/>LangGraph interview,<br/>uses the org catalog"]
    contract["<b>Plan contract</b><br/>refuse, never shrink<br/>must-refuse tests"]
    executor["<b>Executor</b><br/>the org's modules<br/>scoped deploy role"]
    daytwo["<b>Day-two operations</b><br/>logs, perf, costs,<br/>pause, settings"]
    records["<b>Records</b><br/>Postgres, per team<br/>tokens, evidence"]
    discovery["<b>Discovery swarm</b><br/>LangGraph fan-out,<br/>people in the loop"]
    catalog["<b>Org catalog</b><br/>modules, usage rules,<br/>what must be refused"]
  end
  frontdoor ~~~ records
  contract ~~~ discovery
  executor ~~~ catalog
  cli ~~~ frontdoor
  subgraph backbone["Governed backbone: every model call goes through it"]
    gateway["<b>agentgateway</b><br/>one door to models,<br/>keys per person"]
    routing["<b>Model routing</b><br/>cheap for bulk work,<br/>bank code in-account"]
    caps["<b>Spend caps</b><br/>per run, per worker,<br/>rate limits"]
    langfuse["<b>LangFuse</b><br/>self-hosted, Canada<br/>traces, scores, evals"]
  end
  records ~~~ gateway
  subgraph outside["Outside seaLeye"]
    models["<b>Models</b><br/>frontier and small<br/>Claude on Bedrock"]
    cloud["<b>Cloud and IaC</b><br/>AWS, ca-central-1<br/>CloudFormation, TF"]
    library["<b>Platform library</b><br/>modules, pipelines<br/>in the org's repos"]
  end
  gateway ~~~ models
  classDef new fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#111
  class admin,catalog,cloud,contract,discovery,executor,frontdoor,library new
```

Key flow: one discovery run, overnight, in a new account for the customer; the run is paid. The swarm reads in parallel, asks people when unsure, and is tested before use.

```mermaid
flowchart TB
  start["<b>Admin starts run</b><br/>new paid account"] --> scan["<b>Secret scanner</b><br/>findings never sent"]
  scan --> sup["<b>Supervisor</b><br/>changed modules only"]
  sup --> w1["<b>Worker</b><br/>one module, small model"]
  sup --> w2["<b>Worker</b><br/>one module, small model"]
  sup --> w3["<b>Worker</b><br/>one module, small model"]
  w1 --> gather["<b>Gather findings</b><br/>supervisor merges"]
  w2 --> gather
  w3 --> gather
  gather --> unclear{"Unclear?"}
  unclear -- yes --> person["<b>Platform engineer</b><br/>answers, run waits"]
  person --> synth
  unclear -- no --> synth["<b>Write the rules</b><br/>frontier model"]
  synth --> catalog["<b>Org catalog</b><br/>usage and refusals"]
  catalog --> evals["<b>Must-refuse evals</b><br/>in LangFuse"]
  evals -- pass --> use["<b>Front door agent</b><br/>plans from the catalog"]
  classDef new fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#111
  class scan,sup,w1,w2,w3,gather,unclear,person,synth,catalog,evals new
```

## Phase 5: The path to production

Phase 5 hands promotion to the process the organization already runs. Promote asks; the change tool decides. Approvals are graph interrupts that can wait for days.

```mermaid
flowchart TB
  subgraph people["People and agents"]
    dev["<b>Developer</b><br/>brings an app,<br/>says yes to a plan"]
    admin["<b>Platform admin</b><br/>runs discovery,<br/>answers its questions"]
    control["<b>Control partners</b><br/>read evidence<br/>and records"]
  end
  subgraph surfaces["Surfaces"]
    cli["<b>sealeye command</b><br/>seaLeye.run<br/>interview, day two"]
    portal["<b>seaLeye.online</b><br/>same operations,<br/>Cognito sign-in"]
  end
  dev ~~~ cli
  subgraph api["seaLeye API: one small server in ca-central-1"]
    frontdoor["<b>Front door agent</b><br/>LangGraph interview,<br/>uses the org catalog"]
    contract["<b>Plan contract</b><br/>refuse, never shrink<br/>must-refuse tests"]
    executor["<b>Executor</b><br/>the org's modules<br/>role per team account"]
    daytwo["<b>Day-two operations</b><br/>logs, perf, costs,<br/>pause, settings"]
    records["<b>Records</b><br/>Postgres, per team<br/>tokens, evidence"]
    discovery["<b>Discovery swarm</b><br/>LangGraph fan-out,<br/>people in the loop"]
    catalog["<b>Org catalog</b><br/>modules, usage rules,<br/>what must be refused"]
    promote["<b>Promote, approvals</b><br/>approvals wait days<br/>as graph interrupts"]
  end
  frontdoor ~~~ records
  contract ~~~ discovery
  executor ~~~ catalog
  daytwo ~~~ promote
  cli ~~~ frontdoor
  subgraph backbone["Governed backbone: every model call goes through it"]
    gateway["<b>agentgateway</b><br/>one door to models,<br/>keys per person"]
    routing["<b>Model routing</b><br/>cheap for bulk work,<br/>bank code in-account"]
    caps["<b>Spend caps</b><br/>per run, per worker,<br/>rate limits"]
    langfuse["<b>LangFuse</b><br/>self-hosted, Canada<br/>traces, scores, evals"]
  end
  records ~~~ gateway
  subgraph outside["Outside seaLeye"]
    models["<b>Models</b><br/>frontier and small<br/>Claude on Bedrock"]
    cloud["<b>Cloud and IaC</b><br/>AWS, ca-central-1<br/>CloudFormation, TF"]
    library["<b>Platform library</b><br/>modules, pipelines<br/>in the org's repos"]
    tools["<b>Enterprise tools</b><br/>ServiceNow, Jira,<br/>Teams, Slack"]
  end
  gateway ~~~ models
  classDef new fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#111
  class executor,portal,promote,tools new
```

Key flow: one promotion, dev to the next stage. Promotion asks; the change process decides, even if it takes days. The graph waits as an interrupt while the change is reviewed.

```mermaid
flowchart LR
  ask["<b>sealeye promote</b><br/>developer asks"] --> check["<b>Check next stage</b><br/>what is missing?"]
  check --> gaps{"Any gaps?"}
  gaps -- yes --> jira["<b>Gap ticket in Jira</b><br/>developer told what"]
  gaps -- no --> snow["<b>Change request</b><br/>in ServiceNow"]
  snow --> wait["<b>Graph waits</b><br/>interrupt, for days"]
  wait --> cab{"Approved?"}
  cab -- yes --> build["<b>Builds there</b><br/>team account role"]
  build --> ev["<b>Evidence, report</b><br/>change number on it"]
  cab -- no --> told["<b>Told why</b><br/>nothing is built"]
  classDef new fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#111
  class ask,check,gaps,jira,snow,wait,cab,build new
```

## Phase 6: seaLeye for agents

Phase 6 opens the same governed door to other agents. Agents get what developers get: the same tools, the same policy, the same evidence.

```mermaid
flowchart TB
  subgraph people["People and agents"]
    dev["<b>Developer</b><br/>brings an app,<br/>says yes to a plan"]
    admin["<b>Platform admin</b><br/>runs discovery,<br/>answers its questions"]
    control["<b>Control partners</b><br/>read evidence<br/>and records"]
    agents["<b>Other agents</b><br/>Claude Code, Copilot,<br/>ADK agents"]
  end
  subgraph surfaces["Surfaces"]
    cli["<b>sealeye command</b><br/>seaLeye.run<br/>interview, day two"]
    portal["<b>seaLeye.online</b><br/>same operations,<br/>Cognito sign-in"]
    mcp["<b>MCP server</b><br/>plan, validate,<br/>deploy, evidence"]
  end
  dev ~~~ cli
  subgraph api["seaLeye API: one small server in ca-central-1"]
    frontdoor["<b>Front door agent</b><br/>LangGraph interview,<br/>uses the org catalog"]
    contract["<b>Plan contract</b><br/>refuse, never shrink<br/>must-refuse tests"]
    executor["<b>Executor</b><br/>the org's modules<br/>role per team account"]
    daytwo["<b>Day-two operations</b><br/>logs, perf, costs,<br/>pause, settings"]
    records["<b>Records</b><br/>Postgres, per team<br/>tokens, evidence"]
    discovery["<b>Discovery swarm</b><br/>LangGraph fan-out,<br/>people in the loop"]
    catalog["<b>Org catalog</b><br/>modules, usage rules,<br/>what must be refused"]
    promote["<b>Promote, approvals</b><br/>approvals wait days<br/>as graph interrupts"]
  end
  frontdoor ~~~ records
  contract ~~~ discovery
  executor ~~~ catalog
  daytwo ~~~ promote
  cli ~~~ frontdoor
  subgraph backbone["Governed backbone: every model, tool and agent call"]
    gateway["<b>agentgateway</b><br/>models, MCP and A2A,<br/>policy per agent"]
    routing["<b>Model routing</b><br/>cheap for bulk work,<br/>bank code in-account"]
    caps["<b>Spend caps</b><br/>per run, per worker,<br/>rate limits"]
    langfuse["<b>LangFuse</b><br/>self-hosted, Canada<br/>traces, scores, evals"]
  end
  records ~~~ gateway
  subgraph outside["Outside seaLeye"]
    models["<b>Models</b><br/>frontier and small<br/>Claude on Bedrock"]
    cloud["<b>Cloud and IaC</b><br/>AWS, ca-central-1<br/>CloudFormation, TF"]
    library["<b>Platform library</b><br/>modules, pipelines<br/>in the org's repos"]
    tools["<b>Enterprise tools</b><br/>ServiceNow, Jira,<br/>Teams, Slack"]
  end
  gateway ~~~ models
  classDef new fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#111
  class agents,gateway,mcp new
```

Key flow: a coding agent asks seaLeye for an environment through MCP. An agent gets exactly what a developer gets, and no more.

```mermaid
flowchart LR
  agent["<b>Coding agent</b><br/>Claude Code, Copilot, ADK"] --> gw["<b>agentgateway</b><br/>checks agent and tool"]
  gw --> allowed{"Allowed?"}
  allowed -- no --> refused["<b>Refused, logged</b><br/>agent named"]
  allowed -- yes --> mcp["<b>MCP server</b><br/>plan, validate"]
  mcp --> contract["<b>Plan contract</b><br/>refuse, never shrink"]
  contract --> yes["<b>A person says yes</b><br/>as for a developer"]
  yes --> build["<b>Executor builds</b><br/>certified modules"]
  build --> ev["<b>Evidence, trace</b><br/>name the agent"]
  classDef new fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#111
  class agent,gw,allowed,refused,mcp,ev new
```

## Phase 7: Delivery and breadth

Phase 7 runs seaLeye inside the organization, on any cloud. Single tenant or in-network, on the organization's own model, with more clouds, regions and runtimes.

```mermaid
flowchart TB
  subgraph people["People and agents"]
    dev["<b>Developer</b><br/>brings an app,<br/>says yes to a plan"]
    admin["<b>Platform admin</b><br/>runs discovery,<br/>answers its questions"]
    control["<b>Control partners</b><br/>read evidence<br/>and records"]
    agents["<b>Other agents</b><br/>Claude Code, Copilot,<br/>ADK agents"]
  end
  subgraph surfaces["Surfaces"]
    cli["<b>sealeye command</b><br/>seaLeye.run<br/>macOS and Windows"]
    portal["<b>seaLeye.online</b><br/>same operations,<br/>Cognito sign-in"]
    mcp["<b>MCP server</b><br/>plan, validate,<br/>deploy, evidence"]
  end
  dev ~~~ cli
  subgraph api["seaLeye API: single tenant or in your network"]
    frontdoor["<b>Front door agent</b><br/>LangGraph interview,<br/>uses the org catalog"]
    contract["<b>Plan contract</b><br/>refuse, never shrink<br/>must-refuse tests"]
    executor["<b>Executor</b><br/>the org's modules<br/>role per team account"]
    daytwo["<b>Day-two operations</b><br/>logs, perf, costs,<br/>pause, settings"]
    records["<b>Records</b><br/>managed database<br/>per org, per team"]
    discovery["<b>Discovery swarm</b><br/>LangGraph fan-out,<br/>people in the loop"]
    catalog["<b>Org catalog</b><br/>modules, usage rules,<br/>what must be refused"]
    promote["<b>Promote, approvals</b><br/>approvals wait days<br/>as graph interrupts"]
  end
  frontdoor ~~~ records
  contract ~~~ discovery
  executor ~~~ catalog
  daytwo ~~~ promote
  cli ~~~ frontdoor
  subgraph backbone["Governed backbone: every model, tool and agent call"]
    gateway["<b>agentgateway</b><br/>models, MCP and A2A,<br/>policy per agent"]
    routing["<b>Model routing</b><br/>cheap for bulk work,<br/>bank code in-account"]
    caps["<b>Spend caps</b><br/>per run, per worker,<br/>rate limits"]
    langfuse["<b>LangFuse</b><br/>self-hosted, Canada<br/>traces, scores, evals"]
  end
  records ~~~ gateway
  subgraph outside["Outside seaLeye"]
    models["<b>Models</b><br/>the org's own model<br/>any approved endpoint"]
    cloud["<b>Cloud and IaC</b><br/>AWS, Azure, GCP<br/>more regions"]
    library["<b>Platform library</b><br/>modules, pipelines<br/>in the org's repos"]
    tools["<b>Enterprise tools</b><br/>ServiceNow, Jira,<br/>Teams, Slack"]
  end
  gateway ~~~ models
  classDef new fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#111
  class cli,cloud,models,records new
```
