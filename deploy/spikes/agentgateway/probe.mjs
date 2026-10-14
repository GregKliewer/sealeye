// deploy/spikes/agentgateway/probe.mjs
// PHASE3-PLAN Step 4: what agentgateway does in front of seaLeye's model calls. Run from
// the repo root (it uses the repo's own Anthropic SDK), with the gateway up from this
// folder's compose.yaml. README.md says the order.
//
//   node deploy/spikes/agentgateway/probe.mjs setup     keys, tokens' signing key, .work/env
//   node deploy/spikes/agentgateway/probe.mjs mock      every check, against the stand-in model
//   node deploy/spikes/agentgateway/probe.mjs real      the SDK through the gateway to Anthropic
//   node deploy/spikes/agentgateway/probe.mjs bedrock   the same, to Claude on Bedrock
//   node deploy/spikes/agentgateway/probe.mjs memory    what the gateway uses, idle and busy
//
// `mock --quick` leaves out the two slow checks (about three minutes).
//
// Each check prints one line, and the run ends with a JSON summary, also written to
// .work/results-<mode>.json, to paste back. Nothing printed is a key or a token: keys and
// tokens are named, never shown.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Anthropic from "@anthropic-ai/sdk";

// The API's own signer and claims (PHASE3-PLAN Step 6), so the spike checks the tokens
// the API really makes, not tokens of its own.
import { AUDIENCE, ISSUER, claimsFor, jwksFor, keyId, signerFromSettings, withCallerToken } from "../../../api/gateway-token.js";
import { modelClient } from "../../../api/interview/model.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.join(HERE, ".work");
const GATEWAY = process.env.SPIKE_GATEWAY || "http://localhost:4000";
const READY = process.env.SPIKE_READY || "http://localhost:15021/healthz/ready";
const MOCK = process.env.SPIKE_MOCK || "http://localhost:8090";
// The id the API gives its key: the gateway finds the key by it.
const signingKid = () => keyId(crypto.createPublicKey(fs.readFileSync(path.join(WORK, "signing.pem"))));
const MODEL = "claude-sonnet-5";

const results = { mode: process.argv[2], startedAt: new Date().toISOString(), checks: [] };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function check(name, ok, detail = {}) {
  results.checks.push({ name, ok, ...detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${Object.keys(detail).length ? `  ${JSON.stringify(detail)}` : ""}`);
}

function note(name, detail) {
  results.checks.push({ name, note: true, ...detail });
  console.log(`NOTE  ${name}  ${JSON.stringify(detail)}`);
}

// ---------------------------------------------------------------- setup

const b64url = buf => Buffer.from(buf).toString("base64url");
const randomKey = prefix => `${prefix}-${crypto.randomBytes(18).toString("base64url")}`;

function setup() {
  fs.mkdirSync(path.join(WORK, "data"), { recursive: true });
  fs.chmodSync(path.join(WORK, "data"), 0o777); // the image runs as a user of its own
  const pair = crypto.generateKeyPairSync("ed25519");
  const wrong = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(path.join(WORK, "signing.pem"), pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  fs.writeFileSync(path.join(WORK, "wrong.pem"), wrong.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  fs.writeFileSync(path.join(WORK, "jwks.json"), JSON.stringify(jwksFor(pair.publicKey), null, 2));
  const env = {
    GATEWAY_KEY_MAIN: randomKey("spike-main"),
    GATEWAY_KEY_TINY: randomKey("spike-tiny"),
    MOCK_UPSTREAM_KEY: randomKey("spike-upstream")
  };
  fs.writeFileSync(path.join(WORK, "env"), Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  console.log(`Wrote ${path.relative(process.cwd(), WORK)}: a signing key, a wrong one, jwks.json, and env (three keys, not shown).`);
}

function env() {
  const file = path.join(WORK, "env");
  if (!fs.existsSync(file)) throw new Error("Run `node deploy/spikes/agentgateway/probe.mjs setup` first.");
  return Object.fromEntries(fs.readFileSync(file, "utf8").trim().split("\n").map(l => l.split(/=(.*)/s).slice(0, 2)));
}

// ---------------------------------------------------------------- tokens

/** A token like the one the API would sign for each call (D1). */
function token(claims = {}, { key = "signing.pem", kid = signingKid(), alg = "EdDSA" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  // Each token names a run of its own unless a check says otherwise, so the per-run
  // limit only meets the checks that are about it.
  const payload = { iss: ISSUER, aud: AUDIENCE, sub: "greg", run: `run-spike-${crypto.randomBytes(4).toString("hex")}`, worker: "interview", iat: now, exp: now + 300, ...claims };
  for (const [k, v] of Object.entries(payload)) if (v === undefined) delete payload[k];
  const head = b64url(JSON.stringify({ alg, typ: "JWT", kid }));
  const body = b64url(JSON.stringify(payload));
  const pem = fs.readFileSync(path.join(WORK, key));
  const sig = crypto.sign(null, Buffer.from(`${head}.${body}`), crypto.createPrivateKey(pem));
  return `${head}.${body}.${b64url(sig)}`;
}

// ---------------------------------------------------------------- calls

function client({ claims, gatewayKey, timeout = 120_000 } = {}) {
  return new Anthropic({
    baseURL: GATEWAY,
    apiKey: null, // the API never holds the model's key once the gateway does
    authToken: token(claims),
    defaultHeaders: { "x-sealeye-gateway-key": gatewayKey ?? env().GATEWAY_KEY_MAIN },
    maxRetries: 0, // as api/interview/model.js
    timeout
  });
}

const TOOLS = [
  {
    name: "read_file",
    description: "Read one file from the app's folder.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
  }
];

/** One raw call, for the checks that need a status and headers, not the SDK's errors. */
async function raw({ headers = {}, text = "Hello.", model = MODEL } = {}) {
  const started = Date.now();
  const res = await fetch(`${GATEWAY}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model, max_tokens: 64, messages: [{ role: "user", content: text }] })
  });
  const body = await res.text();
  return {
    status: res.status,
    ms: Date.now() - started,
    body: body.slice(0, 160),
    remaining: res.headers.get("x-ratelimit-remaining"),
    retryAfter: res.headers.get("retry-after")
  };
}

