# The seaLeye API, as it runs on the pilot server (DESIGN.md, "One small server in
# ca-central-1"). Built for arm64 (t4g); `npm test` runs during the build, so an image
# that exists passed its tests.
FROM node:20-bookworm-slim AS base

# The executor stages with rsync, zips with zip, and drives AWS through the AWS CLI.
RUN apt-get update \
 && apt-get install -y --no-install-recommends rsync zip unzip curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscli.zip \
 && unzip -q /tmp/awscli.zip -d /tmp \
 && /tmp/aws/install \
 && rm -rf /tmp/aws /tmp/awscli.zip

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .

FROM base AS test
RUN npm test

FROM base
# Depending on the test stage is what makes the build run it.
COPY --from=test /app/package.json /tmp/tested-package.json
RUN mkdir -p /data /app/dist && chown -R node:node /data /app/dist
USER node
ENV NODE_ENV=production \
    PORT=3000 \
    SEALEYE_HOME=/data \
    AWS_REGION=ca-central-1
VOLUME /data
EXPOSE 3000
CMD ["node", "deploy/start.mjs"]
