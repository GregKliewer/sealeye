// lib/run.js
import fs from "fs";
import YAML from "yaml";

/**
 * Load a YAML plan file and return a JS object (plan).
 */
export function loadPlanFromYaml(planPath) {
  const yamlText = fs.readFileSync(planPath, "utf8");
  return YAML.parse(yamlText);
}

/**
 * Create a deployment by calling deployme API.
 */
export async function createDeployment({ apiBaseUrl, backend, plan }) {
  const res = await fetch(`${apiBaseUrl}/deployments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backend, plan })
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(`deployme API error: ${res.status}`);
    err.details = body;
    throw err;
  }

  return body;
}

/**
 * Validate a plan by calling deployme API.
 */
export async function validatePlan({ apiBaseUrl, plan }) {
  const res = await fetch(`${apiBaseUrl}/plans/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(plan)
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(`deployme API error: ${res.status}`);
    err.details = body;
    throw err;
  }

  return body;
}

export async function getDeployment({ apiBaseUrl, deploymentId }) {
  const res = await fetch(`${apiBaseUrl}/deployments/${deploymentId}`, {
    method: "GET"
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(`deployme API error: ${res.status}`);
    err.details = body;
    throw err;
  }

  return body;
}