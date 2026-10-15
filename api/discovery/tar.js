// api/discovery/tar.js
// A platform library arrives from GitHub as a gzipped tar of one commit
// (api/discovery/github.js). This reads it in memory into a flat list of files, which
// core/upload-rules.js then walks as it walks any folder (treeFromPaths), so the same
// rules decide what discovery reads as decide what an interview reads.
//
// Only regular files are kept. Links, devices and anything else never travel, as a
// link in an uploaded folder never does. Every name is checked before it is used: no
// absolute path, nothing that climbs out with "..", no NUL. The size is capped before
// anything is inflated past it.
import zlib from "node:zlib";

import { UploadRefused } from "../../core/upload-rules.js";

const BLOCK = 512;

/** A NUL-terminated field of a header, as text. */
function field(buf, start, length) {
  const slice = buf.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

/** A size field: octal text, or the base-256 form GNU tar uses past 8 GB. */
function sizeOf(buf, start) {
  if (buf[start] & 0x80) {
    let n = 0;
    for (let i = start + 1; i < start + 12; i++) n = n * 256 + buf[i];
    return n;
  }
  const text = field(buf, start, 12).trim();
  return text ? parseInt(text, 8) : 0;
}

/** A pax header's records ("<length> <key>=<value>\n"), as a map. */
function paxRecords(data) {
  const out = {};
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space === -1) break;
    const length = parseInt(data.subarray(i, space).toString("utf8"), 10);
    if (!Number.isFinite(length) || length <= 0 || i + length > data.length) break;
    const record = data.subarray(space + 1, i + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += length;
  }
  return out;
}

/**
 * A name inside the archive as a clean path inside the library, with the archive's own
 * top folder (GitHub's "<owner>-<repo>-<commit>/") taken off, or null when it is not one
 * seaLeye will use.
 */
function cleanName(name) {
  if (typeof name !== "string" || !name || name.includes("\0") || name.includes("\\")) return null;
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return null;
  const parts = name.split("/").filter(p => p !== "" && p !== ".");
  if (parts.some(p => p === "..")) return null;
  if (parts.length < 2) return null;     // the top folder itself, or a file beside it
  return parts.slice(1).join("/");
}

/**
 * Read a gzipped tar into its regular files.
 *
 * @param {Uint8Array} gz
 * @param {{ maxBytes: number, maxFiles: number, subject?: string }} limits
 *        what the library may hold, from core/upload-rules.js's "discovery" rules
 * @returns {{ path: string, size: number, bytes(): Uint8Array, text(): string }[]}
 * @throws UploadRefused when it is not an archive seaLeye can read, or is too big
 */
export function untar(gz, { maxBytes, maxFiles, subject = "The library" }) {
  // Headers and padding add to what the files hold: up to three blocks a file (a pax
  // header, its records, the file's own header) and the last block's padding, plus
  // folders and the archive's own header and end. Anything bigger than this cannot be
  // within the cap, so it is not inflated further.
  const maxOutputLength = maxBytes + (maxFiles + 1) * BLOCK * 4 + 64 * 1024;
  let tar;
  try {
    tar = zlib.gunzipSync(gz, { maxOutputLength });
  } catch (err) {
    if (err?.code === "ERR_BUFFER_TOO_LARGE" || /maxOutputLength|buffer/i.test(String(err?.message))) {
      throw new UploadRefused(`${subject} is bigger than ${maxBytes / 1024 / 1024} MB, which is more than discovery reads.`);
    }
    throw new UploadRefused(`${subject} did not arrive as an archive seaLeye can read.`);
  }

  const files = [];
  let bytes = 0;
  let longName = null;
  let pax = {};
  let offset = 0;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every(b => b === 0)) break;     // the end of the archive

    // The header's own checksum, so a damaged or truncated archive is refused, not read.
    const stated = parseInt(field(header, 148, 8).trim(), 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
    if (stated !== sum) throw new UploadRefused(`${subject} did not arrive as an archive seaLeye can read.`);

    const size = sizeOf(header, 124);
    const type = String.fromCharCode(header[156] || 0x30);
    const start = offset + BLOCK;
    const end = start + size;
    if (!Number.isSafeInteger(size) || size < 0 || end > tar.length) {
      throw new UploadRefused(`${subject} did not arrive as an archive seaLeye can read.`);
    }
    const data = tar.subarray(start, end);
    offset = start + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "g") continue;                         // a global header: GitHub's commit
    if (type === "x") { pax = paxRecords(data); continue; }
    if (type === "L") { longName = field(data, 0, data.length); continue; }

    const prefix = field(header, 345, 155);
    const plain = field(header, 0, 100);
    const name = pax.path || longName || (prefix ? `${prefix}/${plain}` : plain);
    pax = {};
    longName = null;

    if (type !== "0" && type !== "\0" && type !== "7") continue;   // folders, links, devices
    const rel = cleanName(name);
    if (!rel) continue;

    if (files.length + 1 > maxFiles) {
      throw new UploadRefused(`${subject} has more than ${maxFiles} files, which is more than discovery reads.`);
    }
    bytes += size;
    if (bytes > maxBytes) {
      throw new UploadRefused(`${subject} is bigger than ${maxBytes / 1024 / 1024} MB, which is more than discovery reads.`);
    }
    const copy = new Uint8Array(data);   // its own buffer, not a view of the archive
    files.push({ path: rel, size, bytes: () => copy, text: () => Buffer.from(copy).toString("utf8") });
  }
  return files;
}
