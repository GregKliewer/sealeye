// core/upload.js
// The app folder as it travels to the API for an interview (DESIGN.md, "Phase 1: who
// it is for, and how the hosted product is built": the CLI uploads the app).
//
// Both sides live here so they cannot disagree: the CLI zips with zipFolder, the API
// unpacks with unzipInto, and the rules about what may travel are written once.
//
// What travels: the folder, minus what packaging leaves out (node_modules, .git,
// .github, .do), seaLeye's own folders, symlinks, and whatever the folder's .gitignore
// files leave out (build output, virtual environments, caches: what the developer has
// already said is not their source). Secret files (core/secrets.js) travel as their
// names only, even when a .gitignore names them: each is an empty file in the zip, so
// the interview's list_files still shows that a .env exists, while its contents never
// leave the developer's machine.
import fs from "node:fs";
import path from "node:path";

import { unzipSync, zipSync } from "fflate";
import ignore from "ignore";

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

function rulesOf(purpose) {
  const rules = PURPOSES[purpose];
  if (!rules) throw new Error(`no upload purpose called ${purpose}`);
  return rules;
}

/** A file the deploy upload never carries: .env, wherever it is, as the packager had it. */
const isDotEnv = name => path.basename(name).toLowerCase() === ".env";

/** An upload that breaks a rule, said in a sentence a developer can act on. */
export class UploadRefused extends Error {}

/**
 * Zip an app folder for an interview (the default) or a deploy.
 *
 * @returns {{ zip: Uint8Array, files: number, bytes: number, withheld: string[], ignored: number }}
 *          withheld lists the secret files sent as empty names; ignored counts what a
 *          .gitignore left out.
 */
export function zipFolder(dir, { purpose = "interview" } = {}) {
  const rules_ = rulesOf(purpose);
  const root = path.resolve(dir);
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

  const rulesFor = (abs, rel, inherited) => {
    if (!rules_.gitignore) return inherited;
    try {
      const text = fs.readFileSync(path.join(abs, ".gitignore"), "utf8");
      return [...inherited, { base: rel, matcher: ignore().add(text) }];
    } catch {
      return inherited;
    }
  };

  const walk = (abs, rel, inherited) => {
    const rules = rulesFor(abs, rel, inherited);

    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;

      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (rules_.excludedFolders.has(entry.name.toLowerCase())) continue;
        if (gitignored(rules, childRel, true)) { ignored++; continue; }
        walk(childAbs, childRel, rules);
        continue;
      }
      if (!entry.isFile()) continue;

      // A secret file is listed by name whatever .gitignore says: .env is almost always
      // ignored, and knowing it exists is how the model learns the app reads settings.
      if (rules_.secrets === "drop-env" && isDotEnv(entry.name)) continue;
      if (rules_.secrets === "names" && secretFileReason(entry.name)) {
        countFile();
        entries[childRel] = new Uint8Array(0);
        withheld.push(childRel);
        continue;
      }

      if (gitignored(rules, childRel, false)) { ignored++; continue; }
      countFile();

      const data = fs.readFileSync(childAbs);
      bytes += data.length;
      if (bytes > rules_.maxBytes) {
        throw new UploadRefused(`Your folder is bigger than ${rules_.maxBytes / 1024 / 1024} MB, leaving out ${rules_.leftOut}, which is more than ${rules_.readsAs}.`);
      }
      entries[childRel] = new Uint8Array(data.buffer, data.byteOffset, data.length);
    }
  };

  function countFile() {
    files++;
    if (files > rules_.maxFiles) {
      throw new UploadRefused(`Your folder has more than ${rules_.maxFiles} files, leaving out ${rules_.leftOut}, which is more than ${rules_.readsAs}.`);
    }
  }

  walk(root, "", []);
  return { zip: zipSync(entries, { level: 6 }), files, bytes, withheld, ignored };
}

/**
 * Unpack an uploaded zip into `dest`, which must not exist yet. Every rule is checked
 * again here, because the API cannot trust the client that sent it: no absolute paths,
 * nothing that climbs out with "..", nothing in an excluded folder, the same limits,
 * and any secret file that arrives with contents is written empty.
 *
 * A deploy upload follows the deploy rules instead: its own excluded folders and
 * limits, and any .env is not written at all.
 *
 * @returns {{ files: number, bytes: number }}
 */
export function unzipInto(zip, dest, { purpose = "interview" } = {}) {
  const rules = rulesOf(purpose);
  let entries;
  let files = 0;
  let bytes = 0;

  try {
    entries = unzipSync(zip instanceof Uint8Array ? zip : new Uint8Array(zip), {
      // Decide before inflating: a zip can claim small and expand large.
      filter: file => {
        files++;
        bytes += file.originalSize;
        if (files > rules.maxFiles) throw new UploadRefused(`the upload has more than ${rules.maxFiles} files`);
        if (bytes > rules.maxBytes) throw new UploadRefused(`the upload unpacks to more than ${rules.maxBytes / 1024 / 1024} MB`);
        return true;
      }
    });
  } catch (err) {
    if (err instanceof UploadRefused) throw err;
    throw new UploadRefused("the upload is not a zip file seaLeye can read");
  }

  fs.mkdirSync(dest, { recursive: false });
  const root = fs.realpathSync(dest);
  let written = 0;

  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith("/")) continue;   // folder entries; folders are made as needed
    const safe = safeRelative(name, rules.excludedFolders);
    if (!safe) throw new UploadRefused(`the upload has a file path seaLeye will not write: ${name}`);

    const target = path.join(root, ...safe.split("/"));
    if (rules.secrets === "drop-env" && isDotEnv(target)) continue;
    const body = rules.secrets === "names" && secretFileReason(target) ? new Uint8Array(0) : data;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body, { flag: "wx" });
    } catch (err) {
      // The same name twice, or a name that is both a file and a folder.
      throw new UploadRefused(`the upload has two entries that clash at ${safe}`);
    }
    written += body.length;
  }

  return { files: Object.keys(entries).filter(n => !n.endsWith("/")).length, bytes: written };
}

/** A zip entry name as a clean relative path, or null if it is not one we will write. */
function safeRelative(name, excludedFolders) {
  if (typeof name !== "string" || !name || name.includes("\0") || name.includes("\\")) return null;
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return null;
  const parts = name.split("/").filter(p => p !== "" && p !== ".");
  if (!parts.length || parts.some(p => p === "..")) return null;
  // Case-insensitive, as macOS and Windows folders are: .Git is .git there.
  if (parts.slice(0, -1).some(p => excludedFolders.has(p.toLowerCase()))) return null;
  return parts.join("/");
}
