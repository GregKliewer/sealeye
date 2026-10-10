# Running the seaLeye API on the pilot server

PHASE1-PLAN Step 9 (DESIGN.md, "One small server in ca-central-1"). One t4g.small in
ca-central-1 runs the API behind Caddy, which gets its own HTTPS certificate. About $20 a
month. Everything below is run on your Mac, from the repo root, with the AWS CLI signed
in to the seaLeye account as someone who can create IAM roles.

| File | What it is |
|---|---|
| `server.yaml` | The server: instance, fixed address, firewall (web only, no SSH), its role, an image repository, a config bucket. Stack `platform-sealeye-server`. |
| `deploy-role.yaml` | The `sealeye-deploy-*` role every deployment goes through. Stack `platform-sealeye-deploy-role`. |
| `start.mjs` | How the API starts: reads its settings from Parameter Store, switches AWS calls to the deploy role. |
| `compose.yaml`, `Caddyfile` | What runs on the server. |
| `release.sh` | Build, push and roll out a new version. Run on your Mac. |
| `update.sh` | The server's half of a release. `release.sh` sends it. |

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

`ARTIFACT_BUCKET` is the bucket you already use as `SEALEYE_BUCKET`. `SERVER_ROLE_ARN`
is the `ServerRoleArn` output above.

```bash
aws cloudformation deploy --region ca-central-1 \
  --template-file deploy/deploy-role.yaml --stack-name platform-sealeye-deploy-role \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides ServerRoleArn=SERVER_ROLE_ARN ArtifactBucket=ARTIFACT_BUCKET
```

Its output `DeployRoleArn` is `arn:aws:iam::<account>:role/sealeye-deploy-pilot`.

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

## Once: the address

At your registrar, add an **A record** for `api.sealeye.online` pointing at the
`PublicIp` output. Caddy asks for a certificate as soon as the name resolves to the
server, so do this before the first release, or the first minute of the first release
will show a certificate error.

## Every release

Commit your work, start Docker Desktop, then:

```bash
deploy/release.sh
```

It builds the image for the server's processor, with `npm test` inside the build, pushes
it, sends the server its config and restarts it, then waits until the API answers.
The first release takes longer because the server downloads everything for the first
time.

Then check:

```bash
curl https://api.sealeye.online/health
```

## Using it

Point the CLI at it:

```bash
sealeye run --api https://api.sealeye.online
```

`sealeye run` no longer needs an Anthropic or LangFuse key on your machine.

## When something is wrong

Open a shell on the server, with no SSH key needed:

```bash
aws ssm start-session --region ca-central-1 --target <InstanceId>
cd /opt/sealeye && sudo docker compose logs --tail 100 api
```

To install the Session Manager plugin for the AWS CLI, see AWS's "Install the Session
Manager plugin for the AWS CLI" page.
