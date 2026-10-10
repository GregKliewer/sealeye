// src/executor/compose.js
// Turn a validated planVersion 0.2 plan into the one CloudFormation deployment it
// describes: which template, which stack, which parameter overrides.
import fs from "node:fs";
import path from "node:path";

import { backendMappings } from "../mappings.js";
import { safeName } from "../../core/names.js";
import { repoRoot, loadEnv, requireSetting } from "../../core/config.js";
import { settingValues } from "./settings.js";

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_ENTRY_POINT = "index.js";

const CONFIG_PARAMETER_MARKER = "# sealeye:config-parameters";
const CONFIG_VARIABLE_MARKER = "# sealeye:config-variables";

// The two core modules, and the deployment kind each one produces.
const CORE_MODULE_KINDS = {
  http_api_serverless: "api",
  static_site_edge: "static"
};

// safeName() lives in core/names.js so the CLI and the API name things the same way.
export { safeName };

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
 * http_api_serverless.inputs.entry_point -> the file the start script runs.
 *
 * It has to be a path inside the artifact and nothing else: the value ends up in a
 * shell script, and it is the one field in the plan that comes from what the model
 * read in the developer's folder rather than from the contract.
 */
function entryPointFor(plan) {
  const api = enabledModules(plan).find(m => m.id === "http_api_serverless");
  const raw = String(api?.inputs?.entry_point ?? "").trim() || DEFAULT_ENTRY_POINT;

  const unsafe =
    raw.startsWith("/") ||
    raw.split("/").includes("..") ||
    !/^[A-Za-z0-9._\/-]+$/.test(raw);

  if (unsafe) {
    throw new Error(`entry_point has to be a file inside your app folder, and "${raw}" is not`);
  }

  return raw;
}

/**
 * The template this deployment actually gets: the module's own file, with one parameter
 * and one environment variable written in per setting.
 *
 * CloudFormation cannot take an environment variable's *name* from a parameter, so the
 * names are rendered into a copy of the template and only the values travel as
 * parameters, where NoEcho keeps them out of the console, the stack events and
 * `get-template`. With no settings the module's own file is used untouched.
 */
function renderTemplate(templatePath, settings, deploymentId) {
  if (!settings.length) return templatePath;

  const base = fs.readFileSync(templatePath, "utf8");

  for (const marker of [CONFIG_PARAMETER_MARKER, CONFIG_VARIABLE_MARKER]) {
    if (!base.includes(marker)) {
      throw new Error(`${templatePath} has no ${marker} line, so there is nowhere to put the plan's settings`);
    }
  }

  const parameters = settings
    .map((_, i) => [`  ConfigValue${i + 1}:`, "    Type: String", '    Default: ""', "    NoEcho: true"].join("\n"))
    .join("\n");

  const variables = settings
    .map((setting, i) => `          ${setting.name}: !Ref ConfigValue${i + 1}`)
    .join("\n");

  const rendered = base
    .replace(new RegExp(`^[ \\t]*${CONFIG_PARAMETER_MARKER}$`, "m"), parameters)
    .replace(new RegExp(`^[ \\t]*${CONFIG_VARIABLE_MARKER}$`, "m"), variables);

  const out = path.join(repoRoot, "dist", `${deploymentId}.template.yaml`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, rendered);

  return out;
}

/** The parameters with every value the developer owns taken back out. */
function withoutSecrets(parameters) {
  return Object.fromEntries(
    Object.entries(parameters).map(([key, value]) => [key, /^ConfigValue\d+$/.test(key) ? "(redacted)" : value])
  );
}

/**
 * @param {object} plan          a plan that has already passed planSchema validation
 * @param {string} deploymentId  required for kind "api" (it names the artifact)
 * @param {string} [appPath]      the developer's folder, read for its .env only
 * @param {Record<string,string>} [sent] setting values sent with the deploy request
 * @returns {{kind: "api"|"static", templatePath: string, stackName: string, parameters: object,
 *            safeParameters: object, settings: {name: string, source: string}[], entryPoint?: string}}
 */
export function compose(plan, deploymentId, appPath, sent = {}) {
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
  let entryPoint;
  let settings = [];
  let resolvedTemplate = templatePath;

  if (kind === "api") {
    entryPoint = entryPointFor(plan);
    settings = settingValues(plan, { sent, appPath });

    if (!deploymentId) {
      throw new Error("deploymentId is required to compose an http_api_serverless deployment");
    }

    const adapterLayerVersion = Number(requireSetting("LWA_VERSION"));
    if (!Number.isInteger(adapterLayerVersion) || adapterLayerVersion <= 0) {
      throw new Error(
        `SEALEYE_LWA_VERSION must be a layer version number, got "${requireSetting("LWA_VERSION")}"`
      );
    }

    parameters = {
      AppName: appName,
      ArtifactBucket: requireSetting("BUCKET"),
      ArtifactKey: artifactKeyFor(appName, deploymentId),
      AdapterLayerVersion: adapterLayerVersion,
      RetentionDays: retentionDays(plan)
    };

    for (const [i, setting] of settings.entries()) parameters[`ConfigValue${i + 1}`] = setting.value;

    resolvedTemplate = renderTemplate(templatePath, settings, deploymentId);
  } else {
    // static_site_edge takes AppName only; the files are synced after the stack exists.
    parameters = { AppName: appName };
  }

  return {
    kind,
    templatePath: resolvedTemplate,
    stackName: stackNameFor(appName),
    parameters,
    // What may be written down: the record is a file on the developer's machine and an
    // API response, and neither is a place for their values.
    safeParameters: withoutSecrets(parameters),
    settings: settings.map(({ name, source }) => ({ name, source })),
    ...(entryPoint ? { entryPoint } : {})
  };
}
