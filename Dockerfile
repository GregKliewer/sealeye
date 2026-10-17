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

# OpenTofu, the Terraform executor (PHASE4-PLAN Step 9; DESIGN.md, "A Terraform executor
# builds an organization's own modules"), and the one provider a module may use, AWS,
# from a folder in the image: OpenTofu is told to install providers from there and
# nowhere else (/etc/sealeye/tofu.tfrc), so a deploy fetches nothing and a module that
# needs another provider fails before anything is built. Pinned by version and by the
# sha256 of each release, for each architecture, as gitleaks is. The versions must match
# api/executor/terraform/tofu.js (test/tofu-versions.test.js); deploy/pin-tofu.sh writes
# the checksums in after a version changes, and the build stops until it has.
ARG TOFU_VERSION=1.12.6
ARG TOFU_SHA256_ARM64=e573979ba68a17fe7b881752051a694a7efcd970e39521f6a25775197861ed4d
ARG TOFU_SHA256_AMD64=5dc43da4f750f33873dc25e94587128709e819e544b7be9016b255316153c3a8
ARG AWS_PROVIDER_VERSION=5.100.0
ARG AWS_PROVIDER_SHA256_ARM64=6330766f1d85f01ae6ea90d1b214b8b74cc8c1badc4696b165b36ddd4cc15f7b
ARG AWS_PROVIDER_SHA256_AMD64=1589a2266af699cbd5d80737a0fe02e54ec9cf2ca54e7e00ac51c7359056f274
RUN set -eu; \
    case "$(uname -m)" in \
      aarch64) arch=arm64; tofu_sum="${TOFU_SHA256_ARM64}"; aws_sum="${AWS_PROVIDER_SHA256_ARM64}" ;; \
      x86_64)  arch=amd64; tofu_sum="${TOFU_SHA256_AMD64}"; aws_sum="${AWS_PROVIDER_SHA256_AMD64}" ;; \
      *) echo "no OpenTofu for $(uname -m)" >&2; exit 1 ;; \
    esac; \
    if [ "$tofu_sum" = unpinned ] || [ "$aws_sum" = unpinned ]; then \
      echo "OpenTofu ${TOFU_VERSION} and the AWS provider ${AWS_PROVIDER_VERSION} are not pinned yet: run deploy/pin-tofu.sh" >&2; exit 1; \
    fi; \
    curl -fsSL "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_linux_${arch}.zip" -o /tmp/tofu.zip; \
    echo "${tofu_sum}  /tmp/tofu.zip" | sha256sum -c -; \
    unzip -q -o /tmp/tofu.zip tofu -d /usr/local/bin; \
    rm /tmp/tofu.zip; \
    mirror=/usr/share/sealeye/tofu-providers/registry.opentofu.org/hashicorp/aws; \
    mkdir -p "$mirror"; \
    curl -fsSL "https://releases.hashicorp.com/terraform-provider-aws/${AWS_PROVIDER_VERSION}/terraform-provider-aws_${AWS_PROVIDER_VERSION}_linux_${arch}.zip" \
      -o "$mirror/terraform-provider-aws_${AWS_PROVIDER_VERSION}_linux_${arch}.zip"; \
    echo "${aws_sum}  $mirror/terraform-provider-aws_${AWS_PROVIDER_VERSION}_linux_${arch}.zip" | sha256sum -c -; \
    mkdir -p /etc/sealeye /usr/share/sealeye/tofu /tmp/tofu-lock; \
    printf 'provider_installation {\n  filesystem_mirror {\n    path    = "/usr/share/sealeye/tofu-providers"\n    include = ["registry.opentofu.org/hashicorp/aws"]\n  }\n}\n' > /etc/sealeye/tofu.tfrc; \
    printf '{"terraform":{"required_providers":{"aws":{"source":"hashicorp/aws","version":"%s"}}}}\n' "${AWS_PROVIDER_VERSION}" > /tmp/tofu-lock/main.tf.json; \
    (cd /tmp/tofu-lock && TF_CLI_CONFIG_FILE=/etc/sealeye/tofu.tfrc tofu init -backend=false -input=false -no-color >/dev/null); \
    cp /tmp/tofu-lock/.terraform.lock.hcl /usr/share/sealeye/tofu/.terraform.lock.hcl; \
    rm -rf /tmp/tofu-lock; \
    tofu version

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
