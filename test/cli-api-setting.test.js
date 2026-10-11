// Which API the command talks to: --api for one command, SEALEYE_API for every command,
// seaLeye's own API otherwise. Checked against addresses nothing listens on, so the
// answer is in the "not reachable" line. No network: the default is checked by name.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");

async function listWith({ config, args = [] }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-cli-api-"));
  fs.mkdirSync(path.join(home, ".sealeye"));
  if (config) fs.writeFileSync(path.join(home, ".sealeye", "config"), config);
  const env = { ...process.env, HOME: home, SEALEYE_HOME: path.join(home, ".sealeye") };
  delete env.SEALEYE_API;
  try {
    await run(process.execPath, ["cli/bin/sealeye", "list", ...args], { cwd: root, env });
    return "";
  } catch (err) {
    return `${err.stdout}${err.stderr}`;
  }
}

test("SEALEYE_API in ~/.sealeye/config is the API for every command", async () => {
  assert.match(await listWith({ config: "SEALEYE_API=http://127.0.0.1:1/\n" }), /not reachable at http:\/\/127\.0\.0\.1:1\n/);
});

test("--api still wins for one command", async () => {
  assert.match(await listWith({ config: "SEALEYE_API=http://127.0.0.1:1\n", args: ["--api", "http://127.0.0.1:2"] }), /not reachable at http:\/\/127\.0\.0\.1:2/);
});

test("with neither, it is seaLeye's own API", async () => {
  const { DEFAULT_API } = await import("../core/config.js");
  assert.equal(DEFAULT_API, "https://api.sealeye.online");
  const help = (await run(process.execPath, ["cli/bin/sealeye", "--help"], { cwd: root })).stdout;
  assert.match(help, /else https:\/\/api\.sealeye\.online/);
});
