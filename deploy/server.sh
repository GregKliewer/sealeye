#!/bin/bash
# Run one of the pilot server's own jobs from your Mac, through Session Manager, and
# show what it printed. Run from the repo root with the AWS CLI signed in.
#
#   deploy/server.sh backup              back up the database now
#   deploy/server.sh restore-check       restore the newest backup into a scratch database and compare
#   deploy/server.sh import <file>       add the records in a deployments.json, then restart the API
#   deploy/server.sh restart             restart the API, and wait until it answers
#   deploy/server.sh token add <email> "<name>" [team] [--org-wide]   issue a person a token
#   deploy/server.sh token revoke <email | tok_...>      it stops working at once
#   deploy/server.sh token list          every token issued, without the tokens
#   deploy/server.sh logs                the API's last 100 lines
#   deploy/server.sh gateway-restart     reread the model gateway's keys and budget, restart it and the API
#   deploy/server.sh gateway-logs        the model gateway's last 40 lines, never a key
#   deploy/server.sh gateway-calls [run|email] [n]   the record of model calls, 90 days of it
#   deploy/server.sh settings-sources    live environments still taking settings from a developer's .env
#   deploy/server.sh library-check       read each named platform library as discovery will, and say what was read
set -euo pipefail

REGION="${AWS_REGION:-ca-central-1}"
STACK="platform-sealeye-server"
output() {
  aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
INSTANCE="$(output InstanceId)"
BUCKET="$(output ConfigBucket)"

run_on_server() {
  local comment="$1"; shift
  local params
  params="$(node -e 'console.log(JSON.stringify({ commands: process.argv.slice(1) }))' "$@")"
  local id
  id="$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
    --comment "$comment" --parameters "$params" --query Command.CommandId --output text)"
  local status="Pending"
  for _ in $(seq 1 120); do
    sleep 5
    status="$(aws ssm get-command-invocation --region "$REGION" --command-id "$id" --instance-id "$INSTANCE" \
      --query Status --output text 2>/dev/null || echo Pending)"
    case "$status" in Pending|InProgress|Delayed) continue ;; *) break ;; esac
  done
  aws ssm get-command-invocation --region "$REGION" --command-id "$id" --instance-id "$INSTANCE" \
    --query StandardOutputContent --output text
  if [ "$status" != "Success" ]; then
    aws ssm get-command-invocation --region "$REGION" --command-id "$id" --instance-id "$INSTANCE" \
      --query StandardErrorContent --output text
    echo "It did not finish (${status})."
    return 1
  fi
}

