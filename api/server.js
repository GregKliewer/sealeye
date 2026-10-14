import express from "express";
import crypto from "crypto";
import fs from "node:fs";
import path from "node:path";

import { isDrafted, upgradePlan } from "../core/schema.js";
import { checkPlan, checkUpgraded } from "./validate.js";
import { backendMappings } from "./mappings.js";
import { putDeployment, getDeployment, listDeployments, storeFile, count, openStore, flushStore } from "./store.js";
import { startDeployment, startDestroy } from "./executor/index.js";
import { entryPointFor, namingFor, sharedWithAnotherTeam } from "./executor/compose.js";
import { acceptSent, MAX_STORED_BYTES, storableName, storeFolder } from "./executor/settings.js";
import { deleteStoredSetting, listStoredSettings, putStoredSetting } from "./executor/cfn.js";
import { lastChanges, recordSettingChange } from "./setting-changes.js";
import { safeName } from "../core/names.js";
import { settingNamesFor } from "../core/settings.js";
import { removeUpload, stageUpload, sweepUploads } from "./executor/uploads.js";
import { resumeInFlight } from "./executor/resume.js";
import { unsupportedNeeds } from "../core/catalog.js";
import { assembleEvidence, renderEvidence } from "./executor/evidence.js";
import { rollupNeeds } from "./needs.js";
import { readLogs } from "./logs.js";
import { busyRefusal, changeUnderWay } from "./busy.js";
import { replacements } from "./replaced.js";
import { changePaused, pausedState } from "./pause.js";
import { peopleOf } from "./team.js";
import { readPerformance } from "./performance.js";
import { readCosts } from "./costs.js";
import { createInterviewService, NotWaiting, UploadRefused } from "./interview/service.js";
import { scanApp, ScanFailed } from "./secret-scan.js";
import { deployRefusalMessage } from "../core/scan.js";

// When the deeper check could not run, nothing that depended on it goes ahead.
const SCAN_FAILED_WORDS = "seaLeye.run could not finish checking your code for secrets, so nothing was sent on. Try again in a minute; if it keeps happening, tell your platform team.";
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
// Whether the plan meets the contract, and, when it does, whether it is ready or drafted
// (principle 3: a plan with needs is never just "valid"), with each need in the
// catalog's words and the evidence the plan gives for it. Added Oct 12, 2026; the
// valid and errors fields are unchanged.
app.post("/plans/validate", (req, res) => {
  // A plan written against an older contract is read as what it meant, then checked.
  const result = checkPlan(req.body);
  if (!result.valid) return res.status(200).json(result);
  const plan = upgradePlan(req.body);
  const lines = new Map(needKinds(loadCatalog()).map(n => [n.key, String(n.line || "").trim()]));
  const needs = (plan.needs || []).map(n => ({
    kind: n.kind,
    line: lines.get(n.kind) || n.line,
    evidence: (n.evidence || []).map(e => ({ file: e.file, shows: e.shows }))
  }));
  // From the needs themselves, never from a status the plan claims for itself.
  return res.status(200).json({ ...result, status: isDrafted(plan) ? "drafted" : "ready", needs });
});

