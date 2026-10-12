// The platform's settings reader, put into the packaged app beside run.sh and loaded
// before the app with `node --import` (PHASE2-PLAN Step 10, D4). The developer's own
// files are never changed.
//
// When SEALEYE_SETTINGS_PATH names the app's folder in the organization's store
// (/sealeye-apps/<team>/<app>/), it reads every setting there in one signed request to
// Parameter Store and sets each as an environment variable, then the app starts. Without
// it, it does nothing.
//
// It signs the request itself (AWS Signature Version 4, with node:crypto) rather than
// loading the AWS SDK, because loading the SDK took most of a second at every cold start
// (DESIGN.md, "Settings live in the organization's store"). The function's own
// credentials, which Lambda puts in the environment, sign it; its role may read this
// folder and nothing else.
//
// It never prints, logs or returns a value. If the settings cannot be read, the app does
// not start: one line on stderr says why, by the error's name, and the process exits.
// An app that started without its settings would look healthy and behave wrongly.
import crypto from "node:crypto";

const FOLDER = /^\/sealeye-apps\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*\/$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Names the platform or the runtime owns. The same rule as reservedName in
// core/settings.js, which refuses them when they are put in (test/settings-reader.test.js
// checks the two agree).
const RESERVED = /^(PORT|NODE_OPTIONS|AWS_.*|LAMBDA_.*|_.*|SEALEYE_.*)$/;

const TIMEOUT_MS = 5000;
const ATTEMPTS = 2;
const MAX_PAGES = 20;
const RETRY_AFTER_MS = 300;

const hmac = (key, text) => crypto.createHmac("sha256", key).update(text, "utf8").digest();
const sha256 = text => crypto.createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The headers for one signed Parameter Store request (Signature Version 4). Exported so
 * test/settings-reader.test.js can check it against AWS's own signer.
 */
export function signedHeaders({ region, credentials, target, body, now = new Date() }) {
  const host = `ssm.${region}.amazonaws.com`;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const headers = {
    "content-type": "application/x-amz-json-1.1",
    host,
    "x-amz-date": amzDate,
    ...(credentials.sessionToken ? { "x-amz-security-token": credentials.sessionToken } : {}),
    "x-amz-target": target
  };
  const names = Object.keys(headers).sort();
  const canonical = [
    "POST",
    "/",
    "",
    ...names.map(n => `${n}:${String(headers[n]).trim()}`),
    "",
    names.join(";"),
    sha256(body)
  ].join("\n");
  const scope = `${day}/${region}/ssm/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  let key = hmac(`AWS4${credentials.secretAccessKey}`, day);
  for (const part of [region, "ssm", "aws4_request"]) key = hmac(key, part);
  const signature = crypto.createHmac("sha256", key).update(toSign, "utf8").digest("hex");
  const { host: _host, ...sent } = headers;
  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`
  };
}

class Unreadable extends Error {}

/** One page of the folder, with a retry for a dropped connection, throttling or a 5xx. */
async function page(path, nextToken, region, credentials) {
  const body = JSON.stringify({ Path: path, WithDecryption: true, ...(nextToken ? { NextToken: nextToken } : {}) });
  let lastReason = "no answer";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (attempt > 1) await new Promise(r => setTimeout(r, RETRY_AFTER_MS));
    let res;
    try {
      res = await fetch(`https://ssm.${region}.amazonaws.com/`, {
        method: "POST",
        headers: signedHeaders({ region, credentials, target: "AmazonSSM.GetParametersByPath", body }),
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch (err) {
      lastReason = err?.name === "TimeoutError" ? "no answer within five seconds" : "the store could not be reached";
      continue;
    }
    const answer = await res.json().catch(() => null);
    // An answer that is not the store's starts nothing rather than an app with none.
    if (res.ok) {
      if (!answer || typeof answer !== "object") throw new Unreadable("the store's answer could not be read");
      return answer;
    }
    // Only the error's name: an AWS message can quote what it was given.
    const type = String(answer?.__type || "").split("#").pop() || `status ${res.status}`;
    lastReason = type;
    if (res.status < 500 && type !== "ThrottlingException") break;
  }
  throw new Unreadable(lastReason);
}

/**
 * Read the folder and set its settings in `env`. Returns the names it set; never values.
 * @returns {Promise<string[]>}
 */
export async function loadSettings({ path, env = process.env }) {
  if (!FOLDER.test(path)) throw new Unreadable(`SEALEYE_SETTINGS_PATH is not an app's settings folder`);
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION;
  const credentials = { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN };
  if (!region || !credentials.accessKeyId || !credentials.secretAccessKey) {
    throw new Unreadable("the function's credentials are not in its environment");
  }

  const found = new Map();
  let nextToken;
  for (let n = 0; n < MAX_PAGES; n++) {
    const answer = await page(path, nextToken, region, credentials);
    for (const p of answer.Parameters || []) {
      const name = String(p.Name || "").slice(path.length);
      if (NAME.test(name) && !RESERVED.test(name) && typeof p.Value === "string") found.set(name, p.Value);
    }
    nextToken = answer.NextToken;
    if (!nextToken) break;
  }
  // Starting with some of its settings is starting without the rest.
  if (nextToken) throw new Unreadable("the app has more settings than the reader takes");
  for (const [name, value] of found) env[name] = value;
  return [...found.keys()];
}

const path = process.env.SEALEYE_SETTINGS_PATH;
if (path) {
  try {
    await loadSettings({ path });
  } catch (err) {
    const reason = err instanceof Unreadable ? err.message : err?.name || "an unexpected error";
    process.stderr.write(`seaLeye could not read this app's settings from the organization's store (${reason}), so the app was not started.\n`);
    process.exit(1);
  }
}
