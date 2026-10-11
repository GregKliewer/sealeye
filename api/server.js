import express from "express";
import crypto from "crypto";
import fs from "node:fs";
import path from "node:path";

import { upgradePlan } from "../core/schema.js";
import { checkPlan, checkUpgraded } from "./validate.js";
import { backendMappings } from "./mappings.js";
import { putDeployment, getDeployment, listDeployments, storeFile, count, openStore, flushStore } from "./store.js";
import { startDeployment, startDestroy } from "./executor/index.js";
import { sharedWithAnotherTeam } from "./executor/compose.js";
import { acceptSent } from "./executor/settings.js";
import { removeUpload, stageUpload, sweepUploads } from "./executor/uploads.js";
import { resumeInFlight } from "./executor/resume.js";
import { unsupportedNeeds } from "../core/catalog.js";
import { assembleEvidence, renderEvidence } from "./executor/evidence.js";
import { rollupNeeds } from "./needs.js";
import { createInterviewService, NotWaiting, UploadRefused } from "./interview/service.js";
import { postgresCheckpointer, postgresInterviewStore } from "./interview/pgstore.js";
import { databaseUrl, closeDb } from "./db.js";
import { startTracing } from "../core/tracing.js";
import { authMode, callerFor, callerForSession, endSession, SESSION_COOKIE, SESSION_HOURS, startSession } from "./tokens.js";
import { loadCatalog, needKinds, orgName } from "../core/catalog.js";

const app = express();

// An interview's upload is the app folder, zipped and sent as base64, so that one route
// takes a larger body than the rest (core/upload.js caps what it may unpack to).
const smallJson = express.json({ limit: "1mb" });
const uploadJson = express.json({ limit: "40mb" });
// A deploy upload is the whole app the packager will stage (core/upload.js "deploy").
const deployJson = express.json({ limit: "150mb" });
// Who is calling (PHASE1-PLAN Step 13, api/tokens.js). Checked before a body is read,
// so a request without a token never gets to upload anything. GET /health stays open:
// it is how a person, or a load balancer, knows the API is up.
const AUTH = authMode();
const refuse = (res, code, message) =>
  res.status(401).set("WWW-Authenticate", 'Bearer realm="seaLeye"').json({ error: { code, message } });

// The portal's session cookie (PHASE1-PLAN Step 14), read without a cookie library.
// More than one cookie of the name is refused rather than one picked: a browser sends
// two only when something other than the portal set one.
function cookieValue(req, name) {
  const found = [];
  for (const part of String(req.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) found.push(part.slice(i + 1).trim());
  }
  return found.length === 1 ? found[0] : found.length ? "" : null;
}

