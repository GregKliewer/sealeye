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
``` Changing a setting later takes
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

## Once: the address

DNS for seaLeye's domains is in Route 53 (`dns.yaml`, about $0.50 a month per
domain), so the records live in CloudFormation with everything else.

1. Create the zone and the `api` record, with the server's address:

   ```bash
   IP=$(aws cloudformation describe-stacks --region ca-central-1 --stack-name platform-sealeye-server \
     --query "Stacks[0].Outputs[?OutputKey=='PublicIp'].OutputValue" --output text)
   aws cloudformation deploy --region ca-central-1 \
     --template-file deploy/dns.yaml --stack-name platform-sealeye-dns-sealeye-online \
     --parameter-overrides DomainName=sealeye.online ApiAddress=$IP
   ```

2. Read the four nameservers it was given:

   ```bash
   aws cloudformation describe-stacks --region ca-central-1 --stack-name platform-sealeye-dns-sealeye-online \
     --query "Stacks[0].Outputs[?OutputKey=='NameServers'].OutputValue" --output text
   ```

3. At the domain's registrar, replace the domain's nameservers with those four (the
   setting is usually called "custom nameservers"). If the domain was bought through
   Route 53 itself, do it in the Route 53 console under Registered domains, or:

   ```bash
   aws route53domains update-domain-nameservers --region us-east-1 --domain-name sealeye.online \
     --nameservers Name=ns-1.example Name=ns-2.example Name=ns-3.example Name=ns-4.example
   ```

4. Wait until the name resolves to the server. Usually minutes, sometimes a few hours:

   ```bash
   dig +short NS sealeye.online      # the four Route 53 names
   dig +short api.sealeye.online     # the server's address
   ```

Caddy asks for a certificate the first time the name reaches the server, so the first
request after this can take 10 to 20 seconds.

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

## Using it

Point the CLI at it once, for every command:

```bash
echo "SEALEYE_API=https://api.sealeye.online" >> ~/.sealeye/config
```

`--api <url>` still overrides it for one command, and `--api http://localhost:3000`
reaches a local API again.

`sealeye run` no longer needs an Anthropic or LangFuse key on your machine.

## When something is wrong

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
