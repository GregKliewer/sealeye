#!/bin/bash
# Runs on the pilot server, through `deploy/server.sh restore-check`. Restores the newest
# backup into a scratch database beside the real one, compares what it holds with the
# live database, and drops it. Nothing the API uses is touched. A backup is only a backup
# once a restore of it has worked (PHASE1-PLAN Step 10).
set -euo pipefail
cd /opt/sealeye
source ./server.env

# An empty folder makes `aws s3 ls` exit 1, and no match makes grep exit 1; both mean
# "no backup yet", said below, rather than a silent stop.
LATEST="$({ aws s3 ls "s3://${CONFIG_BUCKET}/backups/" --region "$REGION" || true; } | awk '{print $4}' | { grep '\.dump$' || true; } | sort | tail -1)"
if [ -z "$LATEST" ]; then
  echo "There is no backup yet. Run deploy/server.sh backup first."
  exit 1
fi
echo "Restoring ${LATEST} into a scratch database"

psql_() { docker compose exec -T postgres psql -U sealeye -v ON_ERROR_STOP=1 -tA "$@"; }
psql_ -d sealeye -c "DROP DATABASE IF EXISTS restore_check" >/dev/null
psql_ -d sealeye -c "CREATE DATABASE restore_check" >/dev/null
trap 'psql_ -d sealeye -c "DROP DATABASE IF EXISTS restore_check" >/dev/null' EXIT

aws s3 cp "s3://${CONFIG_BUCKET}/backups/${LATEST}" - --region "$REGION" --only-show-errors \
  | docker compose exec -T postgres pg_restore -U sealeye -d restore_check --no-owner --exit-on-error

RESTORED="$(psql_ -d restore_check -c "SELECT count(*) FROM deployments")"
LIVE="$(psql_ -d sealeye -c "SELECT count(*) FROM deployments")"
NEWEST="$(psql_ -d restore_check -c "SELECT coalesce(max(updated_at)::text, 'none') FROM deployments")"

echo "The backup restored: ${RESTORED} deployment records (the live database has ${LIVE}), the newest changed ${NEWEST}."
echo "The scratch database has been removed."
