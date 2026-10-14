# The seaLeye API, as it runs on the pilot server (DESIGN.md, "One small server in
# ca-central-1"). Built for arm64 (t4g); `npm test` runs during the build, so an image
# that exists passed its tests.
FROM node:20-bookworm-slim AS base

# The executor stages with rsync, zips with zip, and drives AWS through the AWS CLI.
# sqlite3 reads the model gateway's record of calls (deploy/gateway.sh calls).
RUN apt-get update \
 && apt-get install -y --no-install-recommends rsync zip unzip curl ca-certificates sqlite3 \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscli.zip \
 && unzip -q /tmp/awscli.zip -d /tmp \
 && /tmp/aws/install \
 && rm -rf /tmp/aws /tmp/awscli.zip

# gitleaks, the API's deeper secret scan (PHASE3-PLAN Step 2, api/secret-scan.js).
# Pinned by version and by the sha256 of its release, for each architecture the image
# is built for; installed before the test stage, so its tests run against it.
ARG GITLEAKS_VERSION=8.30.1
RUN set -eu; \
    case "$(uname -m)" in \
      aarch64) arch=arm64; sum=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;; \
      x86_64)  arch=x64;   sum=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;; \
      *) echo "no gitleaks for $(uname -m)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${arch}.tar.gz" -o /tmp/gitleaks.tgz; \
    echo "${sum}  /tmp/gitleaks.tgz" | sha256sum -c -; \
    tar -xzf /tmp/gitleaks.tgz -C /usr/local/bin gitleaks; \
    rm /tmp/gitleaks.tgz; \
    gitleaks version

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
