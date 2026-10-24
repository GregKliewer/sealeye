# seaLeye: vision

First written Oct 8, 2026, from the Oct 2 product dry run and the code as it
stood at 2.16.0. This file changes rarely. When a decision changes it, the same commit
records the decision in DESIGN.md. "The surfaces" was brought up to date with what is
built on Oct 12, 2026, and again on Oct 23, 2026, when the principles gained the three
CLAUDE.md already held; how each part is built is in ARCHITECTURE.md. On Oct 24, 2026,
Greg widened it past dev: seaLeye builds and manages every stage of the path to
production, each the way the organization chose for it (DESIGN.md, "seaLeye builds
every stage, the way the organization chose for each").

## In one sentence

seaLeye is the self-service front door to an organization's own certified platform: it
learns that platform once, then lets any developer get an environment, change it and
promote it to every stage on the path to production through the organization's
approvals, without a platform engineer at the keyboard, from the command line or the
web, whichever they prefer.

## The problem

Large organizations, banks first among them, have built good platforms: a library of
infrastructure modules and a set of golden pipelines, already certified by InfoSec,
Compliance and Audit. Developers want to be on them. They still wait.

- A squad waits **weeks** for its first dev environment, because a platform engineer has
  to be forward deployed to build it.
- The platform team spends **more than half its capacity** on that simple, repetitive
  work, however much documentation, training and road-showing it does.
- What gets starved is the platform team's own roadmap: retiring legacy automation that
  is not compliant, and enabling the next cloud.

The platform is not the bottleneck. Access to it is.

## Who it is for

| Who | What they want from seaLeye |
|---|---|
| **Developer** (a squad in a line of business) | An environment in minutes, in their own words, without learning the platform's tools |
| **Platform team** | Their modules and pipelines used correctly, without their hands on every request or every promotion, each stage built the way they chose for it, and a clear signal of what apps need that the platform lacks |
| **Platform leader** | Capacity back for strategic work, and adoption of the certified platform |
| **Control partners** (InfoSec, Compliance, Audit, Third-Party and Model Risk) | Nothing built outside the certified platform, evidence for every change, no secrets anywhere |
| **Release management** | Promotions that arrive through their existing approval process |

## What it does

1. **Gets an environment in minutes.** seaLeye reads the app, asks at most a few
   questions, writes a plan a person can read and audit, and on yes builds the
   environment from the platform's own modules. Built today on AWS: four starter modules,
   and an organization's own Terraform modules once its catalog is live.
2. **Manages it over time.** Running seaLeye again on a changed app updates the same
   environment rather than creating a second one. Settings, logs, performance, cost,
   pausing and tearing down are all in seaLeye.
3. **Learns the organization's platform.** A discovery agent ingests the organization's
   own automation (modules, pipelines, legacy templates), the platform team chooses what
   is strategic, and seaLeye builds only from the catalog it writes and the platform team
   approves; no model is fine-tuned. Built today for a library on GitHub; choosing what
   is strategic comes with admin onboarding. It stops on hardcoded
   secrets, flags ambiguity for a person, and proves itself by being asked for plans it
   must refuse.
4. **Runs the path to production.** A developer asks to promote; seaLeye checks what the
   next stage is missing, sends the request through the organization's change process,
   and once the stage's gate approves, builds that stage and manages it from then on,
   the same app with the same plan at every stage. Who applies each stage is the
   organization's choice, made once in its catalog: seaLeye itself, for a platform with
   no pipeline that builds infrastructure; or the organization's own certified
   pipeline, which seaLeye drives and reads back, for a platform whose pipeline is
   already its control point. Planned in Phase 5.
5. **Fits the organization.** Sign-in and rights from the organization's identity
   provider. Gaps raised as tickets in the platform team's queue. Approvals through the
   organization's change tool. Notifications where people already are.

## Principles

**Parity between the two surfaces.** seaLeye.run (the `sealeye` command) and
seaLeye.online (the web portal) offer the same operations, one for one. If an experience
is built for one, it is built for the other. This holds because both are thin clients of
one seaLeye API:

- An operation exists as an API endpoint before either surface has it.
- The command and the page share a name, inputs and outputs. `sealeye promote` and the
  Promote button make the same call and produce the same plan, report and evidence.
- One audit trail records who did what, and from which surface.
- A capability ships when both surfaces have it.
- The surfaces may differ in how they present: the terminal is dense and typed, the
  portal is scannable and clicked. They may not differ in what they can do.

**Refuse, never shrink.** When an app needs something the platform cannot build, seaLeye
says so, names the need with the code that shows it, saves the draft, and builds
nothing. It never builds something smaller and calls it success. Every refusal is a
signal to the platform team about what to build next.

**Only the certified platform.** seaLeye builds only from modules and pipelines the
organization has certified. It never invents infrastructure. Where seaLeye applies a
stage itself, it is the path the organization certified for that stage, and is held to
the same evidence a pipeline would be.

**Real status, real evidence.** Status mirrors what the cloud actually reports. Every
change has a record a control partner can read, built from what was recorded or read at
the moment, never typed in.

**The developer's code is theirs.** seaLeye reads it and never changes it.

**Developers build dev; the organization decides the rest.** A developer builds dev
without asking anyone. Every later stage is built only after its gate approves, and by
whoever the organization chose for that stage: seaLeye, or the organization's own
pipeline, which seaLeye drives. A strong platform keeps its pipeline as the control
point; a platform without one gets seaLeye as its path. Either way the developer asks
the same way, and every stage has the same record.

**Plain language.** A developer reads what the platform does for the app, never a
product name, one cloud's own noun or a size: words every cloud uses the same way are
fine, an acronym is spelled out, and capacity is set by a load test (DESIGN.md, "What a
platform term is").

**Nothing sensitive is kept.** No secret values in any record, file, log or screen.
seaLeye keeps the least it needs to do its job and says what that is.

**Every model call through one governed door.** Each call goes through the platform's
model gateway, named for the person, team and run, under a cap, and carries no content
out: its log holds who, which run, tokens and cost, never a prompt or a reply.

**The model is the organization's choice.** A frontier model by default, or one the
organization runs itself. Priced per app under management with model costs included,
so the bill follows the value, not the tokens.

## The surfaces

- **seaLeye.run**: the `sealeye` command, where a developer already is. Dark, terminal,
  typed.
- **seaLeye.online**: the portal at the seaLeye.online domain, where the platform team
  and anyone who prefers a browser works. Light, scannable. Built: every operation the
  command has today, including a new environment through the interview.
- **The seaLeye API**: the product behind both. Hosted for the pilot on one small server
  at api.sealeye.online, beside the portal; it grows into the hosted service as the
  pilot does.

## How it is delivered

As SaaS, as a single tenant, or inside the organization's own network, with the model
of the organization's choosing. Adoption starts with a pilot: ingest the platform, teach
the front door its catalog, open it to one team with the platform team reviewing every plan, then
scale out on the pilot's evidence.

## What seaLeye is not

- Not a new platform. It sits in front of the one the organization already has.
- Not a way around the platform team. It is how the platform team's work reaches every
  squad, and how the squads' needs reach the platform team.
- Not a code generator for the app. It plans and builds the app's environment.
