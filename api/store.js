// api/store.js
// In-memory map, mirrored to ~/.sealeye/deployments.json on every change so that
// restarting the API does not lose the developer's deployment ids.
import fs from "node:fs";
import path from "node:path";

import { sealeyeHome, legacyHome } from "../core/config.js";

const STORE_DIR = sealeyeHome();
const STORE_FILE = path.join(STORE_DIR, "deployments.json");

// Before 2.17.0 the store was ~/.deployme/deployments.json. The first time the API
// starts with no store of its own and an old one beside it, it copies the old one in,
// so nobody's environments disappear from `sealeye list`. A copy, not a move: the old
// file is left exactly as it was, and nothing ever writes to it again.
export function adoptLegacyStore(storeFile = STORE_FILE, legacyFile = path.join(legacyHome(), "deployments.json")) {
  if (fs.existsSync(storeFile) || !fs.existsSync(legacyFile)) return false;
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  fs.copyFileSync(legacyFile, storeFile);
  console.error(`deployment store: copied ${legacyFile} to ${storeFile}`);
  return true;
}

// A deployment that was in flight when the API stopped has nobody polling it any
// more, so its stored status is the last thing we actually knew, not the truth now.
// Say so rather than let it read as live.
const IN_FLIGHT = new Set(["queued", "packaging", "running", "destroying"]);

function load() {
  // Only for the default home: a SEALEYE_HOME set on purpose starts where it says.
  if (!process.env.SEALEYE_HOME && !process.env.DEPLOYME_HOME) {
    try {
      adoptLegacyStore();
    } catch (err) {
      console.error(`could not copy the old deployment store: ${err.message}`);
    }
  }

  let raw;
  try {
    raw = fs.readFileSync(STORE_FILE, "utf8");
  } catch {
    return []; // no file yet: first run
  }

  let records;
  try {
    records = JSON.parse(raw);
    if (!Array.isArray(records)) throw new Error("expected an array of deployments");
  } catch (err) {
    // Never start by silently overwriting something we could not read.
    const backup = `${STORE_FILE}.corrupt`;
    try {
      fs.renameSync(STORE_FILE, backup);
      console.error(`deployment store unreadable (${err.message}); moved it to ${backup}`);
    } catch {
      console.error(`deployment store unreadable (${err.message})`);
    }
    return [];
  }

  return records
    .filter(dep => dep && dep.deploymentId)
    .map(dep => [dep.deploymentId, IN_FLIGHT.has(dep.status) ? { ...dep, interrupted: true } : dep]);
}

const deployments = new Map(load());

function persist() {
  const tmp = `${STORE_FILE}.tmp`;
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    // Write then rename, so a crash mid-write cannot leave a half-written store.
    fs.writeFileSync(tmp, JSON.stringify([...deployments.values()], null, 2));
    fs.renameSync(tmp, STORE_FILE);
  } catch (err) {
    // The deployment itself is unaffected; only the record of it failed to save.
    console.error(`could not write ${STORE_FILE}: ${err.message}`);
  }
}

export function putDeployment(dep) {
  deployments.set(dep.deploymentId, dep);
  persist();
  return dep;
}

export function getDeployment(id) {
  return deployments.get(id);
}

/** Every known deployment, newest first. */
export function listDeployments() {
  return [...deployments.values()].sort((a, b) =>
    String(b.startedAt || "").localeCompare(String(a.startedAt || ""))
  );
}

/** How many deployments the store is holding. Reading it is what /health checks. */
export function count() {
  return deployments.size;
}

export const storeFile = STORE_FILE;
