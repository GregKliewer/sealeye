// src/executor/compose.js
// Turn a validated planVersion 0.2 plan into the one CloudFormation deployment it
// describes: which template, which stack, which parameter overrides.
import fs from "node:fs";
import path from "node:path";

import { backendMappings } from "../mappings.js";
import { environmentName, safeName } from "../../core/names.js";
import { repoRoot, loadEnv, requireSetting } from "../../core/config.js";
import { settingValues } from "./settings.js";
import { RETENTION_ALLOWED, retentionOf } from "../../core/retention.js";

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

/**
 * What stacks were called before teams had names of their own: sealeye-<app>, with
 * everything in them named after the bare app. Environments made then keep these names
 * (see namingFor); nothing new is named this way.
 */
export function stackNameFor(appName) {
  return `sealeye-${safeName(appName)}`;
}

/** <name>/<deploymentId>.zip: a new key every deploy, so S3Key always changes. */
export function artifactKeyFor(resourceName, deploymentId) {
  return `${safeName(resourceName)}/${deploymentId}.zip`;
}

/**
 * Whether a stack is another team's now. Only a stack from before teams had names of
 * their own can hold more than one team's records. Whoever deployed to it last is in it
 * (an earlier team's code was replaced), so it is that record's team's unless that
 * record is torn down. Records are newest first; a draft has no stack.
 */
export function sharedWithAnotherTeam(stackName, { org = "default", team = "default", records = [] }) {
  if (!stackName) return false;
  const occupant = records.find(r => r.stackName === stackName);
  return Boolean(occupant) &&
    occupant.status !== "destroyed" &&
    ((occupant.orgId || "default") !== org || (occupant.teamId || "default") !== team);
}

/**
 * What everything in a record's environment is named after (its function, log group,
 * API). Records from before names were kept kept the bare app name only as the AppName
 * parameter, or only in the stack's name.
 */
export function resourceNameOf(record) {
  if (!record?.stackName) return null;
  return record.resourceName || record.parameters?.AppName || record.stackName.replace(/^sealeye-/, "");
}

/**
 * Which names a deployment of this app, for this team, uses (DESIGN.md, "Each team's
 * environments have names of their own"):
 *
 * - the team already has an environment of this app that is not torn down: its names,
 *   as its record keeps them, so an environment made before teams had names of their
 *   own keeps "sealeye-<app>", and nothing is renamed or moved;
 * - otherwise: a new name from environmentName() for the stack and everything in it.
 *
 * Another team's records never count: theirs is another environment. Nor is a stack
 * reused that another team deployed to last, as a "sealeye-<app>" stack from before
 * teams had names of their own can be: deploying to it would change their environment,
 * so this team gets a name of its own instead. A stack that is being torn down is not
 * reused either.
 *
 * @param {object} args
 * @param {string} args.app        the plan's app name
 * @param {string} [args.org]      the caller's organization ("default" without tokens)
 * @param {string} [args.team]     the caller's team
 * @param {object[]} [args.records] every record, newest first
 * @returns {{ stackName: string, resourceName: string, reused: boolean }}
 */
export function namingFor({ app, org = "default", team = "default", records = [] }) {
  const appName = safeName(app);
  const sameEnvironment = r =>
    Boolean(r.stackName) &&
    safeName(r.app?.name) === appName &&
    (r.orgId || "default") === org &&
    (r.teamId || "default") === team;

  const latest = records.find(sameEnvironment);
  const reusable = latest &&
    latest.status !== "destroyed" &&
    latest.status !== "destroying" &&
    !sharedWithAnotherTeam(latest.stackName, { org, team, records });
  if (reusable) {
    return { stackName: latest.stackName, resourceName: resourceNameOf(latest), reused: true };
  }
  const name = environmentName({ org, team, app });
  return { stackName: name, resourceName: name, reused: false };
}

function enabledModules(plan) {
  return (plan?.modules || []).filter(m => m && m.enabled !== false);
}

