// core/upload.js
// The app folder as it travels to the API for an interview (DESIGN.md, "Phase 1: who
// it is for, and how the hosted product is built": the CLI uploads the app).
//
// Both sides live here so they cannot disagree: the CLI zips with zipFolder, the API
// unpacks with unzipInto. What may travel, and the walk that decides it, are in
// core/upload-rules.js, which seaLeye.online's upload uses too.
import fs from "node:fs";
import path from "node:path";

import { unzipSync, zipSync } from "fflate";
import ignore from "ignore";

import { secretFileReason } from "./secrets.js";
import { collectUpload, isDotEnv, rulesOf, UploadRefused } from "./upload-rules.js";

// The rules themselves live in core/upload-rules.js, which the portal uses too.
export { EXCLUDED_FOLDERS, MAX_UPLOAD_BYTES, MAX_UPLOAD_FILES, UploadRefused } from "./upload-rules.js";

/** A folder on disk as the tree collectUpload walks. */
function diskNode(abs, name) {
  const stat = fs.lstatSync(abs);
  if (stat.isSymbolicLink()) return { name, kind: "other" };
  if (stat.isDirectory()) {
    return { name, kind: "dir", children: () => fs.readdirSync(abs).map(child => diskNode(path.join(abs, child), child)) };
  }
  if (!stat.isFile()) return { name, kind: "other" };
  return {
    name,
    kind: "file",
    size: stat.size,
    bytes: () => {
      const data = fs.readFileSync(abs);
      return new Uint8Array(data.buffer, data.byteOffset, data.length);
    },
    text: () => fs.readFileSync(abs, "utf8")
  };
}

/**
 * Zip an app folder for an interview (the default) or a deploy, by the rules in
 * core/upload-rules.js.
 *
 * @returns {Promise<{ zip: Uint8Array, files: number, bytes: number, withheld: string[], ignored: number }>}
 *          withheld lists the secret files sent as empty names; ignored counts what a
 *          .gitignore left out.
 */
export async function zipFolder(dir, { purpose = "interview" } = {}) {
  const root = path.resolve(dir);
  const { entries, ...counts } = await collectUpload(diskNode(root, path.basename(root)), { purpose, ignore });
  return { zip: zipSync(entries, { level: 6 }), ...counts };
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
