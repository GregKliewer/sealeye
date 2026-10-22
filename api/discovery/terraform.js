// api/discovery/terraform.js
// What plain code reads from a Terraform library, so no model has to (PHASE4-PLAN Step 6,
// Greg, Oct 15, 2026): which folders are modules, what each takes as inputs, and a hash
// of each module's files so a later run reads only what changed.
//
// A module is a folder with .tf files of its own that is not an example, a test or a
// fixture: Terraform's own convention for a library of modules. Its inputs are its
// `variable` blocks: the name, whether it has a default (and so is optional), the
// default when it is a plain value, and the description, which is the platform team's
// own line for it. Exact, where a model would guess.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Folders that hold modules' examples or tests, not modules. A module's own nested
// modules (modules/x/modules/y) are modules of their own.
const NOT_A_MODULE = new Set(["examples", "example", "test", "tests", "fixtures", ".terraform", ".github", "node_modules"]);

const tfFiles = dir => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith(".tf")).map(e => e.name).sort();
  } catch {
    return [];
  }
};

/**
 * Every module folder in a library, as a path inside it ("modules/postgres"), in name
 * order. The library's root is a module too when it holds .tf files of its own.
 */
export function listModules(libraryDir) {
  const found = [];
  const walk = (dir, rel) => {
    if (tfFiles(dir).length) found.push(rel || ".");
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!entry.isDirectory() || NOT_A_MODULE.has(entry.name.toLowerCase())) continue;
      walk(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
    }
  };
  walk(libraryDir, "");
  return found;
}

/**
 * A hash of everything in a module's folder (names and contents, examples included, but
 * not a nested module's files), so a run can tell a module that changed from one that
 * did not.
 */
export function moduleHash(libraryDir, source) {
  const root = path.join(libraryDir, source);
  const nested = new Set(listModules(root).filter(s => s !== "."));
  const hash = crypto.createHash("sha256");
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!nested.has(childRel)) walk(path.join(dir, entry.name), childRel);
      } else if (entry.isFile()) {
        hash.update(`${childRel}\0`);
        hash.update(fs.readFileSync(path.join(dir, entry.name)));
        hash.update("\0");
      }
    }
  };
  walk(root, "");
  return hash.digest("hex").slice(0, 16);
}

/**
 * A hash of what every reader may read beyond its own module: the library's README.md
 * and its pipeline under .github/ (`mayRead` in readers.js). When it changes, the rules
 * every module is read against may have changed, so every module is read again
 * (DESIGN.md, "Discovery reads again only what changed").
 */
export function libraryHash(libraryDir) {
  const hash = crypto.createHash("sha256");
  const add = (rel, file) => {
    hash.update(`${rel}\0`);
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  };
  const readme = path.join(libraryDir, "README.md");
  if (fs.existsSync(readme) && fs.statSync(readme).isFile()) add("README.md", readme);
  const walk = (dir, rel) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
      else if (entry.isFile()) add(childRel, path.join(dir, entry.name));
    }
  };
  walk(path.join(libraryDir, ".github"), ".github");
  return hash.digest("hex").slice(0, 16);
}

/** The body of each top-level `variable "name" { ... }` block, braces balanced. */
function variableBlocks(text) {
  const blocks = [];
  const re = /^variable\s+"([A-Za-z0-9_-]+)"\s*\{/gm;
  let m;
  while ((m = re.exec(text))) {
    let depth = 1;
    let i = re.lastIndex;
    let inString = false;
    for (; i < text.length && depth > 0; i++) {
      const c = text[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "#" || (c === "/" && text[i + 1] === "/")) {
        const end = text.indexOf("\n", i);
        i = end === -1 ? text.length : end;
      } else if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    blocks.push({ name: m[1], body: text.slice(re.lastIndex, i - 1) });
    re.lastIndex = i;
  }
  return blocks;
}

/** A plain default (a string, a number, true or false, an empty list or map), or undefined. */
function plainDefault(body) {
  const m = body.match(/^\s*default\s*=\s*(.+?)\s*$/m);
  if (!m) return undefined;
  const v = m[1].replace(/\s+#.*$/, "");
  if (/^"(?:[^"\\]|\\.)*"$/.test(v)) return JSON.parse(v);
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v);
  if (v === "true" || v === "false") return v === "true";
  if (v === "null") return null;
  if (v === "[]") return [];
  if (v === "{}") return {};
  return undefined;
}

/** A variable's declared type, as its shape: a list (list, set, tuple), a map (map, object), or a plain value. */
function typeOf(body) {
  const m = body.match(/^\s*type\s*=\s*([a-z]+)/m);
  if (!m) return null;
  if (["list", "set", "tuple"].includes(m[1])) return "list";
  if (["map", "object"].includes(m[1])) return "map";
  return ["string", "number", "bool"].includes(m[1]) ? m[1] : null;
}

/**
 * Each input of a module: its variables, from every .tf file in its own folder.
 *
 * @returns {Record<string, { required: boolean, default?: any, line?: string, sensitive?: true, type?: "list" | "map" | "string" | "number" | "bool" }>}
 */
export function moduleInputs(moduleDir) {
  const inputs = {};
  for (const file of tfFiles(moduleDir)) {
    const text = fs.readFileSync(path.join(moduleDir, file), "utf8");
    for (const { name, body } of variableBlocks(text)) {
      const hasDefault = /^\s*default\s*=/m.test(body);
      const input = { required: !hasDefault };
      if (hasDefault) {
        const value = plainDefault(body);
        if (value !== undefined) input.default = value;
      }
      const description = body.match(/^\s*description\s*=\s*"((?:[^"\\]|\\.)*)"/m);
      if (description) input.line = JSON.parse(`"${description[1]}"`);
      // The shape the module takes it in, so a platform value of one word reaches an
      // input that takes a list as a list of one (inputsFor).
      const type = typeOf(body);
      if (type) input.type = type;
      // A value the module marks sensitive is never one a plan may give (inputsFor).
      if (/^\s*sensitive\s*=\s*true\b/m.test(body)) input.sensitive = true;
      inputs[name] = input;
    }
  }
  return inputs;
}

