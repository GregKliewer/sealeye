// core/terraform-modules.js
// What a Terraform module in a catalog needs before seaLeye builds it (DESIGN.md, "What a
// Terraform module needs before seaLeye builds it"). Plain code over a catalog entry and
// the organization's platform values: no files, no network, so the self-test, the plan
// contract and the executor all get the same answer.
//
// Every required input of the module has a source:
//   - seaLeye's own: name, stage, tags;
//   - the app's code: the inputs discovery found the module takes it through
//     (`delivers`, read from the module by code, api/discovery/terraform.js);
//   - the organization's platform values, set by its platform team (api/platform.js),
//     which the API reads beside the catalog (`catalog.platform`), never into it.
// and the module takes the app's code at all (until modules can be connected, a plan
// builds the one module that runs the app), and its code runs no commands on the
// platform's server (`runs`, recorded by discovery: empty when it checked and found
// none).

/** The inputs seaLeye fills itself, for every module it builds. */
export const SEALEYE_INPUTS = Object.freeze(["name", "stage", "tags"]);

/**
 * The inputs a module that runs an app joins the organization's private network through
 * (DESIGN.md, "An app reaches a database in the private network"). They are filled from
 * the platform's values only when the plan uses a module that lives in that network: an
 * app that uses none stays outside it, where it starts faster and needs nothing from it.
 */
export const NETWORK_INPUTS = Object.freeze(["subnet_ids", "security_group_ids"]);

// What puts a module an app uses in the private network: it takes the stage's subnets,
// or a subnet group of them (a database, a cache).
const NETWORK_PART_INPUTS = Object.freeze(["subnet_group_name", "subnet_ids"]);

/** Whether a module an app uses lives in the private network, so the app's module must join it. */
export function inNetwork(entry) {
  if (!entry || entry.delivers) return false;
  const takes = entry.inputs || {};
  return NETWORK_PART_INPUTS.some(i => i in takes);
}

/** Whether a module that runs an app can join the private network: it takes both network inputs. */
export function joinsNetwork(entry) {
  if (!entry?.delivers) return false;
  const takes = entry.inputs || {};
  return NETWORK_INPUTS.every(i => i in takes);
}

/**
 * Which of the network inputs the platform has no value for: for one module that runs an
 * app, when its id is given (the plain name, or that module's own); or, with no id, for
 * any module that runs an app: the plain name only, since a module's own value may be
 * another part's (a cache's own security groups), which no app joins the network with.
 * So a part is never said to be built while every plan using it would be refused; the
 * other way round it is refused, and the self-test says why.
 */
export function networkValuesMissing(names, { app = null } = {}) {
  const set = names instanceof Set ? names : new Set(names || []);
  if (app) return NETWORK_INPUTS.filter(i => !platformNameFor(app, i, set));
  return NETWORK_INPUTS.filter(i => !set.has(i));
}

/**
 * The platform value that fills a module's input, or null. As platformNameFor, except
 * that a part in the private network takes its network inputs (its own security groups,
 * its own subnets) only from its own value, `<module>.<input>`: the plain one is what
 * apps join the network with, and a database given the apps group would admit nothing.
 */
export function platformValueFor(entry, input, names) {
  if (inNetwork(entry) && NETWORK_INPUTS.includes(input)) {
    const set = names instanceof Set ? names : new Set(names || []);
    return set.has(`${entry.id}.${input}`) ? `${entry.id}.${input}` : null;
  }
  return platformNameFor(entry?.id, input, names);
}

/** The stage a developer's environment is built as (principle 9). */
export const DEVELOPER_STAGE = "dev";

/** The stages a platform value may be set for: Juniper's path to production, and perf. */
export const STAGES = Object.freeze(["dev", "sit", "uat", "staging", "perf", "prod"]);

/**
 * What a platform value may be called: an input's name, or a module's id, a dot and an
 * input's name, which fills that module's input only.
 */