// POST /deployments with fromDeployment (PHASE2-PLAN Step 14): deploy the code an
// earlier deployment of this app packaged, again, with the plan given or that
// deployment's own, and every setting from the organization's store. Nothing is
// uploaded. Added Oct 12, 2026; a request without fromDeployment is unchanged.
//
// It is refused, before any record is written, when it could not do what it says:
// - the earlier deployment is not this team's (an organization-wide token sees other
//   teams' environments, and changes only its own team's);
// - it is a static site, whose files are not kept after a deploy;
// - its code was never packaged, or the plan names another app or another entry point,
//   which would run code the plan does not describe;
// - a setting the earlier deployment was given from a developer's .env is not in the
//   store now: there is no .env here, and deploying without it would change the app.
async function deployAgain(req, res) {
  const refuse = (status, code, message) => res.status(status).json({ error: { code, message } });
  const { backend, fromDeployment } = req.body || {};
  if (!backend || backend !== "cloudformation") return refuse(400, "INVALID_BACKEND", "backend must be cloudformation");
  if (typeof fromDeployment !== "string" || !fromDeployment) return refuse(400, "INVALID_FROM_DEPLOYMENT", "fromDeployment must be a deployment id");
  if (req.body?.zip !== undefined || req.body?.appPath !== undefined) {
    return refuse(400, "INVALID_FROM_DEPLOYMENT", "fromDeployment deploys code the platform already has, so it takes no zip or appPath");
  }

  const source = getDeployment(fromDeployment);
  if (!canSee(req, source)) return refuse(404, "NOT_FOUND", "deploymentId not found");
  if (req.caller && teamOf(source) !== req.caller.team) {
    return refuse(403, "NOT_YOUR_TEAM", `${source.app?.name || "This app"} is team ${teamOf(source)}'s. Deploying it again is for that team.`);
  }
  if (source.kind === "static") {
    return refuse(409, "NOTHING_TO_DEPLOY_AGAIN", "A static site's files are not kept after it is deployed, so it cannot be deployed again from here. Run sealeye run in its folder.");
  }
  if (!source.artifactKey) {
    return refuse(409, "NOTHING_TO_DEPLOY_AGAIN", "That deployment never got as far as packaging its code, so there is nothing to deploy again. Choose one that did, or run sealeye run in the app's folder.");
  }

  const given = req.body?.plan !== undefined;
  const plan = upgradePlan(given ? req.body.plan : source.plan);
  if (!plan || typeof plan !== "object") return refuse(400, "MISSING_PLAN", "That deployment has no plan on record, so give one.");
  const checked = checkUpgraded(plan);
  if (!checked.valid) {
    return res.status(400).json({ error: { code: "INVALID_PLAN", message: "plan failed validation", details: checked.errors } });
  }
  if (safeName(plan.app?.name) !== safeName(source.app?.name)) {
    return refuse(409, "DIFFERENT_APP", `This plan is for ${plan.app?.name}, and that deployment's code is ${source.app?.name}'s.`);
  }
  if (unsupportedNeeds(plan).length) {
    return refuse(422, "UNSUPPORTED_NEEDS", "This plan is drafted: it needs what the platform does not build yet, so there is nothing to deploy again. Validate it to see what it needs.");
  }

  // One change at a time: the environment this goes to must not be changing now.
  {
    const target = namingFor({ app: plan.app.name, org: req.caller?.org || "default", team: req.caller?.team || "default", records: listDeployments() }).stackName;
    const busy = changeUnderWay(target);
    if (busy) return res.status(409).json(busyRefusal(busy));
  }

  if (!(plan.modules || []).some(m => m && m.enabled !== false && m.id === "http_api_serverless")) {
    return refuse(409, "DIFFERENT_APP", "That deployment's code is an API, and this plan does not describe one.");
  }
  const entryNow = entryPointFor(plan);
  const entryThen = source.plan ? entryPointFor(upgradePlan(source.plan)) : null;
  if (entryThen && entryNow !== entryThen) {
    return refuse(409, "DIFFERENT_ENTRY_POINT", `This plan starts the app with ${entryNow}, and that deployment's code was packaged to start with ${entryThen}. Run sealeye run in the app's folder to package it again.`);
  }

  // Settings: every one comes from the store, or was the plan's own placeholder before.
  const wanted = settingNamesFor(plan);
  let stored = [];
  if (wanted.length) {
    let folder;
    try {
      folder = storeFolder({ team: req.caller?.team || "default", app: plan.app.name });
    } catch (err) {
      return refuse(409, "SETTINGS_NOT_STORED", `${plan.app.name}'s settings cannot be in your organization's store (${err.message}), and there is no .env here. Run sealeye run in the app's folder.`);
    }
    const listed = await listStoredSettings(folder);
    if (!listed.ok) return refuse(503, "STORE_UNAVAILABLE", `The platform could not ask your organization's settings store which settings this app has (${listed.error}), so nothing was deployed.`);
    stored = listed.settings.map(x => x.name);
  }
  const before = new Map((source.settings || []).map(x => [x.name, x.source]));
  const missing = wanted.filter(name => !stored.includes(name) && before.get(name) !== "plan");
  if (missing.length) {
    return refuse(409, "SETTINGS_NOT_STORED", `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not in your organization's settings store, and there is no .env here to read ${missing.length === 1 ? "it" : "them"} from. Store ${missing.length === 1 ? "it" : "them"} in Settings, or run sealeye run in the app's folder.`);
  }

  const deploymentId = `dep_${crypto.randomBytes(6).toString("hex")}`;
  const requestedBy = req.caller ? { user: req.caller.email, name: req.caller.name, host: null, verified: "token" } : undefined;
  // How this deployment came to be, said by the platform rather than taken from the
  // request: only the name of a plan file comes from the command line.
  const claimedFile = typeof req.body?.origin?.file === "string" ? req.body.origin.file.slice(0, 200) : null;
  // The deployment that packaged the code, however many times it has been deployed again.
  const packagedBy = source.packagedBy || source.deploymentId;
  const origin = {
    command: req.surface === "portal" ? null : "deploy --again",
    planSource: "again",
    fromDeployment: source.deploymentId,
    packagedBy,
    planGiven: given,
    ...(given && claimedFile ? { file: claimedFile } : {})
  };
  // Which environment it goes to is known now, so the record says so from the start.
  const naming = namingFor({ app: plan.app.name, org: req.caller?.org || "default", team: req.caller?.team || "default", records: listDeployments() });
  // Asked again after the store was read: another change may have started while this
  // waited on it, and from here to putDeployment nothing waits, so nothing can slip in.
  {
    const busy = changeUnderWay(naming.stackName);
    if (busy) return res.status(409).json(busyRefusal(busy));
  }
  const record = putDeployment({
    deploymentId,
    status: "queued",
    source: "again",
    packagedBy,
    // The same code, so the same scan: what the deployment that packaged it found.
    ...(source.secretScan ? { secretScan: { ...source.secretScan, scannedBy: source.secretScan.scannedBy || packagedBy } } : {}),
    kind: "api",
    // The environment it is for, named from the start so a page following it sees it
    // at once. Not stackName: that is set only once the deployment has composed its
    // stack, and a record without one has nothing in AWS to tear down or describe.
    environment: naming.stackName,
    fromDeployment: source.deploymentId,
    backend,
    planVersion: plan.planVersion,
    app: plan.app,
    // No folder was read: the code is the earlier artifact (the report says so).
    appPath: null,
    resolvedModules: (plan.modules || []).filter(m => m.enabled !== false).map(m => ({ id: m.id, mappedTo: backendMappings[backend][m.id] || null })),
    plan,
    ...(req.caller ? { orgId: req.caller.org, teamId: req.caller.team, tokenId: req.caller.tokenId } : {}),
    surface: req.surface || "cli",
    ...(requestedBy ? { requestedBy } : {}),
    origin,
    planSha256: crypto.createHash("sha256").update(JSON.stringify(plan), "utf8").digest("hex"),
    // The code: the earlier deployment's artifact, as it is in S3, and its checksum.
    artifactKey: source.artifactKey,
    artifactSha256: source.artifactSha256 ?? null,
    ...(source.artifactSha256Error ? { artifactSha256Error: source.artifactSha256Error } : {}),
    // The executor refuses, rather than fall back to the plan's placeholder, if any of
    // these has left the store by the time it looks.
    expectStored: wanted.filter(name => stored.includes(name)),
    outputs: {},
    failureReason: null,
    startedAt: new Date().toISOString(),
    finishedAt: null
  });

  startDeployment(record, plan, null, {}).catch(err => {
    record.status = "failed";
    record.failureReason = err.message;
    record.finishedAt = new Date().toISOString();
    putDeployment(record);
  });
  return res.status(201).json({ ...record });
}

