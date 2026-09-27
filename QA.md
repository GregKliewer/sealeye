# QA bench

Copy-paste command sequences for setting up and tearing down test runs. Keep this open in a
second window while demoing or building.

Everything happens in `qa/`, which is inside the repo and ignored by git, so a test folder is
two directories from the repo root instead of over in `/tmp`.

**One rule that is not obvious.** The test folder's **name becomes the app name**, which becomes
the stack name (`sealeye-<app>`). So a test folder is always named exactly like its app folder.
`qa/beneficiary-lookup-api`, never `qa/run1`. Renaming the folder silently creates a second
environment with a different URL, which is the Day 2 `{"message":"Not Found"}` all over again.

Two tests of the same app therefore share one environment. That is correct: they are two
deployments of one app, and `sealeye list` says so.

---

## 0. Before anything

The API has to be running, in its own window.

```
cd ~/dev/deployme-demo/deployme && npm start
```

`npm start` is plain node. Use `npm run dev` (nodemon) only while editing the API; a restart
mid-run drops an in-flight watch.

Check it, from anywhere:

```
curl -s localhost:3000/health
```

**New dependency: terminal-notifier.** `sealeye run` and `sealeye deploy` now hand the
terminal back after a few seconds and finish the wait in the background, notifying you with a
macOS notification when the stack is done. That notification goes through `terminal-notifier`,
not raw `osascript`, because `osascript`'s own notification permission gets attributed to
whatever ran the AppleScript (in practice Script Editor, not Terminal), so Terminal never shows
up in System Settings > Notifications and the notification is silently dropped under a Focus
mode. Install it once on the demo machine:

```
brew install terminal-notifier
```

Then run it once by hand so macOS asks for permission and it registers itself:

```
terminal-notifier -title seaLeye.run -message "test"
```

Check System Settings > Notifications afterward: `terminal-notifier` should be its own entry
there, not folded into Terminal or Script Editor. If the real demo is running under a Focus
mode, add `terminal-notifier` to that Focus mode's allowed apps explicitly, and test one
notification with that exact Focus mode on before relying on it live. If the screen share for
the call is window-only rather than full screen, test that too: a notification banner is a
system-level overlay and a window-only share may not capture it.

If `terminal-notifier` is missing entirely, the CLI falls back to `osascript` and, failing
that, exits quietly; `sealeye status <id>` and `sealeye list` always show the true state either
way. `--watch` on `run` or `deploy` skips all of this and goes back to the old fully-blocking
panel, for a rehearsal or a recording where you want to stay on the live view.

---

## 1. Set up a test folder

Three lines each: make an empty folder, copy the app in, change into it. The `/.` on the source
copies the *contents* rather than nesting a folder inside a folder. Generated files are removed
so the run starts clean, otherwise `run` offers to reuse the previous plan.

