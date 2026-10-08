# sealeye run scoring (POC1 criteria A to F, 1 to 5)

| Criterion | api-1 | api-2 | static-1 | Notes |
|---|---|---|---|---|
| A. Question quality | |4 |4 | |
| B. Relevance | |4 |4 | |
| C. Developer experience | |2 |2 |It is easy to conclude that sealeye is frozen when reading the app as there is no visual feedback while that runs. The same is true in a couple of places, including the sealeye destroy function. A simple visual animation indicating that a process is working would help. I would also like to see the deployment plan markdown before saying yes on top of the simple prose readout. If that doc is too busy or contains too much information for the developer to decide whether or not to say "yes" to deploy, we should consider refactoring it somehow.|
| D. Cognitive load | |5 |5 |1 is high, 5 is low | 
| E. Recommendation clarity | |3 |3 | The single-paragraph, prose readout is a lot of text; we could try bullet-form instead.|
| F. Adaptation across apps | |4 |4 | (one score for the set) |

## Questions asked, verbatim
### api-1: 

? Quick check: this looks like a small live web API that answers requests when someone visits it (not a script that runs once and exits). Is that right? y

Your app is a small Express server (index.js) that listens for requests and responds, confirmed as a live web API rather than a one-off script. It will run behind an on-demand HTTPS endpoint that starts when a request comes in and costs nothing while idle, using the http_api_serverless module, with your existing start command (node index.js) as the entry point. The observability_basic module is included so you automatically get logs plus request, error and latency tracking without any setup. Your app only reads the PORT setting, which the platform supplies itself, so no environment variable configuration was needed and that module is left off. No custom domain is attached, but a public HTTPS URL will be generated for you once it deploys.

  Wrote /private/tmp/try-api/DEPLOYMENT_PLAN.md
  Wrote /private/tmp/try-api/deployme.yaml

? Deploy this? [y/N] n

### api-2: 

? Just to confirm: this app starts up and stays running, answering requests over HTTP, rather than running once and exiting. Is that right? y

Your app is a small Express server (index.js) that listens for HTTP requests and responds with a sample page. It will run behind an HTTPS endpoint that starts up when a request comes in and costs nothing while idle, using the http_api_serverless module. Alongside it, observability_basic will collect your logs and track requests, errors and response times automatically, no setup needed. Since your code only reads the PORT the platform assigns and nothing else from the environment, config_basic is included in the plan but turned off. domain_public is also included but turned off, since this version generates a public HTTPS URL for you rather than attaching a domain you own. Once deployed you will get back a public URL, your logs and your metrics.

  Wrote /private/tmp/try-api/DEPLOYMENT_PLAN.md
  Wrote /private/tmp/try-api/deployme.yaml

? Deploy this? [y/N] y

### static-1:

This is clearly a static site: index.html, about.html, style.css, an images folder, and no server code or dependencies anywhere. I see index.html and about.html, with images and style.css and no server code. This looks like a static site. Is that right? y

Your app is a static website: a home page, an about page, some CSS and a background image, with no server code behind it. It will run on the static_site_edge module, which just serves those files straight to visitors over HTTPS. The observability_basic module is included for every app and will quietly track requests, errors and response times, and keep logs, without any setup on your part. The http_api_serverless module is off since nothing here listens for requests, config_basic is off since the app does not read any settings from its environment, and a custom domain (domain_public) is off for now, though one can be added later. Once deployed you'll get a public HTTPS link to the site plus access to its logs and basic metrics. Deploy this? [y/N] y


## Modules chosen

### api-1:

The correct ones.

### api-2:

The correct ones.

### static-1:

The correct ones.

## Prompt changes made

None.

---

# After Day 5 polish

The same criteria and the same three runs, scored against `sealeye init` as it stands at the end
of Day 5. Everything above this line is the morning's run and is left exactly as it was: the
before is the evidence that the after is worth anything.

| Criterion | api-1 | api-2 | static-1 | Notes |
|---|---|---|---|---|
| A. Question quality |4 |4 |4 | |
| B. Relevance |4 |4 |4 | |
| C. Developer experience |4 |4 |4 |Much improved. |  
| D. Cognitive load |5 |5 |5 |1 is high, 5 is low |
| E. Recommendation clarity |4 |4 |4 | |
| F. Adaptation across apps |4 |4 |4 | (one score for the set) |

## Questions asked, verbatim

### api-1:

I did not record them. One only.

### api-2:

I did not record them. One only.

### static-1:

I did not record them. One only.

## Modules chosen

### api-1:

### api-2:

### static-1:

## Prompt changes made

Three, all in `prompts/interview-system.md`, and one of them is only half a fix.

