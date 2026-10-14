// Who is calling the model (PHASE3-PLAN Step 6): every model call the API makes carries a
// token it signed, naming the person, their organization and team, the run, the worker
// and the surface. End to end over HTTP: the real API, tokens issued to two people, one
// interview started from the command and one from the portal, and a stand-in on
// localhost playing the gateway, which records what each call carried. No AWS, no model.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

import { zipFolder } from "../core/upload.js";
import {
  AUDIENCE,
  ISSUER,
  TOKEN_LIFETIME_S,
  claimsFor,
  jwksFor,
  keyId,
  readSigningKey,
  signerFromSettings,
  withCallerToken
} from "../api/gateway-token.js";
import { freePort } from "./helpers/free-port.js";

const root = path.resolve(import.meta.dirname, "..");
const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const PEM = privateKey.export({ type: "pkcs8", format: "pem" });
const STORED = Buffer.from(PEM).toString("base64"); // as deploy/gateway-signing-key.mjs stores it
const JWKS = jwksFor(publicKey);

/** What the gateway does with a token: check it against the key set, then read it. */
function verify(token, keys = JWKS) {
  const [head, body, sig] = token.split(".");
  const header = JSON.parse(Buffer.from(head, "base64url"));
  const jwk = keys.keys.find(k => k.kid === header.kid);
  if (!jwk || header.alg !== "EdDSA") return null;
  const ok = crypto.verify(null, Buffer.from(`${head}.${body}`), crypto.createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(sig, "base64url"));
  return ok ? { header, claims: JSON.parse(Buffer.from(body, "base64url")) } : null;
}

// ---------------------------------------------------------------------------------
// The signer on its own.

test("a token is signed with the key the key set names, and checks against the public half only", () => {
  const signer = signerFromSettings(STORED);
  assert.equal(signer.kid, keyId(publicKey));
  assert.equal(JWKS.keys[0].kid, signer.kid);
  assert.deepEqual(Object.keys(JWKS.keys[0]).sort(), ["alg", "crv", "kid", "kty", "use", "x"], "no private part in the key set");

  const now = Date.UTC(2026, 9, 14, 20, 0, 0);
  const token = signer.sign({ sub: "greg@example.com", org: "default", team: "payments", run: "int_1", worker: "interview", surface: "cli" }, { now });
  const read = verify(token);
  assert.ok(read, "the gateway's check passes");
  assert.equal(read.claims.iss, ISSUER);
  assert.equal(read.claims.aud, AUDIENCE);
  assert.equal(read.claims.exp - read.claims.iat, TOKEN_LIFETIME_S);
  assert.equal(read.claims.iat, now / 1000);
  assert.equal(read.claims.trace, undefined, "no trace claim when the run has no trace");

  const tampered = token.replace(/\.([^.]+)\./, (_, b) => `.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(b, "base64url")), team: "other" })).toString("base64url")}.`);
  assert.equal(verify(tampered), null, "a changed claim breaks the signature");
  const other = jwksFor(crypto.generateKeyPairSync("ed25519").publicKey);
  assert.equal(verify(token, { keys: [{ ...other.keys[0], kid: signer.kid }] }), null, "another key, under the same id, does not check it");
});

test("the key is read as stored, as PEM, or not at all, and only an Ed25519 key will do", () => {
  assert.equal(signerFromSettings(undefined), null);
  assert.equal(signerFromSettings(""), null);
  assert.equal(readSigningKey(PEM).asymmetricKeyType, "ed25519");
  assert.equal(readSigningKey(STORED).asymmetricKeyType, "ed25519");
  const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
  assert.throws(() => readSigningKey(rsa), /Ed25519/);
});

test("each call signs its own token, and a client with no signer is left as it is", async () => {
  const sent = [];
  const base = { messages: { create: async (params, options) => sent.push(options?.headers?.authorization) } };
  assert.equal(withCallerToken(base, null, () => ({})), base);
  const client = withCallerToken(base, signerFromSettings(STORED), () => claimsFor({ id: "int_x", surface: "cli" }));
  await client.messages.create({});
  await client.messages.create({});
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0], sent[1], "a fresh token, with its own id, on every call");
  const claims = verify(sent[0].replace(/^Bearer /, "")).claims;
  assert.equal(claims.sub, "sealeye-api", "with token checks off there is no person, and the API says so");
});

test("an interview saved before tokens existed names its owner, and says unknown for what it never knew", () => {
  const restored = claimsFor({ id: "int_old", owner: "ana@example.com" });
  assert.equal(restored.sub, "ana@example.com");
  assert.equal(restored.team, "unknown");
  assert.equal(restored.org, "unknown");
  assert.equal(restored.surface, "unknown");
});

