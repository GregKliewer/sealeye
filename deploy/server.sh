#!/bin/bash
# Run one of the pilot server's own jobs from your Mac, through Session Manager, and
# show what it printed. Run from the repo root with the AWS CLI signed in.
#
#   deploy/server.sh backup              back up the database now
#   deploy/server.sh restore-check       restore the newest backup into a scratch database and compare
#   deploy/server.sh import <file>       add the records in a deployments.json, then restart the API
#   deploy/server.sh logs                the API's last 100 lines
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
    run_on_server "seaLeye import" \
      "cd /opt/sealeye && aws s3 cp s3://${BUCKET}/${KEY} - --region ${REGION} --only-show-errors | docker compose exec -T api node deploy/with-settings.mjs scripts/import-records.js -" \
      "aws s3 rm s3://${BUCKET}/${KEY} --region ${REGION} --only-show-errors" \
      "cd /opt/sealeye && docker compose restart api >/dev/null && echo 'The API restarted, so it reads the imported records.'" ;;
  logs)
    run_on_server "seaLeye logs" "cd /opt/sealeye && docker compose logs --tail 100 api" ;;
  *)
    sed -n '2,10p' "$0"; exit 1 ;;
esac
