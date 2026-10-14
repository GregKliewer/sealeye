# seaLeye documentation

Start here. This page says what seaLeye is in a few paragraphs, then points each reader
to what they need. Every other document is linked from the map below.

## seaLeye in two minutes

Large organizations have built good platforms: libraries of infrastructure their
security and audit teams have already approved. Developers still wait weeks for an
environment, because someone from the platform team has to build each one by hand.

seaLeye is the self-service front door to that platform. A developer runs one command in
their app's folder, or opens the web portal. seaLeye reads the app, asks at most four
questions in plain language, and writes a plan a person can read. On yes, it builds the
environment from parts the platform team already trusts, and hands back an address. If
the app needs something the platform cannot build, seaLeye says so, shows the code that
shows the need, saves the draft, and builds nothing. Each of those refusals tells the
platform team what to build next.

After that, the developer manages the environment from either surface: settings, logs,
performance, costs, pausing, evidence for the control partners, and tearing it down.

There are two surfaces and one product:

- **seaLeye.run**, the `sealeye` command, for developers in their terminal.
- **seaLeye.online**, the web portal, for anyone who prefers a browser.
- Both are clients of one **seaLeye API**, so they can always do the same things.

## Where it stands (Oct 14, 2026, version 2.22.0)

- **Live** for a pilot: the API at https://api.sealeye.online, the portal at
  https://sealeye.online, and the command installed from https://sealeye.run.
- **Built:** the interview, planning, refusal and deploy; every day-two operation in
  both surfaces; app settings in the organization's own secret store; one token per
  person and a team's environments kept to that team; a secret scanner, so a key
  written into an app's code never reaches the model or a deploy (Phase 3, Step 2).
- **Next:** the rest of the governed backbone (Phase 3: a cap on every run, then a
  gateway, identity, routing and spend caps in front of every model call), with the
  second-person test (someone other than Greg, on their own machine) alongside it. Then
  learning an organization's own platform (Phase 4), the path to production (Phase 5)
  and seaLeye for agents (Phase 6). [PHASE3-PLAN.md](PHASE3-PLAN.md) is the current
  plan; [BUILD-OUT.md](BUILD-OUT.md) draws each phase.

[ROADMAP.md](ROADMAP.md) has the detail and the parity table.

## Reading paths

| If you are | Read, in this order |
|---|---|
| **Deciding whether seaLeye is worth a look** | This page, then [VISION.md](VISION.md) |
| **Trying it as a developer** | [WELCOME.md](WELCOME.md) |
| **On a platform or security team** | [VISION.md](VISION.md), then [ARCHITECTURE.md](ARCHITECTURE.md) sections 3, 4, 6 and 9 |
| **Changing the code** (person or coding agent) | [CLAUDE.md](../CLAUDE.md), [ARCHITECTURE.md](ARCHITECTURE.md), [ROADMAP.md](ROADMAP.md), [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md), then the newest entries in [DESIGN.md](../DESIGN.md) |
| **Running the pilot server** | [deploy/README.md](../deploy/README.md), then [ARCHITECTURE.md](ARCHITECTURE.md) section 6 |

## Document map

| Document | Kind | What it answers | Changes |
|---|---|---|---|
| [VISION.md](VISION.md) | Vision | Why seaLeye exists, who it serves, its principles | Rarely, with a DESIGN.md entry |
| [ROADMAP.md](ROADMAP.md) | Roadmap | The phases, what is done, the parity table | With the work |
| [BUILD-OUT.md](BUILD-OUT.md) | Roadmap pictures | What the system looks like after each phase, on one layout | With ROADMAP.md |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Architecture | How it is built: context, containers, deployment, flows, data, security | When a diagram would be wrong |
| [DESIGN.md](../DESIGN.md) | Decisions | Each decision, dated, with its reason | Every decision a later reader would have to guess |
| [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) | Decisions not yet made | What is undecided, the options, the leaning, what it blocks | When a question is asked or answered |
| [PHASE3-PLAN.md](PHASE3-PLAN.md) | Plan (current) | The step-by-step plan now being worked, and what it leaves for later | With the work |
| [PHASE2-PLAN.md](PHASE2-PLAN.md) | Plan (done) | How the team release, the secret store and day-two parity were built; its "Owed" list still stands | Not any more |
| [PHASE1-PLAN.md](PHASE1-PLAN.md) | Plan (done) | How Phase 1 was built | Not any more |
| [WELCOME.md](WELCOME.md) | Guide | A new developer's first twenty minutes | When the first run changes |
| [STEP15-CHECKLIST.md](STEP15-CHECKLIST.md) | Checklist | What to watch for in the second-person test | Before the test |
| [CLAUDE.md](../CLAUDE.md) | Rules | The invariants, names, API and layout, for anyone changing the code | With the code |
| [README.md](../README.md) | Guide | Install it, run it locally | With the setup |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Guide | Licence and how to contribute | Rarely |
| [deploy/README.md](../deploy/README.md) | Runbook | Every operation on the pilot server | With the server |
| [brand/BRAND.md](../brand/BRAND.md), [BRAND-ONLINE.md](../brand/BRAND-ONLINE.md) | Brand | How the command and the portal look and speak | Rarely |

## Keeping these true

- A change that makes a diagram in ARCHITECTURE.md wrong fixes it in the same commit.
- A decision goes in DESIGN.md with its date and reason; a finished roadmap row is
  updated in the same commit as the work.
- Nothing here holds an account number, a bucket name or any other value that only
  matters to one installation. Those live in the server's settings and in
  deploy/README.md's instructions for reading them.
