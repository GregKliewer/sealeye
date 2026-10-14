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

put_secret ANTHROPIC_API_KEY
put_secret LANGFUSE_SECRET_KEY
put_value  LANGFUSE_PUBLIC_KEY  pk-lf-...
put_value  LANGFUSE_BASE_URL    https://us.cloud.langfuse.com
put_value  SEALEYE_BUCKET       <your artifact bucket>
put_value  SEALEYE_LWA_VERSION  <the layer version in your .env>
put_value  SEALEYE_DEPLOY_ROLE_ARN arn:aws:iam::<account>:role/sealeye-deploy-pilot
put_value  SEALEYE_FUNCTION_BOUNDARY_ARN arn:aws:iam::<account>:policy/sealeye-function-boundary-pilot
put_value  ORG                  "<organization name>"
```

The values for `SEALEYE_BUCKET`, `SEALEYE_LWA_VERSION` and the LangFuse keys are the ones
already in your repo `.env` and `~/.sealeye/config`. These work in zsh (the macOS
default) and bash. To check what is stored, names only:

```bash
aws ssm get-parameters-by-path --region ca-central-1 --path /sealeye/ --query "Parameters[].[Name,Type]" --output table
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
deploy/server.sh token list                                          # never shows tokens
deploy/server.sh token revoke ana@example.com                        # stops working at once
```

A token sees only its own team's environments: their list, status, evidence and tear
down. Another team's environment answers "not found". A token issued with `--org-wide`
sees every team's, which is what the administrator's own token should be. The needs
ledger lists every app in the organization, but the lines of code that show an app's
needs only to its own team and to organization-wide tokens (DESIGN.md, "Each team sees
its own environments").

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

## When something is wrong

A developer told "could not finish checking your code for secrets" (`SCAN_FAILED`)
means gitleaks, which the image carries for the API's secret scan, did not finish:
nothing was sent to the model or deployed, on purpose. The API's logs say no more than
that, since gitleaks' own output may quote what it found. To check it runs in the
image, open a shell on the server (below) and:

```bash
cd /opt/sealeye && sudo docker compose exec api gitleaks version
```

The API's last lines, or a restart:

```bash
deploy/server.sh logs
deploy/server.sh restart
```

Or open a shell on the server, with no SSH key needed:

```bash
aws ssm start-session --region ca-central-1 --target <InstanceId>
cd /opt/sealeye && sudo docker compose logs --tail 100 api
```

That needs the Session Manager plugin for the AWS CLI (`brew install --cask
session-manager-plugin`). `server.sh` does not.