case "${1:-}" in
  backup)
    run_on_server "seaLeye backup" "/opt/sealeye/backup.sh" ;;
  restore-check)
    run_on_server "seaLeye restore check" "/opt/sealeye/restore-check.sh" ;;
  import)
    FILE="${2:?usage: deploy/server.sh import <deployments.json>}"
    KEY="import/deployments-$(date +%s).json"
    aws s3 cp "$FILE" "s3://${BUCKET}/${KEY}" --region "$REGION" --sse AES256 --only-show-errors
    # The copy in S3 is removed from here, whatever happens: the server's role may read
    # the config bucket but not delete from it. One command with set -e on the server, so
    # a failed import never goes on to restart the API as if it had worked.
    trap 'aws s3 rm "s3://${BUCKET}/${KEY}" --region "$REGION" --only-show-errors || echo "Could not remove s3://${BUCKET}/${KEY}; remove it by hand."' EXIT
    run_on_server "seaLeye import" \
      "set -euo pipefail; cd /opt/sealeye; aws s3 cp s3://${BUCKET}/${KEY} - --region ${REGION} --only-show-errors | docker compose exec -T api node deploy/with-settings.mjs scripts/import-records.js -; docker compose restart api >/dev/null; echo 'The API restarted, so it reads the imported records.'" ;;
  token)
    # The token is made here, on your Mac, and shown only here. The server is sent its
    # hash, so the token is in no command history, log or SSM record on the way.
    TOKENS="cd /opt/sealeye && docker compose exec -T api node deploy/with-settings.mjs scripts/tokens.js"
    case "${2:-}" in
      add)
        EMAIL="${3:?usage: deploy/server.sh token add <email> \"<name>\" [team] [--org-wide]}"
        NAME="${4:?usage: deploy/server.sh token add <email> \"<name>\" [team] [--org-wide]}"
        # A token sees its own team's environments; --org-wide sees every team's
        # (DESIGN.md, "Each team sees its own environments").
        TEAM=""; SCOPE="team"
        for ARG in "${@:5}"; do
          case "$ARG" in
            --org-wide) SCOPE="org" ;;
            -*) echo "Unknown option: $ARG. The only option is --org-wide."; exit 1 ;;
            *) [ -z "$TEAM" ] || { echo "One team only: got $TEAM and $ARG."; exit 1; }; TEAM="$ARG" ;;
          esac
        done
        TEAM="${TEAM:-default}"
        PAIR="$(EMAIL="$EMAIL" NAME="$NAME" TEAM="$TEAM" SCOPE="$SCOPE" node -e '
          const crypto = require("node:crypto");
          const token = "sl_" + crypto.randomBytes(32).toString("base64url");
          const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
          const holder = { tokenHash, email: process.env.EMAIL, name: process.env.NAME, team: process.env.TEAM, scope: process.env.SCOPE };
          console.log(token + " " + Buffer.from(JSON.stringify(holder)).toString("base64"));')"
        TOKEN="${PAIR%% *}"; HOLDER="${PAIR#* }"
        run_on_server "seaLeye token add" "set -euo pipefail; ${TOKENS} add-hash ${HOLDER}"
        echo
        echo "Their token, shown this once and kept nowhere. Send it to them privately:"
        echo
        echo "  ${TOKEN}"
        echo
        echo "They run: sealeye login   (and paste it when asked)"
        ;;
      revoke)
        WHO="${3:?usage: deploy/server.sh token revoke <email | tok_...>}"
        [[ "$WHO" =~ ^[A-Za-z0-9._%+@-]+$ ]] || { echo "That is not an email address or a token id."; exit 1; }
        run_on_server "seaLeye token revoke" "set -euo pipefail; ${TOKENS} revoke ${WHO}" ;;
      list)
        run_on_server "seaLeye token list" "set -euo pipefail; ${TOKENS} list" ;;
      *)
        echo "usage: deploy/server.sh token add <email> \"<name>\" [team] [--org-wide] | revoke <email | tok_...> | list"; exit 1 ;;
    esac ;;
  restart)
    run_on_server "seaLeye restart" \
      "set -euo pipefail; cd /opt/sealeye; docker compose restart api >/dev/null; for i in \$(seq 1 30); do sleep 2; [ \"\$(docker compose ps --format '{{.Health}}' api)\" = healthy ] && { echo 'The API restarted and is answering.'; exit 0; }; done; echo 'The API restarted but is not answering yet; see deploy/server.sh logs.'; exit 1" ;;
  settings-sources)
    run_on_server "seaLeye settings sources" "cd /opt/sealeye && docker compose exec -T api node deploy/with-settings.mjs scripts/settings-sources.js" ;;
  library-check)
    run_on_server "seaLeye library check" "cd /opt/sealeye && docker compose exec -T api node deploy/with-settings.mjs scripts/library-check.js" ;;
  logs)
    run_on_server "seaLeye logs" "cd /opt/sealeye && docker compose logs --tail 100 api" ;;
  gateway-restart)
    # After changing /sealeye/gateway/ANTHROPIC_API_KEY, /sealeye/SEALEYE_GATEWAY_KEY or
    # /sealeye/SEALEYE_GATEWAY_BUDGET. The API restarts too, since it reads the key it
    # calls the gateway with when it starts.
    run_on_server "seaLeye gateway restart" \
      "set -euo pipefail; cd /opt/sealeye; bash gateway.sh settings; bash gateway.sh restart; docker compose restart api >/dev/null; for i in \$(seq 1 30); do sleep 2; [ \"\$(docker compose ps --format '{{.Health}}' api)\" = healthy ] && break; done; bash gateway.sh ready" ;;
  gateway-logs)
    run_on_server "seaLeye gateway logs" "cd /opt/sealeye && bash gateway.sh logs 40" ;;
  gateway-calls)
    WHO="${2:-}"; LIMIT="${3:-50}"
    if [[ "$WHO" =~ ^[0-9]+$ && -z "${3:-}" ]]; then LIMIT="$WHO"; WHO=""; fi
    [[ -z "$WHO" || "$WHO" =~ ^[A-Za-z0-9@._+-]+$ ]] || { echo "Name a run (int_...) or a person's email, or nothing."; exit 1; }
    [[ "$LIMIT" =~ ^[0-9]{1,5}$ ]] || { echo "The number of calls must be a whole number."; exit 1; }
    run_on_server "seaLeye gateway calls" "cd /opt/sealeye && bash gateway.sh calls '${WHO}' ${LIMIT}" ;;
  *)
    sed -n '2,17p' "$0"; exit 1 ;;
esac
