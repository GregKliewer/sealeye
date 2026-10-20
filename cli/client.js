// cli/client.js
import fs from "fs";
import path from "node:path";
import YAML from "yaml";

import { envValuesFor } from "../core/settings.js";
import { setting } from "../core/config.js";
import { loadCatalog, STARTER_VERSION } from "../core/catalog.js";
import { zipFolder, UploadRefused } from "../core/upload.js";

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

/** The developer's token (`sealeye login`), on every request but the health check. */
export function authHeaders(token = setting("TOKEN")) {
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * The platform asked who is calling (401). Its own sentence says what to do, and it is
 * the developer's to act on, so it is printed as it is.
 */
export class NotSignedInError extends Error {
  constructor(body) {
    super(body?.error?.message || "This platform needs to know who is calling. Run sealeye login with the token your platform team gave you.");
    this.name = "NotSignedInError";
    this.code = body?.error?.code || "NOT_SIGNED_IN";
    this.userFacing = true;
  }
}

/**
 * Every request to the platform goes through here, so an unreachable platform, a
 * refused token and an API error are told apart in one place.
 */
async function platformFetch(apiBaseUrl, route, { token, ...options } = {}) {
  let res;

  try {
    res = await fetch(`${apiBaseUrl}${route}`, { ...options, headers: { ...authHeaders(token), ...(options.headers || {}) } });
  } catch (err) {
    throw new PlatformUnreachableError(apiBaseUrl, err);
  }

  const body = await res.json().catch(() => ({}));

  if (res.status === 401) throw new NotSignedInError(body);

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
export async function createDeployment({ apiBaseUrl, backend, plan, appPath, requestedBy, origin, storedNames = [] }) {
  // The app travels as an uploaded copy, packaged by the API as it would package the
  // folder (core/upload.js "deploy": no node_modules, .git or .env). appPath goes with
  // it as the developer's own name for their folder, so their next run recognises the
  // environment; the API never reads it.
  let packed;
  try {
    packed = await zipFolder(appPath, { purpose: "deploy" });
  } catch (err) {
    // Too big, or code that looks like it holds a secret (SecretsFound): the sentence
    // is the developer's to act on, so it is shown as it is.
    if (err instanceof UploadRefused) err.userFacing = true;
    throw err;
  }
  const body = { backend, plan, appPath, zip: Buffer.from(packed.zip).toString("base64") };
  // The values of the settings this plan asks for, from the developer's .env, and only
  // those, less the ones already in the organization's store, which the app reads itself
  // when it starts (DESIGN.md, "Settings live in the organization's store"). A hosted API
  // cannot read this folder, so the rest travel with the request, once.
  const skip = new Set(storedNames);
  const settings = Object.fromEntries(Object.entries(envValuesFor(plan, appPath)).filter(([name]) => !skip.has(name)));
  if (Object.keys(settings).length) body.settings = settings;
  // The names the command left out because the store has them, so the platform can stop
  // rather than start the app without them if its store does not.
  if (storedNames.length) body.expectStored = [...storedNames];
  if (requestedBy) body.requestedBy = requestedBy;
  if (origin) body.origin = origin;
  return platformFetch(apiBaseUrl, "/deployments", asJson(body));
}

/**
 * Deploy the code an earlier deployment packaged, again (POST /deployments with
 * fromDeployment). Nothing is uploaded and no setting values are sent: the platform
 * reads every setting from the organization's store.
 */
export async function deployAgain({ apiBaseUrl, fromDeployment, plan, file }) {
  const body = { backend: "cloudformation", fromDeployment };
  if (plan !== undefined) body.plan = plan;
  if (file) body.origin = { file };
  return platformFetch(apiBaseUrl, "/deployments", asJson(body));
}

/** An environment's recent log lines, newest first, masked (PHASE2-PLAN Step 16). */
export async function getLogs({ apiBaseUrl, deploymentId, since = "1h" }) {
  return platformFetch(apiBaseUrl, `/deployments/${encodeURIComponent(deploymentId)}/logs?since=${encodeURIComponent(since)}`, { method: "GET" });
}

/** Your interviews still open, on either surface. */
export async function listInterviews({ apiBaseUrl }) {
  return (await platformFetch(apiBaseUrl, "/interviews", { method: "GET" })).interviews || [];
}

/** Pause or resume an environment's API (PHASE2-PLAN Step 17); the answer is read back from AWS. */
export async function setPaused({ apiBaseUrl, deploymentId, paused }) {
  return platformFetch(apiBaseUrl, `/deployments/${encodeURIComponent(deploymentId)}/${paused ? "pause" : "resume"}`, { method: "POST" });
}

/** Readings of an environment's API over a window (PHASE2-PLAN Step 20). */
export async function getPerformance({ apiBaseUrl, deploymentId, since = "1d" }) {
  return platformFetch(apiBaseUrl, `/deployments/${encodeURIComponent(deploymentId)}/performance?since=${encodeURIComponent(since)}`, { method: "GET" });
}

/** What each of your team's apps has cost, by tag (PHASE2-PLAN Step 20). */
export async function getCosts({ apiBaseUrl, since = "30d" }) {
  return platformFetch(apiBaseUrl, `/costs?since=${encodeURIComponent(since)}`, { method: "GET" });
}

/** The people on your team, from the tokens in use (PHASE2-PLAN Step 19). */
export async function getTeam({ apiBaseUrl }) {
  return platformFetch(apiBaseUrl, "/team", { method: "GET" });
}

/** The change record for one deployment: the evidence object and its markdown. */
export async function getEvidence({ apiBaseUrl, deploymentId }) {
  return platformFetch(apiBaseUrl, `/deployments/${deploymentId}/evidence`, { method: "GET" });
}

/** The plan a deployment was approved with, as its two files, and its report. */
export async function getPlan({ apiBaseUrl, deploymentId }) {
  return platformFetch(apiBaseUrl, `/deployments/${deploymentId}/plan`, { method: "GET" });
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
 * only (core/upload.js), and so does any file the scanner finds a secret in
 * (core/scan.js), so their contents never leave this machine. The findings go with the
 * upload, file, line and rule only, so the API can say why those files are empty.
 *
 * @returns {Promise<{interviewId, status, withheld: string[], findings: object[]}>}
 *          findings are this machine's and the API's together.
 */
export async function startInterview({ apiBaseUrl, appPath, deployed, user, trace = true }) {
  let packed;
  try {
    packed = await zipFolder(appPath);
  } catch (err) {
    if (err instanceof UploadRefused) err.userFacing = true;
    throw err;
  }

  const started = await interviewFetch(apiBaseUrl, "/interviews", asJson({
    app: path.basename(path.resolve(appPath)),
    zip: Buffer.from(packed.zip).toString("base64"),
    ...(packed.findings.length ? { findings: packed.findings.map(({ file, line, rule }) => ({ file, line, rule })) } : {}),
    ...(packed.unread?.length ? { unread: packed.unread } : {}),
    ...(deployed ? { deployed } : {}),
    ...(user ? { user } : {}),
    ...(trace ? {} : { trace: false })
  }));
  // An older API answers without findings of its own: what this machine found stands.
  return { ...started, withheld: packed.withheld, findings: Array.isArray(started.findings) ? started.findings : packed.findings };
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
  return followEvents({
    apiBaseUrl,
    route: `/interviews/${interviewId}/events`,
    onEvent,
    after,
    ends: ["finished", "failed"],
    gone: "The platform no longer has this interview. Run sealeye run again.",
    broken: status => `The platform could not stream the interview (it answered ${status}). Run sealeye run again.`
  });
}

/**
 * Follow a stream of server-sent events from the platform, picking it up again where
 * it left off when it drops, until an event of a type in `ends` arrives or the handler
 * returns "stop". Resolves with that last event and the last seq seen.
 */
async function followEvents({ apiBaseUrl, route, onEvent, after = 0, ends, gone, broken, over = async () => true }) {
  let last = after;
  let drops = 0;

  while (true) {
    let res;
    try {
      res = await fetch(`${apiBaseUrl}${route}`, {
        headers: { accept: "text/event-stream", "last-event-id": String(last), ...authHeaders() }
      });
    } catch (err) {
      if (++drops > 3) throw new PlatformUnreachableError(apiBaseUrl, err);
      await new Promise(r => setTimeout(r, 500 * drops));
      continue;
    }

    if (res.status === 401) throw new NotSignedInError(await res.json().catch(() => ({})));
    if (res.status === 404) throw Object.assign(new Error(gone), { userFacing: true });
    if (res.status === 403) {
      const body = await res.json().catch(() => ({}));
      throw Object.assign(new Error(body?.error?.message || broken(403)), { userFacing: true, code: body?.error?.code });
    }
    if (!res.ok || !res.body) throw Object.assign(new Error(broken(res.status)), { userFacing: true });

    const decoder = new TextDecoder();
    let buffer = "";
    let ended = false;
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
          if (verdict === "stop" || ends.includes(event.type)) {
            try { await res.body.cancel(); } catch {}
            return { ...event, lastSeq: last };
          }
        }
      }
      ended = true;
    } catch (err) {
      if (err?.fromHandler || err?.userFacing) throw err;
    }
    // A stream the platform closed on purpose with nothing more to say (a run that was
    // already over when it was asked): there is nothing to pick up again. A proxy or a
    // restart can close it cleanly too, so `over` asks whether the run really is.
    if (ended && ends.includes("closed") && await over()) return { type: "closed", lastSeq: last };
    // The stream ended without the run ending: pick it up again, a little later each
    // time, so a proxy that keeps closing it is not hammered.
    if (++drops > 5) throw new PlatformUnreachableError(apiBaseUrl, new Error("the event stream kept closing"));
    await new Promise(r => setTimeout(r, 250 * drops));
  }
}

