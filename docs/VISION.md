# seaLeye: vision

First written Oct 8, 2026, from the Oct 2 dry run of the Blitzy pitch and the code as it
stood at 2.16.0. This file changes rarely. When a decision changes it, the same commit
records the decision in DESIGN.md.

## In one sentence

seaLeye is the self-service front door to an organization's own certified platform: it
learns that platform once, then lets any developer get an environment, change it and
promote it through the organization's approvals, without a platform engineer at the
keyboard, from the command line or the web, whichever they prefer.

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
| **Platform team** | Their modules and pipelines used correctly, without their hands on every request, and a clear signal of what apps need that the platform lacks |
| **Platform leader** | Capacity back for strategic work, and adoption of the certified platform |
| **Control partners** (InfoSec, Compliance, Audit, Third-Party and Model Risk) | Nothing built outside the certified platform, evidence for every change, no secrets anywhere |
| **Release management** | Promotions that arrive through their existing approval process |

## What it does

1. **Gets an environment in minutes.** seaLeye reads the app, asks at most a few
   questions, writes a plan a person can read and audit, and on yes builds the
   environment from the platform's own modules. Built today, for four modules on AWS.
2. **Manages it over time.** Running seaLeye again on a changed app updates the same
   environment rather than creating a second one. Settings, logs, performance, cost,
   pausing and tearing down are all in seaLeye.
3. **Learns the organization's platform.** A discovery agent ingests the organization's
   own automation (modules, pipelines, legacy templates), the platform team chooses what
   is strategic, and seaLeye is trained to build only from that. It stops on hardcoded
   secrets, flags ambiguity for a person, and proves itself by being asked for plans it
   must refuse.
4. **Runs the path to production.** A developer asks to promote; seaLeye checks what the
   next stage is missing and sends the request through the organization's change
   process, then reports back when it is decided.
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
organization has certified. It never invents infrastructure.

**Real status, real evidence.** Status mirrors what the cloud actually reports. Every
change has a record a control partner can read, built from what was recorded or read at
the moment, never typed in.

**The developer's code is theirs.** seaLeye reads it and never changes it.

**Nothing sensitive is kept.** No secret values in any record, file, log or screen.
seaLeye keeps the least it needs to do its job and says what that is.

**The model is the organization's choice.** A frontier model by default, or one the
organization runs itself. Priced per app under management with model costs included,
so the bill follows the value, not the tokens.

## The surfaces

- **seaLeye.run**: the `sealeye` command, where a developer already is. Dark, terminal,
  typed. Today's product.
- **seaLeye.online**: the portal at the seaLeye.online domain, where the platform team
  and anyone who prefers a browser works. Light, scannable. Today a static mock-up.
- **The seaLeye API**: the product behind both. Today it runs on one machine; it becomes
  the hosted service seaLeye.online is served from.

## How it is delivered

As SaaS, as a single tenant, or inside the organization's own network, with the model
of the organization's choosing. Adoption starts with a pilot: ingest the platform, train
the front door, open it to one team with the platform team reviewing every plan, then
scale out on the pilot's evidence.

## What seaLeye is not

- Not a new platform. It sits in front of the one the organization already has.
- Not a way around the platform team. It is how the platform team's work reaches every
  squad, and how the squads' needs reach the platform team.
- Not a code generator for the app. It plans and builds the app's environment.
