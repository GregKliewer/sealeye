// api/logs.js
// An app's recent log lines (PHASE2-PLAN Step 16), for `sealeye logs` and the portal's
// Logs card: what its function wrote, newest first, over a window the reader chooses.
//
// Logs are the developer's own output and may hold anything, so every line passes
// through the same masking as traces (core/tracing.js) before it reaches either surface,
// and a line naming one of the app's stored settings has that value taken out as well
// (DESIGN.md, "Logs pass through the masking traces do"). Read only: nothing changes.
import { maskSecretText } from "../core/tracing.js";
import { recentLogs, listStoredSettings } from "./executor/cfn.js";
import { storeFolder } from "./executor/settings.js";
import { resourceNameOf } from "./executor/compose.js";
import { terraformProfile } from "./executor/terraform/tofu.js";
import { settingNamesFor } from "../core/setting-names.js";

export const WINDOWS = { "15m": 15, "1h": 60, "6h": 360, "1d": 1440 };
export const MAX_LINES = 200;

const REDACTED = "[value redacted]";
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * @param {object} record  any deployment of the environment that has a stack
 * @param {{ window?: string, now?: number, siblings?: object[] }} options  `siblings`:
 *        the environment's other records, for a Terraform environment whose newest
 *        record has no group of its own yet (a build under way, or one that failed)
 * @returns {Promise<{status: number, body: object}>}
 */
// A secret-looking name, as traces mask it: key, secret, token, password.
const SECRET_NAME = "[A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Za-z0-9_]*";

/**
 * Masking for one app: the patterns traces use, then NAME=value, NAME: value and the
 * JSON "NAME": value for every secret-looking name and every setting the app is known
 * to have. A quoted value goes to its closing quote; an unquoted one to the end of the
 * line, since a value can hold spaces and commas, and taking too much is the safe side.
 */
export function maskerFor(names = []) {
  const alternatives = [...new Set(names)].filter(Boolean).map(escape);
  const nameRe = alternatives.length ? `(?:${alternatives.join("|")}|${SECRET_NAME})` : SECRET_NAME;
  const pattern = new RegExp(`\\b(${nameRe})("?\\s*[=:]\\s*)("(?:[^"\\\\\\n]|\\\\.)*"|'[^'\\n]*'|[^\\n]*)`, "gi");
  // Names first, so a quoted value with escaped quotes in it goes whole; then the
  // patterns traces use, for what has no name beside it.
  return text => maskSecretText(String(text).replace(pattern, (_m, name, sep) => `${name}${sep}${REDACTED}`));
}

// How far back each read goes from now, widening until there are enough lines or the
// window is used up: CloudWatch reads forward from a start time, so starting near now is
// how the newest lines come back first.
const STEPS_MINUTES = [1, 5, 15, 60, 360, 1440];

