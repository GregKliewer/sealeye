// api/executor/terraform/root.js
// The root module one environment is built from (DESIGN.md, "A Terraform executor builds
// an organization's own modules"): `main.tf.json`, written by code, never a template a
// person edits and never text a model wrote. It calls the organization's module from
// its library, with every input it needs from one of three sources (core/
// terraform-modules.js), keeps its state in S3 with a lock file, and pins the one
// provider.
//
// What the record keeps of it: each input's name and where it came from, and the
// checksum of the file. Values the platform team set are identifiers and could be kept,
// but the record keeps names, as it does for settings.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { region } from "../../../core/config.js";
import { safeName } from "../../../core/names.js";
import { DEVELOPER_STAGE, SEALEYE_INPUTS, codeInputs, platformInputs } from "../../../core/terraform-modules.js";
import { AWS_PROVIDER_VERSION, IMAGE_LOCK_FILE } from "./tofu.js";

/** The function the adapter seaLeye puts into an app's package exports (templates/sealeye-handler.mjs). */
export const ADAPTER_HANDLER = "sealeye-handler.handler";

/** A plan's input value as OpenTofu takes it: a word, a number, true or false, or a list or map of words. */
const plainValue = v =>
  ["string", "number", "boolean"].includes(typeof v) ||
  (Array.isArray(v) && v.every(x => ["string", "number", "boolean"].includes(typeof x))) ||
  (v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every(x => ["string", "number", "boolean"].includes(typeof x)));

/** Where each environment's state is kept, in the platform's bucket. */
export function stateKeyFor({ org = "default", environment }) {
  return `tofu-state/${safeName(org) || "default"}/${environment}.tfstate`;
}

/**
 * Every input the module is given, and from where.
 *
 * @param {object} p
 * @param {object} p.entry          the catalog's entry for the module
 * @param {object} p.planModule     the plan's module ({ id, inputs })
 * @param {string} p.name           the module's name (moduleName in core/names.js)
 * @param {Record<string,string>} p.tags
 * @param {Record<string, string | string[]>} p.platform  the organization's values at dev
 * @param {{ package?: string }} [p.code]  the packaged app, for a module that takes one
 * @returns {{ inputs: Record<string, any>, sources: { name: string, source: string, from?: string }[], ignored: string[] }}
 * @throws Error naming what the plan asks that cannot be given
 */
export function inputsFor({ entry, planModule, name, tags, platform = {}, code = {} }) {
  const declared = entry.inputs || {};
  const inputs = {};
  const sources = [];
  const give = (input, value, source, from) => {
    inputs[input] = value;
    sources.push({ name: input, source, ...(from ? { from } : {}) });
  };

  if ("name" in declared) give("name", name, "seaLeye");
  if ("stage" in declared) give("stage", DEVELOPER_STAGE, "seaLeye");
  if ("tags" in declared) give("tags", tags, "seaLeye");
  const d = entry.delivers || {};
  if (d.kind === "package") {
    if (!code.package) throw new Error("the platform has no package of your app to give the module");
    give(d.package, code.package, "your app's code");
    give(d.handler, ADAPTER_HANDLER, "seaLeye");
  }
  for (const [input, { from, value }] of Object.entries(platformInputs(entry, platform))) give(input, value, "platform value", from);

  // What the plan asks for itself: an optional input the module takes, with a plain
  // value. seaLeye's own inputs and the platform's are never the plan's to set, so a
  // plan that names one is built with seaLeye's or the platform's (`ignored`).
  const filled = new Set(Object.keys(inputs));
  const own = new Set([...SEALEYE_INPUTS, ...codeInputs(entry)]);
  const ignored = [];
  for (const [input, value] of Object.entries(planModule?.inputs || {})) {
    if (filled.has(input) || own.has(input)) { ignored.push(input); continue; }
    if (!(input in declared)) throw new Error(`the plan gives ${planModule.id} an input called ${input}, which the module does not take`);
    if (declared[input]?.required) { ignored.push(input); continue; }
    if (input === "environment" && value && typeof value === "object" && Object.keys(value).length) {
      throw new Error("the plan gives the app settings, and settings do not reach an app built from your organization's modules yet: a value passed in would be kept in plain text where the environment is recorded");
    }
    if (!plainValue(value)) throw new Error(`the plan gives ${planModule.id} a value for ${input} the platform cannot pass on`);
    give(input, value, "the plan");
  }

  const missing = Object.entries(declared).filter(([n, spec]) => spec?.required && !(n in inputs)).map(([n]) => n);
  if (missing.length) throw new Error(`the platform has no value for ${missing.join(", ")}, which ${entry.id} needs, so nothing was built. Ask your platform team.`);
  return { inputs, sources, ignored: ignored.sort() };
}

/**
 * The root module, as the JSON OpenTofu reads.
 *
 * @param {object} p
 * @param {string} p.moduleSource  the module's folder, relative to the root module
 * @param {Record<string, any>} p.inputs
 * @param {string[]} p.outputs     the module's outputs to read back
 * @param {{ bucket: string, key: string }} p.state
 * @param {Record<string,string>} p.tags  on every resource the provider makes
 */
export function rootModule({ moduleSource, inputs, outputs, state, tags }) {
  return {
    terraform: {
      required_version: ">= 1.10.0",
      required_providers: { aws: { source: "hashicorp/aws", version: AWS_PROVIDER_VERSION } },
      backend: { s3: { bucket: state.bucket, key: state.key, region: region(), encrypt: true, use_lockfile: true } }
    },
    provider: { aws: [{ region: region(), default_tags: [{ tags }] }] },
    module: { app: { source: moduleSource, ...inputs } },
    output: Object.fromEntries(outputs.map(o => [o, { value: `\${module.app.${o}}` }]))
  };
}

/** The outputs worth reading back: the app's address, and where a site's files go. */
export function outputsWanted(entry) {
  const d = entry.delivers || {};
  return [...new Set([d.address, d.kind === "files" ? d.output : null].filter(Boolean))].filter(o => o in (entry.outputs || {}));
}

/**
 * Write the root module into `dir`, with the library beside it, and the provider's lock
 * file when the image has one. Returns the file's sha256, for the change record.
 */
export function writeRoot(dir, { root, libraryDir }) {
  fs.mkdirSync(dir, { recursive: true });
  const lib = path.join(dir, "library");
  fs.rmSync(lib, { recursive: true, force: true });
  fs.cpSync(libraryDir, lib, { recursive: true });
  const text = `${JSON.stringify(root, null, 2)}\n`;
  fs.writeFileSync(path.join(dir, "main.tf.json"), text);
  if (fs.existsSync(IMAGE_LOCK_FILE)) fs.copyFileSync(IMAGE_LOCK_FILE, path.join(dir, ".terraform.lock.hcl"));
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** Whether the image's lock file was used, so `init` may not change it. */
export const lockedProviders = dir => fs.existsSync(path.join(dir, ".terraform.lock.hcl")) && fs.existsSync(IMAGE_LOCK_FILE);