- **State what you found once** (rule 3). Everything written before the question is printed above
  it, so repeating the observation in the question itself says it twice. This is the static-1
  stutter from the morning table. It did not work: a static run after the change produced the
  same shape. The cause is elsewhere in the prompt, where the exemplar question at line 150
  carries its own finding and "How a run goes" step 3 asks for a separate finding line. A rule
  that contradicts an example loses to the example. Still open.
- **Two redeploy rules** (rules 4 and 5). Never re-ask what the live environment's plan already
  answers, and name what changed in the folder and what that changes in the plan without
  proposing a module the folder does not justify. Result: zero questions on an unchanged folder.
- **Never ask for the values of environment variables** (the `config_basic` section). The plan
  holds names; the platform takes values at deploy time. Added after a run asked "what values
  should LEDGER_URL and LEDGER_API_KEY be set to", which cannot change the plan and invites a
  secret to be typed into a terminal in front of an audience.

---

# After Day 6: the Platform Library

Day 6 adds the plan-only tier, so the runs change. `payment-events-processor` is a complex app
the interview has not seen before, and two of these three runs end in a refusal rather than a
deployment. `beneficiary-lookup-api` is here only as a regression check: if its numbers move at
all, the catalog work broke something that was working.

The same six criteria, unchanged, so the three tables can be read side by side. New behaviour
gets its own checklist below rather than new criteria, because changing the scale would make
the comparison worthless.

Raw and cleaned transcripts for all three runs are in `docs/transcripts/day 6/`. The scores
below are yours to fill; everything that could be read straight off a transcript has been
filled in already, and anything a transcript cannot show says so.

| Criterion | pep-prod | pep-poc | api-regression | Notes |
|---|---|---|---|---|
| A. Question quality |4 |4 |4 | |
| B. Relevance |4 |4 |4 | |
| C. Developer experience |4 |4 |4 | |
| D. Cognitive load |4 |4 |4 | 1 is high, 5 is low |
| E. Recommendation clarity |4 |4 |4 | |
| F. Adaptation across apps |4 |4 |4 | (one score for the set) |

**The runs.** `pep-prod` is `payment-events-processor` answering `production` to the profile
question. `pep-poc` is the same app answering `poc`. `api-regression` is
`beneficiary-lookup-api`, answered `poc`, which deployed for real: stack
`sealeye-beneficiary-lookup-api`, deployment `dep_bf161fdc6732`, cold create 12:28:49.180 to
12:29:36.550, **47.4 seconds**.

## The Day 6 checklist

Read off the transcripts. Blank means the transcript cannot show it.

| Check | pep-prod | pep-poc | api-regression |
|---|---|---|---|
| No size, count, memory, concurrency or throughput figure in the card | pass | pass | pass |
| Planned modules marked `(planned)` in the card | pass (5) | pass (5) | n/a |
| The count line above `Deploy this?` is correct | pass | pass | n/a |
| `compute_container` chosen over `http_api_serverless` | pass | pass | n/a |
| `data_relational`, `events_stream`, `secrets_basic` selected from folder evidence | pass | pass | n/a |
| `network_private` selected from the README | pass | pass | n/a |
| Profile is as answered | pass (prod) | pass (poc) | pass (poc) |
| Patterns group present and drawn from the catalog | pass | correctly absent | n/a |
| Perf noted in assumptions as provisioned from this plan | (in DEPLOYMENT_PLAN.md, not the card) | n/a | n/a |
| The refusal names every planned module with its catalog line | pass | pass | n/a |
| The refusal says the plan is valid and saved | pass | pass | n/a |
| The refusal does not pitch, name a vendor, or say "coming soon" | pass | pass | n/a |
| `sealeye list` shows no live environment; `--all` shows a `planned` record | (not captured) | (not captured) | n/a |
| Still at most four questions | pass (1) | pass (1) | pass (1) |

The no-numbers rule held three times out of three, which was the one that mattered. The only
figure anywhere is "kept for 30 days", which is the `observability_basic` retention the
developer set and not a capacity guess, so it stays.

## What the transcripts show that the checklist does not

**One defect, worth fixing before Friday.** In `pep-prod` the refusal says "Five of its modules
are not in the seaLeye catalog" and then prints six rows, because the prod profile is rendered
as a sixth module:

```
    network_private    your app is not reachable from the public internet
    the prod profile   data across more than one zone, capacity warm on the request path, a queue in front of anything that bursts, alarms on errors and latency.
```

A profile is not a module, the row is far longer than the others so the column breaks, and it
is the only line with a trailing full stop. Somebody who counts to five and sees six will say
so. The fix is a separate short paragraph after the module list, along the lines of "The prod
profile is also not one this version builds", with the patterns left to the card where they
already read well. `prompts/refusal.md` and the list renderer.

