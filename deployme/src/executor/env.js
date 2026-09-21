// src/executor/env.js
// Repo-root path and the .env loader shared by the executor modules.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// .../deployme/src/executor/env.js -> repo root
export const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

let loaded = false;
let userConfigLoaded = false;

/**
 * Apply a KEY=value file to process.env. Lines may be `KEY=value` or the
 * shell-sourceable `export KEY=value`. A variable already set in the real
 * environment always wins, so `DEPLOYME_BUCKET=x node ...` overrides the file.
 */
function applyEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return process.env;

  for (const raw of fs.readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) process.env[key] = value;
  }

  return process.env;
}

/**
 * Load .env from the repo root if present. Safe to call repeatedly; the file is read
 * once.
 */
export function loadEnv(envPath = path.join(repoRoot, ".env")) {
  if (loaded) return process.env;
  loaded = true;
  return applyEnvFile(envPath);
}

/**
 * Load ~/.deployme/config, the developer's own secrets file. Same format as .env, and
 * the same rule: anything already in the environment wins. Read once.
 */
export function loadUserConfig(configPath = path.join(os.homedir(), ".deployme", "config")) {
  if (userConfigLoaded) return process.env;
  userConfigLoaded = true;
  return applyEnvFile(configPath);
}

/** Read a required environment value, with a message that says where to set it. */
export function requireEnv(key) {
  loadEnv();
  const value = process.env[key];
  if (!value) {
    throw new Error(`${key} is not set (put it in .env at the repo root or in the environment)`);
  }
  return value;
}
