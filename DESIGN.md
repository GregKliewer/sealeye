# Design decisions

`brand/BRAND.md` is the rule for everything the developer sees. This file is where a
deliberate departure from it is written down, with the reason, so that a difference
nobody can explain later is a bug rather than a decision.

## The dashboard header says seaLeye.online

Decided Mon Sept 22, 2026.

`apps/sealeye-online` is the page that shows environments across the organization, and
it is served from sealeye.online. Its header now reads **seaLeye.online** rather than
seaLeye.run, because a header names the thing you are looking at, and the thing you are
looking at is the dashboard rather than the command line tool.

Everything else still says seaLeye.run: the CLI banner, the report header,
`apps/sealeye-run`, and the product itself in prose. The name of the product did not
change. One page is named after its own address.

**The asset.** `brand/sealeye-online-wordmark.svg`, copied into the app folder beside
the page that uses it. It is the wordmark from `BRAND.md` with `.online` in place of
`.run`: same mark, same JetBrains Mono Bold, same phosphor `L`, and `.online` in regular
weight and Dim exactly as `.run` was. Two geometry changes follow from three more
characters: the canvas widens from 640 to 760, and the phosphor cursor block moves from
x=530 to x=648, which keeps the right margin it had before.

**It carries no provenance manifest.** The files in `brand/` ship a c2pa manifest that
describes those files. A derived file that kept it would be asserting provenance for an
image that no longer exists, so the variant was written clean.

**If the dashboard is ever shown beside the CLI**, the two wordmarks differ only in the
last word, which is the point: same product, two surfaces, and the address is how you
tell which one you are in.

## The Catalog chip says planned, not Platform Library

Decided Mon Sept 22, 2026.

**Superseded Sept 26, 2026** by planVersion 0.4: seaLeye.run no longer names modules it
cannot build, so there is no planned or requested state, only a module it builds or a
need it describes. Kept for its reasoning about naming states once. It changes `brand/BRAND-ONLINE.md` section 4, which said
"Platform Library" in its first draft.

Everything in the Catalog on seaLeye.online is in the Platform Library, including the
modules the platform builds today. A chip reading "Platform Library" on only some of the
cards therefore names the panel rather than the module, and invites the reader to think
the available ones came from somewhere else. It is also wrong about where things are
heading: once the initial install is done, everything in the library is built, and the
only modules carrying a chip at all are the new ones an app has turned out to need.

`planned` is what the plan file, the decision card and the terminal's `(planned)` marks
already say, so the console and the terminal describe a module the same way. The
terminal's refusal still names the Platform Library in its closing sentence, which is
the right place for it: there it is saying where the modules come from, which is a
sentence about provenance rather than a label on a card.

**Three states, one word each.** A module an app needs moves through more than one, and
the words are now the same everywhere:

- **available**: the platform deploys it today.
- **planned**: the platform team has agreed to support it and it has not shipped.
- **requested**: an app has turned out to need it and nobody has agreed to it yet. The
  platform team can still say no.

The difference between planned and requested is whose decision it is waiting on, and
nothing else: both are recorded in a plan, both are marked on the card, and both make
the platform decline to deploy rather than build something smaller and report success.

`availability: real` in the catalog file became `available` for the same reason the chip
changed. "Real" described what the executor could do; "available" describes where the
module has got to, which is the thing everyone reading the page or the card is actually
asking about. Nothing is `requested` today. The state exists because the demo is asked
what happens when an app needs something nobody has agreed to yet, and the honest answer
is a word rather than a shrug.

## The corporate site header says seaLeye.com

Decided Wed Sept 30, 2026.

`apps/sealeye-com` is the company's own site, the one a CIO, a head of platform
engineering or a vendor-risk team reads before a meeting. Its header reads
**seaLeye.com**, for the same reason the console's reads seaLeye.online: a header names
the thing you are looking at, and the thing you are looking at is the company rather
than either of its two products.

seaLeye.com is a name only. The real sealeye.com domain belongs to an unrelated company,
so the site is served from an S3 website address like the other two, and nothing
anywhere links to sealeye.com.

**The asset.** `brand/sealeye-com-wordmark-light.svg`, copied into
`apps/sealeye-com/images/`. It is `sealeye-online-wordmark-light.svg` with `.com` in
place of `.online`: same mark with its dark window, same ink, the same phosphor-deep `L`,
and `.com` in regular weight and Dim exactly as `.online` and `.run` are. `.com` has the
same number of characters as `.run`, so it takes the original `.run` geometry rather
than the widened `.online` one: a 640 canvas, and the cursor block back at x=530.

**It carries no provenance manifest**, for the reason the `.online` variant does not.

**The corporate site is the console's design system, not a third one.** It is set on
the light ground from `brand/BRAND-ONLINE.md`, with IBM Plex Sans for reading, JetBrains
Mono for anything that is code or data, and phosphor-deep and amber-deep in their usual
jobs. The only dark things on it are the mark and the terminal cards, which is the
console's own rule: a small dark window on a light desk. Put side by side, the three
wordmarks differ only in the last word, and the address is how you tell which door you
came in by.

## The demo becomes a product repo

Decided Thu Oct 8, 2026.

**The demo is frozen, not discarded.** The build shown on Oct 2 is the tag
`demo-2026-10-02`. The repo was renamed from `deployme-demo` to `sealeye` rather than
started fresh, because its history is the record of why seaLeye works the way it does.
The May 2026 POC documents were removed from all history first.

