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

/**
 * Each input of a module: its variables, from every .tf file in its own folder.
 *
 * @returns {Record<string, { required: boolean, default?: any, line?: string }>}
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
