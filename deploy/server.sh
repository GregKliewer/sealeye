#!/bin/bash
# Run one of the pilot server's own jobs from your Mac, through Session Manager, and
# show what it printed. Run from the repo root with the AWS CLI signed in.
#
#   deploy/server.sh backup              back up the database now
#   deploy/server.sh restore-check       restore the newest backup into a scratch database and compare
#   deploy/server.sh import <file>       add the records in a deployments.json, then restart the API
#   deploy/server.sh restart             restart the API, and wait until it answers
#   deploy/server.sh token add <email> "<name>" [team] [--org-wide] [--org <org>]   issue a person a token
#   deploy/server.sh token revoke <email | tok_...>      it stops working at once
#   deploy/server.sh token list          every token issued, without the tokens
#   deploy/server.sh logs                the API's last 100 lines
#   deploy/server.sh gateway-restart     reread the model gateway's keys and budget, restart it and the API
#   deploy/server.sh gateway-logs        the model gateway's last 40 lines, never a key
#   deploy/server.sh gateway-calls [run|email] [n]   the record of model calls, 90 days of it
#   deploy/server.sh settings-sources    live environments still taking settings from a developer's .env
#   deploy/server.sh library-check       read each named platform library as discovery will, and say what was read
#   deploy/server.sh tofu-unlock <dep_...> [--release]  what holds a Terraform environment's lock, and release it
#   deploy/server.sh disk [--prune]     how full the server's disk is, and what fills it; --prune removes unused images
#   deploy/server.sh park [--dry-run]    between bursts of work: check nothing is standing, keep a backup, stop paying
#   deploy/server.sh unpark [--dry-run]  start it again, bring back what park removed, update, and check it answers
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

# ---------------------------------------------------------------------------------------
# Parking the pilot between bursts of work (DESIGN.md, "Parking the pilot between bursts
# of work"). Parked, it costs its disk, its fixed address and its DNS zone, about $6 a
# month; everything it knows stays on the disk, and its address and certificates stay
# too, so unpark needs no DNS change. The foundation network is kept: it costs nothing,
# and making it again would change the ids its platform values name. What costs by the
# hour beside it (the network's paid endpoints, platform-sealeye-endpoints) is removed
# and made again.

# Outside /sealeye/, which the API reads every parameter of as a setting at start.
PARKED_PARAM="/sealeye-pilot/PARKED"
ENDPOINTS_STACK="platform-sealeye-endpoints"
API_URL="${SEALEYE_API:-https://api.sealeye.online}"

instance_state() {
  aws ec2 describe-instances --region "$REGION" --instance-ids "$INSTANCE" \
    --query "Reservations[0].Instances[0].State.Name" --output text
}

stack_exists() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" >/dev/null 2>&1
}

# Session Manager answers a few minutes after the server starts.
wait_for_ssm() {
  for _ in $(seq 1 60); do
    [ "$(aws ssm describe-instance-information --region "$REGION" \
      --filters "Key=InstanceIds,Values=$INSTANCE" --query "InstanceInformationList[0].PingStatus" --output text 2>/dev/null)" = Online ] && return 0
    sleep 10
  done
  echo "The server started, but Session Manager has not reached it in ten minutes. Try deploy/server.sh logs in a while."
  return 1
}

# What still costs money while parked, from AWS, not from memory.
still_costing() {
  local size
  size="$(aws ec2 describe-volumes --region "$REGION" --filters "Name=attachment.instance-id,Values=$INSTANCE" \
    --query "sum(Volumes[].Size)" --output text 2>/dev/null || echo "?")"
  echo "What still costs money while it is parked:"
  echo "  its disk, ${size} GB (about \$0.09 a GB a month)"
  echo "  its fixed public address (about \$3.60 a month)"
  echo "  the DNS zone for its names (\$0.50 a month)"
  echo "  the backups, images and settings it keeps (cents)"
}