const authHeaders = (claims, opts, gatewayKey = env().GATEWAY_KEY_MAIN) => ({
  authorization: `Bearer ${token(claims, opts)}`,
  "x-sealeye-gateway-key": gatewayKey
});

async function seen() {
  const res = await fetch(`${MOCK}/seen`);
  return res.json();
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(READY)).ok) return true;
    } catch {}
    await sleep(1000);
  }
  return false;
}

const compose = (...args) => execFileSync("docker", ["compose", ...args], { cwd: HERE, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// ---------------------------------------------------------------- the checks

/** A system prompt long enough to be cached (Sonnet caches from 1,024 tokens). */
const LONG_SYSTEM = Array.from({ length: 220 }, (_, i) => `Rule ${i + 1}: read the folder before asking the developer anything the folder answers.`).join("\n");

async function sdkToolUseAndCache({ expectUpstream }) {
  const anthropic = client();
  const params = {
    model: MODEL,
    max_tokens: 300,
    system: [{ type: "text", text: LONG_SYSTEM, cache_control: { type: "ephemeral" } }],
    tools: TOOLS,
    tool_choice: { type: "tool", name: "read_file" },
    messages: [{ role: "user", content: "USE TOOL. Read README.md with the read_file tool." }]
  };
  // A made-up beta value shows the stand-in what the gateway forwards. Anthropic refuses
  // a beta it does not know (400), which is itself proof the header reaches it, so the
  // real route sends none.
  const first = await anthropic.messages.create(params, expectUpstream ? { headers: { "anthropic-beta": "spike-check-2026" } } : {});
  const toolUse = first.content.find(b => b.type === "tool_use");
  check("sdk: tool use comes back through the gateway", Boolean(toolUse) && toolUse.name === "read_file" && first.stop_reason === "tool_use", {
    stopReason: first.stop_reason,
    blocks: first.content.map(b => b.type)
  });
  const second = await anthropic.messages.create(params);
  const u1 = first.usage;
  const u2 = second.usage;
  check("sdk: prompt caching usage comes back", (u1.cache_creation_input_tokens ?? 0) + (u2.cache_read_input_tokens ?? 0) > 0, {
    first: { cacheWrite: u1.cache_creation_input_tokens, cacheRead: u1.cache_read_input_tokens },
    second: { cacheWrite: u2.cache_creation_input_tokens, cacheRead: u2.cache_read_input_tokens }
  });
  if (expectUpstream) {
    const list = await seen();
    const last = list[list.length - 2]; // the first of the two calls carried the beta header
    check("upstream: the gateway's key reached the model, the client's credentials did not", last.upstreamKeyMatches && !last.hasAuthorization && !last.hasGatewayKey, {
      upstreamKeyMatches: last.upstreamKeyMatches,
      tokenForwarded: last.hasAuthorization,
      gatewayKeyForwarded: last.hasGatewayKey
    });
    check("upstream: tools, cache marks and the beta header arrive unchanged", last.tools.join() === "read_file" && last.cacheMarks >= 1 && last.anthropicBeta === "spike-check-2026", {
      tools: last.tools,
      cacheMarks: last.cacheMarks,
      anthropicBeta: last.anthropicBeta,
      anthropicVersion: last.anthropicVersion
    });
  }
}

async function sdkStream(sentinel) {
  const stream = client().messages.stream({ model: MODEL, max_tokens: 64, messages: [{ role: "user", content: `SENTINEL ${sentinel}. Say hello in five words.` }] });
  let events = 0;
  stream.on("streamEvent", () => events++);
  const final = await stream.finalMessage();
  check("sdk: a streamed reply arrives whole, with its usage", final.content.length > 0 && final.usage.output_tokens > 0, {
    events,
    stopReason: final.stop_reason,
    usage: { input: final.usage.input_tokens, output: final.usage.output_tokens, cacheRead: final.usage.cache_read_input_tokens, cacheWrite: final.usage.cache_creation_input_tokens }
  });
  return final;
}

async function jwtChecks() {
  const wrongAlg = { alg: "RS256" };
  const cases = [
    ["a valid token is let through", authHeaders(), 200],
    ["no token is refused", { "x-sealeye-gateway-key": env().GATEWAY_KEY_MAIN }, 401],
    ["an expired token is refused", authHeaders({ iat: Math.floor(Date.now() / 1000) - 600, exp: Math.floor(Date.now() / 1000) - 300 }), 401],
    ["a token signed with another key is refused", authHeaders({}, { key: "wrong.pem" }), 401],
    ["a token naming another algorithm is refused", authHeaders({}, wrongAlg), 401],
    ["a token for another audience is refused", authHeaders({ aud: "someone-else" }), 401],
    ["a token from another issuer is refused", authHeaders({ iss: "https://elsewhere.test" }), 401],
    ["a token with no person is refused", authHeaders({ sub: undefined }), 401],
    ["a token with no expiry is refused", authHeaders({ exp: undefined }), 401],
    ["a valid token without the API's key is refused", { authorization: `Bearer ${token()}` }, 401],
    ["a valid token with a wrong API key is refused", authHeaders({}, {}, "spike-not-the-key"), 401]
  ];
  for (const [name, headers, want] of cases) {
    const r = await raw({ headers });
    check(`jwt: ${name}`, r.status === want, { status: r.status, body: r.status === 200 ? undefined : r.body });
  }
}

/** A call made the way the API makes it: its own client and signer, for a portal run. */
async function apiSignedCall() {
  process.env.SEALEYE_MODEL_URL = GATEWAY;
  const signer = signerFromSettings(fs.readFileSync(path.join(WORK, "signing.pem"), "utf8"));
  const record = {
    id: `int_spike${crypto.randomBytes(4).toString("hex")}`,
    caller: { email: "greg@example.org", org: "default", team: "payments" },
    surface: "portal",
    traceId: crypto.randomBytes(16).toString("hex")
  };
  const client = withCallerToken(modelClient({ gatewayKey: env().GATEWAY_KEY_MAIN }), signer, () => claimsFor(record));
  const reply = await client.messages.create({ model: MODEL, max_tokens: 32, messages: [{ role: "user", content: "Hello." }] });
  check("api: a call signed by the API's own signer is let through", reply.content.length > 0, { kid: signer.kid });
  return record;
}

async function tokenLimit() {
  const run = `run-limit-${Date.now()}`;
  const statuses = [];
  for (let i = 0; i < 5; i++) {
    const r = await raw({ headers: authHeaders({ run }) });
    statuses.push({ status: r.status, remaining: r.remaining, retryAfter: r.retryAfter, body: r.status === 200 ? undefined : r.body });
    if (r.status !== 200) break;
  }
  // 11,000 tokens a call against 25,000: two fit, the third crosses and is let through,
  // the fourth is refused.
  const codes = statuses.map(s => s.status).join(",");
  check("limit: a run's token limit refuses the call after the one that crosses it", codes === "200,200,200,429", { calls: statuses });
  const other = await raw({ headers: authHeaders({ run: `${run}-other` }) });
  check("limit: another run still has its own limit", other.status === 200, { status: other.status });
  return run;
}

async function budget() {
  const tiny = env().GATEWAY_KEY_TINY;
  const statuses = [];
  for (let i = 0; i < 4; i++) {
    const r = await raw({ headers: authHeaders({ run: `run-budget-${Date.now()}-${i}` }, {}, tiny) });
    statuses.push({ status: r.status, retryAfter: r.retryAfter, body: r.status === 200 ? undefined : r.body });
    if (r.status !== 200) break;
  }
  // About $0.029 a call at Sonnet 5's prices against $0.05: the second crosses, the third is refused.
  check("budget: the API key's money budget refuses the call after the one that crosses it", statuses.map(s => s.status).join(",") === "200,200,429", { calls: statuses });
}

async function slow() {
  const started = Date.now();
  const r = await client({ timeout: 120_000 }).messages.create({ model: MODEL, max_tokens: 64, messages: [{ role: "user", content: "WAIT 95" }] });
  check("timeout: a reply that takes 95 seconds is not cut short", r.content.length > 0, { seconds: Math.round((Date.now() - started) / 1000) });
  const s2 = Date.now();
  const final = await client({ timeout: 200_000 }).messages.stream({ model: MODEL, max_tokens: 64, messages: [{ role: "user", content: "WAIT 70" }] }).finalMessage();
  check("timeout: a stream that is silent for 70 seconds is not cut short", final.content.length > 0, { seconds: Math.round((Date.now() - s2) / 1000) });
}

function logs({ sentinel, run, apiRecord }) {
  const out = compose("logs", "gateway", "--no-log-prefix", "--no-color");
  const lines = out.split("\n").filter(Boolean);
  const json = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const llm = json.filter(j => Object.keys(j).some(k => k.startsWith("gen_ai.")));
  const sample = llm[llm.length - 1] || json[json.length - 1] || {};
  check("logs: no prompt and no reply in the access log", !out.includes(`SENTINEL ${sentinel}`) && !out.includes(`SENTINEL-REPLY-${sentinel}`) && !out.includes("Rule 17: read the folder"), {
    lines: lines.length
  });
  check("logs: no token and no key in the access log", !out.includes(token().split(".")[0] + ".") && !Object.values(env()).some(v => out.includes(v)), {});
  check("logs: the token's person and worker are in the access log", out.includes("jwt.sub") && out.includes("greg") && out.includes("interview"), {
    hasRun: run ? out.includes(run) : undefined
  });
  if (apiRecord) {
    const line = json.find(j => j.run === apiRecord.id) || {};
    check("logs: the API's call is logged with its person, team, run, worker, surface and trace", line["jwt.sub"] === "greg@example.org" && line.team === "payments" && line.worker === "interview" && line.surface === "portal" && line.trace === apiRecord.traceId, {
      fields: Object.keys(line).filter(k => ["jwt.sub", "org", "team", "run", "worker", "surface", "trace"].includes(k)).sort()
    });
  }
  note("logs: the fields of one model call's line (names only)", { fields: Object.keys(sample).sort() });
}

function database({ sentinel, apiRecord }) {
  const dir = path.join(WORK, "data");
  if (!fs.existsSync(dir)) return note("database: no folder", {});
  const files = fs.readdirSync(dir);
  const all = Buffer.concat(files.map(f => fs.readFileSync(path.join(dir, f))));
  const text = all.toString("latin1");
  check("database: no prompt, reply, token or key stored", !text.includes(`SENTINEL ${sentinel}`) && !text.includes(`SENTINEL-REPLY-${sentinel}`) && !text.includes("Rule 17: read the folder") && !Object.values(env()).some(v => text.includes(v)), {
    files: files.map(f => `${f} ${fs.statSync(path.join(dir, f)).size} bytes`)
  });

  // The record of calls the server reads (PHASE3-PLAN Step 7, deploy/gateway.sh calls):
  // each stored row should carry the token's claims, as the log line does. Read from a
  // copy, with the sqlite3 every Mac has, so the gateway's own file is not touched.
  if (apiRecord) {
    const copy = fs.mkdtempSync(path.join(WORK, "dbcopy-"));
    try {
      for (const f of files) fs.copyFileSync(path.join(dir, f), path.join(copy, f));
      const out = execFileSync("sqlite3", ["-json", path.join(copy, "gateway.db"),
        `SELECT json_extract(attributes_json, '$."jwt.sub"') AS person, json_extract(attributes_json, '$.team') AS team,
                json_extract(attributes_json, '$.run') AS run, json_extract(attributes_json, '$.worker') AS worker,
                json_extract(attributes_json, '$.surface') AS surface, json_extract(attributes_json, '$.trace') AS trace,
                gen_ai_request_model AS model, input_tokens, output_tokens, cost, http_status,
                (SELECT count(*) FROM request_log_payloads) AS payloads
         FROM request_logs WHERE json_extract(attributes_json, '$.run') = '${apiRecord.id}'`], { encoding: "utf8" });
      const [row] = JSON.parse(out || "[]");
      check("database: the stored call names its person, team, run, worker, surface and trace, and holds no content", Boolean(row) &&
        row.person === "greg@example.org" && row.team === "payments" && row.worker === "interview" && row.surface === "portal" &&
        row.trace === apiRecord.traceId && row.payloads === 0, { row: row && { ...row } });
    } catch (err) {
      note("database: could not read the stored calls with sqlite3", { error: String(err.message).slice(0, 200) });
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
  }
}

async function restart({ run }) {
  compose("restart", "gateway");
  const ready = await waitReady();
  const tiny = await raw({ headers: authHeaders({ run: `run-after-restart-${Date.now()}` }, {}, env().GATEWAY_KEY_TINY) });
  const limited = await raw({ headers: authHeaders({ run }) });
  note("restart: what survives a restart", {
    ready,
    spentBudgetStillRefuses: tiny.status === 429,
    tinyKeyStatus: tiny.status,
    spentRunStillRefuses: limited.status === 429,
    spentRunStatus: limited.status
  });
}

// ---------------------------------------------------------------- memory

function stats() {
  const out = execFileSync("docker", ["stats", "--no-stream", "--format", "{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}"], { encoding: "utf8" });
  const line = out.split("\n").find(l => l.startsWith("sealeye-gateway-spike-gateway"));
  return line ? line.split("\t").slice(1).join("  ") : "not running";
}

async function memory() {
  const arch = execFileSync("docker", ["version", "--format", "{{.Server.Arch}}"], { encoding: "utf8" }).trim();
  note("memory: idle", { arch, usage: stats() });
  const busy = Array.from({ length: 20 }, (_, i) =>
    client({ timeout: 60_000 }).messages.stream({ model: MODEL, max_tokens: 64, system: LONG_SYSTEM, messages: [{ role: "user", content: `WAIT 8. Call ${i}.` }] }).finalMessage()
  );
  await sleep(4000);
  note("memory: twenty streams at once", { usage: stats() });
  const done = await Promise.allSettled(busy);
  note("memory: after", { usage: stats(), succeeded: done.filter(d => d.status === "fulfilled").length });
}

// ---------------------------------------------------------------- modes

async function mock({ quick }) {
  check("gateway: ready", await waitReady());
  const sentinel = crypto.randomBytes(6).toString("hex");
  await sdkToolUseAndCache({ expectUpstream: true });
  await sdkStream(sentinel);
  await jwtChecks();
  const apiRecord = await apiSignedCall();
  const run = await tokenLimit();
  await budget();
  if (!quick) await slow();
  await sleep(1500); // the access log and the database are written a moment after
  logs({ sentinel, run, apiRecord });
  database({ sentinel, apiRecord });
  await restart({ run });
}

async function live() {
  check("gateway: ready", await waitReady());
  const sentinel = crypto.randomBytes(6).toString("hex");
  await sdkToolUseAndCache({ expectUpstream: false });
  await sdkStream(sentinel);
  const bad = await raw({ headers: { "x-sealeye-gateway-key": env().GATEWAY_KEY_MAIN } });
  check("jwt: no token is refused before it costs anything", bad.status === 401, { status: bad.status });
  await sleep(1500);
  logs({ sentinel });
}

const mode = process.argv[2];
const quick = process.argv.includes("--quick");
try {
  if (mode === "setup") {
    setup();
    process.exit(0);
  } else if (mode === "mock") await mock({ quick });
  else if (mode === "real" || mode === "bedrock") await live();
  else if (mode === "memory") await memory();
  else {
    console.log("Usage: node deploy/spikes/agentgateway/probe.mjs setup|mock|real|bedrock|memory [--quick]");
    process.exit(2);
  }
} catch (err) {
  check("probe: finished without an error", false, { error: String(err?.message || err).slice(0, 300), status: err?.status });
}
results.finishedAt = new Date().toISOString();
results.passed = results.checks.filter(c => c.ok).length;
results.failed = results.checks.filter(c => c.ok === false).length;
fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(path.join(WORK, `results-${mode}.json`), JSON.stringify(results, null, 2));
console.log(`\n${results.passed} passed, ${results.failed} failed. Paste .work/results-${mode}.json back to Claude:\n`);
console.log(JSON.stringify(results));
process.exit(results.failed ? 1 : 0);
