// core/upload-rules.js
// What of an app folder travels to the API, and the one walk that decides it, for both
// surfaces: the command walks the folder on disk (core/upload.js), and seaLeye.online
// walks the folder a developer chose in the browser (portal/src/upload.ts). The rules
// are written once, here, so the two cannot send different things (PHASE2-PLAN D6).
//
// It imports nothing but core/secrets.js, so it runs in a browser. What it needs from a
// package (the .gitignore matcher) is handed in by the caller.
//
// What travels: the folder, minus what packaging leaves out (node_modules, .git,
// .github, .do), seaLeye's own folders, symlinks, and whatever the folder's .gitignore
// files leave out (build output, virtual environments, caches: what the developer has
// already said is not their source). Secret files (core/secrets.js) travel as their
// names only, even when a .gitignore names them: each is an empty file in the zip, so
// the interview's list_files still shows that a .env exists, while its contents never
// leave the developer's machine.
import { secretFileReason } from "./secrets.js";

export const EXCLUDED_FOLDERS = new Set(["node_modules", ".git", ".github", ".do", ".sealeye", ".deployme"]);

// An interview reads a few files of at most 20 KB each, so an app much bigger than this
// is almost certainly carrying build output or data it does not need to be read.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;     // unpacked
export const MAX_UPLOAD_FILES = 5000;

/**
 * The two kinds of upload. An interview reads source, so it leaves out what .gitignore
 * leaves out and carries secret files as names. A deploy is what gets packaged, so it
 * follows the packager's rules exactly as they were when the API read the folder in
 * place (api/executor/package.js): everything but node_modules, .git, .github, .do
 * and .env, whose values travel separately with the deploy request. Build output a
 * .gitignore names, a static site's dist/ say, is often exactly what has to ship.
 */
const PURPOSES = {
  interview: {
    excludedFolders: EXCLUDED_FOLDERS,
    gitignore: true,
    secrets: "names",
    maxBytes: MAX_UPLOAD_BYTES,
    maxFiles: MAX_UPLOAD_FILES,
    readsAs: "an interview can read",
    leftOut: "node_modules, .git and what your .gitignore leaves out"
  },
  deploy: {
    excludedFolders: new Set(["node_modules", ".git", ".github", ".do"]),
    gitignore: false,
    secrets: "drop-env",
    // A function's unpacked code is capped at 250 MB with its dependencies, which the
    // platform installs after the upload.
    maxBytes: 100 * 1024 * 1024,
    maxFiles: 20000,
    readsAs: "the platform can package",
    leftOut: "node_modules and .git"
  }
};

export function rulesOf(purpose) {
  const rules = PURPOSES[purpose];
  if (!rules) throw new Error(`no upload purpose called ${purpose}`);
  return rules;
}

/** A file the deploy upload never carries: .env, wherever it is, as the packager had it. */
export const isDotEnv = name => (String(name).split("/").pop() || "").toLowerCase() === ".env";

/** An upload that breaks a rule, said in a sentence a developer can act on. */
export class UploadRefused extends Error {}

/**
 * Walk a folder and decide what travels. The folder is any tree of nodes:
 *
 *   { name, kind: "dir", children(): node[] | Promise<node[]> }
 *   { name, kind: "file", size, bytes(): Uint8Array | Promise<Uint8Array>, text(): string | Promise<string> }
 *   { name, kind: "other" }   (a symlink or anything else: never travels)
 *
 * so the command can hand it the disk and the portal the browser's folder.
 *
 * @param {object} root                      the folder's own node
 * @param {object} options
 * @param {"interview"|"deploy"} [options.purpose]
 * @param {() => {add(text: string): object, test(path: string): {ignored: boolean, unignored: boolean}}} options.ignore
 *        a .gitignore matcher factory (the `ignore` package's default export)
 * @returns {Promise<{ entries: Record<string, Uint8Array>, files: number, bytes: number, withheld: string[], ignored: number }>}
 *          withheld lists the secret files sent as empty names; ignored counts what a
 *          .gitignore left out.
 */