/** A module's folder as a catalog id: lowercase letters, digits and underscores. */
export function idFor(source) {
  const base = source === "." ? "root" : source.split("/").pop();
  const id = base.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(id) ? id : `m_${id || "module"}`;
}

// ---------------------------------------------------------------------------
// What a module does with an app, and what it would run (PHASE4-PLAN Step 9; DESIGN.md,
// "What a Terraform module needs before seaLeye builds it"). Read by code, so the
// catalog says it exactly and whoever approves the catalog sees it.
// ---------------------------------------------------------------------------

/** HCL without its comments, strings kept, so a word in a comment is never read as code. */
export function withoutComments(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "#" || (c === "/" && text[i + 1] === "/")) {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end - 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    out += c;
  }
  return out;
}

const codeOf = dir => tfFiles(dir).map(f => withoutComments(fs.readFileSync(path.join(dir, f), "utf8"))).join("\n");

/** The body of each top-level `<kind> "name" { ... }` block, braces balanced. */
function blocksOf(text, kind) {
  const blocks = [];
  const re = new RegExp(`^${kind}\\s+"([A-Za-z0-9_-]+)"\\s*\\{`, "gm");
  let m;
  while ((m = re.exec(text))) {
    let depth = 1;
    let i = re.lastIndex;
    let inString = false;
    for (; i < text.length && depth > 0; i++) {
      const c = text[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    blocks.push({ name: m[1], body: text.slice(re.lastIndex, i - 1) });
    re.lastIndex = i;
  }
  return blocks;
}

/**
 * A module's outputs: each one's name and its description, the platform team's own line.
 *
 * @returns {Record<string, { line?: string }>}
 */
export function moduleOutputs(moduleDir) {
  const outputs = {};
  for (const file of tfFiles(moduleDir)) {
    const text = fs.readFileSync(path.join(moduleDir, file), "utf8");
    for (const { name, body } of blocksOf(text, "output")) {
      const description = body.match(/^\s*description\s*=\s*"((?:[^"\\]|\\.)*)"/m);
      outputs[name] = description ? { line: JSON.parse(`"${description[1]}"`) } : {};
    }
  }
  return outputs;
}

// The names a module gives the input that takes a zipped app, and the one naming the
// function the platform calls in it.
const PACKAGE_INPUT = /^(?:package|package_path|package_file|package_zip|zip|zip_path|zip_file|artifact|artifact_path|filename|source_zip)$/;
const HANDLER_INPUT = /^handler$/;
// An output a site's files are uploaded to: named for a bucket, and saying the files go there.
const FILES_OUTPUT = /^(?:bucket|bucket_name|site_bucket|files_bucket|site_bucket_name)$/;
const FILES_LINE = /\b(?:upload|files?\b)/i;
// The output that is the app's address.
const ADDRESS_OUTPUT = /^(?:url|address|site_url|api_url|endpoint)$/;
// The output that says where the app's logs are kept, for a module that runs an app's
// code (DESIGN.md, "A Terraform environment's logs are read where its module says they are").
const LOGS_OUTPUT = /^log_group(?:_name)?$/;

/**
 * How a module takes an app, from its inputs and outputs, or null when it takes none:
 *
 * - { kind: "package", package, handler, address? }: a zipped app, and the function to call;
 * - { kind: "files", output, address? }: an output to upload a site's files to.
 *
 * `address` names the output that is the app's address, when there is one.
 */
export function deliversOf(inputs = {}, outputs = {}) {
  const address = Object.keys(outputs).find(n => ADDRESS_OUTPUT.test(n));
  const logs = Object.keys(outputs).find(n => LOGS_OUTPUT.test(n));
  const pkg = Object.keys(inputs).find(n => PACKAGE_INPUT.test(n));
  const handler = Object.keys(inputs).find(n => HANDLER_INPUT.test(n));
  if (pkg && handler) return { kind: "package", package: pkg, handler, ...(address ? { address } : {}), ...(logs ? { logs } : {}) };
  const files = Object.entries(outputs).find(([n, o]) => FILES_OUTPUT.test(n) && FILES_LINE.test(o?.line || ""));
  if (files) return { kind: "files", output: files[0], ...(address ? { address } : {}) };
  return null;
}