export async function readLogs(record, { window = "1h", now = Date.now(), siblings = [] } = {}) {
  const minutes = WINDOWS[window];
  if (!minutes) return refusal(400, "INVALID_WINDOW", `since must be one of ${Object.keys(WINDOWS).join(", ")}`);
  if (record.kind === "static") {
    return refusal(409, "NO_LOGS", "A static site has no code of its own running, so it writes no logs. Its files are served as they are.");
  }
  if (record.status === "destroyed" || record.status === "destroying") {
    return refusal(409, "NO_LOGS", "This environment has been torn down, and its logs went with it.");
  }
  // An environment built from the organization's own module keeps its logs where that
  // module says (`LogGroup`, from the output discovery found; DESIGN.md, "A Terraform
  // environment's logs are read where its module says they are"), read through the
  // Terraform role. One whose module says nothing has nothing to read.
  const terraform = record.backend === "terraform";
  const terraformGroup = terraform ? environmentLogGroup(record, siblings) : null;
  if (terraform && !terraformGroup) return refusal(409, "NO_LOGS", noTerraformLogsWords(record));
  const fn = resourceNameOf(record);
  if (!record.stackName || (!terraform && !fn)) {
    return refusal(409, "NO_LOGS", "Nothing was built for this deployment, so there are no logs to read.");
  }

  const group = terraform ? terraformGroup : `/aws/lambda/${fn}`;
  const profile = terraform ? terraformProfile() : null;
  const windowStart = now - minutes * 60_000;
  let events = [];
  let until = now;
  let more = false;
  for (const step of [...STEPS_MINUTES.filter(m => m < minutes), minutes]) {
    const since = Math.max(windowStart, now - step * 60_000);
    if (since >= until) continue;
    const read = await recentLogs(group, { sinceMs: since, untilMs: until, profile });
    if (!read.ok && read.missing) {
      return { status: 200, body: { app: record.app?.name || null, since: window, lines: [], more: false, note: "Your app has not written anything yet: there is nothing to read until it has run." } };
    }
    if (!read.ok) return refusal(502, "LOGS_UNAVAILABLE", `The platform could not read your app's logs just now (${read.error}).`);
    // A read that filled up was cut short: its newest lines are the ones not read.
    if (read.events.length >= 2000) more = true;
    events = [...read.events, ...events];
    until = since;
    if (events.length >= MAX_LINES || since <= windowStart) {
      if (since > windowStart) more = true;
      break;
    }
  }
  if (events.length > MAX_LINES) more = true;

  // The names of the app's settings, whose values the API never reads: those in the
  // store, those its deploys were given from a .env, and those its plan asks for.
  let note;
  // Every setting the app reads by name: the starter's, and for an organization's module
  // the settings its parts reach the app under (terraform.settings), whose values are
  // the platform's ids and addresses.
  const names = new Set([...(record.settings || []).map(x => x.name), ...settingNamesFor(record.plan), ...Object.keys(record.terraform?.settings || {})]);
  // An app built from an organization's module reads no settings from the store, so
  // there is nothing there to mask by name.
  if (!terraform) try {
    const listed = await listStoredSettings(storeFolder({ team: record.teamId || "default", app: record.app?.name }));
    if (listed.ok) listed.settings.forEach(x => names.add(x.name));
    else note = "The platform could not read which settings are in your organization's store just now, so only values beside a secret-looking name, or a setting this app's deploys used, were taken out.";
  } catch { /* an app name the store cannot hold has no stored settings */ }
  const mask = maskerFor([...names]);

  return {
    status: 200,
    body: {
      app: record.app?.name || null,
      since: window,
      more,
      ...(note ? { note } : {}),
      lines: events.slice(-MAX_LINES).reverse().map(e => ({ at: new Date(e.timestamp).toISOString(), message: mask(e.message).replace(/\s+$/, "") }))
    }
  };
}

function refusal(status, code, message) {
  return { status, body: { error: { code, message } } };
}

/**
 * Where a Terraform environment's app logs are: the group on this record, or on the
 * newest of the environment's other records that has one (a record being built, or
 * one that failed, has none of its own yet, and the environment's group has not
 * moved). Null when no record of the environment has a group: the module said nothing.
 */
export function environmentLogGroup(record, siblings = []) {
  if (record?.outputs?.LogGroup) return record.outputs.LogGroup;
  const key = record?.stackName || record?.environment;
  if (!key) return null;
  const same = siblings
    .filter(d => d && d.deploymentId !== record.deploymentId && d.backend === "terraform" && (d.stackName || d.environment) === key && d.outputs?.LogGroup)
    .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
  return same[0]?.outputs?.LogGroup || null;
}

/**
 * Why a Terraform environment has no logs to read, in words that are true of this
 * record: the outputs, and so the group, are read back when a build ends, so a build
 * under way has none yet; a build that failed before the app ran wrote nothing; a group
 * the module named that is not the environment's own was not believed; and a module
 * that output no group has said nothing.
 */
export function noTerraformLogsWords(record) {
  const building = ["queued", "packaging", "running"].includes(record?.status);
  if (building) return "Your environment is still being built. Its logs can be read once it is up.";
  const notKept = record?.terraform?.logsNotKept;
  if (notKept && /not this environment's own/.test(notKept)) {
    return "The module your organization built this environment from named a place for your app's logs that is not this environment's own, so the platform did not believe it and read nothing. Ask your platform team.";
  }
  if (record?.status === "failed") return "This build did not get as far as a running app, so there is nothing of it to read.";
  return "The module your organization built this environment from does not say where your app's logs are kept, so the platform cannot read them. Ask your platform team.";
}
