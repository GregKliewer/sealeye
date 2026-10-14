// api/gateway-token.js
// Who is calling the model (PHASE3-PLAN Step 6, D1; DESIGN.md, "A token on every model
// call"). The API signs a short-lived token for each model call, naming the person, their
// organization and team, the run, the worker and the surface the run started from. The
// model gateway checks it against the public half (deploy/gateway.yaml, jwtAuth) and
// writes its claims into its log.
//
// The signing key is SEALEYE_GATEWAY_SIGNING_KEY, an Ed25519 private key in PEM, kept in
// the server's settings and made by deploy/gateway-signing-key.mjs, which also stores the
// public half for the gateway. Node's own crypto signs; no package. Nothing here is ever
// logged: a token is a credential for a minute.
import crypto from "node:crypto";

import { setting } from "../core/config.js";

export const ISSUER = "sealeye-api";
export const AUDIENCE = "sealeye-gateway";
/**
 * The gateway checks a token when the call arrives, and every call (a retry included)
 * signs its own, so a minute is ample, with room for a clock a little off.
 */
export const TOKEN_LIFETIME_S = 60;

const b64url = value => Buffer.from(value).toString("base64url");

/** The private key from a setting: PEM as stored, or the same PEM base64-encoded on one line. */
export function readSigningKey(value) {
  if (!value) return null;
  const text = String(value).trim();
  const pem = text.startsWith("-----BEGIN") ? text : Buffer.from(text, "base64").toString("utf8");
  const key = crypto.createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("SEALEYE_GATEWAY_SIGNING_KEY must be an Ed25519 private key");
  return key;
}

/** The key's id: the first 16 hex characters of the SHA-256 of its public half, so the token and the key set agree without a second setting. */
export function keyId(publicKey) {
  const der = publicKey.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("hex").slice(0, 16);
}

/** The key set the gateway checks tokens with: the public half only. */
export function jwksFor(privateOrPublicKey) {
  const publicKey = privateOrPublicKey.type === "private" ? crypto.createPublicKey(privateOrPublicKey) : privateOrPublicKey;
  const jwk = publicKey.export({ format: "jwk" });
  return { keys: [{ kty: jwk.kty, crv: jwk.crv, x: jwk.x, kid: keyId(publicKey), alg: "EdDSA", use: "sig" }] };
}

/**
 * A signer, or null when the API has no signing key (a laptop API talking straight to
 * Anthropic signs nothing). Throws when the setting is there but is not a usable key,
 * so a mistake shows at start rather than as refused calls.
 */
export function signerFromSettings(value = setting("GATEWAY_SIGNING_KEY")) {
  const key = readSigningKey(value);
  if (!key) return null;
  const kid = keyId(crypto.createPublicKey(key));
  return {
    kid,
    /**
     * One call's token.
     * @param {object} who  { sub, org, team, run, worker, surface, trace? }
     */
    sign(who, { now = Date.now() } = {}) {
      const iat = Math.floor(now / 1000);
      const payload = {
        iss: ISSUER,
        aud: AUDIENCE,
        sub: who.sub,
        org: who.org,
        team: who.team,
        run: who.run,
        worker: who.worker,
        surface: who.surface,
        ...(who.trace ? { trace: who.trace } : {}),
        iat,
        exp: iat + TOKEN_LIFETIME_S,
        jti: crypto.randomBytes(12).toString("base64url")
      };
      const head = b64url(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid }));
      const body = b64url(JSON.stringify(payload));
      const sig = crypto.sign(null, Buffer.from(`${head}.${body}`), key);
      return `${head}.${body}.${b64url(sig)}`;
    }
  };
}

/**
 * What a call's token says, for an interview. A person is the token's (their email) when
 * the API checks tokens; on a laptop with checks off there is no person, and the run is
 * named as the API's own. What the record does not know is said as "unknown", never
 * guessed: an interview saved before tokens existed knows its owner but not its team.
 */
export function claimsFor(record, { worker = "interview" } = {}) {
  const caller = record.caller || null;
  return {
    sub: caller?.email || record.owner || "sealeye-api",
    org: caller?.org || "unknown",
    team: caller?.team || "unknown",
    run: record.id,
    worker,
    surface: record.surface || "unknown",
    trace: record.traceId || undefined
  };
}

/**
 * The client the interview's graph uses: the API's own, with a fresh token on every
 * call. A token lives five minutes, so each turn signs its own rather than sharing one.
 */
export function withCallerToken(client, signer, claims) {
  if (!signer) return client;
  return {
    messages: {
      create(params, options = {}) {
        const headers = { ...(options.headers || {}), authorization: `Bearer ${signer.sign(claims())}` };
        return client.messages.create(params, { ...options, headers });
      }
    }
  };
}
