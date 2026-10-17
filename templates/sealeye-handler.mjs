// sealeye-handler.mjs: the adapter seaLeye puts into an app's package when the
// organization's module runs the app as a function the platform calls, and the app
// listens on a port (DESIGN.md, "An app that listens reaches a module that calls a
// function"). Never in the developer's folder: only in the packaged copy.
//
// It starts the app as the platform's start script does (run.sh, beside it), on a port
// of its own, while the function starts up, and hands it each request as an HTTP
// request, then the app's answer back. Requests come from an HTTPS address in front of
// the function (payload format 2.0). No packages: Node's own modules only.
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SEALEYE_APP_PORT) || 8080;
// How long the app may take to start answering. The function's own start-up may take
// ten seconds; a request waiting on a slow start waits within the function's time.
const READY_MS = Number(process.env.SEALEYE_READY_MS) || 9000;
const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection"]);

let app = null;
let exited = null;

function launch() {
  exited = null;
  app = spawn(path.join(here, "run.sh"), [], {
    cwd: here,
    env: { ...process.env, PORT: String(PORT) },
    stdio: "inherit"
  });
  // The function's runtime never waits for it to end; nor does anything else.
  app.unref();
  app.on("exit", (code, signal) => {
    exited = signal ? `it stopped (${signal})` : `it exited (${code})`;
    app = null;
  });
}

/** Stop the app, when the function is shut down (and in seaLeye's own tests). */
export function stop() {
  if (app) app.kill();
  app = null;
}

/** Whether something answers on the app's port now. */
const answers = () =>
  new Promise(resolve => {
    const req = http.request({ host: "127.0.0.1", port: PORT, method: "HEAD", path: "/", timeout: 500 }, res => {
      res.resume();
      resolve(true);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });

/** Start the app if it is not running, and wait until it answers. */
export async function ready() {
  if (!app) launch();
  const until = Date.now() + READY_MS;
  while (Date.now() < until) {
    if (await answers()) return;
    if (exited) throw new Error(`the app did not start: ${exited}`);
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`the app did not answer on port ${PORT} within ${READY_MS / 1000} s of starting`);
}

// Started while the function itself starts, so the first request does not wait for it.
const starting = ready().catch(err => err);

/** One request, from the function's event to the app and back. */
export async function forward(event) {
  const method = event?.requestContext?.http?.method || event?.httpMethod || "GET";
  const rawPath = event?.rawPath || event?.path || "/";
  const query = event?.rawQueryString ? `?${event.rawQueryString}` : "";
  const headers = { ...(event?.headers || {}) };
  if (Array.isArray(event?.cookies) && event.cookies.length) headers.cookie = event.cookies.join("; ");
  const body = event?.body ? Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8") : null;
  if (body) headers["content-length"] = String(body.length);
  for (const h of Object.keys(headers)) if (HOP.has(h.toLowerCase())) delete headers[h];

  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, method, path: `${rawPath}${query}`, headers }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        const out = {};
        const cookies = [];
        for (const [name, value] of Object.entries(res.headers)) {
          if (HOP.has(name)) continue;
          if (name === "set-cookie") cookies.push(...(Array.isArray(value) ? value : [value]));
          else out[name] = Array.isArray(value) ? value.join(", ") : String(value);
        }
        resolve({
          statusCode: res.statusCode || 502,
          headers: out,
          ...(cookies.length ? { cookies } : {}),
          body: Buffer.concat(chunks).toString("base64"),
          isBase64Encoded: true
        });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

export async function handler(event) {
  // A start that failed while the function started up is tried again here, once.
  const first = await starting;
  if (first instanceof Error || !app) await ready();
  try {
    return await forward(event);
  } catch (err) {
    // The app went away between requests: start it again, once, and try this one again.
    if (!app) {
      await ready();
      return forward(event);
    }
    throw err;
  }
}