**A run is not finished until the service answers.** `succeeded` and a URL mean CloudFormation
finished, not that your code runs: a function that throws on every request still sits inside a
stack reporting `CREATE_COMPLETE`. Every deploy ends with the matching validation from
[section 4](#is-the-app-actually-answering) before it counts or goes in the scoring file. The
one-liner for each app is repeated under its setup block below so it is one paste away.

### beneficiary-lookup-api (the API app, the main demo)

```
mkdir -p ~/dev/deployme-demo/qa/beneficiary-lookup-api
cp -R ~/dev/deployme-demo/apps/beneficiary-lookup-api/. ~/dev/deployme-demo/qa/beneficiary-lookup-api/
cd ~/dev/deployme-demo/qa/beneficiary-lookup-api && rm -f DEPLOYMENT_*.md deployme.yaml && ls -A
```

Validate it, from the same folder, once `run` finishes:

```
U=$(grep -o 'https://[a-z0-9]*\.execute-api[^ ]*' DEPLOYMENT_REPORT.md | head -1) && echo "$U" && curl -s "$U/" && echo && curl -s "$U/beneficiaries/BEN-4417-2290" && echo
```

#### The redeploy change, staged

The second run's story is that the app changed: it now reads two settings from its
environment, so `config_basic` switches on and the diff card shows it. Type that change on
screen and the room watches you type. Stage it beforehand and the live step is one line.

**Pre-stage before the demo.** Once, before anyone is watching. `.stage` is a sibling of the
app folders, never inside one, so the interview never reads it.

```
mkdir -p ~/dev/deployme-demo/qa/.stage && cp -R ~/dev/deployme-demo/docs/demo/beneficiary-lookup-api-v2 ~/dev/deployme-demo/qa/.stage/ && ls -a ~/dev/deployme-demo/qa/.stage/beneficiary-lookup-api-v2
```

**Live change, one line.** From inside `qa/beneficiary-lookup-api`, after the first deploy.
It adds two settings read from the environment and changes nothing else: the routes are
untouched, so the app answers exactly as it did before and the only thing that moved is what
seaLeye.run can see in the folder. Do not wire the settings into the responses. The first run
has to be an app with no settings at all, and a route that used them would either break that
run or break this one.

```
cp ../.stage/beneficiary-lookup-api-v2/index.js ../.stage/beneficiary-lookup-api-v2/.env . && head -8 index.js
```

`head -8` is the proof: the two new constants are on screen, and nothing else was touched.
Then `sealeye run` again, and the card marks `config_basic` and its two settings as new.

**Manual version.** If `qa/.stage` is missing and you need the change without it, this writes
the same two files from inside `qa/beneficiary-lookup-api`:

```
python3 - <<'PY'
import pathlib, re
p = pathlib.Path("index.js"); s = p.read_text()
head = """const express = require('express')
const app = express()
const port = process.env.PORT || 3000

// Where the nightly refresh comes from, and how long this copy may be trusted. Both
// are read from the environment so they can differ per environment without a rebuild.
const PAYMENTS_SOR_URL = process.env.PAYMENTS_SOR_URL
const CACHE_MAX_AGE_MINUTES = Number(process.env.CACHE_MAX_AGE_MINUTES || 60)
"""
s = s.replace("""const express = require('express')
const app = express()
const port = process.env.PORT || 3000
""", head, 1)
p.write_text(s)
pathlib.Path(".env").write_text(
    "PAYMENTS_SOR_URL=https://payments-sor.internal.northline/api/v2/beneficiaries\n"
    "CACHE_MAX_AGE_MINUTES=45\n")
print("patched")
PY
head -8 index.js
```

The staged copy in `docs/demo/beneficiary-lookup-api-v2/` is the tracked original; `qa/.stage`
is a working copy and is ignored, like the rest of `qa/`.

### payment-events-processor (the complex app, plan-only)

```
mkdir -p ~/dev/deployme-demo/qa/payment-events-processor
cp -R ~/dev/deployme-demo/apps/payment-events-processor/. ~/dev/deployme-demo/qa/payment-events-processor/
cd ~/dev/deployme-demo/qa/payment-events-processor && rm -f DEPLOYMENT_*.md deployme.yaml && ls -A
```

Nothing to curl: this one is plan-only and ends in a refusal, so no URL is issued. Its check is
that no environment exists.

```
sealeye list --all --deployments | grep payment-events-processor
```

### static-website (the static path)

```
mkdir -p ~/dev/deployme-demo/qa/static-website
cp -R ~/dev/deployme-demo/apps/static-website/. ~/dev/deployme-demo/qa/static-website/
cd ~/dev/deployme-demo/qa/static-website && rm -f DEPLOYMENT_*.md deployme.yaml && ls -A
```

Validate it. Static sites are `http`, not `https`, and the second line catches the failure that
looks fine in `curl` and terrible in a browser: a stylesheet or image that did not sync.

```
U=$(grep -o 'http://[^ ]*s3-website[^ ]*' DEPLOYMENT_REPORT.md | head -1) && echo "$U" && curl -fsS "$U" | grep -o '<title>[^<]*</title>'
for f in style.css about.html; do curl -s -o /dev/null -w "$f %{http_code}\n" "$U/$f"; done
```

### Reset a folder you are already standing in

Same folder, same app name, same environment. Use this between takes.

```
APP=$(basename "$PWD") && cd .. && rm -rf "$APP" && mkdir -p "$APP" && cp -R ~/dev/deployme-demo/apps/"$APP"/. "$APP"/ && cd "$APP" && rm -f DEPLOYMENT_*.md deployme.yaml && pwd && ls -A
```

It takes the app name from the folder you are standing in, so it only works from inside a test
folder, and it only works because the test folder is named after its app. Check the `pwd` it
prints before you run anything.

---

## 1b. Set up a *separate* environment from the same app

Section 1 gives you the same app again: same name, same stack, so a second run **updates** the
first environment and the URL does not change. That is the redeploy story.

This section gives you a **different** app: a new name, a new stack, a new URL, side by side
with the original. That is the "two teams deployed this afternoon" story, the Cindy setup, and
the only way to get more than one row in `sealeye list`.

Renaming the folder is not enough on its own. The interview takes `app.name` from
`package.json` `name` **or** the folder name, so when the two disagree the model picks one and
you cannot be sure which. The sequences below change both, which is why each has a `node` line.
`static-website` has no `package.json`, so its folder name settles it.

### beneficiary-lookup-api, as a second environment

```
NEW=beneficiary-lookup-api-2
mkdir -p ~/dev/deployme-demo/qa/$NEW && cp -R ~/dev/deployme-demo/apps/beneficiary-lookup-api/. ~/dev/deployme-demo/qa/$NEW/
cd ~/dev/deployme-demo/qa/$NEW && rm -f DEPLOYMENT_*.md deployme.yaml
node -e 'const fs=require("fs"),n=process.argv[1];for(const f of ["package.json","package-lock.json"]){if(!fs.existsSync(f))continue;const j=JSON.parse(fs.readFileSync(f,"utf8"));j.name=n;if(j.packages&&j.packages[""])j.packages[""].name=n;fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")}' "$NEW" && grep -m1 '"name"' package.json && pwd
```

### payment-events-processor, as a second environment

```
NEW=payment-events-processor-2
mkdir -p ~/dev/deployme-demo/qa/$NEW && cp -R ~/dev/deployme-demo/apps/payment-events-processor/. ~/dev/deployme-demo/qa/$NEW/
cd ~/dev/deployme-demo/qa/$NEW && rm -f DEPLOYMENT_*.md deployme.yaml
node -e 'const fs=require("fs"),n=process.argv[1];for(const f of ["package.json","package-lock.json"]){if(!fs.existsSync(f))continue;const j=JSON.parse(fs.readFileSync(f,"utf8"));j.name=n;if(j.packages&&j.packages[""])j.packages[""].name=n;fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")}' "$NEW" && grep -m1 '"name"' package.json && pwd
```

### static-website, as a second environment

No `package.json`, so the folder name is the app name and nothing else needs changing.

```
NEW=static-website-2
mkdir -p ~/dev/deployme-demo/qa/$NEW && cp -R ~/dev/deployme-demo/apps/static-website/. ~/dev/deployme-demo/qa/$NEW/
cd ~/dev/deployme-demo/qa/$NEW && rm -f DEPLOYMENT_*.md deployme.yaml && pwd && ls -A
```

### Give it a believable name instead of a `-2`

`-2` is fine for your own testing. On screen it looks like a test, because it is one. A second
Northline service reads as a second team. Set `NEW` to something real and edit the README line
so the folder does not contradict the name:

```
NEW=settlement-status-api        # or payee-verification-api, fx-rate-service, mandate-registry
```

The README is what makes it hold up if anyone asks to look:

```
sed -i '' "1s/.*/# ${NEW}/" README.md && head -3 README.md
```

Anything deeper than the first line, and it is quicker to have Claude Code write a fresh
five-line README in business terms than to sed your way there.

### Validate the second one separately

Two environments means two URLs, and the whole point of a second environment is that it is
genuinely separate. Check that the new URL answers and that it is not the first one's:

```
U=$(grep -o 'https://[a-z0-9]*\.execute-api[^ ]*' DEPLOYMENT_REPORT.md | head -1) && echo "$U" && curl -fsS "$U/" | grep -o '"service":"[^"]*"'
```

Expected: a URL you have not seen before, and a `service` name matching the new folder. If the
service name is the old one, the `node` line did not run and both folders are deploying to the
same stack.

### Confirm you got two, not one

```
sealeye list
```

Two rows, two apps, two URLs. One row means the names collided: check `grep '"name"'
package.json` in both folders and `basename $PWD`.

### Tear down a second environment

By its own name, like any other:

```
sealeye destroy beneficiary-lookup-api-2
```

## 2. Timing a run

`time` is a zsh keyword, so it goes in front of the whole command.

```
time sealeye run
```

Reading the output: `total` is the wall clock, which is the number that matters. `user` and
`sys` stay near zero because the CLI spends its time waiting on the model and on AWS.

Deploy time alone, without the interview or your typing, is in the report:

```
grep -E "Started|Finished" DEPLOYMENT_REPORT.md
```

**Record cold and warm separately.** A first deploy creates the stack (about 45 s); a second
updates it (about 28 s). A warm number rehearsed as if it were cold is a surprise on the day.

---

## 3. Transcripts

`sealeye run` asks questions, so it needs a terminal. Piping it into `tee` removes the terminal
and it will refuse to run. Use `script`, which gives it a real terminal and records both sides.

```
script -q ~/dev/deployme-demo/qa/transcript-raw.txt sealeye run
```

The raw file contains colour codes and every spinner frame. Clean it into something pasteable:

```
perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g; s/.*\r(?!\n)//g' ~/dev/deployme-demo/qa/transcript-raw.txt > ~/dev/deployme-demo/qa/transcript.txt && open -a TextEdit ~/dev/deployme-demo/qa/transcript.txt
```

The first substitution drops the colours, the second keeps only the final text of any line the
spinner overwrote.

Named transcripts when you are scoring several runs:

```
script -q ~/dev/deployme-demo/qa/t-api-1.txt sealeye run
script -q ~/dev/deployme-demo/qa/t-api-2.txt sealeye run
script -q ~/dev/deployme-demo/qa/t-static-1.txt sealeye run
```

For a non-interactive command, `tee` is fine and simpler:

```
sealeye list --all --deployments | tee ~/dev/deployme-demo/qa/list.txt
```

---

## 4. Looking at what exists

### seaLeye's view

```
sealeye list
```

```
sealeye list --all
```

```
sealeye list --all --deployments
```

`list` is live environments. `--all` adds the ones you have torn down. `--deployments` switches
from one row per environment to one row per deploy.

### AWS's view

The truth, independent of seaLeye's store. If these two disagree, AWS is right.

```
source ~/dev/deployme-demo/.env && aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE ROLLBACK_COMPLETE --query "StackSummaries[].StackName" --output table
```

With when each one was last touched:

```
source ~/dev/deployme-demo/.env && aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE ROLLBACK_COMPLETE --query "StackSummaries[].[StackName,StackStatus,CreationTime,LastUpdatedTime]" --output table
```

One stack in detail:

```
source ~/dev/deployme-demo/.env && aws cloudformation describe-stacks --stack-name sealeye-beneficiary-lookup-api --query "Stacks[0].Outputs" --output table
```

### Is the app actually answering

A green `succeeded` and a URL mean CloudFormation finished. They do not mean your code is
running: a Lambda that throws on every request still lives inside a stack that reports
`CREATE_COMPLETE`. Every new run gets validated against the service itself before it counts as
a good run, and before it goes in the scoring file.

Run these from inside the test folder, right after `sealeye run` finishes, while
`DEPLOYMENT_REPORT.md` is beside you.

#### beneficiary-lookup-api

One line, and it checks the three things that matter: the URL resolves, the service identifies
itself, and the lookup path returns real data.

```
U=$(grep -o 'https://[a-z0-9]*\.execute-api[^ ]*' DEPLOYMENT_REPORT.md | head -1) && echo "$U" && curl -s "$U/" && echo && curl -s "$U/beneficiaries/BEN-4417-2290" && echo
```

Expected: the root returns `"service":"beneficiary-lookup-api"`, `"status":"ok"` and the three
example paths; the lookup returns the payee record with a fresh `checkedAt` timestamp.

The 404 path is worth one more line, because "what happens when it is not found" is a question
somebody asks and an error that arrives as an ordinary answer is a better demo than one that
does not:

```
curl -s -w '\nHTTP %{http_code}\n' "$U/beneficiaries/BEN-0000-0000"
```

Expected: `HTTP 404` with `"error":"beneficiary_not_found"` and a message in plain language,
not a stack trace and not an HTML error page.

Strict version, for a run you are about to record or score. It prints one line per check and
fails loudly rather than making you read JSON:

```
U=$(grep -o 'https://[a-z0-9]*\.execute-api[^ ]*' DEPLOYMENT_REPORT.md | head -1)
curl -fsS "$U/" | grep -q '"status":"ok"' && echo "ok   root identifies the service" || echo "FAIL root"
curl -fsS "$U/beneficiaries/BEN-4417-2290" | grep -q 'checkedAt' && echo "ok   lookup returns a record" || echo "FAIL lookup"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$U/beneficiaries/BEN-0000-0000")" = "404" ] && echo "ok   unknown reference is a clean 404" || echo "FAIL 404 path"
curl -s -o /dev/null -w 'ok   first response in %{time_total}s\n' "$U/"
```

That last line is the cold-start number. Run it twice: the first call after a deploy pays the
start-up cost, the second is what a developer would actually see. Both are worth knowing before
somebody clicks your URL in the room.

#### payment-events-processor

Nothing to curl. It is plan-only, so no environment exists and no URL is issued. If you ever
find yourself with a URL for this app, something deployed that should have been refused, and
that is a bug rather than a validation failure.

The check for this app is the refusal itself:

```
sealeye list --all --deployments | grep payment-events-processor
```

Expected: `planned` records only, and no live environment.

#### static-website, sealeye-run, sealeye-online

Static sites are `http`, not `https`, and the S3 endpoint has no index redirect beyond the
document root, so every page has to be asked for by name:

```
U=$(grep -o 'http://[^ ]*s3-website[^ ]*' DEPLOYMENT_REPORT.md | head -1) && echo "$U"
curl -fsS "$U" | grep -o '<title>[^<]*</title>'
curl -s -o /dev/null -w 'HTTP %{http_code}  %{time_total}s\n' "$U"
```

Expected: the title of the page you deployed, and `HTTP 200`.

`sealeye-run` is a site of six pages now, not one. Every page, the stylesheet and the wordmark
have to come back `200`, because a page that 404s and a stylesheet that 404s look identical
from the home page:

```
for f in index.html docs.html about.html contact.html online.html changelog.html style.css sealeye-wordmark.svg; do
  curl -s -o /dev/null -w "$f %{http_code}\n" "$U/$f"
done
```

Expected: `200` on all eight. Anything else means the sync missed a file, which is the failure
that looks fine in `curl` on the home page and terrible in a browser one click later.

And confirm each page is the page it should be, not the home page served under another name:

```
for f in index.html docs.html about.html contact.html online.html changelog.html; do
  printf '%-16s ' "$f"; curl -fsS "$U/$f" | grep -o '<title>[^<]*</title>' | sed 's/<[^>]*>//g'
done
```

Expected: `seaLeye.run`, `seaLeye.run docs`, `About seaLeye.run`, `Contact seaLeye.run`,
`seaLeye.online`, `seaLeye.run changelog`.

For `sealeye-run` also confirm the install line made it, and that the version on the page is
the version the CLI prints:

```
curl -fsS "$U" | grep -q 'npm install -g @northline/sealeye' && echo "ok   install section is live" || echo "FAIL install section missing"
curl -fsS "$U" | grep -q 'v2.14.2' && echo "ok   version matches" || echo "FAIL version on the page is not v2.14.2"
```

### One check that is not curl

Open the URL in a real browser once per new run, not just in `curl`. `curl` proves the service
answered; it does not prove the page looks right, that the fonts loaded, or that a mixed-content
warning is not sitting in the address bar. Thirty seconds, every time.

---

## 5. Tearing down

By app name, which is what you will want in front of people:

```
sealeye destroy beneficiary-lookup-api
```

```
sealeye destroy payment-events-processor
```

```
sealeye destroy static-website
```

Then confirm against AWS, not against the store:

```
source ~/dev/deployme-demo/.env && aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE ROLLBACK_COMPLETE --query "StackSummaries[].StackName"
```

### Clear the bench

Removes every test folder. Deployed environments are untouched, so destroy first.

```
rm -rf ~/dev/deployme-demo/qa/*/ && ls -A ~/dev/deployme-demo/qa/
```

### End of session

Nothing running, nothing costing money.

```
sealeye list && source ~/dev/deployme-demo/.env && aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE ROLLBACK_COMPLETE --query "StackSummaries[].StackName"
```

Both should come back empty except for the two brand sites, which stay up through October 2.

---

## 6. When something is wrong

**`TypeError: fetch failed`** means the API is not running. Section 0.

**`git status` prints nothing** when you know it should not: a stale lock.

```
rm -f ~/dev/deployme-demo/.git/index.lock && cd ~/dev/deployme-demo && git status --short
```

**A stack exists that seaLeye does not list** (store cleared, or a run interrupted before the
record was written). Delete it directly, then reconcile:

```
source ~/dev/deployme-demo/.env && aws cloudformation delete-stack --stack-name sealeye-<app>
```

A static stack will refuse while its bucket has files in it. Empty it first:

```
source ~/dev/deployme-demo/.env && aws s3 rm s3://<bucket> --recursive
```

**Check the spend**, worth a glance at the end of a heavy day:

```
source ~/dev/deployme-demo/.env && aws ce get-cost-and-usage --time-period Start=$(date -v1d +%Y-%m-%d),End=$(date -v+1d +%Y-%m-%d) --granularity MONTHLY --metrics UnblendedCost --query "ResultsByTime[0].Total.UnblendedCost" 2>/dev/null || echo "Cost Explorer not enabled; check the console"
```

---

## 7. Add your own

Sequences that earn their place: anything typed twice. Keep the folder-name rule in mind when
adding one, and keep each block to a single paste.
