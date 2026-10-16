// A real API on a spare port with tokens, sample records and a stand-in `aws`, for the
// day-two operations (logs, pause, configure, team, performance, costs). No AWS, no
// model. The stand-in is a small script the test writes: it gets the command line and
// answers as the AWS CLI would, and every call it gets is logged, one per line.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { freePort } from "./free-port.js";

const root = path.resolve(import.meta.dirname, "..", "..");
const hash = t => createHash("sha256").update(t).digest("hex");

/**
 * @param {object} options
 * @param {{ token: string, id: string, team: string, scope?: "org", name?: string }[]} options.tokens
 * @param {object[]} options.records   deployment records, newest first
 * @param {string} options.aws         the body of a CommonJS script; it has `args`,
 *        `opt(name)`, `out(value)` (prints JSON, exits 0) and `fail(text)` (exits 254)
 * @param {object} [options.env]
 */
export async function startApi({ tokens, records, aws, env: extra = {}, files = {} }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-day-two-"));
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(home, "tokens.json"), JSON.stringify(tokens.map(t => ({
    tokenId: t.id, tokenHash: hash(t.token), email: `${t.id}@example.com`, name: t.name || t.id, org: t.org || "default", team: t.team,
    ...(t.scope ? { scope: t.scope } : {}), createdAt: at, revokedAt: null, lastUsedAt: null
  }))));
  fs.writeFileSync(path.join(home, "deployments.json"), JSON.stringify(records));
  // Anything else the API's home should hold when it starts (catalogs, discoveries).
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(home, name), typeof content === "string" ? content : JSON.stringify(content));

  const bin = path.join(home, "bin");
  const log = path.join(home, "aws.log");
  fs.mkdirSync(bin);
  fs.writeFileSync(log, "");
  fs.writeFileSync(path.join(bin, "aws.cjs"), `const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
const opt = n => args[args.indexOf(n) + 1];
const out = v => { process.stdout.write(typeof v === "string" ? v : JSON.stringify(v)); process.exit(0); };
const fail = t => { process.stderr.write(t); process.exit(254); };
${aws}
out({});
`);
  fs.writeFileSync(path.join(bin, "aws"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, "aws.cjs")}" "$@"\n`, { mode: 0o755 });

  const port = await freePort();
  const api = `http://localhost:${port}`;
  const env = {
    ...process.env, PORT: String(port), HOME: home, SEALEYE_HOME: home, PATH: `${bin}:${process.env.PATH}`,
    SEALEYE_TRACING: "off", SEALEYE_TEST_POLL_MS: "50", DATABASE_URL: "", ...extra
  };
  delete env.SEALEYE_AUTH;
  const server = spawn(process.execPath, ["api/server.js"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  server.stdout.on("data", d => (output += d));
  server.stderr.on("data", d => (output += d));
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${api}/health`)).ok) break;
    } catch {}
    if (i === 59) throw new Error(`API did not start:\n${output}`);
    await new Promise(r => setTimeout(r, 100));
  }

  const call = (route, { token, method = "GET", body } = {}) => fetch(`${api}${route}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  return {
    api, home, call,
    awsCalls: () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean),
    clearAwsCalls: () => fs.writeFileSync(log, ""),
    stop: () => server.kill()
  };
}

export const token = ch => `sl_${ch.repeat(43)}`;