// HttpOnly so no script on the page can read it, Secure so it never travels in clear,
// SameSite=Strict so no other site's page can make the browser send it.
const sessionCookie = (value, maxAgeSeconds) =>
  `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;

// A change made with the portal's cookie must also carry this header. A page on another
// site cannot add a custom header to a request here without the API agreeing first,
// which it never does, so a request carrying it came from the portal itself.
const PORTAL_HEADER = "x-sealeye-portal";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

app.use(async (req, res, next) => {
  if ((req.method === "GET" || req.method === "HEAD") && req.path === "/health") return next();
  // Signing in and out are how a browser gets and drops a session; each checks its own way.
  if (req.path === "/sessions" && (req.method === "POST" || req.method === "DELETE")) return next();
  if (AUTH === "off") {
    req.caller = null;
    req.surface = req.get(PORTAL_HEADER) ? "portal" : "cli";
    return next();
  }

  const bearer = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") || "");
  const session = bearer ? null : cookieValue(req, SESSION_COOKIE);
  if (!bearer && session === null) {
    return refuse(res, "NOT_SIGNED_IN", "This platform needs to know who is calling. Run sealeye login with the token your platform team gave you.");
  }
  if (session && !SAFE_METHODS.has(req.method) && req.get(PORTAL_HEADER) !== "1") {
    return res.status(403).json({ error: { code: "NOT_FROM_THE_PORTAL", message: "A change made with the portal's sign-in must come from the portal itself." } });
  }

  let caller;
  try {
    caller = bearer ? await callerFor(bearer[1]) : await callerForSession(session);
  } catch (err) {
    return res.status(503).json({ error: { code: "SIGN_IN_UNAVAILABLE", message: `The platform could not check your sign-in just now: ${err.message}` } });
  }
  if (!caller) {
    return bearer
      ? refuse(res, "TOKEN_REFUSED", "The platform does not accept this token: it is not one it issued, or it has been revoked. Ask your platform team for a new one, then run sealeye login.")
      : refuse(res, "SESSION_ENDED", "Your sign-in has ended. Sign in again with your token.");
  }
  req.caller = caller;
  req.surface = bearer ? "cli" : "portal";
  return next();
});

// Records belong to an organization and a team (DESIGN.md, "Each team sees its own
// environments"). A caller sees their own team's, or with an organization-wide token
// every team's in their organization; never another organization's. Anything else
// answers "not found", as another person's interview does, so a record's existence is
// not given away. A laptop API with no tokens (SEALEYE_AUTH=off) has one person and sees
// everything.
const orgOf = dep => dep?.orgId || "default";
const teamOf = dep => dep?.teamId || "default";
const inOrg = (req, dep) => Boolean(dep) && (!req.caller || orgOf(dep) === req.caller.org);
const canSee = (req, dep) =>
  inOrg(req, dep) && (!req.caller || req.caller.scope === "org" || teamOf(dep) === req.caller.team);
const visibleDeployments = req => listDeployments().filter(dep => canSee(req, dep));
// The needs ledger is the platform team's view of what drafted plans across the
// organization wait on. It names apps and needs, never people, and it stays
// organization-wide on purpose: do not narrow it to visibleDeployments. Another team's
// evidence and deployment ids are left out of it (rollupNeeds).
const orgDeployments = req => listDeployments().filter(dep => inOrg(req, dep));

app.use((req, res, next) => {
  if (req.method === "POST" && req.path === "/interviews") return uploadJson(req, res, next);
  if (req.method === "POST" && req.path === "/deployments") return deployJson(req, res, next);
  return smallJson(req, res, next);
});

// The interviews this process holds (api/interview/service.js), created once the store
// is open. The model key and any LangFuse keys are the API's own; developers hold
// neither.
let interviews;

// The version comes from the package, not from a literal, so it cannot drift from what
// was actually shipped.
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// GET /health
// Answering at all proves Express is listening. The count proves the deployment store
// was read as well, which is the half that actually matters when somebody asks how
// their SRE would know this thing is up.
app.get("/health", (_req, res) => {
  return res.status(200).json({ ok: true, version: pkg.version, deployments: count() });
});

// POST /sessions: the portal's sign-in. Body: { token }. The token is checked and
// traded for a session cookie good for SESSION_HOURS; the token itself is not kept by
// the browser. The response says who signed in and when the session ends.
app.post("/sessions", async (req, res) => {
  // From the portal only, like every other change made for a browser: so a page on
  // another site can never sign a browser in as someone else.
  if (req.get(PORTAL_HEADER) !== "1") {
    return res.status(403).json({ error: { code: "NOT_FROM_THE_PORTAL", message: "Signing in to the portal must come from the portal itself." } });
  }
  if (AUTH === "off") return res.status(200).json({ auth: "off" });
  let caller;
  try {
    caller = await callerFor(req.body?.token);
  } catch (err) {
    return res.status(503).json({ error: { code: "SIGN_IN_UNAVAILABLE", message: `The platform could not check your token just now: ${err.message}` } });
  }
  if (!caller) {
    return refuse(res, "TOKEN_REFUSED", "The platform does not accept this token: it is not one it issued, or it has been revoked. Ask your platform team for a new one.");
  }
  const { value, expiresAt } = await startSession(caller);
  res.set("Set-Cookie", sessionCookie(value, SESSION_HOURS * 3600));
  const { email, name, org, team, scope } = caller;
  return res.status(201).json({ email, name, org, team, scope, expiresAt });
});

// DELETE /sessions: the portal's "Sign out". Ends the session and clears the cookie.
app.delete("/sessions", async (req, res) => {
  if (req.get(PORTAL_HEADER) !== "1") {
    return res.status(403).json({ error: { code: "NOT_FROM_THE_PORTAL", message: "Signing out of the portal must come from the portal itself." } });
  }
  await endSession(cookieValue(req, SESSION_COOKIE)).catch(() => {});
  res.set("Set-Cookie", sessionCookie("", 0));
  return res.status(200).json({ signedOut: true });
});

// GET /catalog: what the platform can build, and the fixed list of needs it cannot yet,
// in the catalog's own words (prompts/module-catalog.yaml).
app.get("/catalog", (_req, res) => {
  const catalog = loadCatalog();
  return res.status(200).json({
    catalogVersion: catalog.catalogVersion,
    modules: (catalog.modules || []).map(m => ({
      id: m.id,
      availability: m.availability,
      role: m.role,
      line: String(m.line || "").trim(),
      shortLine: String(m.short_line || "").trim() || null
    })),
    needs: needKinds(catalog).map(n => ({ kind: n.key, line: String(n.line || "").trim() }))
  });
});

// GET /whoami: who the token belongs to. `sealeye login` checks a token with it.
app.get("/whoami", (req, res) => {
  if (!req.caller) return res.status(200).json({ auth: "off", surface: req.surface });
  const { email, name, org, team, scope, tokenId } = req.caller;
  return res.status(200).json({ email, name, org, team, scope, tokenId, surface: req.surface, organizationName: orgName() });
});

// POST /plans/validate
app.post("/plans/validate", (req, res) => {
  // A plan written against an older contract is read as what it meant, then checked.
  return res.status(200).json(checkPlan(req.body));
});

// POST /deployments
app.post("/deployments", (req, res) => {
  const { backend, appPath, zip } = req.body || {};
  const plan = upgradePlan(req.body?.plan);

  // Who asked and how the plan came to be, for the change record. The person is the
  // token's (req.caller), checked by the platform; the machine and how the plan came to
  // be are as the command line reported them. With no token (a laptop API with
  // SEALEYE_AUTH=off), all of it is as the command line sent it, unverified, and said
  // to be so wherever it is read.
  const claimed = req.body?.requestedBy && typeof req.body.requestedBy === "object" ? req.body.requestedBy : undefined;
  const requestedBy = req.caller
    ? { user: req.caller.email, name: req.caller.name, host: typeof claimed?.host === "string" ? claimed.host : null, verified: "token" }
    : claimed;
  const origin = req.body?.origin && typeof req.body.origin === "object" ? req.body.origin : undefined;
  const planSha256 = plan ? crypto.createHash("sha256").update(JSON.stringify(plan), "utf8").digest("hex") : undefined;
  const provenance = {
    ...(req.caller ? { orgId: req.caller.org, teamId: req.caller.team, tokenId: req.caller.tokenId } : {}),
    surface: req.surface || "cli",
    ...(requestedBy ? { requestedBy } : {}),
    ...(origin ? { origin } : {}),
    ...(planSha256 ? { planSha256 } : {})
  };

  if (!backend || !["cloudformation"].includes(backend)) {
    return res.status(400).json({
      error: { code: "INVALID_BACKEND", message: "backend must be cloudformation" }
    });
  }
  if (!plan) {
    return res.status(400).json({
      error: { code: "MISSING_PLAN", message: "plan is required" }
    });
  }
  // The app arrives one of two ways. With `zip`, it is an uploaded copy (DESIGN.md,
  // "Deployments package an uploaded copy"), and `appPath` is only the developer's own
  // name for their folder, kept on the record so the CLI can recognise its app again;
  // the API never reads it. Without `zip`, `appPath` is a folder on the API's own
  // machine, as before, for the local API and older clients.
  const uploaded = typeof zip === "string" && zip.length > 0;
  if (zip !== undefined && !uploaded) {
    return res.status(400).json({ error: { code: "INVALID_UPLOAD", message: "zip must be the app folder, zipped, as base64" } });
  }

  let resolvedAppPath = null;
  if (uploaded) {
    resolvedAppPath = typeof appPath === "string" && appPath ? appPath : null;
  } else {
    if (!appPath || typeof appPath !== "string") {
      return res.status(400).json({
        error: { code: "MISSING_APP_PATH", message: "appPath is required" }
      });
    }

    // Absolute only: the API does not share the developer's working directory, so a
    // relative path would silently resolve against the server's cwd.
    if (!path.isAbsolute(appPath)) {
      return res.status(400).json({
        error: { code: "INVALID_APP_PATH", message: "appPath must be an absolute path" }
      });
    }

    // Checked once, here, so a bad path fails now instead of halfway through packaging.
    resolvedAppPath = path.resolve(appPath);
    if (!fs.existsSync(resolvedAppPath) || !fs.statSync(resolvedAppPath).isDirectory()) {
      return res.status(400).json({
        error: { code: "INVALID_APP_PATH", message: `appPath is not a directory: ${resolvedAppPath}` }
      });
    }
  }

  const checked = checkUpgraded(plan);
  if (!checked.valid) {
    return res.status(400).json({
      error: {
        code: "INVALID_PLAN",
        message: "plan failed validation",
        details: checked.errors
      }
    });
  }

  // Enabled modules and the template each one maps to (null for the modules that
  // contribute parameters rather than a template of their own).
  const mapping = backendMappings[backend];
  const resolvedModules = (plan.modules || [])
    .filter(m => m.enabled !== false)
    .map(m => ({
      id: m.id,
      mappedTo: mapping[m.id] || null
    }));

  const deploymentId = `dep_${crypto.randomBytes(6).toString("hex")}`;

  // A plan can be valid and still ask for a module this version does not build. Nothing
  // is created in AWS, and the record is still written: what a developer asked for is
  // part of the history of their app, and a plan that was refused is a thing they
  // should be able to find again.
  //
  // A profile is not a reason to refuse. Whatever the plan is designed for, this run
  // builds a dev environment, and a dev environment is built from the standard modules.
  // The patterns a prod or dev profile asks for are what the pipeline applies to the
  // environments it builds later, and they are recorded in the plan for it.
  const needs = unsupportedNeeds(plan);

  if (needs.length) {
    const drafted = putDeployment({
      deploymentId,
      status: "drafted",
      backend,
      planVersion: plan.planVersion,
      app: plan.app,
      appPath: resolvedAppPath,
      resolvedModules,
      plan,
      needs,
      ...provenance,
      outputs: {},
      failureReason: null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString()
    });

    return res.status(422).json({
      error: {
        code: "UNSUPPORTED_NEEDS",
        message: "this app needs things no module in the catalog supports yet",
        details: { needs, deploymentId: drafted.deploymentId }
      }
    });
  }

  // An uploaded copy is unpacked now, so a bad upload is a 400 and never a queued
  // deployment that fails later.
  let packageFrom = resolvedAppPath;
  if (uploaded) {
    try {
      packageFrom = stageUpload(Buffer.from(zip, "base64"), deploymentId);
    } catch (err) {
      if (err instanceof UploadRefused) {
        return res.status(400).json({ error: { code: "UPLOAD_REFUSED", message: err.message } });
      }
      throw err;
    }
  }

  const record = putDeployment({
    deploymentId,
    status: "queued",
    source: uploaded ? "upload" : "folder",
    backend,
    planVersion: plan.planVersion,
    app: plan.app,
    appPath: resolvedAppPath,
    resolvedModules,
    // The whole plan, so a later run can say what it is about to change. Additive:
    // records written before this exist without it and are read as before.
    plan,
    ...provenance,
    outputs: {},
    failureReason: null,
    startedAt: new Date().toISOString(),
    finishedAt: null
  });

  // Runs to completion in the background against real CloudFormation; the record is
  // mutated in place, so GET /deployments/:id always reads the live state.
  // Setting values sent with the request (DESIGN.md, "Setting values travel with the
  // deploy, for now"): only for settings this plan asks for, handed to this deployment
  // and never put on the record, in a response or in a log.
  const sent = acceptSent(plan, req.body?.settings);

  startDeployment(record, plan, packageFrom, sent)
    .catch(err => {
      record.status = "failed";
      record.failureReason = err.message;
      record.finishedAt = new Date().toISOString();
      putDeployment(record);
    })
    // The uploaded copy goes once the deployment has reached a final status.
    .finally(() => { if (uploaded) removeUpload(deploymentId); });

  return res.status(201).json({ ...record });
});

// GET /deployments — summary of every known deployment, newest first. Additive; the
// three existing endpoints are unchanged. The full record stays at /deployments/{id},
// so the rendered report is not repeated for every row.
app.get("/deployments", (req, res) => {
  const deployments = visibleDeployments(req).map(dep => ({
    deploymentId: dep.deploymentId,
    app: dep.app,
    status: dep.status,
    outputs: dep.outputs || {},
    stackName: dep.stackName || null,
    startedAt: dep.startedAt || null,
    finishedAt: dep.finishedAt || null,
    failureReason: dep.failureReason || null,
    interrupted: dep.interrupted === true,
    kind: dep.kind || null,
    profile: dep.plan?.profile || null,
    requestedBy: dep.requestedBy || null,
    surface: dep.surface || "cli",
    // Whose environment it is. A team only ever sees its own; an organization-wide
    // token sees several, and two of them can share an app name.
    teamId: dep.teamId || "default",
    destroyRequestedBy: dep.destroyRequestedBy || null,
    needs: Array.isArray(dep.needs) ? dep.needs.length : 0
  }));

  return res.status(200).json({ deployments });
});

// GET /deployments/{deploymentId}
app.get("/deployments/:deploymentId", (req, res) => {
  const dep = getDeployment(req.params.deploymentId);
  if (!canSee(req, dep)) {
    return res.status(404).json({
      error: { code: "NOT_FOUND", message: "deploymentId not found" }
    });
  }
  return res.status(200).json(dep);
});

// GET /deployments/{deploymentId}/evidence — the change record: the evidence object
// and its markdown. Reads the record and asks CloudFormation what it says now. Creates
// nothing and changes nothing; the one outbound request is a GET of the app's own URL.
app.get("/deployments/:deploymentId/evidence", async (req, res) => {
  const dep = getDeployment(req.params.deploymentId);
  if (!canSee(req, dep)) {
    return res.status(404).json({
      error: { code: "NOT_FOUND", message: "deploymentId not found" }
    });
  }

  try {
    const evidence = await assembleEvidence(dep);
    return res.status(200).json({ evidence, markdown: renderEvidence(evidence) });
  } catch (err) {
    return res.status(500).json({
      error: { code: "EVIDENCE_FAILED", message: err.message }
    });
  }
});

// GET /needs — what the drafted plans are waiting on, rolled up by need across apps.
// Store only; no AWS call.
app.get("/needs", (req, res) => {
  try {
    return res.status(200).json(rollupNeeds(orgDeployments(req), { viewer: req.caller }));
  } catch (err) {
    return res.status(500).json({ error: { code: "NEEDS_FAILED", message: err.message } });
  }
});

// DELETE /deployments/{deploymentId} — tears the environment down in the background.
// Returns straight away; the record carries the real progress.
app.delete("/deployments/:deploymentId", (req, res) => {
  const dep = getDeployment(req.params.deploymentId);
  if (!canSee(req, dep)) {
    return res.status(404).json({
      error: { code: "NOT_FOUND", message: "deploymentId not found" }
    });
  }

  // Already gone, or already on its way out: say so instead of starting a second
  // tear-down of the same stack.
  if (dep.status === "destroyed" || dep.status === "destroying") {
    return res.status(200).json(dep);
  }

  // A stack from before teams had names of their own can hold another team's records
  // too, and whoever deployed to it last is in it (DESIGN.md, "Each team's environments
  // have names of their own"). When that is another team, tearing it down would take
  // their environment with it, so only someone who can see both may: an
  // organization-wide token, and never another organization's.
  const occupant = listDeployments().find(r => r.stackName && r.stackName === dep.stackName);
  const theirs = sharedWithAnotherTeam(dep.stackName, { org: orgOf(dep), team: teamOf(dep), records: listDeployments() });
  if (req.caller && theirs && (req.caller.scope !== "org" || orgOf(occupant) !== req.caller.org)) {
    return res.status(409).json({
      error: {
        code: "SHARED_ENVIRONMENT",
        message: "Another team uses this environment too, from before each team's environments had names of their own, so tearing it down would take theirs with it. Ask your platform team to tear it down."
      }
    });
  }

  // Who asked for it, and from where: the command line or the portal.
  if (req.caller) {
    dep.destroyRequestedBy = { user: req.caller.email, name: req.caller.name, surface: req.surface, at: new Date().toISOString() };
  } else {
    dep.destroyRequestedBy = { surface: req.surface || "cli", at: new Date().toISOString() };
  }
  putDeployment(dep);

  startDestroy(dep).catch(err => {
    dep.status = "failed";
    dep.failureReason = err.message;
    putDeployment(dep);
  });

  return res.status(202).json({ ...dep });
});

// An interview is its starter's: their code and their answers. Someone else's token
// gets the same "not found" as an interview that does not exist.
const ownsInterview = (req, id) => {
  if (!req.caller) return true;
  const owner = interviews.ownerOf(id);
  return owner === null || owner === req.caller.email;
};

// POST /interviews: start an interview over an uploaded app folder.
// Body: { app, zip (base64), deployed?, user?, trace? }. The zip is made by the CLI's
// zipFolder (core/upload.js): no dependencies, no git, secret files as names only.
app.post("/interviews", (req, res) => {
  const { app: appName, zip, deployed, user, trace } = req.body || {};

  if (!interviews.ready()) {
    return res.status(503).json({
      error: { code: "NO_MODEL_KEY", message: "the seaLeye API has no model key set, so it cannot run an interview" }
    });
  }
  if (typeof zip !== "string" || !zip) {
    return res.status(400).json({ error: { code: "MISSING_UPLOAD", message: "zip is required: the app folder, zipped, as base64" } });
  }

  try {
    const started = interviews.startFromUpload({
      zip: Buffer.from(zip, "base64"),
      app: appName,
      deployed: deployed && typeof deployed === "object" ? upgradePlan(deployed) : null,
      // With a token, the person is the token's, not what the command line says.
      user: req.caller ? req.caller.email : (typeof user === "string" ? user : undefined),
      owner: req.caller ? req.caller.email : null,
      trace: trace !== false
    });
    return res.status(201).json(started);
  } catch (err) {
    if (err instanceof UploadRefused) {
      return res.status(400).json({ error: { code: "UPLOAD_REFUSED", message: err.message } });
    }
    return res.status(500).json({ error: { code: "INTERVIEW_FAILED", message: err.message } });
  }
});

// POST /interviews/{id}/answers: the developer's answer to what the interview is waiting
// on, a question or "Deploy this?". Body: { answer }. Any client may send it.
app.post("/interviews/:interviewId/answers", (req, res) => {
  if (!ownsInterview(req, req.params.interviewId)) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "interviewId not found" } });
  }
  const value = req.body?.answer;
  if (typeof value !== "string" && typeof value !== "boolean") {
    return res.status(400).json({ error: { code: "MISSING_ANSWER", message: "answer is required" } });
  }
  try {
    const result = interviews.answer(req.params.interviewId, value);
    if (!result) return res.status(404).json({ error: { code: "NOT_FOUND", message: "interviewId not found" } });
    return res.status(202).json(result);
  } catch (err) {
    if (err instanceof NotWaiting) {
      return res.status(409).json({ error: { code: "NOT_WAITING", message: "the interview is not waiting for an answer" } });
    }
    return res.status(500).json({ error: { code: "INTERVIEW_FAILED", message: err.message } });
  }
});

// DELETE /interviews/{id}: the developer left. The interview, its saved state and the
// uploaded copy of their app go now rather than after a day.
app.delete("/interviews/:interviewId", async (req, res) => {
  if (!ownsInterview(req, req.params.interviewId)) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "interviewId not found" } });
  }
  const removed = await interviews.remove(req.params.interviewId);
  if (!removed) return res.status(404).json({ error: { code: "NOT_FOUND", message: "interviewId not found" } });
  return res.status(200).json({ interviewId: req.params.interviewId, removed: true });
});

// GET /interviews/{id}/events: progress lines, questions, the plan and how it ended, as
// server-sent events. Every event so far is sent first, so a client that reconnects
// (with Last-Event-ID, or ?after=) misses nothing. The stream ends with the interview.
app.get("/interviews/:interviewId/events", (req, res) => {
  const after = Number(req.get("Last-Event-ID") ?? req.query.after ?? 0) || 0;
  const id = req.params.interviewId;
  if (!interviews.get(id) || !ownsInterview(req, id)) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "interviewId not found" } });
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  res.write(": seaLeye interview events\n\n");

  let closed = false;
  let unsubscribe = () => {};
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    unsubscribe();
    res.end();
  };

  // A comment line now and then keeps proxies from closing a stream that is waiting on
  // the developer.
  const keepAlive = setInterval(() => res.write(": still here\n\n"), 15_000);

  unsubscribe = interviews.subscribe(id, after, event => {
    if (closed) return;
    if (!event) return close();
    res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    if (event.type === "finished" || event.type === "failed") close();
  }) || (() => {});

  req.on("close", close);
});

const port = process.env.PORT || 3000;
startTracing();
sweepUploads();
// Records first: nothing is served until the store has everything it knew.
const opened = await openStore();
// Then whatever was in flight when the API last stopped is picked up again: deployments,
// and, with a database, interviews.
const resumed = resumeInFlight();
let interviewPersistence = null;
if (databaseUrl()) {
  interviewPersistence = postgresInterviewStore();
  interviews = createInterviewService({ checkpointer: await postgresCheckpointer(), persistence: interviewPersistence });
} else {
  interviews = createInterviewService();
}
const restoredInterviews = await interviews.restore();

// A stop (a release, a reboot) waits for the last record to be written.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    Promise.all([flushStore(), interviewPersistence?.flush()])
      .then(([unsavedIds]) => {
        if (unsavedIds?.length) console.error(`stopping with ${unsavedIds.length} deployment records not saved: ${unsavedIds.join(", ")}`);
        return closeDb();
      })
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

app.listen(port, () => {
  console.log(`seaLeye API listening on http://localhost:${port}`);
  if (opened.adopted) console.log(`deployment store: brought ${opened.adopted} records in from ${opened.from}`);
  for (const r of resumed) console.log(`${r.deploymentId}: ${r.as}`);
  for (const r of restoredInterviews) console.log(`${r.interviewId}: ${r.as}`);
  console.log(`deployment store: ${storeFile} (${listDeployments().length} records loaded${opened.migrations?.length ? `, applied ${opened.migrations.join(", ")}` : ""})`);
});