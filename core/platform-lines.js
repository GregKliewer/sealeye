// core/platform-lines.js
// What the platform saw (DESIGN.md, "What the platform saw, in the developer's words"):
// the lines the platform itself writes into an app's logs, beside the app's own, read
// for the developer. Each is said as what it means for the app and whose choice it was,
// and the platform's own line is kept beside the words, so nothing is hidden and
// nothing has to be decoded. A fixed phrasebook, never a model: both surfaces say the
// same words, and a test can pin them.
//
// Runs in a browser too: nothing here imports a node: module or a package.

/** A number of milliseconds, said as a developer would: "74 ms", "1.2 s", "3 seconds". */
export function timeWords(ms, { whole = false } = {}) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  if (whole) return `${Math.round(n / 1000)} ${Math.round(n / 1000) === 1 ? "second" : "seconds"}`;
  if (n < 1000) return `${Math.round(n)} ms`;
  const s = n / 1000;
  return `${s < 10 ? s.toFixed(1).replace(/\.0$/, "") : Math.round(s)} s`;
}

// The fields of a REPORT line, as the platform writes them: "Duration: 74.18 ms",
// "Status: timeout", "Error Type: Runtime.OutOfMemory".
function fields(line) {
  const out = {};
  for (const m of line.matchAll(/([A-Z][A-Za-z ]+?):\s+([^\t]+?)(?=\t|$)/g)) out[m[1].trim()] = m[2].trim();
  return out;
}
const ms = text => (text ? Number(String(text).replace(/\s*ms$/, "")) : NaN);

const TIME_LIMIT = "the limit the platform gives each request";

/**
 * The platform's reading of one log line, or null for a line the app wrote itself.
 * @returns {{ kind: string, words: string } | null}
 */
export function platformLine(message) {
  const line = String(message || "").trim();
  if (!line) return null;

  if (/^INIT_START\b/.test(line)) return { kind: "cold-start", words: "The platform started a fresh copy of your app" };

  if (/^INIT_REPORT\b/.test(line)) {
    const f = fields(line);
    if (/timeout/i.test(f.Status || "")) return { kind: "start-timeout", words: "Your app did not start within the time the platform gives it" };
    if (/error/i.test(f.Status || "")) return { kind: "start-error", words: "Your app crashed while starting" };
    const took = timeWords(ms(f["Init Duration"]));
    return { kind: "started", words: took ? `Your app started, ready in ${took}` : "Your app started" };
  }

  if (/^START RequestId:/.test(line)) return { kind: "request-start", words: "The platform handed your app a request" };
  if (/^END RequestId:/.test(line)) return { kind: "request-end", words: "Your app finished with that request" };

  if (/^REPORT RequestId:/.test(line)) {
    const f = fields(line);
    const took = timeWords(ms(f.Duration));
    const init = timeWords(ms(f["Init Duration"]));
    if (/timeout/i.test(f.Status || "")) {
      return { kind: "timeout", words: `Ran out of time after ${timeWords(ms(f.Duration), { whole: true }) || "the limit"}, ${TIME_LIMIT}` };
    }
    if (/OutOfMemory/i.test(f["Error Type"] || "")) return { kind: "out-of-memory", words: "Stopped for using more memory than the platform gives it" };
    if (/error/i.test(f.Status || "")) return { kind: "request-error", words: `This request ended in an error${f["Error Type"] ? ` (${f["Error Type"]})` : ""}` };
    if (init) return { kind: "request-cold", words: `Started cold and ready in ${init}; this request then took ${took || "a moment"}` };
    return { kind: "request", words: took ? `This request took ${took}` : "This request finished" };
  }

  const timedOut = line.match(/Task timed out after ([\d.]+) seconds/);
  if (timedOut) return { kind: "timeout", words: `Ran out of time after ${timeWords(Number(timedOut[1]) * 1000, { whole: true })}, ${TIME_LIMIT}` };

  if (/Runtime\.OutOfMemory|signal: killed/.test(line)) return { kind: "out-of-memory", words: "Stopped for using more memory than the platform gives it" };
  if (/Runtime exited without providing a reason|Runtime\.ExitError/.test(line)) return { kind: "exited", words: "Your app exited on its own, without a reason the platform could read" };
  if (/Unhandled Promise Rejection|Uncaught Exception/i.test(line)) return { kind: "uncaught", words: "Your app threw an error it did not catch" };

  return null;
}

/** Every phrase the phrasebook can say, for the word check in the tests. */
export function allPlatformWords() {
  return [
    "The platform started a fresh copy of your app",
    "Your app did not start within the time the platform gives it",
    "Your app crashed while starting",
    "Your app started, ready in 1.2 s",
    "The platform handed your app a request",
    "Your app finished with that request",
    `Ran out of time after 3 seconds, ${TIME_LIMIT}`,
    "Stopped for using more memory than the platform gives it",
    "This request ended in an error (Runtime.ExitError)",
    "Started cold and ready in 473 ms; this request then took 74 ms",
    "This request took 74 ms",
    "Your app exited on its own, without a reason the platform could read",
    "Your app threw an error it did not catch"
  ];
}
