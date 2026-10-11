# seaLeye

Bring your app. `sealeye run` reads it, asks a few questions in your language, writes a
deployment plan you can read, and on "yes" builds a real environment and hands you a
report. When your app needs something the platform cannot build, it says so, with the
code that shows it, and builds nothing.

- **seaLeye.run** is the `sealeye` command.
- **seaLeye.online** is the web portal (`portal/`): your organization's environments,
  their history and tear down, and the catalog.
- Both are clients of the seaLeye API in `api/`, which runs at https://api.sealeye.online.

## Use it

```bash
curl -fsSL https://sealeye.run/install | sh
sealeye login            # paste the token your platform team gave you
cd your-app && sealeye run
```

The command talks to https://api.sealeye.online unless `SEALEYE_API` (in
`~/.sealeye/config`) or `--api` says otherwise.

Where it is going: [docs/VISION.md](docs/VISION.md). What is next:
[docs/ROADMAP.md](docs/ROADMAP.md).

## Run it locally

You need Node 20 or later, the AWS CLI signed in to an account, and an Anthropic API key.

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
```

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
sealeye doctor           # checks every one of the above
```

Settings and files from before 2.17.0 (`DEPLOYME_*`, `~/.deployme/`, `deployme.yaml`)
are still read.

## Layout

| Folder | What is in it |
|---|---|
| `cli/` | the `sealeye` command and its interview |
| `api/` | the API and the executor that builds environments |
| `core/` | the plan contract and settings both of them share |
| `prompts/`, `templates/` | what the model is told, and the CloudFormation it builds from |
| `apps/`, `plans/` | sample apps and test plans |
| `test/` | `npm test` |
| `brand/` | the brand for both surfaces |
| `archive/` | the October 2026 demo, read-only |

Rules for working in this repo are in [CLAUDE.md](CLAUDE.md); decisions and their
reasons in [DESIGN.md](DESIGN.md).
