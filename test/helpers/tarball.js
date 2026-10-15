// A gzipped tar shaped as GitHub's archive of a commit is: a pax global header holding
// the commit, then everything under one top folder, "<owner>-<repo>-<commit>/", with
// pax headers for names too long for the tar header. For the discovery tests, which
// stand in for GitHub (api/discovery/github.js reads the real one).
import zlib from "node:zlib";

const BLOCK = 512;

function header({ name, size, type, linkname = "" }) {
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name.slice(0, 100), 0, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write(linkname.slice(0, 100), 157);
  h.write("ustar\0" + "00", 257);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

const pad = data => Buffer.concat([data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK)]);

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (String(length).length + body.length !== length) length = String(length).length + body.length;
  return `${length}${body}`;
}

/**
 * @param {Record<string, string|Buffer|{ link: string }>} files  path inside the commit -> contents
 * @param {{ top?: string, commit?: string, raw?: { name: string, body?: string }[] }} options
 *        raw entries are written with exactly the name given, top folder and all
 */
export function githubTarball(files, { top = "acme-library-0123456", commit = "0".repeat(40), raw = [] } = {}) {
  const parts = [];
  const global = Buffer.from(paxRecord("comment", commit));
  parts.push(header({ name: "pax_global_header", size: global.length, type: "g" }), pad(global));
  parts.push(header({ name: `${top}/`, size: 0, type: "5" }));
  const entry = (name, body, type = "0", linkname) => {
    if (name.length > 100) {
      const pax = Buffer.from(paxRecord("path", name));
      parts.push(header({ name: "PaxHeader", size: pax.length, type: "x" }), pad(pax));
    }
    parts.push(header({ name, size: body.length, type, linkname }), pad(body));
  };
  for (const [rel, contents] of Object.entries(files)) {
    if (contents && typeof contents === "object" && "link" in contents) entry(`${top}/${rel}`, Buffer.alloc(0), "2", contents.link);
    else entry(`${top}/${rel}`, Buffer.from(contents));
  }
  for (const { name, body = "" } of raw) entry(name, Buffer.from(body));
  parts.push(Buffer.alloc(BLOCK * 2));
  return new Uint8Array(zlib.gzipSync(Buffer.concat(parts)));
}
