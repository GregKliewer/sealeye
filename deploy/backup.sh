#!/bin/bash
# Runs on the pilot server, nightly (sealeye-backup.timer, installed by update.sh), or on
# demand through `deploy/server.sh backup`. Dumps the database to the config bucket's
# backups/ folder, which keeps each dump 30 days.
#
# The interview_state schema is left out: it holds interviews in progress, whose saved
# conversations include the developer's code, and it lives a day at most anyway. The API
# makes it again at start, so a database restored from this dump works as it is.
set -euo pipefail
cd /opt/sealeye
source ./server.env

STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
KEY="backups/sealeye-${STAMP}.dump"

docker compose exec -T postgres pg_dump -U sealeye -d sealeye --format=custom --no-owner --exclude-schema=interview_state \
  | aws s3 cp - "s3://${CONFIG_BUCKET}/${KEY}" --region "$REGION" --sse AES256 --only-show-errors

echo "Backed up to s3://${CONFIG_BUCKET}/${KEY}"