// ---------------------------------------------------------------------------------
// Discovery (PHASE4-PLAN Step 6): a run over the organization's platform library, and
// the questions it asks. For an organization-wide token only; a refusal is the API's
// own sentence.

async function discoveryCall(apiBaseUrl, route, options) {
  try {
    return await platformFetch(apiBaseUrl, route, options);
  } catch (err) {
    const message = err.details?.error?.message;
    if (message) throw Object.assign(new Error(message), { userFacing: true, code: err.details.error.code, more: err.details.error.details });
    throw err;
  }
}

export const startDiscovery = ({ apiBaseUrl }) => discoveryCall(apiBaseUrl, "/discoveries", asJson({}));

// An organization's catalogs, the self-test, approving and making live (PHASE4-PLAN Step 7).
export const listCatalogs = ({ apiBaseUrl }) => discoveryCall(apiBaseUrl, "/catalogs", { method: "GET" });
export const catalogSelfTest = ({ apiBaseUrl, version }) =>
  discoveryCall(apiBaseUrl, `/catalogs/${encodeURIComponent(version)}/self-test`, { method: "GET" }).then(r => r.selfTest);
export const approveCatalogVersion = ({ apiBaseUrl, version }) => discoveryCall(apiBaseUrl, `/catalogs/${encodeURIComponent(version)}/approve`, asJson({}));
export const makeCatalogLive = ({ apiBaseUrl, version }) => discoveryCall(apiBaseUrl, `/catalogs/${encodeURIComponent(version)}/live`, asJson({}));
export const getCatalogVersion = ({ apiBaseUrl, version }) => discoveryCall(apiBaseUrl, `/catalogs/${encodeURIComponent(version)}`, { method: "GET" });
export const editCatalog = ({ apiBaseUrl, version, module, field, text }) =>
  discoveryCall(apiBaseUrl, `/catalogs/${encodeURIComponent(version)}/edits`, asJson({ module, field, text }));
