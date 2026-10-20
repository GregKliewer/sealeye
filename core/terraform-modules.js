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
  if (!delivers || (delivers.kind !== "package" && delivers.kind !== "files")) {
    return no("it does not take an app's code, and the platform does not connect modules to each other yet");
  }
  if (delivers.kind === "package" && codeInputs(entry).length !== 2) return no("it does not say which input takes the app and which the function to call");
  if (delivers.kind === "files" && !(typeof delivers.output === "string" && delivers.output)) return no("it does not say where a site's files go");

  const names = new Set(Array.isArray(platform?.names) ? platform.names : []);
  const own = new Set([...SEALEYE_INPUTS, ...codeInputs(entry)]);
  const missing = Object.entries(entry.inputs || {})
    .filter(([name, spec]) => spec && spec.required === true && !own.has(name) && !platformNameFor(entry.id, name, names))
    .map(([name]) => name)
    .sort();
  if (missing.length) {
    return no(`the platform has no value for its ${missing.join(", ")} input${missing.length === 1 ? "" : "s"}`, missing);
  }
  return { builds: true, why: null, missing: [] };
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
        .map(([name, spec]) => ({ input: name, required: spec?.required === true, line: spec?.line || null, filledBy: platformNameFor(m.id, name, set) }));
      const { builds, why } = terraformBuilds(m, { names: [...set] });
      const open = Array.isArray(m.open) && m.open.length > 0;
      return { module: m.id, source: m.source || null, inputs, builds: builds && !open, why: open ? "it rests on a question not yet answered" : why };
    });
}

/**
 * The inputs a module is given from the organization's platform values, by input, and the
 * name each comes from. Required or not: a value set for an optional input fills it too.
 *
 * @param {object} entry
 * @param {Record<string, string | string[]>} values  name -> value, at the stage
 * @returns {Record<string, { from: string, value: string | string[] }>}
 */
export function platformInputs(entry, values = {}) {
  const names = Object.keys(values);
  const own = new Set([...SEALEYE_INPUTS, ...codeInputs(entry)]);
  const out = {};
  for (const input of Object.keys(entry?.inputs || {})) {
    if (own.has(input)) continue;
    const from = platformNameFor(entry.id, input, names);
    if (from) out[input] = { from, value: values[from] };
  }
  return out;
}
