// core/config.js
// Where seaLeye's settings come from, for the CLI and the API alike: the repo-root
// .env, the developer's own ~/.sealeye/config, and the environment, in that order of
// precedence from lowest to highest.
//
// Names. Settings are SEALEYE_<NAME>. Until 2.17.0 they were DEPLOYME_<NAME> and the
// config folder was ~/.deployme; both are still read, so an existing .env or config
// file keeps working, but nothing here ever writes the old names. When both are set,
// the new name wins.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// core/config.js -> repo root
export const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

const PREFIX = "SEALEYE_";
const LEGACY_PREFIX = "DEPLOYME_";

let loaded = false;
let userConfigLoaded = false;

/**
 * Read a KEY=value file into a plain object. Lines may be `KEY=value` or the
 * shell-sourceable `export KEY=value`. Nothing is applied to process.env: the
 * developer's own .env is read for their deployment, and putting it into the
 * platform's environment would be a way to leak it somewhere else.
 *
 * @returns {Record<string, string>} empty when the file is not there
 */
export function readEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return {};

  const values = {};

  for (const raw of fs.readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[match[1]] = value;
  }

  return values;
}

/**
 * Apply a KEY=value file to process.env. A variable already set in the real
 * environment always wins, so `SEALEYE_BUCKET=x node ...` overrides the file.
 */
function applyEnvFile(envPath) {
  for (const [key, value] of Object.entries(readEnvFile(envPath))) {
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

/** ~/.deployme, where everything lived before 2.17.0. Read, never written. */
export function legacyHome() {
  return path.join(os.homedir(), ".deployme");
}

/**
 * seaLeye's own folder: the developer's config file and the API's deployment store.
 * SEALEYE_HOME moves it, for tests and for running two APIs side by side.
 */
export function sealeyeHome() {
  return process.env.SEALEYE_HOME || process.env.DEPLOYME_HOME || path.join(os.homedir(), ".sealeye");
}

/** Where a developer is told to put their own secrets, for messages. */
export const USER_CONFIG_HINT = path.join("~", ".sealeye", "config");

/**
 * Load ~/.sealeye/config, the developer's own secrets file, then ~/.deployme/config if
 * one is still there. Same format as .env, and the same rule: anything already in the
 * environment wins, and so does the newer file. Read once.
 */
export function loadUserConfig(configPath) {
  if (userConfigLoaded) return process.env;
  userConfigLoaded = true;

  if (configPath) return applyEnvFile(configPath);

  applyEnvFile(path.join(sealeyeHome(), "config"));
  return applyEnvFile(path.join(legacyHome(), "config"));
}

/**
 * A seaLeye setting by its short name: setting("BUCKET") reads SEALEYE_BUCKET, then the
 * older DEPLOYME_BUCKET. Loads .env first.
 *
 * @returns {string|undefined}
 */
export function setting(name) {
  loadEnv();
  const value = process.env[PREFIX + name];
  if (value !== undefined && value !== "") return value;
  const legacy = process.env[LEGACY_PREFIX + name];
  return legacy === "" ? undefined : legacy;
}

/** The variable name a message should tell someone to set. */
export function settingName(name) {
  return PREFIX + name;
}

/** A required setting, with a message that says where to set it. */
export function requireSetting(name) {
  const value = setting(name);
  if (!value) {
    throw new Error(`${settingName(name)} is not set (put it in .env at the repo root or in the environment)`);
  }
  return value;
}

/** Hard rule: ca-central-1. SEALEYE_REGION is an explicit opt-out, nothing else. */
/**
 * The API the command talks to when nothing says otherwise: seaLeye's own (PHASE1-PLAN
 * Step 12). SEALEYE_API or --api points it elsewhere, `http://localhost:3000` for an API
 * run from the repo with `npm start`.
 */
export const DEFAULT_API = "https://api.sealeye.online";

export function region() {
  return setting("REGION") || "ca-central-1";
}
