// src/executor/compose.js
// Turn a validated planVersion 0.2 plan into the one CloudFormation deployment it
// describes: which template, which stack, which parameter overrides.
import fs from "node:fs";
import path from "node:path";

import { backendMappings } from "../mappings.js";
import { repoRoot, loadEnv, requireEnv } from "./env.js";

const DEFAULT_RETENTION_DAYS = 30;

// The two core modules, and the deployment kind each one produces.
const CORE_MODULE_KINDS = {
  http_api_serverless: "api",
  static_site_edge: "static"
};

/** Lowercase, [a-z0-9-] only — safe for a stack name, a function name and an S3 prefix. */
export function safeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Stacks are sealeye-<app>. */
export function stackNameFor(appName) {
  return `sealeye-${safeName(appName)}`;
}

/** <app>/<deploymentId>.zip — a new key every deploy, so S3Key always changes. */
export function artifactKeyFor(appName, deploymentId) {
  return `${safeName(appName)}/${deploymentId}.zip`;
}

function enabledModules(plan) {
  return (plan?.modules || []).filter(m => m && m.enabled !== false);
}

/** observability_basic.inputs.retention_days -> RetentionDays, default 30. */
function retentionDays(plan) {
  const obs = enabledModules(plan).find(m => m.id === "observability_basic");
  const value = Number(obs?.inputs?.retention_days);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_RETENTION_DAYS;
}

/**
 * @param {object} plan          a plan that has already passed planV02Schema validation
 * @param {string} deploymentId  required for kind "api" (it names the artifact)
 * @returns {{kind: "api"|"static", templatePath: string, stackName: string, parameters: object}}
 */
export function compose(plan, deploymentId) {
  loadEnv();

  const appName = safeName(plan?.app?.name);
  if (!appName) {
    throw new Error("plan.app.name is required and must contain at least one [a-z0-9] character");
  }

  const core = enabledModules(plan)
    .map(m => m.id)
    .filter(id => id in CORE_MODULE_KINDS);

  if (core.length === 0) {
    throw new Error(
      "plan enables no deployable module: one of http_api_serverless or static_site_edge is required"
    );
  }
  if (new Set(core).size > 1) {
    throw new Error(
      `plan enables both ${core.join(" and ")}: one template per deployment, so only one may be enabled`
    );
  }

  const moduleId = core[0];
  const kind = CORE_MODULE_KINDS[moduleId];

  const templatePath = path.join(repoRoot, backendMappings.cloudformation[moduleId]);
  if (!fs.existsSync(templatePath)) {
    throw new Error(`template for ${moduleId} not found at ${templatePath}`);
  }

  let parameters;
  if (kind === "api") {
    if (!deploymentId) {
      throw new Error("deploymentId is required to compose an http_api_serverless deployment");
    }

    const adapterLayerVersion = Number(requireEnv("DEPLOYME_LWA_VERSION"));
    if (!Number.isInteger(adapterLayerVersion) || adapterLayerVersion <= 0) {
      throw new Error(
        `DEPLOYME_LWA_VERSION must be a layer version number, got "${process.env.DEPLOYME_LWA_VERSION}"`
      );
    }

    parameters = {
      AppName: appName,
      ArtifactBucket: requireEnv("DEPLOYME_BUCKET"),
      ArtifactKey: artifactKeyFor(appName, deploymentId),
      AdapterLayerVersion: adapterLayerVersion,
      RetentionDays: retentionDays(plan)
    };
  } else {
    // static_site_edge takes AppName only; the files are synced after the stack exists.
    parameters = { AppName: appName };
  }

  return { kind, templatePath, stackName: stackNameFor(appName), parameters };
}