park() {
  local dry="${1:-}"
  [ -z "$dry" ] || [ "$dry" = "--dry-run" ] || { echo "usage: deploy/server.sh park [--dry-run]"; exit 1; }
  local state; state="$(instance_state)"
  if [ "$state" = stopped ]; then echo "It is parked already."; still_costing; return 0; fi
  [ "$state" = running ] || { echo "The server is ${state}; park it once it is running or stopped."; exit 1; }

  echo "1. Is anything still standing? A parked pilot keeps paying for what it built."
  # The script exits 3 when something stands; said as a word here, so Session Manager
  # reports a check that ran as one that finished.
  local standing
  standing="$(run_on_server "seaLeye park: standing environments" "cd /opt/sealeye && { docker compose exec -T api node deploy/with-settings.mjs scripts/standing-environments.js || echo STILL-STANDING; }")" || { echo "$standing"; echo "Could not check, so nothing was parked."; exit 1; }
  printf '%s\n' "$standing" | grep -v '^STILL-STANDING$'
  if printf '%s' "$standing" | grep -q '^STILL-STANDING$'; then
    echo "Nothing was parked."
    exit 1
  fi

  local endpoints=false
  stack_exists "$ENDPOINTS_STACK" && endpoints=true
  if [ -n "$dry" ]; then
    echo "2. It would back up the database and keep that backup until you delete it."
    $endpoints && echo "3. It would delete ${ENDPOINTS_STACK}, the network's paid endpoints." || echo "3. There are no paid endpoints to delete."
    echo "4. It would stop the server."
    still_costing
    echo "Nothing was changed (--dry-run)."
    return 0
  fi

  echo "2. Backing up the database, and keeping that backup until you delete it."
  local out key
  out="$(run_on_server "seaLeye park: backup" "/opt/sealeye/backup.sh")" || { echo "$out"; echo "The backup did not finish, so nothing was parked."; exit 1; }
  echo "$out"
  key="$(printf '%s\n' "$out" | tr -d '\r' | sed -n 's#^Backed up to s3://[^/]*/\(backups/.*\.dump\)$#\1#p' | tail -1)"
  [ -n "$key" ] || { echo "Could not tell which backup was taken, so nothing was parked."; exit 1; }
  # backups/ keeps each dump 30 days; parked/ has no rule, so this one outlasts any pause.
  aws s3 cp "s3://${BUCKET}/${key}" "s3://${BUCKET}/parked/${key#backups/}" --region "$REGION" --sse AES256 --only-show-errors
  echo "   Kept as s3://${BUCKET}/parked/${key#backups/}"

  if $endpoints; then
    echo "3. Deleting ${ENDPOINTS_STACK}, the network's paid endpoints."
    aws cloudformation delete-stack --region "$REGION" --stack-name "$ENDPOINTS_STACK"
    aws cloudformation wait stack-delete-complete --region "$REGION" --stack-name "$ENDPOINTS_STACK"
  else
    echo "3. There are no paid endpoints to delete."
  fi

  echo "4. Stopping the server."
  aws ec2 stop-instances --region "$REGION" --instance-ids "$INSTANCE" >/dev/null
  aws ec2 wait instance-stopped --region "$REGION" --instance-ids "$INSTANCE"

  local note
  note="$(AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" KEY="parked/${key#backups/}" EP="$endpoints" node -e \
    'console.log(JSON.stringify({ at: process.env.AT, backup: process.env.KEY, endpoints: process.env.EP === "true" }))')"
  aws ssm put-parameter --region "$REGION" --name "$PARKED_PARAM" --type String --overwrite --value "$note" >/dev/null
  echo
  echo "Parked. deploy/server.sh unpark brings it back."
  still_costing
}

