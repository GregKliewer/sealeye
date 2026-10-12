// api/performance.js
// How an app has been doing (PHASE2-PLAN Step 20): requests, errors, requests refused
// while it was paused, and the time its code took, over a window the reader chooses,
// read from CloudWatch when asked. These are readings of what happened. They are never
// a statement of what the app can take, which is "set by a load test" (principle 8;
// DESIGN.md, "Performance shows readings, not capacity").
import { functionMetrics } from "./executor/cfn.js";
import { resourceNameOf } from "./executor/compose.js";

export const PERF_WINDOWS = {
  "1h": { minutes: 60, periodSec: 300 },
  "6h": { minutes: 360, periodSec: 1800 },
  "1d": { minutes: 1440, periodSec: 3600 },
  "7d": { minutes: 10080, periodSec: 21600 }
};

const refusal = (status, code, message) => ({ status, body: { error: { code, message } } });
const round = (n, places = 0) => (n === null || n === undefined ? null : Number(n.toFixed(places)));

export async function readPerformance(record, { window = "1d", now = Date.now() } = {}) {
  const w = PERF_WINDOWS[window];
  if (!w) return refusal(400, "INVALID_WINDOW", `since must be one of ${Object.keys(PERF_WINDOWS).join(", ")}`);
  if (record.kind === "static") {
    return refusal(409, "NO_READINGS", "A static site is served straight from storage, with no code of its own running, so there is nothing of its own to measure.");
  }
  if (record.status === "destroyed" || record.status === "destroying") {
    return refusal(409, "NO_READINGS", "This environment has been torn down, so there is nothing running to measure.");
  }
  const fn = resourceNameOf(record);
  if (!fn) return refusal(409, "NO_READINGS", "Nothing was built for this deployment, so there is nothing to measure.");

  // Periods end on a whole period, so the bars line up with the clock.
  const endMs = Math.ceil(now / (w.periodSec * 1000)) * w.periodSec * 1000;
  const startMs = endMs - w.minutes * 60_000;
  const read = await functionMetrics(fn, { startMs, endMs, periodSec: w.periodSec });
  if (!read.ok) return refusal(502, "READINGS_UNAVAILABLE", `The platform could not read how your app has been doing (${read.error}).`);

  const byId = Object.fromEntries(read.results.map(r => [r.Id, r]));
  const at = id => {
    const m = new Map();
    const r = byId[id];
    (r?.Timestamps || []).forEach((t, i) => m.set(new Date(t).getTime(), r.Values[i]));
    return m;
  };
  const series = { requests: at("requests"), errors: at("errors"), refused: at("refused"), average: at("average"), slowest: at("slowest") };
  const periods = [];
  for (let t = startMs; t < endMs; t += w.periodSec * 1000) {
    periods.push({
      at: new Date(t).toISOString(),
      requests: series.requests.get(t) ?? 0,
      errors: series.errors.get(t) ?? 0,
      refused: series.refused.get(t) ?? 0,
      // No requests in a period means no time taken to measure: null, never 0.
      averageMs: round(series.average.get(t) ?? null),
      slowestMs: round(series.slowest.get(t) ?? null)
    });
  }
  const one = id => byId[id]?.Values?.[0] ?? null;
  const sum = id => (byId[id]?.Values || []).reduce((a, b) => a + b, 0);
  return {
    status: 200,
    body: {
      app: record.app?.name || null,
      since: window,
      from: new Date(startMs).toISOString(),
      to: new Date(endMs).toISOString(),
      periodMinutes: w.periodSec / 60,
      totals: {
        requests: sum("totalRequests"),
        errors: sum("totalErrors"),
        refused: sum("totalRefused"),
        averageMs: round(one("totalAverage")),
        slowestMs: round(one("totalSlowest"))
      },
      periods
    }
  };
}
