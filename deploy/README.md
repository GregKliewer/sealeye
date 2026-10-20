# Running the seaLeye API on the pilot server

PHASE1-PLAN Step 9 (DESIGN.md, "One small server in ca-central-1"). One t4g.small in
ca-central-1 runs the API behind Caddy, which gets its own HTTPS certificate. About $20 a
month. Everything below is run on your Mac, from the repo root, with the AWS CLI signed
in to the seaLeye account as someone who can create IAM roles.

| File | What it is |
|---|---|
| `server.yaml` | The server: instance, fixed address, firewall (web only, no SSH), its role, an image repository, a config bucket. Stack `platform-sealeye-server`. |
| `deploy-role.yaml` | The `sealeye-deploy-*` role every deployment goes through. Stack `platform-sealeye-deploy-role`. |
| `settings.mjs`, `start.mjs`, `with-settings.mjs` | How the API starts: its settings from Parameter Store, its database, AWS calls through the deploy role. |
| `compose.yaml`, `Caddyfile` | What runs on the server: the API, Postgres and Caddy. |
| `dns.yaml` | Route 53 for a domain, with the `api` record. |
| `release.sh` | Build, push and roll out a new version. Run on your Mac. |
| `update.sh` | The server's half of a release. `release.sh` sends it. It also installs the nightly backup. |
| `server.sh` | The server's own jobs, run from your Mac: backup, restore check, importing records, restart, logs. |
| `ci-role.yaml` | The role GitHub takes to store the image it builds. Stack `platform-sealeye-ci`. |
| `backup.sh`, `restore-check.sh` | The server's half of those jobs. |
| `terraform-role.yaml` | The `sealeye-deploy-terraform-*` role an organization's own modules are built through, and their functions' boundary. Stack `platform-sealeye-terraform-role`. |
| `foundation.yaml` | The network the made-up organization's modules are built into. Stack `platform-sealeye-foundation`. |
| `pin-tofu.sh` | Writes OpenTofu's and the AWS provider's checksums into the Dockerfile. Run on your Mac after either version changes. |

Platform stacks are named `platform-sealeye-*`, never `sealeye-*`, so the deploy role,
which may only touch `sealeye-*` stacks, can never touch them.

## Once: create the server

```bash
aws cloudformation deploy --region ca-central-1 \
  --template-file deploy/server.yaml --stack-name platform-sealeye-server \
  --capabilities CAPABILITY_IAM
```

Takes about five minutes. Then read its outputs:

```bash
aws cloudformation describe-stacks --region ca-central-1 --stack-name platform-sealeye-server \
  --query "Stacks[0].Outputs" --output table
```

## Once: create the deploy role

It may write function code only to your artifact bucket, so it needs that bucket's exact
name: the value of `SEALEYE_BUCKET` (or `DEPLOYME_BUCKET`) in your repo `.env`. A wrong
name shows up only at the first deploy, as AccessDenied on `s3:PutObject`. These read
both values for you:

```bash
BUCKET=$(grep -hE '^(SEALEYE|DEPLOYME)_BUCKET=' .env | head -1 | cut -d= -f2-)
SERVER_ROLE=$(aws cloudformation describe-stacks --region ca-central-1 --stack-name platform-sealeye-server \
  --query "Stacks[0].Outputs[?OutputKey=='ServerRoleArn'].OutputValue" --output text)
echo "bucket: $BUCKET"; echo "server role: $SERVER_ROLE"

aws cloudformation deploy --region ca-central-1 \
  --template-file deploy/deploy-role.yaml --stack-name platform-sealeye-deploy-role \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides ServerRoleArn="$SERVER_ROLE" ArtifactBucket="$BUCKET"
```

Both `echo` lines should print a real value before you run the deploy. Its output
`DeployRoleArn` is `arn:aws:iam::<account>:role/sealeye-deploy-pilot`.

When `deploy-role.yaml` changes, run the same commands again: the stack is updated in
place, the role keeps its name, and `SEALEYE_DEPLOY_ROLE_ARN` stays the same. Do it, and
store any new output it names, before releasing an API that needs it: an API release
from Oct 12, 2026 on needs `SEALEYE_FUNCTION_BOUNDARY_ARN`, and every API app deploy
fails without it. A laptop API (`npm start`) needs it in `.env` too, and AWS credentials
that may read `/sealeye-apps/`; `sealeye doctor --api http://localhost:3000` checks.

## Once: the API's settings

The server reads every parameter under `/sealeye/` when it starts. The name after the
slash is the setting's name. Secrets are SecureStrings, so they are encrypted at rest and
never in a file. Type each value at the prompt rather than on the command line, so it
stays out of your shell history:

