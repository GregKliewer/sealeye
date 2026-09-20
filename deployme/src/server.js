import express from "express";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import crypto from "crypto";
import fs from "node:fs";
import path from "node:path";

import { planV02Schema } from "./schema.js";
import { backendMappings } from "./mappings.js";
import { putDeployment, getDeployment } from "./store.js";
import { startDeployment } from "./executor/index.js";

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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`deployme listening on http://localhost:${port}`));