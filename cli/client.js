// cli/client.js
import fs from "fs";
import path from "node:path";
import YAML from "yaml";

import { zipFolder } from "../core/upload.js";

/**
 * The platform did not answer at all: wrong port, API not started, machine asleep.
 * This is the Day 3 `TypeError: fetch failed`, which says nothing a developer can act
 * on, so every call in this file turns it into one sentence naming the address.
 */
export class PlatformUnreachableError extends Error {
  constructor(apiBaseUrl, cause) {
    super(`seaLeye.run platform is not reachable at ${apiBaseUrl}`);
    this.name = "PlatformUnreachableError";
    this.userFacing = true;   // the CLI prints the sentence, not a stack
    this.cause = cause;
  }
}

/**
 * Every request to the platform goes through here, so an unreachable platform and an
 * API error are told apart in one place.
 */
async function platformFetch(apiBaseUrl, route, options = {}) {
  let res;

  try {
    res = await fetch(`${apiBaseUrl}${route}`, options);
  } catch (err) {
    throw new PlatformUnreachableError(apiBaseUrl, err);
  }

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(`seaLeye.run API error: ${res.status}`);
    err.details = body;
    throw err;
  }

  return body;
}

const asJson = payload => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload)
});

/**
 * Load a YAML plan file and return a JS object (plan).
 */
export function loadPlanFromYaml(planPath) {
  const yamlText = fs.readFileSync(planPath, "utf8");
  return YAML.parse(yamlText);
}

/**
 * Create a deployment by calling the seaLeye API.
 *
 * `requestedBy` and `origin` are optional and stored on the record exactly as sent. They
 * are what the change record reads later: who ran the command, on which machine, and
 * how the plan came to be. The API does not verify them; the evidence says so.
 */
export async function createDeployment({ apiBaseUrl, backend, plan, appPath, requestedBy, origin }) {
  const body = { backend, plan, appPath };
  if (requestedBy) body.requestedBy = requestedBy;
  if (origin) body.origin = origin;
  return platformFetch(apiBaseUrl, "/deployments", asJson(body));
}

/** The change record for one deployment: the evidence object and its markdown. */
export async function getEvidence({ apiBaseUrl, deploymentId }) {
  return platformFetch(apiBaseUrl, `/deployments/${deploymentId}/evidence`, { method: "GET" });
}

/** What the drafted plans are waiting on, rolled up across apps. */
export async function getNeeds({ apiBaseUrl }) {
  return platformFetch(apiBaseUrl, "/needs", { method: "GET" });
}

/**
 * Validate a plan by calling the seaLeye API.
 */
export async function validatePlan({ apiBaseUrl, plan }) {
  return platformFetch(apiBaseUrl, "/plans/validate", asJson(plan));
}

/**
 * List every deployment the platform knows about.
 */
export async function listDeployments({ apiBaseUrl }) {
  const body = await platformFetch(apiBaseUrl, "/deployments", { method: "GET" });
  return body.deployments || [];
}

/**
 * Ask the platform to tear a deployment down. Returns as soon as it has started.
 */
export async function destroyDeployment({ apiBaseUrl, deploymentId }) {
  return platformFetch(apiBaseUrl, `/deployments/${deploymentId}`, { method: "DELETE" });
}

export async function getDeployment({ apiBaseUrl, deploymentId }) {
  return platformFetch(apiBaseUrl, `/deployments/${deploymentId}`, { method: "GET" });
}

// ---------------------------------------------------------------------------------
// The interview, which runs in the API (DESIGN.md, "The interview runs as a LangGraph
// graph"). The CLI uploads the folder, streams what happens, and sends the answers.

/** An API refusal as the one sentence it carries, for the CLI to print. */
async function interviewFetch(apiBaseUrl, route, options) {
  try {
    return await platformFetch(apiBaseUrl, route, options);
  } catch (err) {
    const message = err?.details?.error?.message;
    if (message) {
      const sentence = new Error(`seaLeye.run could not run the interview: ${message}.`);
      sentence.userFacing = true;
      sentence.code = err.details.error.code;
      throw sentence;
    }
    throw err;
  }
}