```bash
put_secret() { printf "%s: " "$1"; stty -echo; read -r v; stty echo; echo; aws ssm put-parameter --region ca-central-1 --name "/sealeye/$1" --type SecureString --value "$v" --overwrite >/dev/null && echo "saved /sealeye/$1"; unset v; }
put_value()  { aws ssm put-parameter --region ca-central-1 --name "/sealeye/$1" --type String --value "$2" --overwrite >/dev/null; }

put_secret LANGFUSE_SECRET_KEY
put_value  LANGFUSE_PUBLIC_KEY  pk-lf-...
put_value  LANGFUSE_BASE_URL    https://us.cloud.langfuse.com
put_value  SEALEYE_BUCKET       <your artifact bucket>
put_value  SEALEYE_LWA_VERSION  <the layer version in your .env>
put_value  SEALEYE_DEPLOY_ROLE_ARN arn:aws:iam::<account>:role/sealeye-deploy-pilot
put_value  SEALEYE_FUNCTION_BOUNDARY_ARN arn:aws:iam::<account>:policy/sealeye-function-boundary-pilot
put_value  ORG                  "<organization name>"
```

The model key does not go here: it belongs to the model gateway, under
`/sealeye/gateway/`, and "The model gateway" below says how to store it, and how to make
`SEALEYE_GATEWAY_KEY`, the key the API calls the gateway with. The values for `SEALEYE_BUCKET`, `SEALEYE_LWA_VERSION` and the LangFuse keys are the ones
already in your repo `.env` and `~/.sealeye/config`. These work in zsh (the macOS
default) and bash. To check what is stored, names only:

```bash
aws ssm get-parameters-by-path --region ca-central-1 --path /sealeye/ --recursive --query "Parameters[].[Name,Type]" --output table
```

`SEALEYE_DEPLOY_ROLE_ARN` is the deploy-role stack's `DeployRoleArn` output, and can be
stored straight from it:

```bash
put_value SEALEYE_DEPLOY_ROLE_ARN "$(aws cloudformation describe-stacks --region ca-central-1 \
  --stack-name platform-sealeye-deploy-role \
  --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArn'].OutputValue" --output text)"
put_value SEALEYE_FUNCTION_BOUNDARY_ARN "$(aws cloudformation describe-stacks --region ca-central-1 \
  --stack-name platform-sealeye-deploy-role \
  --query "Stacks[0].Outputs[?OutputKey=='FunctionBoundaryArn'].OutputValue" --output text)"
```

`SEALEYE_FUNCTION_BOUNDARY_ARN` is the most any app's function may do (write its logs and
read app settings); every function role is made with it, and the deploy role can make
one no other way. Changing a setting later takes
effect at the next release, or after `docker compose restart api` on the server.

## Once: the database password

Postgres keeps the API's records and its interviews in progress (PHASE1-PLAN Step 10).
Its password is one more parameter, made up once and never typed by anyone:

```bash
aws ssm put-parameter --region ca-central-1 --name /sealeye/POSTGRES_PASSWORD \
  --type SecureString --value "$(openssl rand -hex 24)" >/dev/null && echo saved
```

Postgres reads it only the first time it creates the database. Do not change the
parameter afterwards: the database would keep the old password and the API could no
longer connect. (To change it on purpose, change it inside Postgres first, with
`ALTER USER sealeye PASSWORD ...`, then the parameter, then release.)

## Once: the model gateway

From the first release with `deploy/gateway.yaml` (Oct 2026), every model call goes
through a gateway on the server (agentgateway,
`deploy/gateway.yaml`; DESIGN.md, "The model gateway on the server"). The gateway holds
the model key; the API holds only a key for the gateway, and the gateway's budget stops
model calls once $20 (or what you set) is spent in a 30-day period. The release does not
switch the API over by itself: you do that in step 3, once the gateway is up, so you can
switch back the same way.

**1. Before the release that brings it.** The release stops, changing nothing,
until both keys are in Parameter Store. Copy the model key the API uses now to the
gateway's folder, without showing it, and make a new random key for the API to call the
gateway with:

```bash
aws ssm put-parameter --region ca-central-1 --name /sealeye/gateway/ANTHROPIC_API_KEY --type SecureString --overwrite \
  --value "$(aws ssm get-parameter --region ca-central-1 --name /sealeye/ANTHROPIC_API_KEY --with-decryption --query Parameter.Value --output text)" \
  --query Version --output text
aws ssm put-parameter --region ca-central-1 --name /sealeye/SEALEYE_GATEWAY_KEY --type SecureString --overwrite \
  --value "$(openssl rand -base64 33 | tr '+/' '-_' | tr -d '=\n')" --query Version --output text
```

On a new server that never had `/sealeye/ANTHROPIC_API_KEY`, type the model key instead,
with `put_secret` from "Once: the API's settings": `put_secret gateway/ANTHROPIC_API_KEY`.

Success: two version numbers. The budget is $20 for each 30-day period unless
`/sealeye/SEALEYE_GATEWAY_BUDGET` says otherwise, in US dollars:

```bash
aws ssm put-parameter --region ca-central-1 --name /sealeye/SEALEYE_GATEWAY_BUDGET --type String --value 20 --overwrite --query Version --output text
```

