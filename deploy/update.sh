#!/bin/bash
# Runs on the pilot server, sent by deploy/release.sh through Session Manager: fetch the
# server config, pull the image tagged $1, restart, and wait until the API answers.
set -euo pipefail
TAG="${1:?usage: update.sh <image tag>}"

cd /opt/sealeye
# REGION, CONFIG_BUCKET and REPOSITORY, written when the server was created.
source ./server.env

aws s3 cp "s3://${CONFIG_BUCKET}/server/compose.yaml" compose.yaml --region "$REGION" --only-show-errors
aws s3 cp "s3://${CONFIG_BUCKET}/server/Caddyfile" Caddyfile --region "$REGION" --only-show-errors

# Compose reads .env, so a reboot or a later `docker compose` keeps the same image.
echo "SEALEYE_IMAGE=${REPOSITORY}:${TAG}" > .env

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "${REPOSITORY%%/*}" >/dev/null
docker compose pull --quiet
docker compose up -d --remove-orphans
docker image prune -f >/dev/null

for _ in $(seq 1 36); do
  if [ "$(docker compose ps --format '{{.Health}}' api)" = "healthy" ]; then
    echo "The API is up, running ${REPOSITORY}:${TAG}"
    exit 0
  fi
  sleep 5
done

echo "The API did not become healthy within three minutes. Its last lines:"
docker compose logs --tail 40 api
exit 1
