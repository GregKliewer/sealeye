#!/bin/bash
# The model gateway's jobs on the pilot server (PHASE3-PLAN Step 5; deploy/README.md, "The
# model gateway"). Run on the server, in /opt/sealeye, by update.sh and deploy/server.sh.
#
#   gateway.sh settings             write secrets/gateway.env from Parameter Store
#   gateway.sh restart-if-changed   restart the gateway when its settings or keys changed
#   gateway.sh restart              restart it now, with what secrets/gateway.env holds
#   gateway.sh ready                wait until it answers, asked through the API
#   gateway.sh logs                 its last lines, without any that hold one of its keys
#
# No value is ever printed or put on a command line.
set -euo pipefail
cd /opt/sealeye
# REGION, written when the server was created.
source ./server.env

ENV_FILE=secrets/gateway.env

param_value() {
  aws ssm get-parameter --region "$REGION" --name "$1" --with-decryption --query Parameter.Value --output text 2>/dev/null || true
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
    MODEL_KEY="$(param_value /sealeye/gateway/ANTHROPIC_API_KEY)"
    GATEWAY_KEY="$(param_value /sealeye/SEALEYE_GATEWAY_KEY)"
    GATEWAY_BUDGET="$(param_value /sealeye/SEALEYE_GATEWAY_BUDGET)"
    GATEWAY_BUDGET="${GATEWAY_BUDGET:-20}"
    if [ -z "$MODEL_KEY" ] || [ -z "$GATEWAY_KEY" ]; then
      unset MODEL_KEY GATEWAY_KEY
      echo "The model gateway needs /sealeye/gateway/ANTHROPIC_API_KEY and /sealeye/SEALEYE_GATEWAY_KEY. deploy/README.md, \"The model gateway\", says how to create them. Nothing was changed."
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
    # Its spending is kept in SQLite here, so a restart does not reset the budget. It runs
    # as a user of its own (65532), which must be able to write the folder.
    mkdir -p gateway-data && chown 65532:65532 gateway-data && chmod 700 gateway-data
    echo "The model gateway's settings are written (budget: ${GATEWAY_BUDGET} US dollars a 30-day period)" ;;

  restart-if-changed)
    # .gateway-started records the settings and keys the running gateway started with.
    NOW="$(cat gateway.yaml "$ENV_FILE" | sha256sum | cut -d' ' -f1)"
    if [ "$NOW" != "$(cat .gateway-started 2>/dev/null || true)" ]; then
      docker compose up -d --no-deps --force-recreate gateway
      echo "$NOW" > .gateway-started
      echo "The model gateway restarted with this release's settings"
    fi ;;

  restart)
    docker compose up -d --no-deps --force-recreate gateway
    cat gateway.yaml "$ENV_FILE" | sha256sum | cut -d' ' -f1 > .gateway-started
    echo "The model gateway restarted" ;;

  ready)
    # The gateway has no shell to check itself with, and only the API can reach it, so
    # the API asks it.
    for _ in $(seq 1 12); do
      if docker compose exec -T api node -e "fetch('http://gateway:15021/healthz/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
        echo "The model gateway is up"
        exit 0
      fi
      sleep 5
    done
    echo "The model gateway did not become ready within a minute. Its last lines:"
    docker compose logs --tail 40 --no-log-prefix gateway 2>&1 | filtered
    exit 1 ;;

  logs)
    docker compose logs --tail "${2:-40}" --no-log-prefix gateway 2>&1 | filtered ;;

  *)
    sed -n '2,10p' "$0"; exit 1 ;;
esac
