// api/executor/settings.js
// Where an app's setting values come from: the one place that decides (DESIGN.md,
// "Setting values travel with the deploy, for now"). When values move to the
// organization's secret store (ROADMAP, Phase 1 work item 10), that is a new source
// here, and the rest of the executor does not change.
//
// Sources, first match wins:
//   "store" the organization's store (PHASE2-PLAN Part B): the app reads it itself when
//           it starts, so it has no value here and none is passed to the template
//   "sent"  the developer's .env, read by the CLI and sent with this deploy request
//   ".env"  the .env in the app folder, read here; only when the API shares the
//           developer's machine (the local API), and kept so older clients still work
//   "plan"  the placeholder the interview wrote into the plan
//
// Values are used for this deployment's parameters and dropped. A deployment record
// keeps each setting's name and source, never its value.
import path from "node:path";

import { readEnvFile } from "../../core/config.js";
import { safeName } from "../../core/names.js";
import { ENV_NAME, RESERVED_NAME, settingNamesFor } from "../../core/settings.js";

const MAX_VALUE_LENGTH = 4096;

/**
 * Where one team's app keeps its settings in the organization's store (PHASE2-PLAN D3):
 * /sealeye-apps/<team>/<app>/, one entry per setting, named as the app reads it. Its
 * function may read this folder and no other (Step 10). Never /sealeye/, which holds
 * the platform's own keys.
 */
export function storeFolder({ team = "default", app }) {
  const appName = safeName(app);
  const teamName = safeName(team);
  if (!appName || !teamName) throw new Error("a settings folder needs a team and an app name");
  if (appName.length > 100) throw new Error("an app's name is at most 100 characters for its settings to be stored");
  return `/sealeye-apps/${teamName}/${appName}/`;
}

/** Whether a name can be a setting the platform stores: an environment variable's, not one the platform or the runtime owns. */
export function storableName(name) {
  return typeof name === "string" && name.length <= 128 && ENV_NAME.test(name) && !RESERVED_NAME.test(name);
}

/** The largest value the store keeps (Parameter Store's standard tier: 4 KB). */
export const MAX_STORED_BYTES = 4096;

/**
 * @param {object} plan
 * @param {object} [options]
 * @param {Record<string, string>} [options.sent]  values sent with the deploy request
 * @param {string} [options.appPath]               the app folder, when the API can read it
 * @returns {{name: string, value: string, source: "sent"|".env"|"plan"}[]}
 */
export function settingValues(plan, { sent = {}, appPath, stored = [] } = {}) {
  const inStore = new Set(stored);
  const module = (plan?.modules || []).find(m => m && m.enabled !== false && m.id === "config_basic");
  const placeholders = module?.inputs?.variables || {};
  const fromFolder = appPath ? readEnvFile(path.join(appPath, ".env")) : {};
  const has = (obj, name) => Object.prototype.hasOwnProperty.call(obj, name);

  return settingNamesFor(plan).map(name => {
    if (!ENV_NAME.test(name)) {
      throw new Error(`config_basic asks for a setting called "${name}", which is not a name an environment variable can have`);
    }
    if (inStore.has(name)) return { name, value: null, source: "store" };
    if (has(sent, name)) return { name, value: String(sent[name]), source: "sent" };
    if (has(fromFolder, name)) return { name, value: String(fromFolder[name]), source: ".env" };
    return { name, value: String(placeholders[name] ?? ""), source: "plan" };
  });
}

/**
 * The values a deploy request may carry: strings, for settings this plan asks for,
 * within a sane length. Anything else is dropped, not stored, not echoed back.
 */
export function acceptSent(plan, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const wanted = new Set(settingNamesFor(plan));
  const out = {};
  for (const [name, value] of Object.entries(body)) {
    if (wanted.has(name) && typeof value === "string" && value.length <= MAX_VALUE_LENGTH) out[name] = value;
  }
  return out;
}

/** Where a setting's value came from, in words, for the report and the evidence. */
export function sourceInWords(source, { forDeveloper = false } = {}) {
  if (source === "store") return forDeveloper ? "your organization's settings store, read when the app starts" : "the organization's settings store, read by the app when it starts";
  if (source === "sent") return forDeveloper ? "the `.env` in your folder" : "the .env in the folder, sent with the deploy request";
  if (source === ".env") return forDeveloper ? "the `.env` in your folder" : "the .env in the folder";
  return forDeveloper ? "your plan" : "the plan";
}