/**
 * Upload the app folder and start an interview over it. Secret files travel as names
 * only (core/upload.js), so their contents never leave this machine.
 *
 * @returns {Promise<{interviewId, status, withheld: string[]}>}
 */
export async function startInterview({ apiBaseUrl, appPath, deployed, user, trace = true }) {
  let packed;
  try {
    packed = zipFolder(appPath);
  } catch (err) {
    if (err?.name === "UploadRefused" || err?.constructor?.name === "UploadRefused") err.userFacing = true;
    throw err;
  }

  const started = await interviewFetch(apiBaseUrl, "/interviews", asJson({
    app: path.basename(path.resolve(appPath)),
    zip: Buffer.from(packed.zip).toString("base64"),
    ...(deployed ? { deployed } : {}),
    ...(user ? { user } : {}),
    ...(trace ? {} : { trace: false })
  }));
  return { ...started, withheld: packed.withheld };
}

/** Drop an interview the developer has left, so the API keeps nothing of their app. */
export async function abandonInterview({ apiBaseUrl, interviewId }) {
  return platformFetch(apiBaseUrl, `/interviews/${interviewId}`, { method: "DELETE" });
}

/** The developer's answer to a question, or y/n to "Deploy this?". */
export async function answerInterview({ apiBaseUrl, interviewId, answer }) {
  return interviewFetch(apiBaseUrl, `/interviews/${interviewId}/answers`, asJson({ answer }));
}

/**
 * Follow an interview's events until it ends or `onEvent` returns "stop". Events are
 * handled one at a time, in order; `onEvent` may be async (a question waits for the
 * developer). A dropped stream is picked up again from the last event seen.
 *
 * @returns {Promise<object|null>} the event that ended the follow
 */
export async function followInterview({ apiBaseUrl, interviewId, onEvent, after = 0 }) {
  let last = after;
  let drops = 0;

  while (true) {
    let res;
    try {
      res = await fetch(`${apiBaseUrl}/interviews/${interviewId}/events`, {
        headers: { accept: "text/event-stream", "last-event-id": String(last) }
      });
    } catch (err) {
      if (++drops > 3) throw new PlatformUnreachableError(apiBaseUrl, err);
      await new Promise(r => setTimeout(r, 500 * drops));
      continue;
    }

    if (res.status === 404) {
      const gone = new Error("The platform no longer has this interview. Run sealeye run again.");
      gone.userFacing = true;
      throw gone;
    }
    if (!res.ok || !res.body) {
      const err = new Error(`The platform could not stream the interview (it answered ${res.status}). Run sealeye run again.`);
      err.userFacing = true;
      throw err;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let cut;
        while ((cut = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const data = block.split("\n").filter(l => l.startsWith("data: ")).map(l => l.slice(6)).join("\n");
          if (!data) continue;
          const event = JSON.parse(data);
          if (event.seq <= last) continue;
          last = event.seq;
          drops = 0;

          let verdict;
          try {
            verdict = await onEvent(event);
          } catch (err) {
            // The handler's own failure is the caller's, not a dropped stream.
            throw Object.assign(err instanceof Error ? err : new Error(String(err)), { fromHandler: true });
          }
          if (verdict === "stop" || event.type === "finished" || event.type === "failed") {
            try { await res.body.cancel(); } catch {}
            return { ...event, lastSeq: last };
          }
        }
      }
    } catch (err) {
      if (err?.fromHandler || err?.userFacing) throw err;
    }
    // The stream ended without the interview ending: pick it up again, a little later
    // each time, so a proxy that keeps closing it is not hammered.
    if (++drops > 5) throw new PlatformUnreachableError(apiBaseUrl, new Error("the event stream kept closing"));
    await new Promise(r => setTimeout(r, 250 * drops));
  }
}
