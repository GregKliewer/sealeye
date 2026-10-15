// Deploy again (PHASE2-PLAN Step 14) with a plan from a catalog that was since replaced
// (PHASE4-PLAN Step 2): refused with CATALOG_CHANGED before anything is recorded or any
// AWS call is made, as a first deploy is. The API runs on a spare port with one
// organization whose live catalog no longer builds a module the earlier plan used.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import YAML from "yaml";

import { freePort } from "./helpers/free-port.js";

const root = path.resolve(import.meta.dirname, "..");
const TOKEN = `sl_${"c".repeat(43)}`;
const hash = t => createHash("sha256").update(t).digest("hex");
const at = m => new Date(Date.now() - m * 60_000).toISOString();
let home, api, server, awsLog;

// Written against the starter, as every plan before today was.
const plan = {
  planVersion: "0.4", app: { name: "lookup-api", type: "api" }, profile: "dev",
  modules: [
    { id: "http_api_serverless", inputs: { runtime: "nodejs", entry_point: "index.js", trigger: "http" } },
    { id: "observability_basic", inputs: { retention_days: 14 } }
  ],
  outputs: ["public_url", "logs"]
};

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-changed-again-"));
  awsLog = path.join(home, "aws.log");
  const port = await freePort();
  api = `http://localhost:${port}`;

  fs.writeFileSync(path.join(home, "tokens.json"), JSON.stringify([
    { tokenId: "ana", tokenHash: hash(TOKEN), email: "ana@acme.example", name: "Ana", org: "acme", team: "default", createdAt: at(0), revokedAt: null, lastUsedAt: null }
  ]));
  const stack = "sealeye-default-lookup-api-abc123";
  fs.writeFileSync(path.join(home, "deployments.json"), JSON.stringify([
    { deploymentId: "dep_acmesource01", backend: "cloudformation", orgId: "acme", teamId: "default", surface: "cli", outputs: {},
      app: { name: "lookup-api" }, kind: "api", status: "succeeded", stackName: stack, resourceName: stack, plan,
      artifactKey: `${stack}/dep_acmesource01.zip`, artifactSha256: "a".repeat(64), startedAt: at(60) }
  ]));
  // acme's live catalog keeps the API module and drops the one that keeps logs.
  const doc = YAML.parse(fs.readFileSync(path.join(root, "prompts", "module-catalog.yaml"), "utf8"));
  doc.modules = doc.modules.filter(m => m.id !== "observability_basic");
  fs.writeFileSync(path.join(home, "catalogs.json"), JSON.stringify([
    { org: "acme", version: 1, status: "live", document: doc, createdBy: "discovery", createdAt: at(30), approvedBy: "pat@acme.example", approvedAt: at(20) }
  ]));

  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "aws"), `#!/bin/sh\necho "$*" >> "${awsLog}"\necho '{}'\n`, { mode: 0o755 });

  const env = { ...process.env, PORT: String(port), HOME: home, SEALEYE_HOME: home, PATH: `${bin}:${process.env.PATH}`, SEALEYE_TRACING: "off", DATABASE_URL: "" };
  delete env.SEALEYE_AUTH;
  server = spawn(process.execPath, ["api/server.js"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  server.stdout.on("data", d => (out += d));
  server.stderr.on("data", d => (out += d));
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${api}/health`)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`API did not start:\n${out}`);
});

after(() => server?.kill());

test("deploying again from a replaced catalog is refused with CATALOG_CHANGED, and nothing happens", async () => {
  const res = await fetch(`${api}/deployments`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ backend: "cloudformation", fromDeployment: "dep_acmesource01" })
  });
  const body = await res.json();
  assert.equal(res.status, 409, JSON.stringify(body));
  assert.equal(body.error.code, "CATALOG_CHANGED");
  assert.equal(body.error.details.noLongerBuilt.length, 1);
  assert.match(body.error.message, /no longer builds everything it uses\. [A-Z][^.]*\. Run sealeye run again/, "whole sentences, one period each");
  assert.doesNotMatch(body.error.message, /observability_basic|\.\.|—/);

  const list = await (await fetch(`${api}/deployments`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  assert.deepEqual(list.deployments.map(d => d.deploymentId), ["dep_acmesource01"], "nothing was recorded");
  assert.equal(fs.existsSync(awsLog), false, "and AWS was never asked anything");
});
