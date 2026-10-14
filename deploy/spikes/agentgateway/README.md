# Step 4: does agentgateway carry seaLeye's model calls?

PHASE3-PLAN Step 4, before anything in Step 5 is built. It runs on your Mac with Docker
Desktop, from the repo root, in about fifteen minutes. Most of it needs no key and costs
nothing: a stand-in model (`mock.mjs`) answers in place of Anthropic. Two optional parts
use real models: Anthropic's API (a few cents, with your key), and Claude on Bedrock
(waiting on the account's access).

The gateway configuration was written from agentgateway v1.6.0's source and checked
against its published schema. This spike is the first time it runs. What reading the
source found is in DESIGN.md, "agentgateway, read from its source (Step 4)". This run
confirms it or corrects it.

It answers these questions:

1. Does the Anthropic SDK, pointed at the gateway (`SEALEYE_MODEL_URL`), still get tool
   use, prompt caching and streaming back? Does the gateway send its own key upstream
   and keep the caller's token and key to itself?
2. Does `jwtAuth` let a good token through and refuse a missing, expired, wrongly signed,
   wrong-audience, wrong-issuer, person-less or expiry-less one? Does it work alongside
   the API's own key, which is sent in a header of its own?
3. Does a run's token limit, keyed by the token's `run` claim, refuse the call after the
   one that crosses it? Does the API key's money budget do the same? What database does
   the budget need?
4. Does a reply that takes 95 seconds, or a stream that is silent for 70, get through?
5. Is any prompt, reply, token or key in the access log or in the gateway's database?
6. What survives a restart: a spent budget, a spent run limit?
7. How much memory does it use, idle and with twenty calls at once? An Apple silicon Mac
   is arm64, the same as the pilot server.
8. Do the same calls work to Anthropic, and to Bedrock?

Nothing here prints a key or a token. The probe names them; it never shows them.

## 1. The image and its digest

```bash
cd deploy/spikes/agentgateway
docker pull ghcr.io/agentgateway/agentgateway:v1.6.0
docker buildx imagetools inspect ghcr.io/agentgateway/agentgateway:v1.6.0 | head -3
docker run --rm ghcr.io/agentgateway/agentgateway:v1.6.0 --version
```

Success: a `Digest: sha256:...` line, and a version that says 1.6.0. Paste both back.
Step 5 pulls the image by that digest (D7).

## 2. Keys, then the gateway against the stand-in model

From the spike's folder, where step 1 left you:

```bash
cd ../../..
node deploy/spikes/agentgateway/probe.mjs setup
cd deploy/spikes/agentgateway
docker compose run --rm gateway --validate-only -f /config/config.mock.yaml
docker compose up -d
cd ../../..
```

`setup` writes `.work/` (ignored by git). It holds a signing key for test tokens, a
second key to sign wrong ones with, the public key as `jwks.json`, and three made-up keys
in `env`: the API's key, a key with a five-cent budget, and the stand-in model's own key.

Success: `--validate-only` prints no error, and `up` starts two containers. If
validation fails, paste its output back and stop here. That is a finding.

## 3. Every check against the stand-in model

```bash
node deploy/spikes/agentgateway/probe.mjs mock
```

This takes about four minutes, two and a half of which are the slow checks. (`--quick`
leaves those out.) Each check prints PASS, FAIL or NOTE. The run ends with a JSON line,
also saved to `deploy/spikes/agentgateway/.work/results-mock.json`. **Paste that JSON
back to Claude**, whatever it says. A FAIL is a finding, not a mistake to fix here.

## 4. Memory, idle and busy

```bash
node deploy/spikes/agentgateway/probe.mjs memory
```

It prints three NOTE lines (idle, during twenty streams, after) and the JSON. Paste it
back.

## 5. Optional: the real route to Anthropic (a few cents)

This needs the same key the API uses, from your password manager. The gateway holds
it; the probe never sends it. (No comments after commands in this README: zsh reads a
`#` mid-line as an argument.)

```bash
cd deploy/spikes/agentgateway
export ANTHROPIC_API_KEY=paste-your-key-here
AGW_CONFIG=config.real.yaml docker compose up -d --force-recreate gateway
cd ../../..
node deploy/spikes/agentgateway/probe.mjs real
```

Paste the JSON back. Caching shows as a cache write on the first call and a cache read
on the second.

## 6. Waiting on Bedrock access: the route to Claude on Bedrock

Run this once `aws bedrock-runtime converse ... us.anthropic.claude-sonnet-5` works in
the account (DESIGN.md, "Inference from Canada"). The gateway signs its calls with the
credentials you give it:

```bash
cd deploy/spikes/agentgateway
eval "$(aws configure export-credentials --format env)"
AGW_CONFIG=config.bedrock.yaml docker compose up -d --force-recreate gateway
cd ../../..
node deploy/spikes/agentgateway/probe.mjs bedrock
```

Paste the JSON back. If tool use or caching fails here, try again with
`bedrockEndpointPreference: mantlePreferred` uncommented in `config.bedrock.yaml`. That
sends Anthropic's own format to Bedrock instead of translating it.

## 7. Clean up

```bash
cd deploy/spikes/agentgateway
docker compose down
rm -rf .work
unset ANTHROPIC_API_KEY AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
```

Nothing was created in AWS.

## What is here

| File | What it is |
|---|---|
| `compose.yaml` | The gateway, and a stand-in model on Node 20 |
| `config.mock.yaml` | The gateway's configuration: the API's key and its money budget, jwtAuth, a per-run token limit, timeouts, the access log, SQLite |
| `config.real.yaml`, `config.bedrock.yaml` | The same, apart from `llm.models` |
| `mock.mjs` | The stand-in model. It answers as Anthropic does and remembers what reached it (`GET /seen`) |
| `probe.mjs` | The checks |
