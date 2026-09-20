import express from "express";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import crypto from "crypto";

import { planV02Schema } from "./schema.js";
import { backendMappings } from "./mappings.js";
import { putDeployment, getDeployment } from "./store.js";

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
  const { backend, plan } = req.body || {};

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

  // Resolve enabled modules and map to backend artifacts (stub for now)
  const mapping = backendMappings[backend];
  const resolvedModules = (plan.modules || [])
    .filter(m => m.enabled !== false)
    .map(m => ({
      id: m.id,
      mappedTo: mapping[m.id] || `unknown/${m.id}`
    }));

  const deploymentId = `dep_${crypto.randomBytes(6).toString("hex")}`;
  const now = new Date().toISOString();

  // Deterministic outputs for demo purposes
  const outputs = {};
  if ((plan.outputs || []).includes("public_url")) outputs.public_url = "https://your-app-name.platform.app";
  if ((plan.outputs || []).includes("logs")) outputs.logs = "available";
  if ((plan.outputs || []).includes("metrics")) outputs.metrics = "available";
  if ((plan.outputs || []).includes("metrics_dashboard")) outputs.metrics_dashboard = "available";
  if ((plan.outputs || []).includes("log_stream")) outputs.log_stream = "available";

  const record = putDeployment({
    deploymentId,
    status: "queued",
    backend,
    planVersion: plan.planVersion,
    app: plan.app,
    resolvedModules,
    outputs,
    startedAt: now,
    finishedAt: null
});

  setTimeout(() => {
    const dep = getDeployment(deploymentId);
    if (!dep) return;
    dep.status = "running";
    putDeployment(dep);
  }, 10000);

  setTimeout(() => {
    const dep = getDeployment(deploymentId);
    if (!dep) return;
    dep.status = "succeeded";
    dep.finishedAt = new Date().toISOString();
    putDeployment(dep);
  }, 20000);

  const response = { ...record };
  return res.status(201).json(response)   ;
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