**2. The release.** `deploy/release.sh`, as in "Every release" below. Success: among its
lines, in this order,

```
The model gateway's settings are written (budget: 20 US dollars a 30-day period)
The model gateway restarted with this release's settings
The API is up, running ...
The model gateway is up
```

The API still calls the model directly at this point, so nothing a developer sees has
changed. If the gateway does not come up, the release says so, shows its last lines and
still finishes, since the API does not use it yet: fix the gateway before step 3. If a
key is missing, the release stops before changing anything on the server.

**3. Switch the API to the gateway.** Point it at the gateway, take the model key away
from it, and restart it:

```bash
aws ssm put-parameter --region ca-central-1 --name /sealeye/SEALEYE_MODEL_URL --type String --value http://gateway:4000 --overwrite --query Version --output text
aws ssm delete-parameter --region ca-central-1 --name /sealeye/ANTHROPIC_API_KEY
deploy/server.sh restart
deploy/server.sh logs | grep "settings read"
```

On a new server that never had `/sealeye/ANTHROPIC_API_KEY`, the delete says
`ParameterNotFound`, which is fine.

(This needs AWS CLI version 2, which `aws --version` shows: version 1 would try to
fetch the address instead of storing it.)

Success: `The API restarted and is answering.`, then a line of setting names that has
`SEALEYE_GATEWAY_KEY` and `SEALEYE_MODEL_URL` and no `ANTHROPIC_API_KEY`. Then run an
interview from any app folder (`sealeye run` in `apps/static-website`, answering N at
the end), and see the gateway carried it:

```bash
deploy/server.sh gateway-logs
```

Success: a line per model call naming `claude-sonnet-5`, its token counts and a cost,
and no prompt or reply.

**To switch back** (the gateway stays up, unused): give the API its model key again,
stop pointing it at the gateway, and restart it.

```bash
aws ssm put-parameter --region ca-central-1 --name /sealeye/ANTHROPIC_API_KEY --type SecureString --overwrite \
  --value "$(aws ssm get-parameter --region ca-central-1 --name /sealeye/gateway/ANTHROPIC_API_KEY --with-decryption --query Parameter.Value --output text)" \
  --query Version --output text
aws ssm delete-parameter --region ca-central-1 --name /sealeye/SEALEYE_MODEL_URL
deploy/server.sh restart
```

Success: `The API restarted and is answering.`, and `deploy/server.sh logs | grep
"settings read"` lists `ANTHROPIC_API_KEY` again and no `SEALEYE_MODEL_URL`.

**Rolling back to a release from before the gateway:** switch back first, as above.
Otherwise the old release removes the gateway while the API still sends its calls to
it, and every interview fails. (An old release also reads `/sealeye/gateway/` into the
API again, since only new releases leave it out.)

**Changing the budget or a key later:** change the parameter, then

```bash
deploy/server.sh gateway-restart
```

