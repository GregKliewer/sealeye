#!/bin/bash
# Build the API image, push it, and roll it out to the pilot server. Run from the repo
# root on your Mac, with Docker running and the AWS CLI signed in to the seaLeye account.
# deploy/README.md says when to use it.
set -euo pipefail

REGION="${AWS_REGION:-ca-central-1}"
STACK="platform-sealeye-server"

output() {
  aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

REPOSITORY="$(output RepositoryUri)"
BUCKET="$(output ConfigBucket)"
INSTANCE="$(output InstanceId)"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "You have changes that are not committed. Commit them first, so the server runs code that is in git."
  exit 1
fi
TAG="$(git rev-parse --short HEAD)-$(date +%Y%m%d%H%M%S)"

echo "Building ${REPOSITORY}:${TAG} for the server (the tests run as part of the build)"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "${REPOSITORY%%/*}" >/dev/null
docker buildx build --platform linux/arm64 -t "${REPOSITORY}:${TAG}" --push .

echo "Sending the server its config"
for f in compose.yaml Caddyfile update.sh backup.sh restore-check.sh; do
  aws s3 cp "deploy/$f" "s3://${BUCKET}/server/$f" --region "$REGION" --only-show-errors
done

echo "Rolling it out"
PARAMS=$(printf '{"commands":["aws s3 cp s3://%s/server/update.sh /opt/sealeye/update.sh --region %s --only-show-errors","bash /opt/sealeye/update.sh %s"]}' "$BUCKET" "$REGION" "$TAG")
COMMAND_ID="$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE" \
  --document-name AWS-RunShellScript --comment "seaLeye release ${TAG}" \
  --parameters "$PARAMS" --query Command.CommandId --output text)"

STATUS="Pending"
for _ in $(seq 1 120); do
  sleep 5
  STATUS="$(aws ssm get-command-invocation --region "$REGION" --command-id "$COMMAND_ID" --instance-id "$INSTANCE" \
    --query Status --output text 2>/dev/null || echo Pending)"
  case "$STATUS" in Pending|InProgress|Delayed) continue ;; *) break ;; esac
done

aws ssm get-command-invocation --region "$REGION" --command-id "$COMMAND_ID" --instance-id "$INSTANCE" \
  --query StandardOutputContent --output text
if [ "$STATUS" != "Success" ]; then
  aws ssm get-command-invocation --region "$REGION" --command-id "$COMMAND_ID" --instance-id "$INSTANCE" \
    --query StandardErrorContent --output text
  echo "The rollout did not finish (${STATUS})."
  exit 1
fi
