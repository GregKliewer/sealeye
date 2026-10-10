// core/settings.js
// Which settings a plan asks the platform to pass to the app, by name. The CLI and the
// API both need the same answer: the CLI to know which values to send with a deploy,
// the API to know which values to accept (DESIGN.md, "Setting values travel with the
// deploy, for now").
import path from "node:path";

import { readEnvFile } from "./config.js";

// The platform decides the port and tells the app what it is, so it is never a setting
// the plan gets to pass.
export const PLATFORM_OWNED = new Set(["PORT"]);
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The setting names the plan's config_basic module asks for, minus the platform's own. */
export function settingNamesFor(plan) {
  const module = (plan?.modules || []).find(m => m && m.enabled !== false && m.id === "config_basic");
  return Object.keys(module?.inputs?.variables || {}).filter(name => !PLATFORM_OWNED.has(name));
}

/**
 * The values the developer's .env holds for the settings the plan asks for, and only
 * those. Read on the developer's machine and sent once with the deploy request; never
 * printed, never written anywhere.
 *
 * @returns {Record<string, string>}
 */
export function envValuesFor(plan, appPath) {
  const names = settingNamesFor(plan);
  if (!names.length || !appPath) return {};
  const fromFile = readEnvFile(path.join(appPath, ".env"));
  const out = {};
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(fromFile, name)) out[name] = String(fromFile[name]);
  }
  return out;
}