// ---------------------------------------------------------------------------------
// End to end: the API, with tokens, and a stand-in gateway.

let home, apiBase, server, gateway, log = "";
const seen = [];

const env = () => ({ ...process.env, HOME: home, SEALEYE_HOME: home, DATABASE_URL: "", SEALEYE_AUTH: "" });
const issue = (email, name, ...flags) =>
  execFileSync(process.execPath, ["scripts/tokens.js", "add", email, name, ...flags], { cwd: root, env: env(), encoding: "utf8" }).match(/sl_[A-Za-z0-9_-]{43}/)[0];

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-gateway-token-"));
  gateway = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push({ authorization: req.headers.authorization, gatewayKey: req.headers["x-sealeye-gateway-key"], apiKey: req.headers["x-api-key"] });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_standin", type: "message", role: "assistant", model: "claude-sonnet-5",
        content: [{ type: "text", text: "This version of the platform cannot build this app." }],
        stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }
      }));
    });
  });
  await new Promise(r => gateway.listen(0, "127.0.0.1", r));

  const port = await freePort();
  apiBase = `http://localhost:${port}`;
  const e = {
    ...env(),
    PORT: String(port),
    SEALEYE_TRACING: "off",
    SEALEYE_MODEL_URL: `http://127.0.0.1:${gateway.address().port}`,
    SEALEYE_GATEWAY_KEY: "test-gateway-key-not-real",
    SEALEYE_GATEWAY_SIGNING_KEY: STORED
  };
  delete e.ANTHROPIC_API_KEY;
  server = spawn(process.execPath, ["api/server.js"], { cwd: root, env: e, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", d => (log += d));
  server.stderr.on("data", d => (log += d));
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${apiBase}/health`)).ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`API did not start:\n${log}`);
});

after(() => {
  server?.kill();
  gateway?.close();
});

async function interview(headers) {
  const zip = Buffer.from((await zipFolder(path.join(root, "apps", "static-website"))).zip).toString("base64");
  const before = seen.length;
  const res = await fetch(`${apiBase}/interviews`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ app: "static-website", zip, user: "someone-the-command-line-claims", trace: false })
  });
  assert.equal(res.status, 201, await res.clone().text());
  const { interviewId } = await res.json();
  for (let i = 0; i < 100 && seen.length === before; i++) await new Promise(r => setTimeout(r, 50));
  assert.ok(seen.length > before, `the interview called the model:\n${log.slice(-800)}`);
  return { interviewId, call: seen[before] };
}

test("an interview started from the command: its calls name the token's person, team and run, and say cli", async () => {
  const ana = issue("ana@example.com", "Ana P", "--team", "payments");
  const { interviewId, call } = await interview({ authorization: `Bearer ${ana}` });

  assert.equal(call.gatewayKey, "test-gateway-key-not-real");
  assert.equal(call.apiKey, undefined, "no model key leaves the API");
  const read = verify(call.authorization.replace(/^Bearer /, ""));
  assert.ok(read, "signed with the API's key");
  assert.equal(read.header.kid, keyId(publicKey));
  const { iss, aud, sub, org, team, run, worker, surface } = read.claims;
  assert.deepEqual({ iss, aud, sub, org, team, run, worker, surface }, {
    iss: "sealeye-api",
    aud: "sealeye-gateway",
    sub: "ana@example.com",
    org: "default",
    team: "payments",
    run: interviewId,
    worker: "interview",
    surface: "cli"
  });
  assert.ok(!call.authorization.includes(ana), "the person's own token never reaches the gateway");
});

test("an interview started from the portal: its calls say portal, and name the signed-in person", async () => {
  const greg = issue("greg@example.com", "Greg K");
  const signIn = await fetch(`${apiBase}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sealeye-portal": "1" },
    body: JSON.stringify({ token: greg })
  });
  assert.equal(signIn.status, 201);
  const cookie = /__Host-sealeye_session=[^;]*/.exec(signIn.headers.get("set-cookie"))[0];

  const { interviewId, call } = await interview({ cookie, "x-sealeye-portal": "1" });
  const { claims } = verify(call.authorization.replace(/^Bearer /, ""));
  assert.equal(claims.sub, "greg@example.com");
  assert.equal(claims.team, "default");
  assert.equal(claims.run, interviewId);
  assert.equal(claims.surface, "portal");
});

test("the API's log never holds a call's token, its signing key or its gateway key", () => {
  assert.ok(seen.length >= 2);
  for (const call of seen) assert.ok(!log.includes(call.authorization.replace(/^Bearer /, "")));
  assert.ok(!log.includes(STORED) && !log.includes("test-gateway-key-not-real"));
});
