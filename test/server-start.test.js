// deploy/start.mjs, the way the API starts on the server: settings read from SSM through
// the server's role, the deploy role made the default for everything after, and no
// value ever printed. A stand-in `aws` on the PATH plays SSM. No AWS.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const KEY = "sk-ant-api03-from-parameter-store";

test("settings come from SSM, values stay out of the log, and AWS calls go through the deploy role", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-start-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const calls = path.join(dir, "aws-calls.log");
  // Records how it was called, with which profile, and answers as SSM would.
  fs.writeFileSync(path.join(bin, "aws"), `#!/bin/sh
echo "profile=\${AWS_PROFILE:-none} $*" >> "${calls}"
cat <<'JSON'
{"Parameters":[
  {"Name":"/sealeye/ANTHROPIC_API_KEY","Value":"${KEY}"},
  {"Name":"/sealeye/SEALEYE_DEPLOY_ROLE_ARN","Value":"arn:aws:iam::123456789012:role/sealeye-deploy-pilot"},
  {"Name":"/sealeye/POSTGRES_PASSWORD","Value":"pg-pass/with:odd@chars"},
  {"Name":"/sealeye/not a name","Value":"ignored"}
]}
JSON
`, { mode: 0o755 });

  const port = 4500 + Math.floor(Math.random() * 90);
  const child = spawn(process.execPath, ["deploy/start.mjs"], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PORT: String(port), HOME: dir, SEALEYE_HOME: dir, AWS_PROFILE: "should-not-be-used-for-ssm" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  child.stdout.on("data", d => (log += d));
  child.stderr.on("data", d => (log += d));

  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { up = (await fetch(`http://localhost:${port}/health`)).ok; } catch {}
      if (!up) await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(up, `the API started:\n${log}`);

    assert.match(log, /3 settings read from \/sealeye\/: ANTHROPIC_API_KEY, POSTGRES_PASSWORD, SEALEYE_DEPLOY_ROLE_ARN/);
    assert.ok(!log.includes("pg-pass"), "no password in the log");
    assert.doesNotMatch(log, /kept in Postgres/, "no database host given, so no database");
    assert.match(log, /AWS actions go through the deploy role/);
    assert.ok(!log.includes(KEY), "no value in the log");
    assert.match(fs.readFileSync(calls, "utf8"), /^profile=none ssm get-parameters-by-path --path \/sealeye\/ --recursive --with-decryption/);

    // The key reached the API: an interview no longer says it has none.
    const res = await fetch(`http://localhost:${port}/interviews`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app: "x" })
    });
    assert.equal((await res.json()).error.code, "MISSING_UPLOAD");
  } finally {
    child.kill();
  }
});

test("a deploy role that is not a sealeye-deploy-* role stops the server from starting", async () => {
  const child = spawn(process.execPath, ["deploy/start.mjs"], {
    cwd: root,
    env: { ...process.env, SEALEYE_SKIP_SSM: "1", SEALEYE_DEPLOY_ROLE_ARN: "arn:aws:iam::123456789012:role/Admin", PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  child.stderr.on("data", d => (log += d));
  const code = await new Promise(r => child.on("close", r));
  assert.notEqual(code, 0);
  assert.match(log, /must be the arn of a role named sealeye-deploy-\*/);
});

test("with a database host, the password from Parameter Store becomes the database address", async () => {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { applyServerSettings } from "./deploy/settings.mjs";
    applyServerSettings({ quiet: true });
    console.log(process.env.DATABASE_URL);
    console.log(String(process.env.POSTGRES_PASSWORD));
  `], { cwd: root, encoding: "utf8", env: { ...process.env, SEALEYE_SKIP_SSM: "1", SEALEYE_DATABASE_HOST: "postgres", POSTGRES_PASSWORD: "a/b:c@d", DATABASE_URL: "" } });
  const [url, left] = r.stdout.trim().split("\n");
  assert.equal(url, "postgres://sealeye:a%2Fb%3Ac%40d@postgres:5432/sealeye");
  assert.equal(left, "undefined", "the password alone is gone from the environment");
});

test("npm install in staging sees no keys, passwords or database address", async () => {
  const { installEnv } = await import("../api/executor/package.js");
  const env = installEnv({
    PATH: "/usr/bin", HOME: "/home/api", HTTPS_PROXY: "http://proxy",
    ANTHROPIC_API_KEY: "sk", DATABASE_URL: "postgres://x", POSTGRES_PASSWORD: "p",
    AWS_PROFILE: "sealeye-deploy", AWS_ACCESS_KEY_ID: "AKIA", LANGFUSE_SECRET_KEY: "s"
  });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "HTTPS_PROXY", "PATH"]);
});
