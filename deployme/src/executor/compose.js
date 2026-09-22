// src/executor/compose.js
// Turn a validated planVersion 0.2 plan into the one CloudFormation deployment it
// describes: which template, which stack, which parameter overrides.
import fs from "node:fs";
import path from "node:path";

import { backendMappings } from "../mappings.js";
import { repoRoot, loadEnv, requireEnv, readEnvFile } from "./env.js";

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_ENTRY_POINT = "index.js";

// The platform decides the port and tells the app what it is, so it is never a setting
// the plan gets to pass.
const PLATFORM_OWNED = new Set(["PORT"]);
const CONFIG_PARAMETER_MARKER = "# sealeye:config-parameters";
const CONFIG_VARIABLE_MARKER = "# sealeye:config-variables";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
 * The settings the plan asks the platform to pass to the app, with their values.
 *
 * A value comes from the developer's own `.env` when they have one, because that is
 * where a developer already keeps these, and from the plan otherwise, where the
 * interview left a placeholder for them to fill in. The file is read, never written,
 * and never applied to the platform's own environment.
 */
function configSettings(plan, appPath) {
  const module = enabledModules(plan).find(m => m.id === "config_basic");
  const wanted = module?.inputs?.variables || {};
  const fromFolder = appPath ? readEnvFile(path.join(appPath, ".env")) : {};

  return Object.keys(wanted)
    .filter(name => !PLATFORM_OWNED.has(name))
    .map(name => {
      if (!ENV_NAME.test(name)) {
        throw new Error(
          `config_basic asks for a setting called "${name}", which is not a name an environment variable can have`
        );
      }

      const mine = Object.prototype.hasOwnProperty.call(fromFolder, name);

      return {
        name,
        value: String((mine ? fromFolder[name] : wanted[name]) ?? ""),
        source: mine ? ".env" : "plan"
      };
    });
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
 * @param {object} plan          a plan that has already passed planV02Schema validation
 * @param {string} deploymentId  required for kind "api" (it names the artifact)
 * @param {string} [appPath]      the developer's folder, read for its .env only
 * @returns {{kind: "api"|"static", templatePath: string, stackName: string, parameters: object,
 *            safeParameters: object, settings: {name: string, source: string}[], entryPoint?: string}}
 */
export function compose(plan, deploymentId, appPath) {
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
    settings = configSettings(plan, appPath);

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
