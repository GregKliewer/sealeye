// core/settings.js
// Which settings a plan asks the platform to pass to the app, by name. The CLI and the
// API both need the same answer: the CLI to know which values to send with a deploy,
// the API to know which values to accept (DESIGN.md, "Setting values travel with the
// deploy, for now").
import path from "node:path";

import { readEnvFile } from "./config.js";

export { ENV_NAME, PLATFORM_OWNED, RESERVED_NAME, settingNamesFor } from "./setting-names.js";
import { settingNamesFor } from "./setting-names.js";

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
