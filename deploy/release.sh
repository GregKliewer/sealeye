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

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "You have changes that are not committed. Commit them first, so the server runs code that is in git."
  exit 1
fi
# The image, the portal and the package all come from what is checked out here, so it
# must be main as GitHub has it: a copy that is behind ships an old portal beside a new
# API (Oct 11, 2026).
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ]; then
  echo "This is the $BRANCH branch. Release from main: git switch main && git pull"
  exit 1
fi
if ! git fetch --quiet origin main; then
  echo "Could not reach GitHub to check this copy is up to date with main. Check your connection and run this again."
  exit 1
fi
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "This copy of main is not the same as GitHub's ($(git rev-list --count HEAD..origin/main) behind, $(git rev-list --count origin/main..HEAD) ahead). Run git pull (and push anything of yours first), then run this again."
  exit 1
fi
echo "Releasing $(git log -1 --format='%h %s')"

# The cap on every run prices from core/model-prices.js, and a stale price lets a run
# spend past its cap (DESIGN.md, "A run's cap is close, not exact"). A warning, not a
# stop: the release may be the fix for something else. deploy/README.md, "Model prices".
PRICE_AGE="$(node --input-type=module -e 'import { pricesAgeDays, PRICES } from "./core/model-prices.js"; console.log(`${pricesAgeDays()} ${PRICES.checkedOn}`)')"
if [ "${PRICE_AGE%% *}" -gt 90 ]; then
  echo "Warning: the model prices the run cap uses were last checked on ${PRICE_AGE#* } (${PRICE_AGE%% *} days ago)."
  echo "Check them against the provider's page and update core/model-prices.js; see deploy/README.md, Model prices."
fi

# Developers install the command as sealeye-<version>.tgz. If the command changed and
# the version did not, a new package would replace the old one under the same name: npm
# may hand back its cached copy, and nobody can tell which they have (Oct 12, 2026, a
# Mac still on the command from before deploy --again). So a changed command needs a new
# version in package.json, and this stops until it has one.
VERSION="$(node -p 'require("./package.json").version')"
CHECK="$(mktemp -d)"
mkdir -p "$CHECK/new" "$CHECK/live" "$CHECK/here"
npm pack --silent --pack-destination "$CHECK/new" >/dev/null
if curl -fsS -o "$CHECK/live.tgz" "https://sealeye.run/sealeye-${VERSION}.tgz" 2>/dev/null; then
  tar -xzf "$CHECK/live.tgz" -C "$CHECK/live"
  tar -xzf "$CHECK/new/sealeye-${VERSION}.tgz" -C "$CHECK/here"
  if ! diff -rq "$CHECK/live" "$CHECK/here" >/dev/null; then
    echo "The command has changed since sealeye ${VERSION} was released, and package.json still says ${VERSION}."
    echo "Raise the version in package.json (npm version minor --no-git-tag-version), commit it through a pull request, and run this again."
    rm -rf "$CHECK"
    exit 1
  fi
  echo "The command is the same as the sealeye ${VERSION} already released"
else
  echo "sealeye ${VERSION} is new to sealeye.run"
fi
rm -rf "$CHECK"

REPOSITORY="$(output RepositoryUri)"
BUCKET="$(output ConfigBucket)"
INSTANCE="$(output InstanceId)"

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
for f in compose.yaml Caddyfile gateway.yaml gateway.sh update.sh backup.sh restore-check.sh; do
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
