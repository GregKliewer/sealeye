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

// ---------------------------------------------------------------------------------
// The front door's and a module's own lines (DESIGN.md, "The front door's and the
// database's lines, beside the app's"): every line from those places is the platform's,
// so each is read, and the line itself is kept beside the words as an app line's is.

/** Where a line came from, in the developer's words: the app, the front door, or a module. */
export function fromWords(from) {
  if (!from || from === "app") return "your app";
  if (from === "door") return "the front door";
  return String(from);
}

const pathOf = r => `${r.method || "?"} ${r.path || "/"}`;
const known = v => v !== undefined && v !== null && v !== "" && v !== "-";

/**
 * The front door's record of one request (the JSON the library's http-api module writes:
 * method, path, status, latency, integrationStatus, integrationError, error), or null
 * when the line is not one.
 */
export function doorLine(message) {
  let r;
  try { r = JSON.parse(String(message || "")); } catch { return null; }
  if (!r || typeof r !== "object" || !known(r.status)) return null;
  const status = Number(r.status);
  const took = known(r.latency) ? timeWords(Number(r.latency)) : null;
  const reached = known(r.integrationStatus);
  const why = known(r.integrationError) ? r.integrationError : known(r.error) ? r.error : null;
  const call = pathOf(r);
  if (status === 429) return { kind: "door-throttled", words: `The front door turned away ${call}: too many requests at once (${status})` };
  if (status === 504) return { kind: "door-timeout", words: `${call} got ${status}: your app did not answer within the time the front door waits` };
  if (status >= 500 && !reached) return { kind: "door-error", words: `${call} got ${status}: the front door could not reach your app${why ? ` (${why})` : ""}` };
  if (status >= 500 && why && Number(r.integrationStatus) < 500) return { kind: "door-error", words: `${call} got ${status}: the front door could not read your app's answer (${why})` };
  if (status >= 400 && !reached) return { kind: "door-refused", words: `The front door refused ${call} with ${status} before it reached your app${why ? ` (${why})` : ""}` };
  return { kind: status >= 400 ? "door-app-error" : "door-request", words: `${call} answered ${status}${took ? ` in ${took}` : ""}` };
}

// A database line's level and text, as the database writes it:
// "2026-10-22 12:00:00 UTC:10.0.1.5(41234):notes_app@notes:[812]:FATAL:  PAM authentication failed for user ..."
const LEVEL = /:(FATAL|ERROR|PANIC|WARNING|LOG|DETAIL|HINT|STATEMENT):\s+(.*)$/;

/** A database's own line, or one of its refused sign-ins, read for the developer; null when not one it knows. */
export function databaseLine(message) {
  const line = String(message || "").trim();
  if (!line) return null;
  // Its record of sign-ins with an app's own identity that it refused.
  if (/token is malformed/i.test(line)) return { kind: "sign-in-refused", words: "The database could not read the sign-in your app sent" };
  if (/token age is longer than/i.test(line)) return { kind: "sign-in-refused", words: "Your app signed in with an old sign-in: make a new one for each connection" };
  if (/Failed to authorize .*IAM policy/i.test(line)) return { kind: "sign-in-refused", words: "Your app is not allowed to sign in to the database as that user" };
  if (/authentication throttling/i.test(line)) return { kind: "sign-in-refused", words: "Too many sign-ins at once: the database turned some away" };
  if (/internal IAM DB authentication error/i.test(line)) return { kind: "sign-in-refused", words: "The platform could not check your app's sign-in just then" };

  const m = line.match(LEVEL);
  if (!m) return null;
  const [, level, text] = m;
  if (/PAM authentication failed/i.test(text)) return { kind: "sign-in-refused", words: "The database refused your app's sign-in" };
  if (/password authentication failed/i.test(text)) return { kind: "sign-in-refused", words: "The database refused a sign-in with a password" };
  if (/no pg_hba\.conf entry/i.test(text)) return { kind: "sign-in-refused", words: "The database refused a connection it does not accept from there" };
  if (/database ".*" does not exist/i.test(text)) return { kind: "query-error", words: "Your app asked for a database that does not exist" };
  if (/relation ".*" does not exist/i.test(text)) return { kind: "query-error", words: "A query named a table that does not exist" };
  if (/permission denied/i.test(text)) return { kind: "query-error", words: "Your app's user may not do that in the database" };
  if (/deadlock detected/i.test(text)) return { kind: "query-error", words: "Two queries were waiting on each other, so the database stopped one" };
  if (/too many connections|remaining connection slots/i.test(text)) return { kind: "connections", words: "The database has no room for another connection" };
  if (/duplicate key value/i.test(text)) return { kind: "query-error", words: "A query would have written a value that must be unique twice" };
  if (/syntax error/i.test(text)) return { kind: "query-error", words: "The database could not read a query" };
  if (level === "STATEMENT") return { kind: "statement", words: "The query that failed" };
  if (level === "ERROR") return { kind: "query-error", words: "The database refused a query" };
  if (level === "FATAL" || level === "PANIC") return { kind: "connection-ended", words: "The database ended a connection" };
  return null;
}

/** A line read for the developer, by where it came from; null for an app's own line. */
export function readLine(from, message) {
  if (!from || from === "app") return platformLine(message);
  if (from === "door") return doorLine(message);
  return databaseLine(message);
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
    "Your app threw an error it did not catch",
    "your app", "the front door",
    "The front door turned away GET /notes: too many requests at once (429)",
    "GET /notes got 504: your app did not answer within the time the front door waits",
    "GET /notes got 502: the front door could not reach your app",
    "GET /notes got 502: the front door could not read your app's answer",
    "The front door refused GET /missing with 404 before it reached your app",
    "GET /notes answered 200 in 74 ms",
    "The database could not read the sign-in your app sent",
    "Your app signed in with an old sign-in: make a new one for each connection",
    "Your app is not allowed to sign in to the database as that user",
    "Too many sign-ins at once: the database turned some away",
    "The platform could not check your app's sign-in just then",
    "The database refused your app's sign-in",
    "The database refused a sign-in with a password",
    "The database refused a connection it does not accept from there",
    "Your app asked for a database that does not exist",
    "A query named a table that does not exist",
    "Your app's user may not do that in the database",
    "Two queries were waiting on each other, so the database stopped one",
    "The database has no room for another connection",
    "A query would have written a value that must be unique twice",
    "The database could not read a query",
    "The query that failed",
    "The database refused a query",
    "The database ended a connection"
  ];
}