**Parity is a principle, not a feature.** The dry run promised that seaLeye.online does
everything seaLeye.run does, one for one. That only holds if both are clients of one API,
so the rule is: an operation is an API endpoint first, then a command and a page with
the same name, inputs and outputs, and it ships when both surfaces have it. VISION.md has
it in full.

**cli/, api/ and core/, in one package.** The CLI and the API will ship separately (a
command developers install, a service we host), so they cannot depend on each other.
What both must agree on, the plan contract, the catalog, settings and how an app name
becomes a stack name, is core/. One package rather than npm workspaces for now, because
nothing is published yet; a test enforces the boundary instead. Workspaces come when the
CLI is published (OPEN-QUESTIONS Q10).

**sealeye everywhere, deployme still read.** `deployme.yaml` was being written into
developers' folders and `~/.deployme/config` was where they were told to put their key,
so the internal name had already leaked. From 2.17.0 the names are `sealeye.yaml`,
`~/.sealeye/` and `SEALEYE_*`. The old ones are read for at least one release and never
written, and the old deployment store is copied rather than moved, so a rollback to
2.16.0 still finds everything. The `deployme` bin alias is gone; `init` stays as the
hidden alias for `run`.

**Demo material is archived, not deleted.** The three sites, transcripts, day notes,
PROGRESS, SCOPE and the QA bench are in `archive/`. The seaLeye.online mock-up is where
the real portal's design starts (OPEN-QUESTIONS Q11).

## Phase 1: who it is for, and how the hosted product is built

Decided Fri Oct 9, 2026. These answer the questions that blocked Phase 1 in
`docs/OPEN-QUESTIONS.md`.

**The first release is for collaborators, then a pilot group.** Both: people building
seaLeye with Greg, and a pilot group using it to deploy their own apps. So Phase 1 needs
a repo that sets up in minutes with good tests, and also a hosted API, sign-in and AWS
access for people who only use it. Collaborators come first, which makes the provenance
of the earliest code (OPEN-QUESTIONS Q12) a gate before anyone else sees the repo.

**The CLI uploads the app; the portal will read a repository.** A hosted API cannot read
a folder on the developer's machine, and the portal has no folder at all. For now the CLI
uploads a zip of the folder, with the same exclusions as packaging and with secret files
never leaving the laptop, and the API unpacks it into a scratch folder per interview.
Reading from a connected Git repository and branch comes later, for the portal and for
promotions. Upload first keeps the promise that you run seaLeye in your own folder.

**One AWS account, ca-central-1, Postgres, grown in three stages.** Everything stays in
one account and one region. The executor runs the AWS CLI and polls CloudFormation from a
long-lived process, so it needs a real machine with an IAM role, not Lambda and not
stored access keys. Each stage starts on a trigger, not a date:

1. Pilot: one EC2 t4g.small running the API, Postgres and Caddy in Docker Compose, with a
   nightly `pg_dump` to S3. About $20 a month.
2. When someone else's data matters: the same server, with Postgres moved to RDS
   (db.t4g.micro) for backups, point-in-time restore and patching. About $35 to $40.
3. When downtime becomes the problem (a second team, or anyone who expects it to stay
   up): ECS Express Mode, which is Fargate behind a load balancer, plus the same RDS.
   About $65 to $100, less with a 1-year Savings Plan.

Ruled out: API Gateway in front of the API, because it times out at 30 seconds and an
interview turn takes 25 to 45 seconds over server-sent events; Lightsail, Fly, Render and
Railway, because they mean long-lived AWS keys and data outside the account and possibly
outside Canada; Fargate Spot, because an interruption kills a running interview. Costs
are approximate USD as of Oct 9, 2026.

**Sign-in is Amazon Cognito.** Every bank will ask to use its own identity provider, so
sign-in speaks SAML and OIDC from the start. Cognito does, and it runs in the same
account and region as the API, so user records stay in Canada. Its free tier covers
10,000 people signing in directly and 50 through their own company's identity provider,
then $0.015 per person a month. Google sign-in works out of the box; GitHub needs a
small shim, because its sign-in is not standard OIDC. The CLI signs in through the
browser and keeps a token. How Cognito replaces the Phase 1 plan's temporary per-person
token (D7) is still to be decided.

**Deployments are designed for each team's own account and start in one shared account.**
A bank will require deployments in its own AWS account, through a role the API assumes.
The pilot starts with one shared seaLeye account and one team, but every deployment
already goes through an assumed role (the API's instance role may only assume roles
named `sealeye-deploy-*`), so adding a team's own account is configuration, not a
rewrite.

**Model calls move behind the API.** The interview runs in the API, with the API's
`ANTHROPIC_API_KEY` and any other model settings, and the CLI streams it. Developers no
longer need a key of their own, model cost can be priced into the product as the vision
says, and the system prompt stays off developers' machines. Tracing keys move with it.

**The portal is React and TypeScript, built with Vite, with shadcn/ui and Playwright.**
Greg builds through coding agents, and agents write React more reliably than any other
framework because there is the most of it to learn from. TypeScript makes an agent's
mistake a failed build with a clear error, rather than something found by reading code.
Vite builds plain static files that Caddy serves beside the API, so there is no second
server, and the portal talks only to the API. shadcn/ui components are copied into the
repo and styled from `brand/BRAND-ONLINE.md`. Playwright tests check that pages load and
work, and run in CI beside `npm test`. The archived seaLeye.online mock-up is the design
reference; the portal is rebuilt in `portal/`, not copied. Not chosen: Next.js (a second
server), Svelte and Vue (less for agents to draw on), staying plain (the interview page
would force a rewrite). All of it is free.