export const listDiscoveries = ({ apiBaseUrl }) => discoveryCall(apiBaseUrl, "/discoveries", { method: "GET" }).then(r => r.discoveries);
export const getDiscovery = ({ apiBaseUrl, id }) => discoveryCall(apiBaseUrl, `/discoveries/${encodeURIComponent(id)}`, { method: "GET" });
export const answerDiscovery = ({ apiBaseUrl, id, question, answer }) =>
  discoveryCall(apiBaseUrl, `/discoveries/${encodeURIComponent(id)}/answers`, asJson({ question, answer })).then(r => r.question);

// An organization's platform values (PHASE4-PLAN Step 9): what only its platform team can
// give a module, by stage. An organization-wide token's only, as discovery is.
const stageQuery = stage => (stage ? `?stage=${encodeURIComponent(stage)}` : "");
export const getPlatform = ({ apiBaseUrl, stage }) => discoveryCall(apiBaseUrl, `/platform${stageQuery(stage)}`, { method: "GET" });
export const setPlatformValue = ({ apiBaseUrl, name, value, stage }) =>
  discoveryCall(apiBaseUrl, `/platform/values/${encodeURIComponent(name)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value, ...(stage ? { stage } : {}) }) }).then(r => r.value);
export const removePlatformValue = ({ apiBaseUrl, name, stage }) =>
  discoveryCall(apiBaseUrl, `/platform/values/${encodeURIComponent(name)}${stageQuery(stage)}`, { method: "DELETE" });

/** A run's events from `after`: every one so far, then each as it comes, until it ends. */
export function followDiscovery({ apiBaseUrl, id, onEvent, after = 0 }) {
  return followEvents({
    apiBaseUrl,
    route: `/discoveries/${encodeURIComponent(id)}/events`,
    onEvent,
    after,
    ends: ["finished", "stopped", "failed", "closed"],
    over: async () => (await getDiscovery({ apiBaseUrl, id }).catch(() => ({ status: "running" }))).status !== "running",
    gone: "The platform has no such discovery run.",
    broken: status => `The platform could not stream the discovery run (it answered ${status}).`
  });
}

/**
 * Who a token belongs to, as the platform says (GET /whoami). `token` defaults to the
 * one in ~/.sealeye/config; `sealeye login` passes the one being checked.
 */
// ---------------------------------------------------------------------------------
// An app's settings in the organization's store (PHASE2-PLAN Step 8). A value goes up
// once and never comes back: the list is names, whether each is set, and who changed
// it when. A refusal is one sentence, from the API.

const settingsRoute = (app, name, team) =>
  `/apps/${encodeURIComponent(app)}/settings${name ? `/${encodeURIComponent(name)}` : ""}${team ? `?team=${encodeURIComponent(team)}` : ""}`;

async function settingsCall(apiBaseUrl, route, options) {
  try {
    return await platformFetch(apiBaseUrl, route, options);
  } catch (err) {
    const message = err.details?.error?.message;
    if (message) throw Object.assign(new Error(message), { userFacing: true, code: err.details.error.code, more: err.details.error.details });
    throw err;
  }
}

export function getSettings({ apiBaseUrl, app, team }) {
  return settingsCall(apiBaseUrl, settingsRoute(app, null, team), { method: "GET" });
}

export function putSetting({ apiBaseUrl, app, name, value, team }) {
  return settingsCall(apiBaseUrl, settingsRoute(app, name, team), {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value })
  });
}

export function deleteSetting({ apiBaseUrl, app, name, team }) {
  return settingsCall(apiBaseUrl, settingsRoute(app, name, team), { method: "DELETE" });
}

export async function whoAmI({ apiBaseUrl, token }) {
  return platformFetch(apiBaseUrl, "/whoami", { token });
}

/**
 * What the platform can build, and the needs it cannot yet (GET /catalog): the
 * organization's live catalog, or with `version` the one a plan names.
 */
export async function getCatalog({ apiBaseUrl, version }) {
  return platformFetch(apiBaseUrl, version === undefined ? "/catalog" : `/catalog?version=${encodeURIComponent(version)}`);
}

/**
 * The catalog a plan was written against (planVersion 0.5), as the API serves it for
 * drawing the plan: the card and DEPLOYMENT_PLAN.md read it, so an organization's own
 * module reads the same in the terminal as in seaLeye.online. An API from before
 * Oct 15, 2026 sends no document, and only ever had the starter, which is the command's
 * own copy word for word.
 */
export async function catalogForPlan({ apiBaseUrl, plan }) {
  const version = plan?.catalog ?? STARTER_VERSION;
  const body = await getCatalog({ apiBaseUrl, version });
  if (body?.document && typeof body.document === "object") return body.document;
  if (version === STARTER_VERSION) return loadCatalog();
  throw new Error(`the platform did not send catalog ${version}, which this plan was written against`);
}