unpark() {
  local dry="${1:-}"
  [ -z "$dry" ] || [ "$dry" = "--dry-run" ] || { echo "usage: deploy/server.sh unpark [--dry-run]"; exit 1; }
  local note endpoints=false
  note="$(aws ssm get-parameter --region "$REGION" --name "$PARKED_PARAM" --query Parameter.Value --output text 2>/dev/null || echo "")"
  [ -n "$note" ] && [ "$(printf '%s' "$note" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).endpoints===true)}catch{console.log(false)}})')" = true ] && endpoints=true
  local state; state="$(instance_state)"
  if [ -z "$note" ] && [ "$state" = running ]; then echo "It is not parked: the server is running."; return 0; fi
  [ -n "$note" ] && echo "Parked since $(printf '%s' "$note" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).at))')."

  if [ -n "$dry" ]; then
    echo "1. It would start the server and wait for it."
    $endpoints && echo "2. It would make ${ENDPOINTS_STACK} again." || echo "2. There are no paid endpoints to make again."
    echo "3. It would apply the system's updates, restarting the server if they need it."
    echo "4. It would wait until ${API_URL} answers, and say whether it runs the newest release."
    echo "Nothing was changed (--dry-run)."
    return 0
  fi

  echo "1. Starting the server."
  if [ "$state" != running ]; then
    aws ec2 start-instances --region "$REGION" --instance-ids "$INSTANCE" >/dev/null
    aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE"
  fi
  wait_for_ssm

  if $endpoints; then
    echo "2. Making ${ENDPOINTS_STACK} again."
    if [ -f deploy/endpoints.yaml ]; then
      aws cloudformation deploy --region "$REGION" --template-file deploy/endpoints.yaml --stack-name "$ENDPOINTS_STACK" --no-fail-on-empty-changeset
    else
      echo "   deploy/endpoints.yaml is not in this copy of the repository, so they were not made. Run this from main."
    fi
  else
    echo "2. There are no paid endpoints to make again."
  fi

  echo "3. Applying the system's updates."
  local updated
  updated="$(run_on_server "seaLeye unpark: updates" \
    "set -euo pipefail; dnf -y -q upgrade --refresh >/dev/null; newest=\$(rpm -q kernel --qf '%{VERSION}-%{RELEASE}.%{ARCH}\\n' | sort -V | tail -1); if [ \"\$newest\" != \"\$(uname -r)\" ]; then echo RESTART; else echo 'Up to date.'; fi")"
  if printf '%s' "$updated" | grep -q RESTART; then
    echo "   A new kernel came with them: restarting the server."
    aws ec2 reboot-instances --region "$REGION" --instance-ids "$INSTANCE"
    sleep 30
    wait_for_ssm
  else
    echo "   $updated"
  fi

  echo "4. Waiting until ${API_URL} answers."
  local health=""
  for _ in $(seq 1 60); do
    health="$(curl -fsS --max-time 5 "${API_URL}/health" 2>/dev/null || true)"
    [ -n "$health" ] && break
    sleep 5
  done
  [ -n "$health" ] || { echo "It did not answer in five minutes. deploy/server.sh logs says why."; exit 1; }
  local running here
  running="$(printf '%s' "$health" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version||"")}catch{console.log("")}})')"
  here="$(node -p 'require("./package.json").version' 2>/dev/null || echo "")"
  aws ssm delete-parameter --region "$REGION" --name "$PARKED_PARAM" >/dev/null 2>&1 || true
  echo
  echo "Unparked: ${API_URL} answers, running ${running:-a version it did not say}."
  if [ -n "$here" ] && [ -n "$running" ] && [ "$running" != "$here" ]; then
    echo "This copy of the repository is ${here}: on an up-to-date main, run deploy/release.sh to bring the server to it."
  fi
  [ -n "$note" ] && echo "The backup park kept stays in s3://${BUCKET}/parked/ until you delete it."
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
        EMAIL="${3:?usage: deploy/server.sh token add <email> \"<name>\" [team] [--org-wide] [--org <org>]}"
        NAME="${4:?usage: deploy/server.sh token add <email> \"<name>\" [team] [--org-wide] [--org <org>]}"
        # A token sees its own team's environments; --org-wide sees every team's
        # (DESIGN.md, "Each team sees its own environments"). --org names another
        # organization than default: Juniper Mutual's, juniper, where its discovered
        # catalog can go live without touching anyone else's (PHASE4-PLAN Step 7).
        TEAM=""; SCOPE="team"; ORG="default"
        set -- "${@:5}"
        while [ $# -gt 0 ]; do
          case "$1" in
            --org-wide) SCOPE="org" ;;
            --org) ORG="${2:?--org names an organization}"; shift ;;
            -*) echo "Unknown option: $1. The options are --org-wide and --org <org>."; exit 1 ;;
            *) [ -z "$TEAM" ] || { echo "One team only: got $TEAM and $1."; exit 1; }; TEAM="$1" ;;
          esac
          shift
        done
        [[ "$ORG" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] || { echo "An organization is lowercase letters, digits and hyphens: $ORG"; exit 1; }
        TEAM="${TEAM:-default}"
        PAIR="$(EMAIL="$EMAIL" NAME="$NAME" TEAM="$TEAM" SCOPE="$SCOPE" ORG="$ORG" node -e '
          const crypto = require("node:crypto");
          const token = "sl_" + crypto.randomBytes(32).toString("base64url");
          const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
          const holder = { tokenHash, email: process.env.EMAIL, name: process.env.NAME, org: process.env.ORG, team: process.env.TEAM, scope: process.env.SCOPE };
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
        echo "usage: deploy/server.sh token add <email> \"<name>\" [team] [--org-wide] [--org <org>] | revoke <email | tok_...> | list"; exit 1 ;;
    esac ;;
  restart)
    run_on_server "seaLeye restart" \
      "set -euo pipefail; cd /opt/sealeye; docker compose restart api >/dev/null; for i in \$(seq 1 30); do sleep 2; [ \"\$(docker compose ps --format '{{.Health}}' api)\" = healthy ] && { echo 'The API restarted and is answering.'; exit 0; }; done; echo 'The API restarted but is not answering yet; see deploy/server.sh logs.'; exit 1" ;;
  settings-sources)
    run_on_server "seaLeye settings sources" "cd /opt/sealeye && docker compose exec -T api node deploy/with-settings.mjs scripts/settings-sources.js" ;;
  tofu-unlock)
    DEP="${2:?usage: deploy/server.sh tofu-unlock <dep_...> [--release]}"
    [[ "$DEP" =~ ^dep_[0-9a-f]+$ ]] || { echo "Name a deployment: dep_..."; exit 1; }
    RELEASE=""; [ "${3:-}" = "--release" ] && RELEASE="--release"
    run_on_server "seaLeye tofu unlock" "cd /opt/sealeye && docker compose exec -T api node deploy/with-settings.mjs scripts/tofu-unlock.js ${DEP} ${RELEASE}" ;;
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
  disk)
    # Images no container uses, and Docker's build cache, are all --prune removes: the
    # running containers, their volumes (the database, certificates, the API's home)
    # and their images stay.
    PRUNE=""
    case "${2:-}" in "") ;; --prune) PRUNE="echo 'Removing images no container uses:'; docker image prune -af | tail -1; docker builder prune -af 2>/dev/null | tail -1; echo; echo 'The disk after:'; df -h / | tail -1;" ;; *) echo "usage: deploy/server.sh disk [--prune]"; exit 1 ;; esac
    run_on_server "seaLeye disk" \
      "cd /opt/sealeye; echo 'The disk:'; df -h / | tail -1; echo; docker system df; echo; ${PRUNE}" ;;
  park)
    park "${2:-}" ;;
  unpark)
    unpark "${2:-}" ;;
  *)
    sed -n '2,21p' "$0"; exit 1 ;;
esac
