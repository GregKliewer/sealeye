// core/upload.js
// The app folder as it travels to the API for an interview (DESIGN.md, "Phase 1: who
// it is for, and how the hosted product is built": the CLI uploads the app).
//
// Both sides live here so they cannot disagree: the CLI zips with zipFolder, the API
// unpacks with unzipInto, and the rules about what may travel are written once.
//
// What travels: the folder, minus what packaging leaves out (node_modules, .git,
// .github, .do), seaLeye's own folders, and symlinks. Secret files (core/secrets.js)
// travel as their names only: each is an empty file in the zip, so the interview's
// list_files still shows that a .env exists, while its contents never leave the
// developer's machine.
import fs from "node:fs";
import path from "node:path";

import { unzipSync, zipSync } from "fflate";

import { secretFileReason } from "./secrets.js";

export const EXCLUDED_FOLDERS = new Set(["node_modules", ".git", ".github", ".do", ".sealeye", ".deployme"]);

// An interview reads a few files of at most 20 KB each, so an app much bigger than this
// is almost certainly carrying build output or data it does not need to be read.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;     // unpacked
export const MAX_UPLOAD_FILES = 5000;

/** An upload that breaks a rule, said in a sentence a developer can act on. */
export class UploadRefused extends Error {}

/**
 * Zip an app folder for an interview.
 *
 * @returns {{ zip: Uint8Array, files: number, bytes: number, withheld: string[] }}
 *          withheld lists the secret files sent as empty names.
 */
export function zipFolder(dir) {
  const root = path.resolve(dir);
  const entries = {};
  const withheld = [];
  let files = 0;
  let bytes = 0;

  const walk = (abs, rel) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;

      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (EXCLUDED_FOLDERS.has(entry.name)) continue;
        walk(childAbs, childRel);
        continue;
      }
      if (!entry.isFile()) continue;

      files++;
      if (files > MAX_UPLOAD_FILES) {
        throw new UploadRefused(`Your folder has more than ${MAX_UPLOAD_FILES} files outside node_modules and .git, which is more than an interview can read.`);
      }

      if (secretFileReason(entry.name)) {
        entries[childRel] = new Uint8Array(0);
        withheld.push(childRel);
        continue;
      }

      const data = fs.readFileSync(childAbs);
      bytes += data.length;
      if (bytes > MAX_UPLOAD_BYTES) {
        throw new UploadRefused(`Your folder is bigger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB outside node_modules and .git, which is more than an interview can read.`);
      }
      entries[childRel] = new Uint8Array(data.buffer, data.byteOffset, data.length);
    }
  };

  walk(root, "");
  return { zip: zipSync(entries, { level: 6 }), files, bytes, withheld };
}

/**
 * Unpack an uploaded zip into `dest`, which must not exist yet. Every rule is checked
 * again here, because the API cannot trust the client that sent it: no absolute paths,
 * nothing that climbs out with "..", nothing in an excluded folder, the same limits,
 * and any secret file that arrives with contents is written empty.
 *
 * @returns {{ files: number, bytes: number }}
 */
export function unzipInto(zip, dest) {
  let entries;
  let files = 0;
  let bytes = 0;

  try {
    entries = unzipSync(zip instanceof Uint8Array ? zip : new Uint8Array(zip), {
      // Decide before inflating: a zip can claim small and expand large.
      filter: file => {
        files++;
        bytes += file.originalSize;
        if (files > MAX_UPLOAD_FILES) throw new UploadRefused(`the upload has more than ${MAX_UPLOAD_FILES} files`);
        if (bytes > MAX_UPLOAD_BYTES) throw new UploadRefused(`the upload unpacks to more than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
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
    const safe = safeRelative(name);
    if (!safe) throw new UploadRefused(`the upload has a file path seaLeye will not write: ${name}`);

    const target = path.join(root, ...safe.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const body = secretFileReason(target) ? new Uint8Array(0) : data;
    fs.writeFileSync(target, body, { flag: "wx" });
    written += body.length;
  }

  return { files: Object.keys(entries).filter(n => !n.endsWith("/")).length, bytes: written };
}

/** A zip entry name as a clean relative path, or null if it is not one we will write. */
function safeRelative(name) {
  if (typeof name !== "string" || !name || name.includes("\0") || name.includes("\\")) return null;
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return null;
  const parts = name.split("/").filter(p => p !== "" && p !== ".");
  if (!parts.length || parts.some(p => p === "..")) return null;
  if (parts.slice(0, -1).some(p => EXCLUDED_FOLDERS.has(p))) return null;
  return parts.join("/");
}
