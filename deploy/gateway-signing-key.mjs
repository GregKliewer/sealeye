// deploy/gateway-signing-key.mjs
// Makes the key the API signs each model call's token with (PHASE3-PLAN Step 6; DESIGN.md,
// "A token on every model call"), and stores both halves in Parameter Store:
//
//   /sealeye/SEALEYE_GATEWAY_SIGNING_KEY   the private half, a SecureString, read by the API
//   /sealeye/gateway/JWKS                  the public half, read by deploy/gateway.sh for the
//                                          gateway, which never sees the private half
//
// Run on your Mac from the repo root, with the AWS CLI signed in:
//
//   node deploy/gateway-signing-key.mjs            make one, unless one is already stored
//   node deploy/gateway-signing-key.mjs --replace  make a new one in place of the stored one
//
// then `deploy/server.sh gateway-restart`, which gives the gateway the new public half and
// restarts the API with the new private half. Nothing is printed but the key's id, and the
// private half never touches a command line: each value goes to the AWS CLI in a file only
// you can read, removed straight after.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { jwksFor, keyId } from "../api/gateway-token.js";

const REGION = process.env.AWS_REGION || "ca-central-1";
const PRIVATE_NAME = "/sealeye/SEALEYE_GATEWAY_SIGNING_KEY";
const PUBLIC_NAME = "/sealeye/gateway/JWKS";

function aws(args, { input } = {}) {
  return spawnSync("aws", [...args, "--region", REGION], { encoding: "utf8", input });
}

/** Whether a parameter is stored, asked without decrypting it. */
function exists(name) {
  const r = aws(["ssm", "describe-parameters", "--parameter-filters", `Key=Name,Values=${name}`, "--query", "length(Parameters)", "--output", "text"]);
  if (r.status !== 0) throw new Error(`could not check ${name}: ${(r.stderr || r.error?.message || "").trim()}`);
  return r.stdout.trim() === "1";
}

/** The public half stored now, to put back if storing the new pair fails halfway. */
function storedPublicHalf() {
  const r = aws(["ssm", "get-parameter", "--name", PUBLIC_NAME, "--query", "Parameter.Value", "--output", "text"]);
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Put one parameter, its value passed in a 0600 file rather than on the command line. */
function put(name, value, type) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-key-"));
  const file = path.join(dir, "input.json");
  try {
    fs.writeFileSync(file, JSON.stringify({ Name: name, Value: value, Type: type, Overwrite: true }), { mode: 0o600 });
    const r = aws(["ssm", "put-parameter", "--cli-input-json", `file://${file}`, "--query", "Version", "--output", "text"]);
    if (r.status !== 0) throw new Error(`could not store ${name}: ${(r.stderr || r.error?.message || "").trim()}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const replace = process.argv.includes("--replace");
try {
  const hasPrivate = exists(PRIVATE_NAME);
  const hasPublic = exists(PUBLIC_NAME);
  if (!replace && hasPrivate && hasPublic) {
    console.log(`A signing key is already stored (${PRIVATE_NAME} and ${PUBLIC_NAME}). To make a new one in its place: node deploy/gateway-signing-key.mjs --replace`);
    process.exit(0);
  }
  if (!replace && (hasPrivate || hasPublic)) {
    // Half a pair is no pair: making a new one is the only way to know the halves match.
    console.log(`Only ${hasPrivate ? PRIVATE_NAME : PUBLIC_NAME} is stored, so a new pair is made in place of it.`);
  }
  const previousPublic = hasPublic ? storedPublicHalf() : null;
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  // The public half first: a gateway given a new public half before the API has the
  // matching private half refuses calls only until gateway-restart restarts both.
  put(PUBLIC_NAME, JSON.stringify(jwksFor(publicKey)), "String");
  try {
    put(PRIVATE_NAME, Buffer.from(pem).toString("base64"), "SecureString");
  } catch (err) {
    // Put the previous public half back, so the stored pair still matches.
    let restored = false;
    if (previousPublic) {
      try {
        put(PUBLIC_NAME, previousPublic, "String");
        restored = true;
      } catch {}
    }
    throw new Error(`${err.message}\n${restored
      ? "The previous key is still stored and in use; nothing changed. Run this again."
      : "The two halves no longer match. Run node deploy/gateway-signing-key.mjs --replace before any release or restart."}`);
  }
  console.log(`Stored a new signing key, id ${keyId(publicKey)}: the private half at ${PRIVATE_NAME}, the public half at ${PUBLIC_NAME}.`);
  console.log("Next: deploy/server.sh gateway-restart (or a release), so the gateway and the API both use it.");
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
