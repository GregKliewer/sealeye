#!/bin/bash
# The model gateway's jobs on the pilot server (PHASE3-PLAN Step 5; deploy/README.md, "The
# model gateway"). Run on the server, in /opt/sealeye, by update.sh and deploy/server.sh.
#
#   gateway.sh settings             write secrets/gateway.env from Parameter Store
#   gateway.sh validate             check its settings, keys filled in, without starting it
#   gateway.sh restart-if-changed   restart the gateway when its settings or keys changed
#   gateway.sh restart              restart it now, with what secrets/gateway.env holds
#   gateway.sh ready                wait until it answers, asked through the API
#   gateway.sh logs                 its last lines, without any that hold one of its keys
#   gateway.sh calls [run|email] [n] the record of model calls, newest first (default 50)
#   gateway.sh prune                remove calls older than 90 days from that record
#
# No value is ever printed or put on a command line.
set -euo pipefail
cd /opt/sealeye
# REGION, written when the server was created.
source ./server.env

ENV_FILE=secrets/gateway.env

# A parameter's name if it is stored, or nothing, read without decrypting its value.
param_name() {
  local out err
  err="$(mktemp)"
  if out="$(aws ssm get-parameter --region "$REGION" --name "$1" --query Parameter.Name --output text 2>"$err")"; then
    rm -f "$err"
    printf '%s' "$out"
  elif grep -q ParameterNotFound "$err"; then
    rm -f "$err"
  else
    rm -f "$err"
    echo "Could not ask Parameter Store about $1. Nothing was changed." >&2
    exit 1
  fi
}

# A parameter's value, or nothing when there is no such parameter. Any other failure
# (no permission, throttled, no network) stops here, naming the parameter, so a stored
# budget is never quietly read as the default.
param_value() {
  local out err
  err="$(mktemp)"
  if out="$(aws ssm get-parameter --region "$REGION" --name "$1" --with-decryption --query Parameter.Value --output text 2>"$err")"; then
    rm -f "$err"
    printf '%s' "$out"
  elif grep -q ParameterNotFound "$err"; then
    rm -f "$err"
  else
    rm -f "$err"
    echo "Could not read $1 from Parameter Store. Nothing was changed." >&2
    exit 1
  fi
}

# The gateway's lines, leaving out any line that holds one of its two keys.
filtered() {
  if [ -s "$ENV_FILE" ]; then
    grep -v -F -f <(grep -E '^(ANTHROPIC_API_KEY|SEALEYE_GATEWAY_KEY)=' "$ENV_FILE" | cut -d= -f2-) || true
  else
    cat
  fi
}