// POST /deployments
app.post("/deployments", (req, res, next) => {
  if (req.body?.fromDeployment !== undefined) return deployAgain(req, res).catch(next);
  return deployNew(req, res).catch(next);
});

async function deployNew(req, res) {
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

  // The code is scanned for secrets before anything is queued (PHASE3-PLAN Step 2, D4):
  // the shared rules again and gitleaks. A finding refuses the deploy, with the file,
  // the line and what to do; nothing is kept. The command and seaLeye.online ran the
  // same rules before sending, so this mostly catches what only gitleaks knows.
  let scan;
  try {
    scan = await scanApp(packageFrom, { purpose: "deploy" });
  } catch (err) {
    if (uploaded) removeUpload(deploymentId);
    if (err instanceof ScanFailed) return res.status(503).json({ error: { code: "SCAN_FAILED", message: SCAN_FAILED_WORDS } });
    throw err;
  }
  if (scan.found.length) {
    if (uploaded) removeUpload(deploymentId);
    return res.status(422).json({
      error: { code: "SECRETS_FOUND", message: deployRefusalMessage(scan.found), details: { findings: scan.found } }
    });
  }

  // One change at a time: the environment this goes to must not be changing now. (A
  // drafted plan changes nothing, so it was saved above whatever was under way.)
  // Checked after the scan, which waits, and right before the record is written, which
  // does not, so two deploys cannot both pass it.
  {
    const target = namingFor({ app: plan.app?.name, org: req.caller?.org || "default", team: req.caller?.team || "default", records: listDeployments() }).stackName;
    const busy = changeUnderWay(target);
    if (busy) {
      if (uploaded) removeUpload(deploymentId);
      return res.status(409).json(busyRefusal(busy));
    }
  }

  // Which environment it goes to is known now, so the record names it from the start
  // (environment) and a page following that environment sees it at once. stackName is
  // set by the executor once it composes the stack, as before.
  const naming = namingFor({ app: plan.app?.name, org: req.caller?.org || "default", team: req.caller?.team || "default", records: listDeployments() });
  const record = putDeployment({
    deploymentId,
    status: "queued",
    source: uploaded ? "upload" : "folder",
    environment: naming.stackName,
    backend,
    planVersion: plan.planVersion,
    app: plan.app,
    appPath: resolvedAppPath,
    resolvedModules,
    // The whole plan, so a later run can say what it is about to change. Additive:
    // records written before this exist without it and are read as before.
    plan,
    // What the secret scan let through on the developer's word (.sealeye-allow), and
    // whether gitleaks ran: file, line and rule, never a value. The evidence lists it.
    secretScan: { allowed: scan.allowed.map(({ file, line, rule }) => ({ file, line, rule })), gitleaks: scan.gitleaks },
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
  // Names the command did not send because it found them in the store: the executor
  // stops if the store does not have them, rather than build the app without them.
  record.expectStored = Array.isArray(req.body?.expectStored)
    ? req.body.expectStored.filter(n => storableName(n)).slice(0, 200)
    : [];

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
}

// GET /deployments — summary of every known deployment, newest first. Additive; the
// three existing endpoints are unchanged. The full record stays at /deployments/{id},
// so the rendered report is not repeated for every row.
app.get("/deployments", (req, res) => {
  const visible = visibleDeployments(req);
  const seen = new Set(visible.map(d => d.deploymentId));
  const replaced = replacements(listDeployments());
  const deployments = visible.map(dep => ({
    deploymentId: dep.deploymentId,
    app: dep.app,
    status: dep.status,
    outputs: dep.outputs || {},
    stackName: dep.stackName || null,
    // The environment a deployment is for, from the moment it is queued (stackName comes
    // once its stack is composed). Lists group by stackName, else by this.
    environment: dep.stackName || dep.environment || null,
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
    // What the platform is doing for it now, in a line (while it is under way).
    step: dep.step || null,
    // A failed first create whose dead stack is being removed: no other change until
    // it is gone (api/busy.js).
    cleaningUp: dep.cleaningUp === true,
    cleanupStartedAt: dep.cleanupStartedAt || null,
    // A successful deploy a newer successful deploy has since replaced: no longer what
    // its environment runs. Its result stays its own. replacedBy names the newer one
    // when the reader can see it (a stack from before teams had names can hold another
    // team's records).
    replaced: replaced.has(dep.deploymentId),
    replacedBy: seen.has(replaced.get(dep.deploymentId)) ? replaced.get(dep.deploymentId) : null,
    needs: Array.isArray(dep.needs) ? dep.needs.length : 0,
    // Whether its code was packaged and can be deployed again (PHASE2-PLAN Step 14),
    // and, for one that was itself deployed again, whose code it ran.
    // Paused as of the last pause or resume made here (read from AWS then). Control
    // reads it from AWS again (GET /deployments/{id}/paused).
    paused: dep.paused === true && !replaced.has(dep.deploymentId),
    pauses: Array.isArray(dep.pauses) ? dep.pauses : [],
    packaged: Boolean(dep.artifactKey) && dep.kind !== "static",
    fromDeployment: dep.fromDeployment || null,
    packagedBy: dep.artifactKey && dep.kind !== "static" ? dep.packagedBy || dep.deploymentId : null
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
  // Whether a newer success has replaced it, as the list says (DESIGN.md).
  const replacedBy = replacements(listDeployments()).get(dep.deploymentId);
  if (!replacedBy) return res.status(200).json(dep);
  return res.status(200).json({ ...dep, replaced: true, replacedBy: canSee(req, getDeployment(replacedBy)) ? replacedBy : null });
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

// A stack from before teams had names of their own may now run another team's code
// (DESIGN.md, "Each team's environments have names of their own"). An older record of
// it is still its team's to read, but what is running there now is the other team's:
// its logs, its readings, whether it is paused. Only an organization-wide token may.
function runsAnotherTeams(req, res, dep) {
  if (!req.caller || req.caller.scope === "org") return false;
  if (!sharedWithAnotherTeam(dep.stackName, { org: orgOf(dep), team: teamOf(dep), records: listDeployments() })) return false;
  res.status(409).json({ error: { code: "SHARED_ENVIRONMENT", message: "Another team runs this environment now, from before each team's environments had names of their own, so what it does is theirs to see." } });
  return true;
}

// GET /deployments/{deploymentId}/logs?since=15m|1h|6h|1d — its environment's recent
// log lines, newest first, masked (api/logs.js). Read only. PHASE2-PLAN Step 16.
app.get("/deployments/:deploymentId/logs", async (req, res) => {
  const dep = getDeployment(req.params.deploymentId);
  if (!canSee(req, dep)) return res.status(404).json({ error: { code: "NOT_FOUND", message: "deploymentId not found" } });
  if (runsAnotherTeams(req, res, dep)) return;
  const { status, body } = await readLogs(dep, { window: typeof req.query.since === "string" ? req.query.since : "1h" });
  return res.status(status).json(body);
});

// GET /deployments/{id}/paused, POST /deployments/{id}/pause and /resume (PHASE2-PLAN
// Step 17): whether its environment's API is taking requests, read from AWS, and the
// change. Its team, or an organization-wide token, as for a tear-down.
app.get("/deployments/:deploymentId/paused", async (req, res) => {
  const dep = getDeployment(req.params.deploymentId);
  if (!canSee(req, dep)) return res.status(404).json({ error: { code: "NOT_FOUND", message: "deploymentId not found" } });
  if (runsAnotherTeams(req, res, dep)) return;
  const { status, body } = await pausedState(dep);
  return res.status(status).json(body);
});
for (const [action, paused] of [["pause", true], ["resume", false]]) {
  app.post(`/deployments/:deploymentId/${action}`, async (req, res) => {
    const dep = getDeployment(req.params.deploymentId);
    if (!canSee(req, dep)) return res.status(404).json({ error: { code: "NOT_FOUND", message: "deploymentId not found" } });
    if (runsAnotherTeams(req, res, dep)) return;
    const busy = changeUnderWay(dep.stackName || dep.environment);
    if (busy) return res.status(409).json(busyRefusal(busy));
    const by = req.caller ? { user: req.caller.email, name: req.caller.name } : null;
    const { status, body } = await changePaused(dep, paused, { by, surface: req.surface || "cli" });
    return res.status(status).json(body);
  });
}

// GET /deployments/{id}/performance?since=1h|6h|1d|7d — readings of its environment's
// API: requests, errors, refused, time taken (api/performance.js). Step 20.
app.get("/deployments/:deploymentId/performance", async (req, res) => {
  const dep = getDeployment(req.params.deploymentId);
  if (!canSee(req, dep)) return res.status(404).json({ error: { code: "NOT_FOUND", message: "deploymentId not found" } });
  if (runsAnotherTeams(req, res, dep)) return;
  const { status, body } = await readPerformance(dep, { window: typeof req.query.since === "string" ? req.query.since : "1d" });
  return res.status(status).json(body);
});

// GET /costs?since=7d|30d — what each of your team's apps has cost (api/costs.js),
// by the cost allocation tags; an organization-wide token sees every team's. Step 20.
app.get("/costs", async (req, res) => {
  const { status, body } = await readCosts(req.caller, { window: typeof req.query.since === "string" ? req.query.since : "30d" });
  return res.status(status).json(body);
});

// GET /team — the people on your team, from the tokens in use (api/team.js). No tokens,
// no hashes. PHASE2-PLAN Step 19.
app.get("/team", async (req, res) => {
  try {
    return res.status(200).json(await peopleOf(req.caller));
  } catch (err) {
    return res.status(500).json({ error: { code: "TEAM_FAILED", message: err.message } });
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

  // One change at a time: no tear-down while a deploy to it is under way, this one's own
  // included, which would otherwise build it again once its packaging finished.
  {
    const busy = changeUnderWay(dep.stackName || dep.environment);
    if (busy) return res.status(409).json(busyRefusal(busy));
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

// GET /interviews: the caller's own interviews that are still open, running or waiting
// on them, so one started on either surface can be finished on the other. Never anyone
// else's. Added Oct 12, 2026.
app.get("/interviews", (req, res) => {
  return res.status(200).json({ interviews: interviews.openFor(req.caller ? req.caller.email : null) });
});

// POST /interviews: start an interview over an uploaded app folder.
// Body: { app, zip (base64), deployed?, user?, trace? }. The zip is made by the CLI's
// zipFolder (core/upload.js): no dependencies, no git, secret files as names only.
app.post("/interviews", async (req, res) => {
  const { app: appName, zip, deployed, user, trace, findings } = req.body || {};

  if (!interviews.ready()) {
    return res.status(503).json({
      error: { code: "NO_MODEL_KEY", message: "the seaLeye API has no model key set, so it cannot run an interview" }
    });
  }
  if (typeof zip !== "string" || !zip) {
    return res.status(400).json({ error: { code: "MISSING_UPLOAD", message: "zip is required: the app folder, zipped, as base64" } });
  }

  try {
    const started = await interviews.startFromUpload({
      zip: Buffer.from(zip, "base64"),
      app: appName,
      findings,
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
    if (err instanceof ScanFailed) {
      return res.status(503).json({ error: { code: "SCAN_FAILED", message: SCAN_FAILED_WORDS } });
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

// An app's settings in the organization's store (PHASE2-PLAN Step 8, D3). A team's app
// keeps them in its own folder, /sealeye-apps/<team>/<app>/, so a team reaches only its
// own; an organization-wide token may name another team with ?team=. Values go in and
// never come out: every answer is names, whether each is set, and who changed it when.
const TEAM_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
function settingsScope(req) {
  const app = safeName(req.params.app);
  const asked = typeof req.query.team === "string" && req.query.team ? req.query.team : null;
  if (!app || app.length > 100 || (asked && !TEAM_ID.test(asked))) return null;
  const org = req.caller ? req.caller.org : "default";
  if (!req.caller) return { org, team: asked || "default", app };
  if (!asked || asked === req.caller.team) return { org, team: req.caller.team, app };
  return req.caller.scope === "org" ? { org, team: asked, app } : null;
}
const noSuchApp = res => res.status(404).json({ error: { code: "NOT_FOUND", message: "No app of that name that you can see." } });

// GET /apps/{app}/settings: the settings its latest plan asks for and the ones stored,
// each with whether it is set and who last changed it.
app.get("/apps/:app/settings", async (req, res) => {
  const scope = settingsScope(req);
  if (!scope) return noSuchApp(res);
  const folder = storeFolder(scope);
  const stored = await listStoredSettings(folder);
  if (!stored.ok) {
    return res.status(502).json({ error: { code: "STORE_UNAVAILABLE", message: `The settings store did not answer: ${stored.error}` } });
  }
  const latest = listDeployments().find(dep =>
    orgOf(dep) === scope.org && teamOf(dep) === scope.team && safeName(dep.app?.name) === scope.app && dep.plan);
  const wanted = latest ? settingNamesFor(latest.plan) : [];
  const changes = await lastChanges(scope);
  const storedNames = new Map(stored.settings.map(x => [x.name, x]));
  const names = [...new Set([...wanted, ...storedNames.keys()])].sort();
  const settings = names.map(name => {
    const change = changes.get(name);
    return {
      name,
      wanted: wanted.includes(name),
      set: storedNames.has(name),
      changedAt: storedNames.get(name)?.changedAt || change?.at || null,
      changedBy: change ? { name: change.byName, email: change.byEmail, surface: change.surface, action: change.action } : null
    };
  });
  return res.status(200).json({ app: scope.app, team: scope.team, settings });
});

// PUT /apps/{app}/settings/{name} { value }: store one, encrypted, replacing any before.
app.put("/apps/:app/settings/:name", async (req, res) => {
  const scope = settingsScope(req);
  if (!scope) return noSuchApp(res);
  const name = req.params.name;
  if (!storableName(name)) {
    return res.status(400).json({ error: { code: "INVALID_NAME", message: "A setting's name is letters, digits and underscores, not starting with a digit, and not one the platform or the runtime owns (PORT, NODE_OPTIONS, or starting with AWS_, LAMBDA_, SEALEYE_ or an underscore)." } });
  }
  const value = req.body?.value;
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value, "utf8") > MAX_STORED_BYTES) {
    return res.status(400).json({ error: { code: "INVALID_VALUE", message: `A setting's value is text, from 1 byte to ${MAX_STORED_BYTES / 1024} KB.` } });
  }
  const put = await putStoredSetting(`${storeFolder(scope)}${name}`, value);
  if (!put.ok) {
    return res.status(502).json({ error: { code: "STORE_REFUSED", message: `The settings store did not keep it: ${put.error}` } });
  }
  await recordSettingChange({ ...scope, name, action: "set", caller: req.caller, surface: req.surface });
  return res.status(200).json({ app: scope.app, team: scope.team, name, set: true });
});

// DELETE /apps/{app}/settings/{name}: remove one.
app.delete("/apps/:app/settings/:name", async (req, res) => {
  const scope = settingsScope(req);
  if (!scope) return noSuchApp(res);
  const name = req.params.name;
  if (!storableName(name)) {
    return res.status(400).json({ error: { code: "INVALID_NAME", message: "That is not a setting's name." } });
  }
  const removed = await deleteStoredSetting(`${storeFolder(scope)}${name}`);
  if (!removed.ok) {
    return res.status(502).json({ error: { code: "STORE_REFUSED", message: `The settings store did not remove it: ${removed.error}` } });
  }
  if (removed.existed) await recordSettingChange({ ...scope, name, action: "removed", caller: req.caller, surface: req.surface });
  return res.status(200).json({ app: scope.app, team: scope.team, name, set: false });
});

// A request the API could not read. Node's own messages for bad JSON quote the body, and
// a body can hold a setting's value, so the answer and the log name only what kind of
// failure it was, never its message.
app.use((err, req, res, _next) => {
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ error: { code: "INVALID_JSON", message: "The request body is not JSON." } });
  }
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: { code: "TOO_LARGE", message: "The request body is larger than the platform accepts." } });
  }
  // The whole error for the server's log, except on the settings routes, where a
  // message could carry a value.
  console.error(req.path.startsWith("/apps/")
    ? `${req.method} ${req.path}: ${err?.name || "Error"}${err?.code ? ` (${err.code})` : ""}`
    : err?.stack || String(err));
  return res.status(500).json({ error: { code: "INTERNAL", message: "The platform could not finish this request." } });
});

const listening = app.listen(port, () => {
  console.log(`seaLeye API listening on http://localhost:${port}`);
  if (opened.adopted) console.log(`deployment store: brought ${opened.adopted} records in from ${opened.from}`);
  for (const r of resumed) console.log(`${r.deploymentId}: ${r.as}`);
  for (const r of restoredInterviews) console.log(`${r.interviewId}: ${r.as}`);
  console.log(`deployment store: ${storeFile} (${listDeployments().length} records loaded${opened.migrations?.length ? `, applied ${opened.migrations.join(", ")}` : ""})`);
});

// An idle kept-alive connection stays open longer than anything in front of the API
// keeps one. Node closes them after five seconds by default, and a client or proxy that
// reuses a connection just as it closes gets "socket closed" (a 502 through Caddy, or a
// failed request in the tests) for a request the API never saw.
const KEEP_ALIVE_MS = 130_000;
listening.keepAliveTimeout = KEEP_ALIVE_MS;
listening.headersTimeout = KEEP_ALIVE_MS + 1_000;
