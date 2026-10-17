#!/bin/bash
# Write the sha256 of OpenTofu's release, and of the AWS provider's, for each
# architecture the image is built for, into the Dockerfile's ARG lines (PHASE4-PLAN Step
# 9). Run from the repo root on a machine that can reach GitHub and releases.hashicorp.com,
# once after either version changes in the Dockerfile and api/executor/terraform/tofu.js.
# Then read the diff, and commit it.
#
#   deploy/pin-tofu.sh
#
# What it pins is what the releases are as downloaded now. OpenTofu signs its releases;
# check the signature too, the first time, as its documentation says.
set -euo pipefail

DOCKERFILE="Dockerfile"
arg() { sed -n "s/^ARG $1=//p" "$DOCKERFILE"; }
TOFU_VERSION="$(arg TOFU_VERSION)"
AWS_PROVIDER_VERSION="$(arg AWS_PROVIDER_VERSION)"
[ -n "$TOFU_VERSION" ] && [ -n "$AWS_PROVIDER_VERSION" ] || { echo "The Dockerfile names no OpenTofu or AWS provider version."; exit 1; }

sum() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

pin() {
  local name="$1" url="$2"
  curl -fsSL "$url" -o "$work/file"
  local value
  value="$(sum "$work/file")"
  # In place, on this one line, whatever was there before.
  sed -i.bak "s/^ARG ${name}=.*/ARG ${name}=${value}/" "$DOCKERFILE" && rm -f "$DOCKERFILE.bak"
  echo "${name}=${value}  (${url})"
}

for arch in arm64 amd64; do
  ARCH="$(echo "$arch" | tr a-z A-Z)"
  pin "TOFU_SHA256_${ARCH}" "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_linux_${arch}.zip"
  pin "AWS_PROVIDER_SHA256_${ARCH}" "https://releases.hashicorp.com/terraform-provider-aws/${AWS_PROVIDER_VERSION}/terraform-provider-aws_${AWS_PROVIDER_VERSION}_linux_${arch}.zip"
done

# Cross-checked against each project's own published sums, so a download that went wrong
# on the way is caught here rather than pinned.
curl -fsSL "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_SHA256SUMS" -o "$work/tofu.sums"
curl -fsSL "https://releases.hashicorp.com/terraform-provider-aws/${AWS_PROVIDER_VERSION}/terraform-provider-aws_${AWS_PROVIDER_VERSION}_SHA256SUMS" -o "$work/aws.sums"
for arch in arm64 amd64; do
  ARCH="$(echo "$arch" | tr a-z A-Z)"
  grep -q "^$(arg TOFU_SHA256_${ARCH})  tofu_${TOFU_VERSION}_linux_${arch}.zip$" "$work/tofu.sums" || { echo "OpenTofu's own sums do not list the ${arch} download as pinned. Nothing should be committed."; exit 1; }
  grep -q "^$(arg AWS_PROVIDER_SHA256_${ARCH})  terraform-provider-aws_${AWS_PROVIDER_VERSION}_linux_${arch}.zip$" "$work/aws.sums" || { echo "HashiCorp's own sums do not list the ${arch} provider as pinned. Nothing should be committed."; exit 1; }
done
echo "Pinned, and each matches its project's own sums. Review the Dockerfile's diff, then commit it."