// What a module offers an app that uses it (PHASE4-PLAN Step 9, connecting modules;
// DESIGN.md, "Modules are connected through what the library offers"): a policy granting
// access, made by the module itself, and a narrower one beside it; a secret the app may
// read; and the values the app looks each one up by.
const ACCESS_OUTPUT = /^access_policy_arn$/;
const POLICY_OUTPUT = /_policy_arn$/;
const SECRET_OUTPUT = /_secret_arn$/;
// What an app module takes of them.
const POLICIES_INPUT = /^policy_arns$/;
const SECRETS_INPUT = /^secret_arns$/;
const ENVIRONMENT_INPUT = /^environment$/;

/**
 * How a module connects to another, from its inputs and outputs, by code:
 *
 * - `offers`, for a module an app uses: `access` (the output granting what the app needs),
 *   `narrower` (other policies), `secrets` (secrets the app may read) and `values` (what
 *   the app looks it up by: a name, an address), each by output name. Only a module that
 *   grants access or a secret offers anything: an app cannot use the rest.
 * - `accepts`, for a module that runs an app: the inputs that take policies, secrets and
 *   the settings the app reads.
 *
 * @returns {{ offers?: object, accepts?: object }}
 */
export function connectsOf(inputs = {}, outputs = {}) {
  const names = Object.keys(outputs);
  const access = names.find(n => ACCESS_OUTPUT.test(n)) || null;
  const secrets = names.filter(n => SECRET_OUTPUT.test(n)).sort();
  const out = {};
  if (access || secrets.length) {
    out.offers = {
      access,
      narrower: names.filter(n => POLICY_OUTPUT.test(n) && n !== access).sort(),
      secrets,
      values: names.filter(n => !/_arns?$|_ids?$/.test(n) && n !== "role_name").sort()
    };
  }
  const takes = Object.keys(inputs);
  const policies = takes.find(n => POLICIES_INPUT.test(n));
  const secretsIn = takes.find(n => SECRETS_INPUT.test(n));
  const environment = takes.find(n => ENVIRONMENT_INPUT.test(n));
  if (policies || secretsIn) {
    out.accepts = { ...(policies ? { policies } : {}), ...(secretsIn ? { secrets: secretsIn } : {}), ...(environment ? { environment } : {}) };
  }
  return out;
}

/**
 * What a module's code would run on the platform's own server, or reach beyond the
 * library, in words: a provisioner, the `external` data source, another state, any
 * provider but AWS, or a nested module from outside the library. Empty when there is
 * nothing. A nested module inside the library is read too, as it would run.
 *
 * @param {string} libraryDir  the library's root
 * @param {string} source      the module's folder in it
 * @returns {string[]}
 */
export function moduleRuns(libraryDir, source) {
  const root = path.resolve(libraryDir);
  const found = new Set();
  const seen = new Set();
  const visit = rel => {
    const dir = path.resolve(root, rel);
    if (seen.has(dir)) return;
    seen.add(dir);
    const code = codeOf(dir);
    for (const m of code.matchAll(/\bprovisioner\s+"([A-Za-z0-9_-]+)"/g)) found.add(`a provisioner (${m[1]})`);
    if (/\bdata\s+"external"/.test(code)) found.add("the external data source");
    if (/\bdata\s+"terraform_remote_state"/.test(code)) found.add("another environment's state (terraform_remote_state)");
    // Providers named in required_providers, and any resource or data source of one.
    for (const m of code.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=\s*\{[^}]*source\s*=\s*"([^"]+)"/gm)) {
      const src = m[2].toLowerCase().replace(/^registry\.(?:opentofu|terraform)\.io\//, "");
      if (src !== "hashicorp/aws") found.add(`the ${src} provider`);
    }
    for (const m of code.matchAll(/^\s*(?:resource|data)\s+"([a-z0-9]+)_[A-Za-z0-9_]+"/gm)) {
      if (m[1] !== "aws" && m[1] !== "terraform") found.add(`the ${m[1]} provider`);
    }
    for (const { name, body } of blocksOf(code, "module")) {
      const src = body.match(/^\s*source\s*=\s*"([^"]*)"/m)?.[1];
      const target = src ? path.resolve(dir, src) : null;
      if (!src || !/^\.\.?\//.test(src) || !target || !(target === root || target.startsWith(root + path.sep))) {
        found.add(`a module from outside the library (${name}${src ? `: ${src}` : ""})`);
      } else if (fs.existsSync(target)) {
        visit(path.relative(root, target));
      } else {
        found.add(`a module that is not in the library (${name}: ${src})`);
      }
    }
  };
  visit(source);
  return [...found].sort();
}