It rewrites the gateway's settings, restarts the gateway and the API, and ends with `The
model gateway is up`. A new budget amount keeps the money already spent in this period
counted. A new gateway key may start the count again, since the gateway keeps the count
for each key. The gateway's
period is 30 days counted from 1970, not the calendar month, so it resets on a date that
moves by a day or two each month.

**When the budget is spent**, every interview stops at its first model call, and the
developer reads that seaLeye has used its model budget for this period, until the
period ends or you raise the budget. `deploy/server.sh gateway-logs` shows the refusals
(status 429).

The commands above put a key on the `aws` command line for the moment it runs, where
another program on your Mac could see it, as `put_secret` does; they keep it out of
your shell history. On the server, `docker inspect` and `docker compose config` show the
gateway's keys to anyone with root, so never paste their output anywhere.

## Once: who is calling (the token on every model call)

From the first release with `api/gateway-token.js` (Phase 3 Step 6), the API signs a
short-lived token for every model call. It names the person who started the
interview, their team, the run, the worker and whether it started from the command or
the portal. The gateway refuses any call without one, and writes those names into each
line of its log (DESIGN.md, "A token on every model call").

**1. Before that release,** make the signing key, on your Mac from the repo root:

```bash
node deploy/gateway-signing-key.mjs
```

Success: `Stored a new signing key, id ...`. It stores the private half at
`/sealeye/SEALEYE_GATEWAY_SIGNING_KEY`, which only the API reads, and the public half at
`/sealeye/gateway/JWKS`, which the gateway gets. It prints neither. Without them the
release stops, changing nothing, and says to run this.

**2. The release,** `deploy/release.sh`. Success: the same lines as before, with `The
model gateway's settings are valid` before the restart, and ending with `The model
gateway is up, and checks the key the API signs with (...)`. If it says the two keys
differ, run `node deploy/gateway-signing-key.mjs --replace` and `deploy/server.sh
gateway-restart`. Calls that are in flight during the release itself may fail
once, between the API's restart and the gateway's.

**3. Check,** with one interview (`sealeye run` in `apps/static-website`, answering N),
then:

```bash
deploy/server.sh gateway-logs
```

Success: each model call's line has `jwt.sub` (your email), `team`, `run` (the
interview's id, `int_...`), `worker` (`interview`) and `surface` (`cli`). If the
interview fails with "The seaLeye API's credentials for the model were refused", the
gateway did not accept the API's token. Its log shows the reason, and switching back
("Once: the model gateway") works as before.

**A new signing key** (for example, if the old one may have been seen):

```bash
node deploy/gateway-signing-key.mjs --replace
deploy/server.sh gateway-restart
```

Model calls are refused for the few seconds `gateway-restart` takes, between the gateway's restart and the API's.

## The record of model calls, and the outer limit shown once

Every model call is kept in the gateway's own file on the server, with no prompt or
reply, for 90 days (a nightly job removes older ones). Unlike `gateway-logs`, it
survives a gateway restart.

The last 50 calls, the last 5, one run's calls, and one person's last 20:

```bash
deploy/server.sh gateway-calls
deploy/server.sh gateway-calls 5
deploy/server.sh gateway-calls int_097529c27e48a35a
deploy/server.sh gateway-calls greg@opmoadvisory.com 20
```

Each row has the time (UTC), person, team, run, worker, surface, model, tokens in and
out, cost in US dollars, and status: 200 for a call that was answered, 429 for one the
budget or a run's limit refused. It needs the release that brought it, whose image
carries sqlite3. Add `AWS_PAGER=` in front if the output scrolls oddly. The nightly
job's result is in the server's journal (`journalctl -u sealeye-gateway-prune` in a
shell on the server); nothing tells you if it fails.

**The outer limit, shown once** (PHASE3-PLAN Step 7). Note the budget now (no output
means the default, 20), then shrink it below what this period has already spent,
restart the gateway, and run an interview:

```bash
aws ssm get-parameter --region ca-central-1 --name /sealeye/SEALEYE_GATEWAY_BUDGET --query Parameter.Value --output text
aws ssm put-parameter --region ca-central-1 --name /sealeye/SEALEYE_GATEWAY_BUDGET --type String --value 0.01 --overwrite --query Version --output text
deploy/server.sh gateway-restart
```

Then `sealeye run` in `apps/static-website`. Success: it stops at once and says
"seaLeye has used its model budget for this period, so the interview stopped. Nothing
was written to your folder and nothing was built. Tell whoever runs the API."
`deploy/server.sh gateway-calls 5` shows the refusal as status 429. Then put the
budget back to what it was (20 here):

```bash
aws ssm put-parameter --region ca-central-1 --name /sealeye/SEALEYE_GATEWAY_BUDGET --type String --value 20 --overwrite --query Version --output text
deploy/server.sh gateway-restart
```

and run the interview once more to see it work again.

## Once: the addresses

Each of seaLeye's domains has one job, all served by the one server's Caddy, which gets
each certificate itself (PHASE1-PLAN Step 12, DESIGN.md "Each domain has one job"):

| Address | Serves |
|---|---|
| `api.sealeye.online` | the API |
| `sealeye.online` | the portal (`portal/`, built by every release), with the API under `/api` |
| `sealeye.run` | the command's home page, `sealeye.run/install` and the package it installs |
| `sealeye.org` | a redirect to `sealeye.run` |

The pages are in `sites/` and the portal in `portal/`; `release.sh` builds the portal
and sends both, with the package, every release. A release now needs Node on your Mac
for that, as `npm pack` already did.

DNS for each is a Route 53 zone (`dns.yaml`, about $0.50 a month per domain), so the
records live in CloudFormation with everything else.

1. Read the server's address once:

   ```bash
   IP=$(aws cloudformation describe-stacks --region ca-central-1 --stack-name platform-sealeye-server \
     --query "Stacks[0].Outputs[?OutputKey=='PublicIp'].OutputValue" --output text); echo $IP
   ```

2. Create or update each zone. `sealeye.online` keeps its `api` record and gains the
   domain itself and `www`; the other two get the domain and `www`:

   ```bash
   aws cloudformation deploy --region ca-central-1 \
     --template-file deploy/dns.yaml --stack-name platform-sealeye-dns-sealeye-online \
     --parameter-overrides DomainName=sealeye.online ApiAddress=$IP SiteAddress=$IP

   for d in sealeye.run sealeye.org; do
     aws cloudformation deploy --region ca-central-1 \
       --template-file deploy/dns.yaml --stack-name "platform-sealeye-dns-${d//./-}" \
       --parameter-overrides DomainName=$d SiteAddress=$IP
   done
   ```

3. Read the four nameservers each new zone was given:

   ```bash
   for d in sealeye-run sealeye-org; do
     echo "$d:"; aws cloudformation describe-stacks --region ca-central-1 --stack-name "platform-sealeye-dns-$d" \
       --query "Stacks[0].Outputs[?OutputKey=='NameServers'].OutputValue" --output text
   done
   ```

4. At the registrar, set each domain's nameservers to its four. At Namecheap: Domain
   List, Manage beside the domain, Nameservers, choose "Custom DNS", enter the four
   (without any trailing dot), and save. Each domain has its own four; do not mix them.

5. Wait until each name resolves to the server. Usually minutes, sometimes a few hours:

   ```bash
   for n in sealeye.online sealeye.run sealeye.org api.sealeye.online; do echo "$n: $(dig +short $n)"; done
   ```

Caddy asks for a certificate the first time a name reaches the server, so the first
request to each can take 10 to 20 seconds. Until a name resolves, Caddy keeps retrying
it quietly; the others are unaffected.

## Once: let GitHub store the images it builds

Every push and pull request runs the tests on GitHub (`.github/workflows/test.yml`). A
push to main that passes also builds the server's image and stores it in ECR, so a
release needs no Docker on your Mac. GitHub gets in through a role that trusts only this
repository's main branch, with no AWS keys stored anywhere:

```bash
aws cloudformation deploy --region ca-central-1 \
  --template-file deploy/ci-role.yaml --stack-name platform-sealeye-ci \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides GitHubRepository=GregKliewer/sealeye \
    GitHubOwnerId=4442214 GitHubRepositoryId=1378114164