**Module selection is better than expected.** The card passes `KAFKA_BROKERS` and
`BENEFICIARY_API_URL` through `config_basic`, and does not pass `DATABASE_URL` or `SIGNING_KEY`,
because those belong to `data_relational` and `secrets_basic`. Nothing told it to make that
split. It is exactly the distinction a platform engineer would draw, and it is worth having
ready as an aside if anyone asks how it decided.

**My Day 6 expectation was wrong, not the behaviour.** The guide said `pep-poc` should produce
"a visibly smaller plan" than `pep-prod`. It does not: both select the same seven modules, and
the only difference is that prod adds the Patterns group and the profile clause in the count
line. That is correct. Modules come from what the app needs, which does not change with the
profile; patterns come from the profile. Do not "fix" this, and if asked, the answer is that
the app needs a database either way, and what changes is how it is run.

**The one question is now the profile question.** After Day 5 the single question was a
confirmation of app type ("is this a live web API?"). It now spends its one question on the
profile instead, because the folder settles the app type on its own. That is a better use of
the question, and it holds across all three runs.

**`script` transcripts of a real deploy are enormous.** `api-regression` came out at 1004 lines
because `watch` redraws in place and `script` records every frame; the escape codes it uses are
cursor moves, which the `perl` strip in QA.md does not collapse. The cleaned file here keeps the
first frame and the final one with a marker between them. If you capture another deploy, expect
to trim it by hand, and use `--json` or the report for anything you only need the numbers from.

## Questions asked, verbatim

### pep-prod

> Looking at this, I can see `index.js` runs a Kafka consumer loop that connects once and keeps
> consuming, with an express server that only exposes a `/health` check reporting on that loop,
> not an HTTP API in its own right. It reads from Postgres (`DATABASE_URL`), a payment event
> stream (`KAFKA_BROKERS`, topic `payment.events`), a beneficiary service URL, and a signing
> key. The README also states plainly it must not be reachable from the public internet.
>
> **? One question: is this a proof of concept, or something Northline Bank relies on for real
> payment processing?** `production`

### pep-poc

Same app, same reading, different answer. The lead paragraph differs in wording from `pep-prod`,
which is the model writing its own prose each time; the modules it chose did not differ.

> **? One question before I finalize this: is this something Northline Bank relies on in
> production, or is it a proof of concept?** `poc`

### api-regression

> This is an Express API with two routes (a root status check and a beneficiary lookup by
> reference), reading only `PORT` from its environment, so no other settings to configure. The
> README mentions it's used by branch staff reviewing real payments before they're released.
>
> **? Is this something Northline Bank relies on day to day, or is it a proof of concept you're
> trying out?** `poc`

No stutter in any of the three: the lead says what was found, the question asks something the
lead did not already answer. The Day 5 prompt fix is holding.

## Modules chosen

### pep-prod

Enabled: `observability_basic`, `config_basic`, `compute_container` (planned),
`data_relational` (planned), `events_stream` (planned), `secrets_basic` (planned),
`network_private` (planned). Settings passed through: `KAFKA_BROKERS`, `BENEFICIARY_API_URL`.
Profile `prod`, with the Patterns group applied. No public URL offered, correctly, because the
service is private.

Correct. `compute_container` over `http_api_serverless` is the call that matters, and it made it
from the consumer loop rather than from the `/health` route.

### pep-poc

Identical module selection to `pep-prod`. No Patterns group. Profile `poc`.

Correct, and see the note above about why the plan is not smaller.

### api-regression

`http_api_serverless`, `observability_basic`. Unchanged from Day 5.

## The refusal, verbatim

From `pep-poc`, which is the clean version. `pep-prod` prints the same thing plus the profile
row described above.

```
✗ seaLeye.run cannot build this environment yet.

  Your plan is valid and saved in DEPLOYMENT_PLAN.md. Five of its modules are not
  in the seaLeye catalog:

    compute_container  a service that runs continuously rather than on demand
    data_relational    a managed relational database your app connects to
    events_stream      a stream your services publish to and read from
    secrets_basic      secrets your app reads at runtime, never stored in code
    network_private    your app is not reachable from the public internet

  These modules come from your organization's Platform Library. Once seaLeye.run is
  connected to Northline Bank's, this plan deploys as written.
```

This is the text the pivot line follows. It states what is missing, that the plan is safe, and
where the modules come from, and it stops there, which is what leaves the discovery agents and
the trained assistant for you to say rather than reading the screen aloud.

## Prompt changes made