export const PLATFORM_NAME = /^(?:[a-z][a-z0-9_]{0,63}\.)?[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

/** The inputs a module takes the app's code through, from its `delivers`. */
export function codeInputs(entry) {
  const d = entry?.delivers;
  if (!d || typeof d !== "object") return [];
  if (d.kind === "package") return [d.package, d.handler].filter(x => typeof x === "string" && x);
  return [];
}

/**
 * Whether a platform value fills an input of this module: the module's own
 * (`<module>.<input>`) or the plain name.
 *
 * @param {string} moduleId
 * @param {string} input
 * @param {Iterable<string>} names  the names the organization has values for, at the stage
 * @returns {string | null} the name that fills it, or null
 */
export function platformNameFor(moduleId, input, names) {
  const set = names instanceof Set ? names : new Set(names || []);
  if (set.has(`${moduleId}.${input}`)) return `${moduleId}.${input}`;
  if (set.has(input)) return input;
  return null;
}

/**
 * Whether the Terraform executor builds this module, and if not, why.
 *
 * @param {object} entry     a catalog module
 * @param {{ names?: string[] }} [platform]  the organization's platform values at the
 *        developer's stage, by name only (the catalog as the API reads it)
 * @returns {{ builds: boolean, why: string | null, missing: string[] }}
 */
export function terraformBuilds(entry, platform = {}) {
  const no = (why, missing = []) => ({ builds: false, why, missing });
  if (!entry || entry.builds_with !== "terraform") return no("it is not a Terraform module");
  if (!Array.isArray(entry.runs)) return no("its code has not been checked for commands it would run (discovery must read the library again)");
  if (entry.runs.length) return no(`its code would run commands on the platform's server (${entry.runs.join(", ")})`);
  // In a library that releases its modules by tag, only a released module is built, at
  // its release (core/module-versions.js).
  if (entry.unreleased) return no(`your organization's library has not released it yet (a release is a tag such as ${String(entry.source || "").split("/").pop() || "its-folder"}/v1.0.0)`);
  const delivers = entry.delivers;
  // A module an app uses rather than one that runs it: built beside the app's module and
  // connected to it through what it offers (isPart). It must grant what the app needs.
  const part = !delivers && isPart(entry);
  if (!part && (!delivers || (delivers.kind !== "package" && delivers.kind !== "files"))) {
    return no("it does not take an app's code, and offers an app nothing it can connect to");
  }
  if (delivers?.kind === "package" && codeInputs(entry).length !== 2) return no("it does not say which input takes the app and which the function to call");
  if (delivers?.kind === "files" && !(typeof delivers.output === "string" && delivers.output)) return no("it does not say where a site's files go");

  const names = new Set(Array.isArray(platform?.names) ? platform.names : []);
  // A module in the private network is reached only by an app's module that joins it,
  // with the stage's subnets and the apps security group from the platform's values.
  if (part && inNetwork(entry)) {
    // Inside the network the app signs in with its own identity, so the module has to
    // grant that; a module offering only a password would hand the app a secret it
    // should never hold.
    if (!entry.offers?.access) return no("an app reaches it over the private network and signs in with its own identity, which this module does not offer (no policy granting access, only a secret)");
    const missing = networkValuesMissing(names);
    if (missing.length) return no(`an app reaches it over the private network, and the platform has no ${missing.join(" and ")} value for the module that runs the app to join that network with`, missing);
  }
  const own = new Set([...SEALEYE_INPUTS, ...codeInputs(entry)]);
  const missing = Object.entries(entry.inputs || {})
    .filter(([name, spec]) => spec && spec.required === true && !own.has(name) && !platformValueFor(entry, name, names))
    .map(([name]) => name)
    .sort();
  if (missing.length) {
    return no(`the platform has no value for its ${missing.join(", ")} input${missing.length === 1 ? "" : "s"}`, missing);
  }
  return { builds: true, why: null, missing: [], ...(part ? { part: true } : {}) };
}

/**
 * Whether a module is one an app uses (a table, a bucket, a queue, a database) and can
 * be connected to: it offers a policy granting the app access, or a secret the app reads
 * (api/discovery/terraform.js, connectsOf).
 */
export function isPart(entry) {
  const o = entry?.offers;
  return Boolean(o && (o.access || (Array.isArray(o.secrets) && o.secrets.length)));
}

/** What a module that runs an app takes of the modules it uses, or null when nothing. */
export function acceptsOf(entry) {
  const a = entry?.accepts;
  return a && (a.policies || a.secrets) ? a : null;
}

/**
 * For a platform engineer: each of a catalog's Terraform modules that is offered, the
 * inputs only the platform can give it (every input that is not seaLeye's or the app's
 * code), which value fills each one, and whether the module is built, or why not.
 *
 * @param {object} catalog
 * @param {string[]} names  the names the organization has values for, at the stage
 */
export function platformWanted(catalog, names = []) {
  const set = new Set(names);
  return (catalog?.modules || [])
    .filter(m => m && m.builds_with === "terraform" && m.availability === "available")
    .map(m => {
      const own = new Set([...SEALEYE_INPUTS, ...codeInputs(m)]);
      const inputs = Object.entries(m.inputs || {})
        .filter(([name]) => !own.has(name))
        .map(([name, spec]) => ({ input: name, required: spec?.required === true, line: spec?.line || null, filledBy: platformValueFor(m, name, set) }));
      const { builds, why } = terraformBuilds(m, { names: [...set] });
      const open = Array.isArray(m.open) && m.open.length > 0;
      return { module: m.id, source: m.source || null, version: m.version || null, inputs, builds: builds && !open, why: open ? "it rests on a question not yet answered" : why };
    });
}

/**
 * The inputs a module is given from the organization's platform values, by input, and the
 * name each comes from. Required or not: a value set for an optional input fills it too.
 * The network inputs of a module that runs an app are the exception: they are filled
 * only when the plan has a module in the private network (`network`).
 *
 * @param {object} entry
 * @param {Record<string, string | string[]>} values  name -> value, at the stage
 * @param {{ network?: boolean }} [options]
 * @returns {Record<string, { from: string, value: string | string[] }>}
 */
export function platformInputs(entry, values = {}, { network = false } = {}) {
  const names = Object.keys(values);
  const own = new Set([...SEALEYE_INPUTS, ...codeInputs(entry)]);
  const out = {};
  for (const input of Object.keys(entry?.inputs || {})) {
    if (own.has(input)) continue;
    if (entry?.delivers && !network && NETWORK_INPUTS.includes(input)) continue;
    const from = platformValueFor(entry, input, names);
    if (from) out[input] = { from, value: values[from] };
  }
  return out;
}

const SETTING = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * What is wrong with how a plan connects the modules its app uses to the app's module
 * (DESIGN.md, "Modules are connected through what the library offers"), as the plan
 * check's problems ({ code: "CONNECTION", path, message }), for the model to put right.
 * Empty for a plan that uses none. Code wires them (api/executor/terraform/root.js);
 * the plan says only which modules, and the setting each value reaches the app under.
 *
 * @param {object} plan
 * @param {object} catalog  the catalog the plan names
 */
export function connectionProblems(plan, catalog) {
  const problems = [];
  const say = (path, message) => problems.push({ code: "CONNECTION", path, message });
  const entries = new Map((catalog?.modules || []).map(m => [m?.id, m]));
  const used = (plan?.modules || []).map((m, i) => ({ m, i })).filter(({ m }) => m && m.enabled !== false);
  const parts = used.filter(({ m }) => isPart(entries.get(m.id)) && !entries.get(m.id)?.delivers);
  for (const { m, i } of used) {
    if (m.connect && !parts.some(p => p.m === m)) say(`/modules/${i}/connect`, `/modules/${i} (${m.id}) is not a module the app uses, so it connects nothing: leave connect out`);
  }
  if (!parts.length) return problems;

  const apps = used.filter(({ m }) => entries.get(m.id)?.delivers);
  if (apps.length !== 1) {
    say("/modules", `a plan that uses ${parts.map(p => p.m.id).join(", ")} needs exactly one module that runs the app, to connect ${parts.length === 1 ? "it" : "them"} to`);
    return problems;
  }
  const app = entries.get(apps[0].m.id);
  const takes = acceptsOf(app);
  const settings = new Map(Object.keys(apps[0].m.inputs?.environment || {}).map(k => [k, `/modules/${apps[0].i}/inputs/environment`]));

  const names = new Set(Array.isArray(catalog?.platform?.names) ? catalog.platform.names : []);

  for (const { m, i } of parts) {
    const entry = entries.get(m.id);
    const offers = entry.offers;
    const where = `/modules/${i}`;
    if (offers.access && !takes?.policies) say(where, `${app.id} cannot be given what the app needs to use ${m.id}: it takes no policies`);
    // A secret is handed to the app only by a module that offers no access of its own:
    // one that grants access (a database the app signs in to) keeps its secret.
    if (offers.secrets?.length && !offers.access && !takes?.secrets) say(where, `${app.id} cannot be given ${m.id}'s secret: it takes no secrets`);
    if (inNetwork(entry)) {
      if (!joinsNetwork(app)) {
        say(where, `${m.id} is in the private network, and ${app.id} cannot join it: it takes no ${NETWORK_INPUTS.join(" and ")}`);
      } else {
        const missing = networkValuesMissing(names, { app: app.id });
        if (missing.length) say(where, `the platform has no ${missing.join(" and ")} value for ${app.id} to join the private network with, which using ${m.id} needs`);
      }
    }
    const connect = m.connect || {};
    const values = offers.values || [];
    if (values.length && !Object.keys(connect).length) {
      say(`${where}/connect`, `${where} (${m.id}) must say the setting the app reads each of its values from, in connect: ${values.join(", ")}`);
    }
    for (const [value, setting] of Object.entries(connect)) {
      if (!values.includes(value)) say(`${where}/connect/${value}`, `${m.id} offers no value called ${value}; it offers ${values.join(", ") || "none"}`);
      if (!SETTING.test(String(setting))) say(`${where}/connect/${value}`, `${setting} is not a setting's name: upper-case letters, digits and underscores`);
      else if (settings.has(setting)) say(`${where}/connect/${value}`, `${setting} is already a setting the app reads, at ${settings.get(setting)}; give this value its own`);
      else settings.set(setting, `${where}/connect/${value}`);
    }
    if (Object.keys(connect).length && !takes?.environment) say(`${where}/connect`, `${app.id} cannot hand the app settings: it takes no environment`);
  }
  return problems;
}

// Where an environment's other lines are kept, beside the app's own (DESIGN.md, "The
// front door's and the database's lines, beside the app's"): read by code from what a
// module outputs, never from what a model wrote. The app's own group is `delivers.logs`.

/** The output the module that runs an app names its front door's record of requests by. */
export const DOOR_LOGS_OUTPUT = "access_log_group";

/** The outputs a module an app uses names its own logs by: `log_group`, `sign_in_log_group`. */
export const PART_LOGS_OUTPUT = /^(?:[a-z0-9_]+_)?log_group$/;

/** Which output of an app's module says where its front door's record is, or null. */
export function doorLogsOutput(entry) {
  return entry?.delivers?.kind === "package" && entry.outputs && DOOR_LOGS_OUTPUT in entry.outputs ? DOOR_LOGS_OUTPUT : null;
}

/** Which outputs of a module an app uses say where its own logs are, sorted. */
export function partLogsOutputs(entry) {
  if (!entry || entry.delivers || !entry.outputs) return [];
  return Object.keys(entry.outputs).filter(n => PART_LOGS_OUTPUT.test(n)).sort();
}

/**
 * Where a group of an environment's own may be, for the front door and the modules it
 * uses: named for the environment's module name, under the services the platform's role
 * may read there. The app's own group is `/aws/lambda/<name>-...` (`ownLogGroup`).
 */
export const OTHER_LOG_PREFIXES = Object.freeze(["/aws/vendedlogs/apigateway/", "/aws/rds/instance/"]);

/**
 * Whether a group a module output is one of the environment's own, beside the app's:
 * under one of those, named `<name>-dev` and then `-` or `/`, so another app whose name
 * begins with this one's is not taken for it.
 */
export function ownOtherLogGroup(group, name) {
  if (typeof group !== "string" || !name) return false;
  return OTHER_LOG_PREFIXES.some(p => {
    const own = `${p}${name}-${DEVELOPER_STAGE}`;
    return group.startsWith(own) && (group[own.length] === "-" || group[own.length] === "/");
  });
}

/**
 * What a module an app uses is, for reading its lines (`readLine`): a database, whose
 * lines the database phrasebook reads, or another module, whose lines are shown as they
 * are. Read from the needs discovery said it meets.
 */
export function partLogKind(entry) {
  return (entry?.meets || []).includes("relational_database") ? "database" : "module";
}