aws cloudformation describe-stacks --region ca-central-1 --stack-name platform-sealeye-ci \
  --query "Stacks[0].Outputs[?OutputKey=='ImageRoleArn'].OutputValue" --output text
```

GitHub names the repository in what it sends AWS by its numeric ids as well as its
name, and the role checks both, so a renamed repository's old name is no use to anyone
else. The ids are not secret; for another repository, `gh api repos/<owner>/<name> --jq
'.owner.id, .id'` prints them.

If the first command fails because the identity provider for
`token.actions.githubusercontent.com` already exists, the account already trusts GitHub:
run it again with `CreateOidcProvider=false` added to the overrides.

Then, on GitHub, in the repository's Settings, Secrets and variables, Actions, Variables
tab, add a repository variable `SEALEYE_CI_ROLE_ARN` with the value the second command
printed. It is not a secret; the role only accepts this repository's main branch.
Until it is set, the image step is skipped and the tests still run.

## Once: count costs by app

The portal's Costs page and `sealeye costs` read billing by two tags every environment
carries from its first deploy on or after Oct 12, 2026: `sealeye:app` and
`sealeye:team` (DESIGN.md, "Costs come from tags, a day behind"). AWS keeps no cost by
a tag until that tag is activated for billing, and until then Costs says "No costs
carry seaLeye's tags yet" forever. Activation is once per account. Run these as someone
who may manage billing (in an AWS Organization, the management account):

```bash
aws ce list-cost-allocation-tags --region us-east-1 --tag-keys sealeye:app sealeye:team
```

- Both keys listed as `"Status": "Inactive"`: activate them (next command).
- Both `"Active"`: nothing to do here; see "Costs stay empty" under "When something is wrong".
- Nothing listed: billing has not seen the keys on any resource yet. Redeploy one
  environment, wait a day, and check again. Until then the next command fails.

```bash
aws ce update-cost-allocation-tags-status --region us-east-1 \
  --cost-allocation-tags-status TagKey=sealeye:app,Status=Active TagKey=sealeye:team,Status=Active
```

Success is an empty `Errors` list; the first command now shows both as `"Active"`.
Activation counts from that moment on. To count the days before it as well (once a
day at most, up to a year back):

```bash
aws ce start-cost-allocation-tag-backfill --region us-east-1 --backfill-from 2026-10-01T00:00:00Z
```

Costs then show about a day later; the API also keeps each answer for an hour. Pilot
apps mostly fit in AWS's free tier, so an app listed at $0.00 is working.

## Once: reading a platform library (discovery)

Discovery reads each repository named in `SEALEYE_LIBRARY_REPOS`, one commit at a time,
read-only, from GitHub's API (DESIGN.md, "Reading the library"). It needs a way in: a
GitHub App (the way an organization's own library is read), or a fine-grained token
(the pilot's way, quickest to set up). When both are set the app is used. Either can be
set up first; the API reads the settings when it starts.

**The repositories.** Owner/repo, optionally `@` and a branch, tag or commit; several
separated by commas:

```bash
aws ssm put-parameter --region ca-central-1 --name /sealeye/SEALEYE_LIBRARY_REPOS --type String --overwrite \
  --value "GregKliewer/sealeye-sample-platform" >/dev/null && echo saved