case "${1:-}" in
  settings)
    # The model key is kept under /sealeye/gateway/ so the API, which reads /sealeye/,
    # never holds it (deploy/settings.mjs). The API's key for the gateway is at
    # /sealeye/SEALEYE_GATEWAY_KEY, read by both. The budget is in US dollars for each
    # 30-day period, 20 when nothing says otherwise (DESIGN.md, "The gateway's budget").
    MODEL_KEY="$(param_value /sealeye/gateway/ANTHROPIC_API_KEY)" || exit 1
    GATEWAY_KEY="$(param_value /sealeye/SEALEYE_GATEWAY_KEY)" || exit 1
    GATEWAY_BUDGET="$(param_value /sealeye/SEALEYE_GATEWAY_BUDGET)" || exit 1
    GATEWAY_BUDGET="${GATEWAY_BUDGET:-20}"
    # The public half of the key the API signs each call's token with; the gateway refuses
    # any call whose token it does not sign. Only whether the private half is stored is
    # checked here: its value is the API's alone.
    JWKS="$(param_value /sealeye/gateway/JWKS)" || exit 1
    # Asked without decrypting it: only its name comes back. (Not describe-parameters,
    # which the server's role may not call: it names /sealeye/ parameters only.)
    SIGNING_KEY_STORED="$(param_name /sealeye/SEALEYE_GATEWAY_SIGNING_KEY)" || exit 1
    if [ -z "$MODEL_KEY" ] || [ -z "$GATEWAY_KEY" ]; then
      unset MODEL_KEY GATEWAY_KEY
      echo "The model gateway needs /sealeye/gateway/ANTHROPIC_API_KEY and /sealeye/SEALEYE_GATEWAY_KEY. deploy/README.md, \"The model gateway\", says how to create them. Nothing was changed."
      exit 1
    fi
    if [ -z "$JWKS" ] || [ -z "$SIGNING_KEY_STORED" ]; then
      unset MODEL_KEY GATEWAY_KEY
      echo "The model gateway needs the API's signing key: run node deploy/gateway-signing-key.mjs on your Mac (deploy/README.md, \"Who is calling\"). Nothing was changed."
      exit 1
    fi
    if [[ "$JWKS" != \{* ]]; then
      unset MODEL_KEY GATEWAY_KEY
      echo "/sealeye/gateway/JWKS is not a key set. Make it again with node deploy/gateway-signing-key.mjs --replace. Nothing was changed."
      exit 1
    fi
    # The gateway reads every dollar sign in its settings as a name to fill in, so a key
    # with anything but letters, digits, dashes and underscores is refused here.
    if ! [[ "$MODEL_KEY" =~ ^[A-Za-z0-9_-]+$ && "$GATEWAY_KEY" =~ ^[A-Za-z0-9_-]+$ ]]; then
      unset MODEL_KEY GATEWAY_KEY
      echo "A model gateway key holds a character other than letters, digits, - and _. Make it again (deploy/README.md, \"The model gateway\"). Nothing was changed."
      exit 1
    fi
    if ! [[ "$GATEWAY_BUDGET" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
      unset MODEL_KEY GATEWAY_KEY
      echo "/sealeye/SEALEYE_GATEWAY_BUDGET must be an amount in US dollars, such as 20. Nothing was changed."
      exit 1
    fi
    mkdir -p secrets && chmod 700 secrets
    ( umask 077
      printf 'ANTHROPIC_API_KEY=%s\nSEALEYE_GATEWAY_KEY=%s\nSEALEYE_GATEWAY_BUDGET=%s\n' "$MODEL_KEY" "$GATEWAY_KEY" "$GATEWAY_BUDGET" > "$ENV_FILE.new" )
    mv "$ENV_FILE.new" "$ENV_FILE"
    unset MODEL_KEY GATEWAY_KEY
    # Public, so readable by the gateway's own user.
    printf '%s\n' "$JWKS" > gateway-jwks.json.new && chmod 644 gateway-jwks.json.new && mv gateway-jwks.json.new gateway-jwks.json
    # Its spending is kept in SQLite here, so a restart does not reset the budget. It runs
    # as a user of its own (65532), which must be able to write the folder.
    mkdir -p gateway-data && chown 65532:65532 gateway-data && chmod 700 gateway-data
    echo "The model gateway's settings are written (budget: ${GATEWAY_BUDGET} US dollars a 30-day period)" ;;

  validate)
    # Run by update.sh before the new compose file starts anything, so a mistake in this
    # release's gateway settings stops the release with the old gateway still running.
    if ! ( umask 077; docker compose run --rm --no-deps gateway --validate-only -f /config/gateway.yaml > secrets/gateway-check 2>&1 ); then
      echo "The model gateway's settings in this release are not valid, so nothing was restarted. What it said:"
      filtered < secrets/gateway-check
      rm -f secrets/gateway-check
      exit 1
    fi
    rm -f secrets/gateway-check
    echo "The model gateway's settings are valid" ;;

  restart-if-changed)
    # .gateway-started records the settings and keys the running gateway started with.
    NOW="$(cat gateway.yaml "$ENV_FILE" gateway-jwks.json | sha256sum | cut -d' ' -f1)"
    if [ "$NOW" != "$(cat .gateway-started 2>/dev/null || true)" ]; then
      # The gateway checks its own settings first, with the keys filled in, so a
      # mistake leaves the running gateway as it was rather than stopping it.
      if ! ( umask 077; docker compose run --rm --no-deps gateway --validate-only -f /config/gateway.yaml > secrets/gateway-check 2>&1 ); then
        echo "The model gateway's new settings are not valid, so it keeps running with the old ones. What it said:"
        filtered < secrets/gateway-check
        rm -f secrets/gateway-check
        exit 1
      fi
      rm -f secrets/gateway-check
      docker compose up -d --no-deps --force-recreate gateway
      echo "$NOW" > .gateway-started
      echo "The model gateway restarted with this release's settings"
    fi ;;

  restart)
    docker compose up -d --no-deps --force-recreate gateway
    cat gateway.yaml "$ENV_FILE" gateway-jwks.json | sha256sum | cut -d' ' -f1 > .gateway-started
    echo "The model gateway restarted" ;;

  ready)
    # The gateway has no shell to check itself with, and only the API can reach it, so
    # the API asks it. Until the API is switched to the gateway (SEALEYE_MODEL_URL set),
    # a gateway that is not ready is a warning: the API does not use it yet.
    IN_USE="$(param_value /sealeye/SEALEYE_MODEL_URL)" || exit 1
    UP=""
    for _ in $(seq 1 12); do
      if docker compose exec -T api node -e "fetch('http://gateway:15021/healthz/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
        UP=1
        break
      fi
      sleep 5
    done
    if [ -n "$UP" ]; then
      # The key the API signs with must be the one the gateway checks against, or every
      # call is refused. Both ids are public.
      API_KID="$(docker compose exec -T api node deploy/with-settings.mjs scripts/gateway-key-id.js 2>/dev/null | tail -1 || true)"
      GATEWAY_KID="$(grep -o '"kid":"[^"]*"' gateway-jwks.json | head -1 | cut -d'"' -f4)"
      if [ -n "$API_KID" ] && [ "$API_KID" = "$GATEWAY_KID" ]; then
        echo "The model gateway is up, and checks the key the API signs with ($API_KID)"
        exit 0
      fi
      echo "The model gateway is up, but the API signs with key '${API_KID:-unknown}' and the gateway checks key '${GATEWAY_KID:-none}'. Make them match: node deploy/gateway-signing-key.mjs --replace, then deploy/server.sh gateway-restart."
    else
      echo "The model gateway did not become ready within a minute. Its last lines:"
      docker compose logs --tail 40 --no-log-prefix gateway 2>&1 | filtered
    fi
    if [ -z "$IN_USE" ]; then
      echo "The API does not use the gateway yet, so it is unaffected. Fix the gateway before switching the API to it (deploy/README.md, \"The model gateway\")."
      exit 0
    fi
    echo "The API sends its model calls to the gateway, so interviews fail until this is fixed. To switch the API back, see deploy/README.md, \"The model gateway\"."
    exit 1 ;;

  logs)
    docker compose logs --tail "${2:-40}" --no-log-prefix gateway 2>&1 | filtered ;;

  calls)
    # The gateway keeps each call in its own SQLite file, which outlives its log
    # (PHASE3-PLAN Step 7). Read with the API's image, which carries sqlite3, as the
    # gateway's own user, so no file it shares with the gateway changes owner. Only the
    # fields below are read: the file holds no prompt or reply (database.llm: metadata),
    # and this never asks for one.
    WHO="${2:-}"
    LIMIT="${3:-50}"
    # A lone number is how many calls, not a name: gateway.sh calls 5.
    if [[ "$WHO" =~ ^[0-9]+$ && -z "${3:-}" ]]; then LIMIT="$WHO"; WHO=""; fi
    if [[ -n "$WHO" && ! "$WHO" =~ ^[A-Za-z0-9@._+-]+$ ]]; then
      echo "Name a run (int_...) or a person's email, or nothing for every call."; exit 1
    fi
    [[ "$LIMIT" =~ ^[0-9]{1,5}$ ]] || { echo "The number of calls must be a whole number."; exit 1; }
    WHERE=""
    if [[ "$WHO" == int_* ]]; then
      WHERE="WHERE json_extract(attributes_json, '\$.run') = '$WHO'"
    elif [ -n "$WHO" ]; then
      WHERE="WHERE json_extract(attributes_json, '\$.\"jwt.sub\"') = '$WHO'"
    fi
    source ./.env
    docker run --rm --user 65532:65532 -v "$PWD/gateway-data:/data" --entrypoint sqlite3 "$SEALEYE_IMAGE" \
      -readonly -box -cmd ".timeout 5000" /data/gateway.db \
      "SELECT substr(completed_at, 1, 19) AS time,
              json_extract(attributes_json, '\$.\"jwt.sub\"') AS person,
              json_extract(attributes_json, '\$.team') AS team,
              json_extract(attributes_json, '\$.run') AS run,
              json_extract(attributes_json, '\$.worker') AS worker,
              json_extract(attributes_json, '\$.surface') AS surface,
              gen_ai_request_model AS model,
              input_tokens AS input, output_tokens AS output,
              printf('%.4f', cost) AS cost_usd,
              http_status AS status
       FROM request_logs $WHERE ORDER BY completed_at DESC LIMIT $LIMIT;" ;;

  prune)
    # Calls older than 90 days leave the record (DESIGN.md, "The record of model calls").
    # Only the call log: the budget's own tables are the gateway's and are not touched.
    source ./.env
    docker run --rm --user 65532:65532 -v "$PWD/gateway-data:/data" --entrypoint sqlite3 "$SEALEYE_IMAGE" -cmd ".timeout 10000" /data/gateway.db \
      "DELETE FROM request_log_payloads WHERE log_id IN (SELECT id FROM request_logs WHERE unixepoch(completed_at) < unixepoch('now', '-90 days'));
       DELETE FROM request_logs WHERE unixepoch(completed_at) < unixepoch('now', '-90 days');
       SELECT 'Removed ' || changes() || ' calls older than 90 days from the record';" ;;

  *)
    sed -n '2,10p' "$0"; exit 1 ;;
esac
