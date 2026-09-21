import express from "express";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import crypto from "crypto";
import fs from "node:fs";
import path from "node:path";

import { planV02Schema } from "./schema.js";
import { backendMappings } from "./mappings.js";
import { putDeployment, getDeployment, listDeployments, storeFile, count } from "./store.js";
import { startDeployment, startDestroy } from "./executor/index.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validatePlan = ajv.compile(planV02Schema);

function formatAjvErrors(errors = []) {
  return errors.map(e => ({
    code: "SCHEMA_ERROR",
    message: `${e.instancePath || "/"} ${e.message}`,
    path: e.instancePath || "/"
  }));
}

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

// POST /plans/validate
app.post("/plans/validate", (req, res) => {
  const ok = validatePlan(req.body);
  return res.status(200).json({
    valid: !!ok,
    errors: ok ? [] : formatAjvErrors(validatePlan.errors)
  });
});

// POST /deployments
app.post("/deployments", (req, res) => {
  const { backend, plan, appPath } = req.body || {};

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
  const resolvedAppPath = path.resolve(appPath);
  if (!fs.existsSync(resolvedAppPath) || !fs.statSync(resolvedAppPath).isDirectory()) {
    return res.status(400).json({
      error: { code: "INVALID_APP_PATH", message: `appPath is not a directory: ${resolvedAppPath}` }
    });
  }

  const ok = validatePlan(plan);
  if (!ok) {
    return res.status(400).json({
      error: {
        code: "INVALID_PLAN",
        message: "plan failed validation",
        details: formatAjvErrors(validatePlan.errors)
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

  const record = putDeployment({
    deploymentId,
    status: "queued",
    backend,
    planVersion: plan.planVersion,
    app: plan.app,
    appPath: resolvedAppPath,
    resolvedModules,
    // The whole plan, so a later run can say what it is about to change. Additive:
    // records written before this exist without it and are read as before.
    plan,
    outputs: {},
    failureReason: null,
    startedAt: new Date().toISOString(),
    finishedAt: null
  });

  // Runs to completion in the background against real CloudFormation; the record is
  // mutated in place, so GET /deployments/:id always reads the live state.
  startDeployment(record, plan, resolvedAppPath).catch(err => {
    record.status = "failed";
    record.failureReason = err.message;
    record.finishedAt = new Date().toISOString();
    putDeployment(record);
  });

  return res.status(201).json({ ...record });
});

// GET /deployments — summary of every known deployment, newest first. Additive; the
// three existing endpoints are unchanged. The full record stays at /deployments/{id},
// so the rendered report is not repeated for every row.
app.get("/deployments", (_req, res) => {
  const deployments = listDeployments().map(dep => ({
    deploymentId: dep.deploymentId,
    app: dep.app,
    status: dep.status,
    outputs: dep.outputs || {},
    stackName: dep.stackName || null,
    startedAt: dep.startedAt || null,
    finishedAt: dep.finishedAt || null,
    failureReason: dep.failureReason || null,
    interrupted: dep.interrupted === true
  }));

  return res.status(200).json({ deployments });
});

// GET /deployments/{deploymentId}
app.get("/deployments/:deploymentId", (req, res) => {
  const dep = getDeployment(req.params.deploymentId);
  if (!dep) {
    return res.status(404).json({
      error: { code: "NOT_FOUND", message: "deploymentId not found" }
    });
  }
  return res.status(200).json(dep);
});

// DELETE /deployments/{deploymentId} — tears the environment down in the background.
// Returns straight away; the record carries the real progress.
app.delete("/deployments/:deploymentId", (req, res) => {
  const dep = getDeployment(req.params.deploymentId);
  if (!dep) {
    return res.status(404).json({
      error: { code: "NOT_FOUND", message: "deploymentId not found" }
    });
  }

  // Already gone, or already on its way out: say so instead of starting a second
  // tear-down of the same stack.
  if (dep.status === "destroyed" || dep.status === "destroying") {
    return res.status(200).json(dep);
  }

  startDestroy(dep).catch(err => {
    dep.status = "failed";
    dep.failureReason = err.message;
    putDeployment(dep);
  });

  return res.status(202).json({ ...dep });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`deployme listening on http://localhost:${port}`);
  console.log(`deployment store: ${storeFile} (${listDeployments().length} records loaded)`);
});