```

**A read-only token.** On GitHub: Settings, Developer settings, Personal access tokens,
Fine-grained tokens, Generate new token. Resource owner: you. Repository access: Only
select repositories, the library repositories and nothing else. Repository permissions:
Contents, Read-only (Metadata, Read-only, comes with it). Nothing else. An expiry of 90
days. Copy the token, then paste it at the prompt (it is not shown):

```bash
printf "SEALEYE_GITHUB_READ_TOKEN: "; stty -echo; read -r v; stty echo; echo
aws ssm put-parameter --region ca-central-1 --name /sealeye/SEALEYE_GITHUB_READ_TOKEN --type SecureString --overwrite --value "$v" >/dev/null && echo saved; unset v
```

**A GitHub App.** On GitHub: Settings, Developer settings, GitHub Apps, New GitHub App.
Name it, for example `seaLeye discovery (yourname)`. Homepage: https://sealeye.run.
Untick Webhook, Active. Repository permissions: Contents, Read-only (Metadata, Read-only,
comes with it); nothing else. Where can it be installed: Only on this account. Create it,
then:

1. Note the **App ID** at the top of its page.
2. Under Private keys, **Generate a private key**. A `.pem` file downloads.
3. Install App (left menu), on your account, **Only select repositories**: the library
   repositories.

Then, from the repo root, with the App ID and the downloaded file's path:

```bash
aws ssm put-parameter --region ca-central-1 --name /sealeye/SEALEYE_GITHUB_APP_ID --type String --overwrite \
  --value "<the App ID>" >/dev/null && echo saved
aws ssm put-parameter --region ca-central-1 --name /sealeye/SEALEYE_GITHUB_APP_KEY --type SecureString --overwrite \
  --value "file://<path to the downloaded .pem>" >/dev/null && echo saved
```

Delete the `.pem` from your Downloads once it is saved: Parameter Store holds the only
copy, and GitHub can issue another.

**Check it.** After `deploy/server.sh restart` (or a release), read each library as the
run will. It calls no model and keeps nothing:

```bash
deploy/server.sh library-check
```

Success looks like this for Juniper Mutual: its full commit and "read with the GitHub App"
(or "read-only token"), 71 files, gitleaks ran, the variables file
`modules/postgres/examples/restore-from-snapshot/terraform.tfvars` held back, and one
line replaced, `modules/postgres/examples/restore-from-snapshot/main.tf:11
(assigned-secret)`.

## Once: the Terraform executor (an organization's own modules)

PHASE4-PLAN Step 9 (DESIGN.md, "A Terraform executor builds an organization's own
modules"). seaLeye builds Juniper Mutual's `http-api` and `static-site` with OpenTofu, in
the API's image, through a role of its own. In order:

**1. Pin OpenTofu and the provider into the image.** On your Mac, from the repo root:

```bash
deploy/pin-tofu.sh
git diff Dockerfile
```

It downloads OpenTofu 1.12.6 and the AWS provider 5.100.0 for arm64 and amd64, writes
each file's sha256 into the Dockerfile's `ARG` lines, and checks each against its
project's own published sums. Commit the diff. Until then the image does not build: its
OpenTofu step stops and says to run this.

**2. The Terraform deploy role**, beside the deploy role, in the same account:

```bash
SERVER_ROLE=$(aws cloudformation describe-stacks --region ca-central-1 --stack-name platform-sealeye-server \
  --query "Stacks[0].Outputs[?OutputKey=='ServerRoleArn'].OutputValue" --output text)
BUCKET=$(aws ssm get-parameter --region ca-central-1 --name /sealeye/SEALEYE_BUCKET --query Parameter.Value --output text)
aws cloudformation deploy --region ca-central-1 --capabilities CAPABILITY_NAMED_IAM \
  --template-file deploy/terraform-role.yaml --stack-name platform-sealeye-terraform-role \
  --parameter-overrides ServerRoleArn="$SERVER_ROLE" ArtifactBucket="$BUCKET"
