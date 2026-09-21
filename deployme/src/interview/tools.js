// src/interview/tools.js
// The two read-only tools the interview gives the model, scoped to one app folder.
//
// The developer's folder is read-only to seaLeye.run, and the model only ever sees
// what is inside it: every path is resolved, symlinks included, and rejected if it
// lands outside the folder or inside node_modules or .git.
import fs from "node:fs";
import path from "node:path";

const MAX_ENTRIES = 40;          // list_files
const MAX_BYTES = 20 * 1024;     // read_file
const BLOCKED = new Set(["node_modules", ".git", ".deployme"]);

export const listFilesTool = {
  name: "list_files",
  description:
    "List the names in a folder inside the developer's app, so you can see what the " +
    "app is made of. Use \".\" for the app folder itself. Read-only. Returns at most " +
    `${MAX_ENTRIES} entries, folders marked with a trailing slash.`,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: {
        type: "string",
        description: 'Folder path relative to the app folder. "." for the app folder itself.'
      }
    }
  }
};

export const readFileTool = {
  name: "read_file",
  description:
    "Read a text file inside the developer's app folder, so you can see how the app " +
    `starts and what it needs. Read-only. Truncated at ${MAX_BYTES / 1024} KB.`,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", description: "File path relative to the app folder." }
    }
  }
};

/** A tool asked for something outside the folder, or something it may not have. */
export class ToolRefusal extends Error {}

/**
 * Resolve a model-supplied path to a real path inside the app folder, or refuse.
 * Symlinks are resolved before the check, so a link pointing out of the folder is
 * refused rather than followed.
 */
export function resolveInside(appPath, requested) {
  if (typeof requested !== "string" || requested.trim() === "") {
    throw new ToolRefusal("path is required");
  }
  if (path.isAbsolute(requested)) {
    throw new ToolRefusal("path must be relative to the app folder");
  }

  const root = fs.realpathSync(appPath);
  const target = path.resolve(root, requested);

  // Reject the blocked folders by name, before touching the disk.
  const relative = path.relative(root, target);
  const segments = relative === "" ? [] : relative.split(path.sep);
  if (segments.some(s => s === "..")) {
    throw new ToolRefusal("that path is outside your app folder");
  }
  for (const segment of segments) {
    if (BLOCKED.has(segment)) throw new ToolRefusal(`${segment} is not readable`);
  }

  // Resolve symlinks: the real path has to be inside the folder too. A path that does
  // not exist yet is resolved through its nearest existing parent.
  const real = realpathOfNearest(target);
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new ToolRefusal("that path leaves your app folder");
  }

  return target;
}

function realpathOfNearest(target) {
  let candidate = target;
  while (true) {
    try {
      return fs.realpathSync(candidate);
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) return candidate;
      candidate = parent;
    }
  }
}

/** Names in a folder, folders marked with a trailing slash, capped at 40. */
export function listFiles(appPath, requested = ".") {
  const dir = resolveInside(appPath, requested);

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOTDIR") throw new ToolRefusal(`${requested} is a file, not a folder`);
    if (err.code === "ENOENT") throw new ToolRefusal(`${requested} does not exist`);
    throw new ToolRefusal(`could not read ${requested}`);
  }

  const visible = entries
    .filter(e => !BLOCKED.has(e.name))
    .map(e => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();

  const shown = visible.slice(0, MAX_ENTRIES);
  const omitted = visible.length - shown.length;

  return omitted > 0
    ? `${shown.join("\n")}\n(${omitted} more entries not shown)`
    : shown.join("\n") || "(empty folder)";
}

/** A text file, capped at 20 KB. */
export function readFile(appPath, requested) {
  const file = resolveInside(appPath, requested);

  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new ToolRefusal(`${requested} does not exist`);
  }
  if (stat.isDirectory()) throw new ToolRefusal(`${requested} is a folder, use list_files`);

  const handle = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(MAX_BYTES);
    const read = fs.readSync(handle, buffer, 0, MAX_BYTES, 0);
    const text = buffer.subarray(0, read).toString("utf8");
    return stat.size > MAX_BYTES ? `${text}\n(truncated at ${MAX_BYTES / 1024} KB)` : text;
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * Run one tool call by name. Refusals come back as text for the model to read, not as
 * exceptions: a refused path is a normal event in a conversation, not a crash.
 */
export function runTool(appPath, name, input = {}) {
  try {
    if (name === "list_files") return { content: listFiles(appPath, input.path), isError: false };
    if (name === "read_file") return { content: readFile(appPath, input.path), isError: false };
    return { content: `no tool named ${name}`, isError: true };
  } catch (err) {
    if (err instanceof ToolRefusal) return { content: `refused: ${err.message}`, isError: true };
    return { content: `could not run ${name}: ${err.message}`, isError: true };
  }
}

/**
 * The short digest the CLI sends as the first user message: enough for the model to
 * skip the questions the folder already answers.
 */
export function folderDigest(appPath) {
  const lines = [];
  const name = path.basename(path.resolve(appPath));
  lines.push(`Folder name: ${name}`);

  let top = "";
  try {
    top = listFiles(appPath, ".");
  } catch {
    top = "(could not read the folder)";
  }
  lines.push("", "Top level of the folder:", top);

  const pkgPath = path.join(appPath, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      lines.push(
        "",
        "package.json:",
        `  name: ${pkg.name || "(none)"}`,
        `  main: ${pkg.main || "(none)"}`,
        `  scripts: ${JSON.stringify(pkg.scripts || {})}`,
        `  dependencies: ${Object.keys(pkg.dependencies || {}).join(", ") || "(none)"}`
      );
    } catch {
      lines.push("", "package.json: present but could not be parsed");
    }
  } else {
    lines.push("", "package.json: none");
  }

  lines.push("", `index.html at the root: ${fs.existsSync(path.join(appPath, "index.html")) ? "yes" : "no"}`);

  return lines.join("\n");
}
