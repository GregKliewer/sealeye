// The OpenTofu and AWS provider versions the image carries are the ones the executor
// writes into every root module (PHASE4-PLAN Step 9).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { AWS_PROVIDER_VERSION, TOFU_VERSION } from "../api/executor/terraform/tofu.js";

const root = path.resolve(import.meta.dirname, "..");
const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
const arg = name => dockerfile.match(new RegExp(`^ARG ${name}=(.*)$`, "m"))?.[1];

test("the image's OpenTofu and provider are the executor's", () => {
  assert.equal(arg("TOFU_VERSION"), TOFU_VERSION);
  assert.equal(arg("AWS_PROVIDER_VERSION"), AWS_PROVIDER_VERSION);
  for (const name of ["TOFU_SHA256_ARM64", "TOFU_SHA256_AMD64", "AWS_PROVIDER_SHA256_ARM64", "AWS_PROVIDER_SHA256_AMD64"]) {
    assert.match(arg(name), /^(?:unpinned|[0-9a-f]{64})$/, `${name} is a sha256, or unpinned until deploy/pin-tofu.sh is run`);
  }
  // Providers only from the image's own folder: no `direct` block, which would let one
  // be fetched from anywhere.
  assert.match(dockerfile, /filesystem_mirror/);
  assert.doesNotMatch(dockerfile, /\bdirect\s*\{/);
  // And the job that runs real OpenTofu runs this one.
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/tofu.yml"), "utf8");
  assert.match(workflow, new RegExp(`tofu_version: ${TOFU_VERSION.replace(/\./g, "\\.")}\\b`));
});
