#!/bin/bash
# Build the API image, push it, and roll it out to the pilot server. Run from the repo
# root on your Mac, with Docker running and the AWS CLI signed in to the seaLeye account.
# deploy/README.md says when to use it. With --from-ci it only uses GitHub's image, and
# stops if there is none for this commit.
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
# GitHub builds every commit on main that passes its tests (.github/workflows/test.yml).
# If it has built this one, that image is used and Docker is not needed here.
CI_TAG="main-$(git rev-parse --short=12 HEAD)"
if aws ecr describe-images --region "$REGION" --repository-name sealeye-api --image-ids imageTag="$CI_TAG" >/dev/null 2>&1; then
  TAG="$CI_TAG"
  echo "Using ${REPOSITORY}:${TAG}, built and tested by GitHub"
else
  if [ "${1:-}" = "--from-ci" ]; then
    echo "GitHub has not built this commit yet. Wait for its run on main to finish, or run without --from-ci to build here."
    exit 1
  fi
  TAG="$(git rev-parse --short HEAD)-$(date +%Y%m%d%H%M%S)"
  echo "Building ${REPOSITORY}:${TAG} for the server (the tests run as part of the build)"
  aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "${REPOSITORY%%/*}" >/dev/null
  docker buildx build --platform linux/arm64 -t "${REPOSITORY}:${TAG}" --push .
fi

echo "Building the sites, the portal and the package sealeye.run installs"
SITES="$(mktemp -d)"
trap 'rm -rf "$SITES"' EXIT
VERSION="$(node -p 'require("./package.json").version')"
cp -R sites/. "$SITES/"
# seaLeye.online is the portal, built from portal/ (Vite), static files only.
( cd portal && npm ci --no-audit --no-fund --loglevel=error && npm run build >/dev/null )
mkdir -p "$SITES/online"
cp -R portal/dist/. "$SITES/online/"
# The package is what `npm install -g` gets: the command, core and the few prompt
# files it reads (package.json "files"), never the API.
npm pack --silent --pack-destination "$SITES/run" >/dev/null
for f in "$SITES/run/index.html" "$SITES/run/install.sh"; do
  sed -i.bak "s/{{VERSION}}/${VERSION}/g" "$f" && rm -f "$f.bak"
done
[ -f "$SITES/run/sealeye-${VERSION}.tgz" ] || { echo "npm pack did not make sealeye-${VERSION}.tgz"; exit 1; }
aws s3 sync "$SITES/" "s3://${BUCKET}/server/sites/" --region "$REGION" --delete --only-show-errors

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