/** observability_basic.inputs.retention_days -> RetentionDays (core/retention.js). */
function retentionDays(plan) {
  const days = retentionOf(plan);
  if (!RETENTION_ALLOWED.includes(days)) {
    throw new Error(`your plan keeps logs for ${days} days, and they can be kept for ${RETENTION_ALLOWED.slice(0, 12).join(", ")} days or longer steps of a year`);
  }
  return days;
}

/**
 * http_api_serverless.inputs.entry_point -> the file the start script runs.
 *
 * It has to be a path inside the artifact and nothing else: the value ends up in a
 * shell script, and it is the one field in the plan that comes from what the model
 * read in the developer's folder rather than from the contract.
 */
export function entryPointFor(plan) {
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
 * @param {{stackName: string, resourceName: string}} [naming] from namingFor(); without
 *        it, a new name for the "default" team, as a laptop API with no tokens has
 * @param {{folder?: string, stored?: string[]}} [store] the app's folder in the
 *        organization's store and the names stored there (PHASE2-PLAN Part B)
 * @returns {{kind: "api"|"static", templatePath: string, stackName: string, resourceName: string,
 *            parameters: object, safeParameters: object, settings: {name: string, source: string}[],
 *            entryPoint?: string}}
 */
/** The app and team, as cost allocation tags (sealeye:app, sealeye:team). */
function costTags(plan, naming) {
  return { TagApp: safeName(plan?.app?.name), TagTeam: safeName(naming?.team || "default") };
}

export function compose(plan, deploymentId, appPath, sent = {}, naming, store = {}) {
  loadEnv();

  const appName = safeName(plan?.app?.name);
  if (!appName) {
    throw new Error("plan.app.name is required and must contain at least one [a-z0-9] character");
  }
  // The templates' AppName parameter is the name every resource is called after: the
  // environment's name, never the bare app name, except for an environment made before
  // teams had names of their own, which keeps the one it has.
  const { stackName, resourceName } = naming || namingFor({ app: appName });

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
    const stored = store.folder ? store.stored || [] : [];
    settings = settingValues(plan, { sent, appPath, stored });

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
      AppName: resourceName,
      ArtifactBucket: requireSetting("BUCKET"),
      ArtifactKey: artifactKeyFor(resourceName, deploymentId),
      AdapterLayerVersion: adapterLayerVersion,
      RetentionDays: retentionDays(plan),
      // Every function's role carries the platform's boundary (deploy/deploy-role.yaml).
      FunctionBoundaryArn: requireSetting("FUNCTION_BOUNDARY_ARN"),
      // When the app has settings in the store, its function reads that folder at start
      // and may read no other; with none there, it reads nothing.
      SettingsFolder: stored.length ? store.folder.replace(/\/$/, "") : "",
      // Changes every deploy, so a deploy of the same code with the same parameters is
      // still a change CloudFormation makes, never an empty change set.
      DeploymentId: deploymentId,
      ...costTags(plan, naming)
    };

    // A setting in the store has no value here: the app reads it when it starts. Every
    // other one is passed in as before, as a parameter of its own.
    const passed = settings.filter(s => s.source !== "store");
    for (const [i, setting] of passed.entries()) parameters[`ConfigValue${i + 1}`] = setting.value;

    resolvedTemplate = renderTemplate(templatePath, passed, deploymentId);
  } else {
    // static_site_edge takes AppName only; the files are synced after the stack exists.
    parameters = { AppName: resourceName, ...costTags(plan, naming) };
  }

  return {
    kind,
    templatePath: resolvedTemplate,
    stackName,
    resourceName,
    parameters,
    // What may be written down: the record is a file on the developer's machine and an
    // API response, and neither is a place for their values.
    safeParameters: withoutSecrets(parameters),
    settings: settings.map(({ name, source }) => ({ name, source })),
    ...(entryPoint ? { entryPoint } : {})
  };
}