export async function collectUpload(root, { purpose = "interview", ignore } = {}) {
  const rules_ = rulesOf(purpose);
  if (rules_.gitignore && typeof ignore !== "function") throw new Error("collectUpload needs a .gitignore matcher for an interview upload");
  const entries = {};
  const withheld = [];
  let files = 0;
  let bytes = 0;
  let ignored = 0;

  // Every .gitignore from the root down to the folder being read, each applied to paths
  // relative to its own folder, as git applies them: a deeper file's rule wins, so its
  // "!keep.log" brings back what a parent's "*.log" left out.
  const gitignored = (rules, rel, isDir) => {
    let ignoredHere = false;
    for (const { base, matcher } of rules) {
      const own = base ? rel.slice(base.length + 1) : rel;
      if (own === "") continue;
      const verdict = matcher.test(isDir ? `${own}/` : own);
      if (verdict.ignored) ignoredHere = true;
      else if (verdict.unignored) ignoredHere = false;
    }
    return ignoredHere;
  };

  const countFile = () => {
    files++;
    if (files > rules_.maxFiles) {
      throw new UploadRefused(`Your folder has more than ${rules_.maxFiles} files, leaving out ${rules_.leftOut}, which is more than ${rules_.readsAs}.`);
    }
  };

  const walk = async (dir, rel, inherited) => {
    const children = await dir.children();
    let rules = inherited;
    if (rules_.gitignore) {
      const own = children.find(c => c.kind === "file" && c.name === ".gitignore");
      if (own) {
        try {
          rules = [...inherited, { base: rel, matcher: ignore().add(String(await own.text())) }];
        } catch {
          rules = inherited;
        }
      }
    }

    // In name order, so both surfaces walk the same folder the same way.
    for (const child of [...children].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const childRel = rel ? `${rel}/${child.name}` : child.name;

      if (child.kind === "dir") {
        if (rules_.excludedFolders.has(child.name.toLowerCase())) continue;
        if (gitignored(rules, childRel, true)) { ignored++; continue; }
        await walk(child, childRel, rules);
        continue;
      }
      if (child.kind !== "file") continue;

      // A secret file is listed by name whatever .gitignore says: .env is almost always
      // ignored, and knowing it exists is how the model learns the app reads settings.
      if (rules_.secrets === "drop-env" && isDotEnv(child.name)) continue;
      if (rules_.secrets === "names" && secretFileReason(child.name)) {
        countFile();
        entries[childRel] = new Uint8Array(0);
        withheld.push(childRel);
        continue;
      }

      if (gitignored(rules, childRel, false)) { ignored++; continue; }
      countFile();

      // Checked before reading, so a browser never reads a file it would refuse.
      if (bytes + (child.size || 0) > rules_.maxBytes) throw tooBig();
      const data = await child.bytes();
      bytes += data.length;
      if (bytes > rules_.maxBytes) throw tooBig();
      entries[childRel] = data;
    }
  };

  function tooBig() {
    return new UploadRefused(`Your folder is bigger than ${rules_.maxBytes / 1024 / 1024} MB, leaving out ${rules_.leftOut}, which is more than ${rules_.readsAs}.`);
  }

  await walk(root, "", []);
  return { entries, files, bytes, withheld, ignored };
}

/**
 * A folder given as a flat list of files, as a browser's folder input gives it (each
 * with its path inside the folder), as the tree collectUpload walks. Folders exist by
 * having files in them; an empty folder has nothing to send anyway.
 *
 * @param {string} rootName
 * @param {{ path: string, size: number, bytes(): any, text(): any }[]} files
 */
export function treeFromPaths(rootName, files) {
  const root = { name: rootName, kind: "dir", map: new Map() };
  for (const file of files) {
    const parts = String(file.path).split("/").filter(p => p && p !== ".");
    if (!parts.length || parts.includes("..")) continue;
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.map.get(part);
      if (!next) {
        next = { name: part, kind: "dir", map: new Map() };
        dir.map.set(part, next);
      }
      if (next.kind !== "dir") break;
      dir = next;
    }
    const name = parts[parts.length - 1];
    if (!dir.map.has(name)) dir.map.set(name, { name, kind: "file", size: file.size, bytes: () => file.bytes(), text: () => file.text() });
  }
  const finish = node => (node.kind === "dir" ? { name: node.name, kind: "dir", children: () => [...node.map.values()].map(finish) } : node);
  return finish(root);
}
