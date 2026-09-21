// lib/run.js
import fs from "fs";
import YAML from "yaml";

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
 * Create a deployment by calling deployme API.
 */
export async function createDeployment({ apiBaseUrl, backend, plan, appPath }) {
  return platformFetch(apiBaseUrl, "/deployments", asJson({ backend, plan, appPath }));
}

/**
 * Validate a plan by calling deployme API.
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