out() { aws cloudformation describe-stacks --region ca-central-1 --stack-name platform-sealeye-terraform-role \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
aws ssm put-parameter --region ca-central-1 --name /sealeye/SEALEYE_TERRAFORM_ROLE_ARN --type String --overwrite \
  --value "$(out TerraformRoleArn)" >/dev/null && echo saved
out FunctionBoundaryArn    # step 4 sets this as a platform value
```

The server's role may already become any `sealeye-deploy-*` role, so `server.yaml` does
not change. State goes under `tofu-state/` in the platform's bucket, which the role may
read and write and nothing else of.

**3. The foundation**, the network Juniper's modules are built into. It costs nothing
while nothing is built in it (no NAT gateway):

```bash
aws cloudformation deploy --region ca-central-1 --template-file deploy/foundation.yaml \
  --stack-name platform-sealeye-foundation
aws cloudformation describe-stacks --region ca-central-1 --stack-name platform-sealeye-foundation \
  --query "Stacks[0].Outputs" --output table
```

Each output's description says which platform value it is. Today's two modules need
none of them; connecting modules (the next pull request) will.

**4. Release, then discover Juniper's library again.** Catalog 3 was written before
discovery recorded how a module takes an app and what it would run, so the executor
builds none of it (`sealeye catalog test 3` says so). After `deploy/release.sh`:

```bash
sealeye discover                 # with Juniper's organization-wide token: a new draft
sealeye catalog fix              # if its words need it
sealeye catalog approve <n>
sealeye catalog live <n>
```

**5. Juniper's platform values.** With the same token:

```bash
sealeye platform set permissions_boundary_arn <FunctionBoundaryArn from step 2>
sealeye platform                 # http_api and static_site should say "built"
```

**6. The first build.** With a Juniper developer's token, in `apps/beneficiary-lookup-api`
and then `apps/static-website`: `sealeye run`, yes, then `sealeye status`, the URL,
`sealeye evidence` and `sealeye teardown`. A site takes several minutes to build and
longer to tear down: the content network is slow to change.

**If the API restarts in the middle of a build,** the deployment fails saying so, and
the environment's state keeps its lock. Look at what is there, then:

```bash
deploy/server.sh tofu-unlock dep_...            # what holds the lock
deploy/server.sh tofu-unlock dep_... --release  # release it
```

The developer's next deploy, or a tear-down, finishes what the build left.

## Once: versions and connected modules

PHASE4-PLAN Step 9, the second pull request (DESIGN.md, "Each module is built at the
version its library released" and "Modules are connected through what the library
offers"). In order, after the pull requests are merged and released:

**1. Tag Juniper's library.** Every module at the commit it was first discovered at, and
the five that changed at the merge of sealeye-sample-platform#3:

```bash
cd ~/dev/sealeye-sample-platform && git switch main && git pull
for m in $(ls modules); do git tag "$m/v1.0.0" 5e63aa5; done
for m in document-table file-bucket work-queue postgres http-api; do git tag -f "$m/v1.1.0" HEAD; done
git push origin --tags
```

**2. The Terraform deploy role again**, the same command as step 2 above: the role now
makes tables, buckets and queues, their access policies, and attaches those to an app's
role, and the boundary lets an app use its own environment's table, bucket and queue.

**3. Discover the library again**, then approve and make it live, as in step 4 above.
`sealeye catalog versions` and the Platform page show each module's version; `sealeye
platform` says `document_table`, `file_bucket` and `work_queue` are built, and why
`postgres` is not yet (docs/OPEN-QUESTIONS.md, Q23).

**4. An app that uses a table.** With a Juniper developer's token, in an app whose code
reads a table's name from its environment: `sealeye run` should enable `http_api` and
`document_table`, naming the setting; then the URL, `sealeye evidence` (its parts and
settings) and `sealeye teardown`, which says the table and everything in it go too.

## Every release

Merge to main, wait for the run on GitHub to go green, then on your Mac, on main and up
to date:

```bash
git switch main && git pull
deploy/release.sh
```

It ships what is checked out in this folder: the API image for that commit, and the
portal and the package built from its files. So it stops, before anything reaches AWS,
unless this is `main` with nothing uncommitted and exactly the commit GitHub has, and
then says which commit it is releasing. If it says this copy is behind, `git pull` and
run it again.

If GitHub built this commit, the release uses that image and needs no Docker. If not
(GitHub's run is still going, or the role is not set up), it builds the image here,
with `npm test` inside the build, which needs Docker Desktop running.
`deploy/release.sh --from-ci` uses GitHub's image or stops. Either way it then sends the
server its config, restarts it and waits until the API answers. The first release takes
longer because the server downloads everything for the first time.

Then check:

```bash
curl https://api.sealeye.online/health
```

## Backups

Every night at 03:15 Toronto time the server dumps its database to the config bucket's
`backups/` folder, where each dump is kept 30 days. Interviews in progress are left out
on purpose: their saved conversations include developers' code, and they last a day at
most.

```bash
deploy/server.sh backup          # one now
deploy/server.sh restore-check   # restore the newest into a scratch database and compare
```

Run `restore-check` once after the first backup: a backup is only a backup once a
restore of it has worked. It never touches the database the API uses.

## Records from before Postgres

The first time the API starts with Postgres, it brings in the records it kept in its own
file until then, by itself. Records that only your laptop's API knows (your
`~/.sealeye/deployments.json`) come across with:

```bash
deploy/server.sh import ~/.sealeye/deployments.json
```

Records already there are left alone, so running it twice does no harm. It restarts the
API afterwards, which is how the API reads them; an interview in progress carries on
across the restart.

## Who may call it: tokens

Every request but `/health` needs a token issued to a person (PHASE1-PLAN Step 13).
Issue one from your Mac, then send it to the person privately:

```bash
deploy/server.sh token add ana@example.com "Ana Pereira"            # team "default"
deploy/server.sh token add ana@example.com "Ana Pereira" payments   # or a team
deploy/server.sh token add you@example.com "Your Name" --org-wide   # sees every team
deploy/server.sh token add you@example.com "Your Name" --org-wide --org juniper   # in another organization
deploy/server.sh token list                                          # never shows tokens
deploy/server.sh token revoke ana@example.com                        # stops working at once
```

A token sees only its own team's environments: their list, status, evidence and tear
down. Another team's environment answers "not found". A token issued with `--org-wide`
sees every team's, which is what the administrator's own token should be. The needs
ledger lists every app in the organization, but the lines of code that show an app's
needs only to its own team and to organization-wide tokens (DESIGN.md, "Each team sees
its own environments").

`--org` issues a token in an organization other than `default`. Each organization has
its own catalogs, environments and discovery runs, and sees none of another's. The
pilot has a second one, `juniper`, so a catalog discovered from Juniper Mutual's library
(the made-up organization) can be approved and made live without changing what anyone
in `default` plans against (PHASE4-PLAN Step 7). To act as it, use that token:
`SEALEYE_TOKEN=<its token> sealeye catalog versions`, or sign in with it on the portal.
The library discovery reads is still the server's one setting (`SEALEYE_LIBRARY_REPOS`)
for every organization, until admin onboarding names one each.

The token is made on your Mac and shown once, there. The server is sent only its hash,
so it is in no log, no command history and no Session Manager record, and a copy of the
database gives nobody a working token. Someone who loses theirs gets a new one; revoke
the old one first.

After the release that brings tokens, every `sealeye` without one is refused until it
logs in, yours included, so issue your own first.

## The portal

`https://sealeye.online` asks for the same token `sealeye login` takes, once, and keeps
a twelve-hour session in its place; "Sign out" ends it, and revoking the token ends it
too. Tearing an environment down there is recorded as coming from the portal.

## Using it

The command talks to `https://api.sealeye.online` by default, so a developer installs
it, signs in once, and runs:

```bash
curl -fsSL https://sealeye.run/install | sh
sealeye login
```

`SEALEYE_API` in `~/.sealeye/config` or `--api <url>` points it elsewhere, and
`--api http://localhost:3000` reaches a local API.

`sealeye run` no longer needs an Anthropic or LangFuse key on your machine.

## Model prices

Every interview is capped by what it spends: a dollar by default, or `SEALEYE_RUN_CAP`
(in US dollars) in the server's settings. The cap prices each reply from
`core/model-prices.js`, a table with the date it was last checked. It is close, not
exact: a run can go past it by one reply, or by more if a provider changes a price
before the table does (DESIGN.md, "A run's cap is close, not exact").

Check the table, and update `checkedOn`, before any organization starts using seaLeye,
before a release that changes the model, and whenever `release.sh` warns that it is
more than 90 days old:

1. Compare each model's prices with https://platform.claude.com/docs/en/about-claude/pricing.
2. Run `npm run eval:interview`. It flags any run whose own count differs from
   LangFuse's by more than five percent.
3. If anything changed, update the table and `checkedOn` in one commit, through a pull
   request.

An interview on a model the table does not name is refused (`MODEL_NOT_PRICED`), so
set `SEALEYE_MODEL` only to a model the table prices.

The model gateway prices calls from a table of its own, compiled into its image, for
its $20 budget and the cost column of `deploy/server.sh gateway-calls`. When you check
seaLeye's table, compare a few rows of `gateway-calls` with it too: on Oct 14, 2026
they agreed to a tenth of a cent. If they differ, the gateway's budget is counting from
old prices, and a newer agentgateway image (pinned by digest, run through the spike
first) is the fix.

## When something is wrong

A developer told "could not finish checking your code for secrets" (`SCAN_FAILED`)
means gitleaks, which the image carries for the API's secret scan, did not finish:
nothing was sent to the model or deployed, on purpose. The API's logs say no more than
that, since gitleaks' own output may quote what it found. To check it runs in the
image, open a shell on the server (below) and:

```bash
cd /opt/sealeye && sudo docker compose exec api gitleaks version
```

Costs stay empty ("No costs carry seaLeye's tags yet") although apps are deployed: the
API read billing and found nothing by seaLeye's tags. An error would say so instead.
In order: the tags are not activated ("Once: count costs by app"); the environments
have not been deployed since Oct 12, 2026, so they carry no tags (this lists what does):

```bash
aws resourcegroupstaggingapi get-resources --region ca-central-1 \
  --tag-filters Key=sealeye:app --query 'ResourceTagMappingList[].ResourceARN'
```

or activation was less than a day ago, plus the hour the API keeps an answer.

The API's last lines, or a restart:

```bash
deploy/server.sh logs
deploy/server.sh restart
```

Interviews fail at their first model call: the model gateway may be down, or its budget
spent. Its last lines, which never hold a key, prompt or reply, or switch the API back
to calling the model directly ("Once: the model gateway", "To switch back"):

```bash
deploy/server.sh gateway-logs
```

Or open a shell on the server, with no SSH key needed:

```bash
aws ssm start-session --region ca-central-1 --target <InstanceId>
cd /opt/sealeye && sudo docker compose logs --tail 100 api
```

That needs the Session Manager plugin for the AWS CLI (`brew install --cask
session-manager-plugin`). `server.sh` does not.
