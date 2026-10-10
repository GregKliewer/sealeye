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

for f in backup.sh restore-check.sh; do
  aws s3 cp "s3://${CONFIG_BUCKET}/server/$f" "$f" --region "$REGION" --only-show-errors
done
chmod +x backup.sh restore-check.sh

# The database password, from Parameter Store, for the Postgres container. Postgres
# reads it only when it first creates the database, so changing the parameter later
# does not change the password; see deploy/README.md.
mkdir -p secrets && chmod 700 secrets
if ! aws ssm get-parameter --region "$REGION" --name /sealeye/POSTGRES_PASSWORD --with-decryption \
  --query Parameter.Value --output text > secrets/pg_password.new 2>/dev/null || [ ! -s secrets/pg_password.new ]; then
  rm -f secrets/pg_password.new
  echo "There is no /sealeye/POSTGRES_PASSWORD parameter. deploy/README.md says how to create it."
  exit 1
fi
chmod 644 secrets/pg_password.new && mv secrets/pg_password.new secrets/pg_password

# The nightly backup, at 03:15 Toronto time (07:15 UTC). Installed or updated every
# release; Persistent=true runs a missed one after the server was off.
cat > /etc/systemd/system/sealeye-backup.service <<UNIT
[Unit]
Description=seaLeye nightly database backup to S3
[Service]
Type=oneshot
WorkingDirectory=/opt/sealeye
ExecStart=/opt/sealeye/backup.sh
UNIT
cat > /etc/systemd/system/sealeye-backup.timer <<UNIT
[Unit]
Description=seaLeye nightly database backup
[Timer]
OnCalendar=*-*-* 03:15:00 America/Toronto
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now sealeye-backup.timer >/dev/null

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
