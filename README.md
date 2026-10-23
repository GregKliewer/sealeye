# seaLeye

Bring your app. `sealeye run` reads it, asks a few questions in your language, writes a
deployment plan you can read, and on "yes" builds a real environment and hands you a
report. When your app needs something the platform cannot build, it says so, with the
code that shows it, and builds nothing.

- **seaLeye.run** is the `sealeye` command.
- **seaLeye.online** is the web portal (`portal/`): a new environment from a folder,
  each environment's state, history, logs, evidence, plan and report and tear down, a
  plan's check, the catalog and the needs ledger, costs, the team and health; for an
  organization-wide token, discovery, the platform values and the gap report too.
- Both are clients of the seaLeye API in `api/`, which runs at https://api.sealeye.online.

## Use it

```bash
curl -fsSL https://sealeye.run/install | sh
sealeye login            # paste the token your platform team gave you
cd your-app && sealeye run
```

The command talks to https://api.sealeye.online unless `SEALEYE_API` (in
`~/.sealeye/config`) or `--api` says otherwise.

All the documentation starts at [docs/README.md](docs/README.md): where it is going
([VISION](docs/VISION.md)), what is next ([ROADMAP](docs/ROADMAP.md)), and how it is
built ([ARCHITECTURE](docs/ARCHITECTURE.md)).

## Run it locally

You need Node 20 or later, zip, the AWS CLI signed in to an account, and an Anthropic
API key. gitleaks on your PATH adds the API's deeper secret scan, and OpenTofu 1.12.6
is needed only to build an organization's own Terraform modules.

```bash
npm install
npm test                 # no AWS, no API key needed
npm link                 # puts `sealeye` on your path
```

Settings go in `.env` at the repo root (ignored by git):

```bash
export SEALEYE_ACCOUNT=<the AWS account id you expect to be signed in to>
export SEALEYE_BUCKET=<an S3 bucket for build artifacts, in ca-central-1>
export SEALEYE_LWA_VERSION=<the Lambda Web Adapter layer version>
export SEALEYE_FUNCTION_BOUNDARY_ARN=<the deploy-role stack's FunctionBoundaryArn output (deploy/README.md)>
```

The AWS credentials must also be able to read `/sealeye-apps/` in Parameter Store, where
an app's settings are kept.

Your own API key goes in your environment or in `~/.sealeye/config`:

```bash
ANTHROPIC_API_KEY=...
ORG=Your Organization
```

Start the API in one window, then use the command in another, pointed at it (add
`SEALEYE_API=http://localhost:3000` to the repo `.env` to make that the default here).
The local API asks for a token too: `node scripts/tokens.js add you@example.com "Your
Name"` prints one for `sealeye login --api http://localhost:3000`, or start it with
`SEALEYE_AUTH=off npm start` to skip that on your own machine.

```bash
npm start
cd apps/beneficiary-lookup-api && sealeye run --api http://localhost:3000
sealeye doctor --api http://localhost:3000   # checks every one of the above
```

Settings and files from before 2.17.0 (`DEPLOYME_*`, `~/.deployme/`, `deployme.yaml`)
are still read.

## Layout

| Folder | What is in it |
|---|---|
| `cli/` | the `sealeye` command and its interview |
| `api/` | the API and the executor that builds environments |
| `core/` | the plan contract and settings both of them share |
| `prompts/`, `templates/` | what the model is told, and the CloudFormation the starter's modules are built from (an organization's own modules are built with OpenTofu, `api/executor/terraform/`) |
| `portal/` | seaLeye.online, with its own package.json: `cd portal && npm ci && npm run build`, then `npm run test:e2e` |
| `apps/`, `plans/` | sample apps and test plans |
| `test/` | `npm test` |
| `scripts/` | the evals (`npm run eval:interview`, `npm run eval:discovery`) and the server's one-off jobs |
| `deploy/` | the pilot server and its runbook, [deploy/README.md](deploy/README.md) |
| `sites/` | seaLeye.run (with the installer) and sealeye.org |
| `docs/` | everything else, from [docs/README.md](docs/README.md) |
| `brand/` | the brand for both surfaces |
| `archive/` | the October 2026 demo, read-only |

Rules for working in this repo are in [CLAUDE.md](CLAUDE.md); decisions and their
reasons in [DESIGN.md](DESIGN.md).
