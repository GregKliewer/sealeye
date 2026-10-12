// api/logs.js
// An app's recent log lines (PHASE2-PLAN Step 16), for `sealeye logs` and the portal's
// Logs card: what its function wrote, newest first, over a window the reader chooses.
//
// Logs are the developer's own output and may hold anything, so every line passes
// through the same masking as traces (core/tracing.js) before it reaches either surface,
// and a line naming one of the app's stored settings has that value taken out as well
// (DESIGN.md, "Logs pass through the masking traces do"). Read only: nothing changes.
import { maskSecrets } from "../core/tracing.js";
import { recentLogs, listStoredSettings } from "./executor/cfn.js";
import { storeFolder } from "./executor/settings.js";
import { resourceNameOf } from "./executor/compose.js";

export const WINDOWS = { "15m": 15, "1h": 60, "6h": 360, "1d": 1440 };
export const MAX_LINES = 200;

const REDACTED = "[value redacted]";
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * @param {object} record  any deployment of the environment that has a stack
 * @param {{ window?: string, now?: number }} options
 * @returns {Promise<{status: number, body: object}>}
 */
export async function readLogs(record, { window = "1h", now = Date.now() } = {}) {
  const minutes = WINDOWS[window];
  if (!minutes) return refusal(400, "INVALID_WINDOW", `since must be one of ${Object.keys(WINDOWS).join(", ")}`);
  if (record.kind === "static") {
    return refusal(409, "NO_LOGS", "A static site has no code of its own running, so it writes no logs. Its files are served as they are.");
  }
  const fn = resourceNameOf(record);
  if (!record.stackName || !fn) {
    return refusal(409, "NO_LOGS", "Nothing was built for this deployment, so there are no logs to read.");
  }

  const read = await recentLogs(`/aws/lambda/${fn}`, { sinceMs: now - minutes * 60_000 });
  if (!read.ok && read.missing) {
    return { status: 200, body: { app: record.app?.name || null, since: window, lines: [], more: false, note: "Your app has not written anything yet: there is nothing to read until it has run." } };
  }
  if (!read.ok) return refusal(502, "LOGS_UNAVAILABLE", `The platform could not read your app's logs just now (${read.error}).`);

  // The values of the app's own stored settings are never read, so a line that names
  // one has whatever follows the name taken out.
  let names = [];
  try {
    const listed = await listStoredSettings(storeFolder({ team: record.teamId || "default", app: record.app?.name }));
    if (listed.ok) names = listed.settings.map(x => x.name);
  } catch { /* an app name the store cannot hold has no stored settings */ }
  const byName = names.length ? new RegExp(`\\b(${names.map(escape).join("|")})(\\s*[=:]\\s*)("[^"\\n]*"|'[^'\\n]*'|[^\\s"',;]+)`, "g") : null;
  const mask = text => {
    const masked = maskSecrets(String(text));
    return byName ? masked.replace(byName, (_m, name, sep) => `${name}${sep}${REDACTED}`) : masked;
  };

  const events = read.events.slice(-MAX_LINES).reverse();
  return {
    status: 200,
    body: {
      app: record.app?.name || null,
      since: window,
      more: read.events.length > MAX_LINES,
      lines: events.map(e => ({ at: new Date(e.timestamp).toISOString(), message: mask(e.message).replace(/\s+$/, "") }))
    }
  };
}

function refusal(status, code, message) {
  return { status, body: { error: { code, message } } };
}
