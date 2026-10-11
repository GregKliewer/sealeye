// api/tokens.js
// Who is calling (PHASE1-PLAN Step 13, D7, a stand-in until sign-in, Q3). Every request
// but GET /health carries `Authorization: Bearer sl_...`, a token issued to one person.
// The API keeps only the token's SHA-256: the token is shown once, to whoever issues
// it, so a copy of the database or the file gives nobody a working token.
//
// Tokens live in Postgres when the API has a database (the tokens table), and in
// <SEALEYE_HOME>/tokens.json otherwise (a laptop API). Either way they are read on
// every request rather than cached, so a revoked token stops working at once.
//
// What a token resolves to, the caller, is the shape sign-in will fill later: a
// person, their organization and their team.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { sealeyeHome } from "../core/config.js";
import { looksLikeToken, TOKEN_PREFIX } from "../core/token.js";
import { databaseUrl, db } from "./db.js";

/** A new token: 32 random bytes, so guessing one is not a thing anyone can do. */
export function newToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

export { looksLikeToken };

const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const NAME = /^[\p{L}\p{M} .'-]{1,80}$/u;
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Check what a token is issued to. Throws with a sentence when something is off. */
export function checkHolder({ email, name, org = "default", team = "default" }) {
  if (!EMAIL.test(String(email || ""))) throw new Error(`not an email address: ${email}`);
  if (!NAME.test(String(name || ""))) throw new Error("a name is letters, spaces, dots, apostrophes and hyphens, up to 80");
  if (!SLUG.test(org)) throw new Error(`an organization id is lowercase letters, digits and hyphens: ${org}`);
  if (!SLUG.test(team)) throw new Error(`a team id is lowercase letters, digits and hyphens: ${team}`);
  return { email: String(email).toLowerCase(), name: String(name).trim(), org, team };
}

// ---------------------------------------------------------------------------------
// The file, for an API with no database.

const tokensFile = () => path.join(sealeyeHome(), "tokens.json");

function readFile() {
  try {
    const rows = JSON.parse(fs.readFileSync(tokensFile(), "utf8"));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function writeFile(rows) {
  fs.mkdirSync(path.dirname(tokensFile()), { recursive: true });
  const tmp = `${tokensFile()}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, tokensFile());
}

const fromRow = r => ({
  tokenId: r.token_id ?? r.tokenId,
  email: r.email,
  name: r.name,
  org: r.org_id ?? r.org,
  team: r.team_id ?? r.team,
  createdAt: r.created_at ? new Date(r.created_at).toISOString() : r.createdAt,
  revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : (r.revokedAt ?? null),
  lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : (r.lastUsedAt ?? null)
});

// ---------------------------------------------------------------------------------
// What the API and the admin script use.

/**
 * Record a token for a person, by its hash. The caller made the token and shows it;
 * this never sees it.
 *
 * @returns {Promise<object>} the token's record, without the hash
 */
export async function addToken({ tokenHash, ...holder }) {
  if (!/^[0-9a-f]{64}$/.test(String(tokenHash))) throw new Error("tokenHash must be a SHA-256, in hex");
  const who = checkHolder(holder);
  const tokenId = `tok_${crypto.randomBytes(6).toString("hex")}`;
  if (databaseUrl()) {
    const { rows } = await db().query(
      `INSERT INTO tokens (token_id, token_hash, email, name, org_id, team_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [tokenId, tokenHash, who.email, who.name, who.org, who.team]
    );
    return fromRow(rows[0]);
  }
  const rows = readFile();
  if (rows.some(r => r.tokenHash === tokenHash)) throw new Error("that token is already recorded");
  const row = { tokenId, tokenHash, ...who, createdAt: new Date().toISOString(), revokedAt: null, lastUsedAt: null };
  writeFile([...rows, row]);
  return fromRow(row);
}

/**
 * Revoke every live token of a person (by email), or one token (by its id).
 * @returns {Promise<number>} how many were revoked
 */
export async function revokeTokens(emailOrId) {
  const key = String(emailOrId || "").toLowerCase();
  const byId = key.startsWith("tok_");
  if (databaseUrl()) {
    const { rowCount } = await db().query(
      `UPDATE tokens SET revoked_at = now() WHERE revoked_at IS NULL AND ${byId ? "token_id" : "email"} = $1`,
      [key]
    );
    return rowCount;
  }
  const rows = readFile();
  let n = 0;
  for (const r of rows) {
    if (!r.revokedAt && (byId ? r.tokenId === key : r.email === key)) {
      r.revokedAt = new Date().toISOString();
      n++;
    }
  }
  if (n) writeFile(rows);
  return n;
}

/** Every token issued, newest first, without hashes. */
export async function listTokens() {
  if (databaseUrl()) {
    const { rows } = await db().query("SELECT * FROM tokens ORDER BY created_at DESC");
    return rows.map(fromRow);
  }
  return readFile().map(fromRow).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// Noting when a token was last used, at most once a minute each, so a busy CLI does not
// write on every poll.
const lastNoted = new Map();
const NOTE_EVERY_MS = 60_000;

/**
 * Who a token belongs to, or null for a token that is unknown, revoked or malformed.
 * @returns {Promise<{ tokenId, email, name, org, team } | null>}
 */
export async function callerFor(token) {
  if (!looksLikeToken(token)) return null;
  const tokenHash = hashToken(token);
  let found = null;
  if (databaseUrl()) {
    const { rows } = await db().query("SELECT * FROM tokens WHERE token_hash = $1 AND revoked_at IS NULL", [tokenHash]);
    found = rows[0] ? fromRow(rows[0]) : null;
  } else {
    const row = readFile().find(r => r.tokenHash === tokenHash && !r.revokedAt);
    found = row ? fromRow(row) : null;
  }
  if (!found) return null;

  const now = Date.now();
  if (now - (lastNoted.get(found.tokenId) || 0) > NOTE_EVERY_MS) {
    lastNoted.set(found.tokenId, now);
    noteUse(found.tokenId).catch(() => {});
  }
  const { tokenId, email, name, org, team } = found;
  return { tokenId, email, name, org, team };
}

async function noteUse(tokenId) {
  if (databaseUrl()) {
    await db().query("UPDATE tokens SET last_used_at = now() WHERE token_id = $1", [tokenId]);
    return;
  }
  // Read again right before writing, with nothing in between, so a revocation another
  // process wrote a moment ago is carried over rather than written back over. (A laptop
  // API only; the server keeps tokens in Postgres.)
  const rows = readFile();
  const row = rows.find(r => r.tokenId === tokenId);
  if (row) {
    row.lastUsedAt = new Date().toISOString();
    writeFile(rows);
  }
}

/** Whether this API asks who is calling. Off only on request, and never with a database. */
export function authMode() {
  const off = String(process.env.SEALEYE_AUTH || "").toLowerCase() === "off";
  if (off && databaseUrl()) {
    throw new Error("SEALEYE_AUTH=off is for a laptop API only: an API with a database always asks who is calling");
  }
  return off ? "off" : "tokens";
}

// ---------------------------------------------------------------------------------
// Portal sessions (PHASE1-PLAN Step 14). A browser cannot keep a token the way
// ~/.sealeye/config does without any script on the page being able to read it, so the
// portal trades the token for a session: a random value in an HttpOnly cookie that page
// scripts cannot read, good for SESSION_HOURS, ending at once if the token is revoked.

export const SESSION_HOURS = 12;
// The __Host- prefix makes the browser refuse any cookie of this name that names a
// domain or a narrower path, so a neighbouring site cannot plant one that shadows it.
export const SESSION_COOKIE = "__Host-sealeye_session";

const sessionsFile = () => path.join(sealeyeHome(), "sessions.json");

function readSessions() {
  try {
    const rows = JSON.parse(fs.readFileSync(sessionsFile(), "utf8"));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function writeSessions(rows) {
  fs.mkdirSync(path.dirname(sessionsFile()), { recursive: true });
  const tmp = `${sessionsFile()}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, sessionsFile());
}

/**
 * A new session for a caller, from their token. The value goes in the cookie and is
 * returned only here; what is kept is its hash.
 *
 * @returns {Promise<{ value: string, expiresAt: string }>}
 */
export async function startSession(caller, nowMs = Date.now()) {
  const value = crypto.randomBytes(32).toString("base64url");
  const sessionHash = hashToken(value);
  const expiresAt = new Date(nowMs + SESSION_HOURS * 3600_000).toISOString();
  if (databaseUrl()) {
    await db().query("DELETE FROM sessions WHERE expires_at < now()");
    await db().query("INSERT INTO sessions (session_hash, token_id, expires_at) VALUES ($1, $2, $3)", [sessionHash, caller.tokenId, expiresAt]);
  } else {
    const now = new Date(nowMs).toISOString();
    writeSessions([...readSessions().filter(s => s.expiresAt > now), { sessionHash, tokenId: caller.tokenId, createdAt: now, expiresAt }]);
  }
  return { value, expiresAt };
}

/** Who a session belongs to, or null when it is unknown, expired or its token revoked. */
export async function callerForSession(value, nowMs = Date.now()) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const sessionHash = hashToken(value);
  if (databaseUrl()) {
    const { rows } = await db().query(
      `SELECT t.* FROM sessions s JOIN tokens t ON t.token_id = s.token_id
        WHERE s.session_hash = $1 AND s.expires_at > $2 AND t.revoked_at IS NULL`,
      [sessionHash, new Date(nowMs).toISOString()]
    );
    if (!rows[0]) return null;
    const { tokenId, email, name, org, team } = fromRow(rows[0]);
    return { tokenId, email, name, org, team };
  }
  const now = new Date(nowMs).toISOString();
  const session = readSessions().find(s => s.sessionHash === sessionHash && s.expiresAt > now);
  if (!session) return null;
  const token = readFile().find(r => r.tokenId === session.tokenId && !r.revokedAt);
  if (!token) return null;
  const { tokenId, email, name, org, team } = fromRow(token);
  return { tokenId, email, name, org, team };
}

/** End a session (sign out). Never throws for one that is already gone. */
export async function endSession(value) {
  if (typeof value !== "string" || !value) return;
  const sessionHash = hashToken(value);
  if (databaseUrl()) {
    await db().query("DELETE FROM sessions WHERE session_hash = $1", [sessionHash]);
    return;
  }
  const rows = readSessions();
  const kept = rows.filter(s => s.sessionHash !== sessionHash);
  if (kept.length !== rows.length) writeSessions(kept);
}
