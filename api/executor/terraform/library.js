// api/executor/terraform/library.js
// The organization's module code, as the executor runs it (DESIGN.md, "A Terraform
// executor builds an organization's own modules"): the library at the commit its catalog
// names, fetched read-only through the reader discovery uses (api/discovery/github.js).
//
// Unlike discovery's copy it is not redacted: this is code that runs, and no model reads
// it. Each commit is fetched once and kept, read-only, in the API's home; a commit never
// changes. Before anything runs, the module it is for is checked again for anything it
// would run on the platform's server (`moduleRuns`): the code that runs is this code,
// whatever the catalog said of it.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { sealeyeHome } from "../../../core/config.js";
import { rulesOf } from "../../../core/upload-rules.js";
import { githubReader, parseRepo } from "../../discovery/github.js";
import { untar } from "../../discovery/tar.js";
import { moduleRuns } from "../../discovery/terraform.js";

const SHA = /^[0-9a-f]{40}$/;
const LIMITS = rulesOf("discovery");

/** Where fetched libraries are kept, by repository and commit. */
export const librariesDir = () => path.join(sealeyeHome(), "tofu-libraries");

/** Why the module's code cannot be built from, in a sentence. */
export class ModuleUnusable extends Error {
  constructor(message) {
    super(message);
    this.name = "ModuleUnusable";
  }
}

/**
 * Which library and commit a catalog's module comes from: the catalog's own record of
 * what discovery read. One library a catalog, today (409 ONE_LIBRARY).
 *
 * @returns {{ repo: string, owner: string, name: string, commit: string }}
 */
export function libraryOf(catalog) {
  const lib = (catalog?.discovery?.library || [])[0];
  const parsed = lib?.repo ? parseRepo(lib.repo) : null;
  if (!parsed || !SHA.test(String(lib?.commit || ""))) {
    throw new ModuleUnusable("the catalog does not say which commit of your organization's library it was read from, so the platform cannot fetch the module");
  }
  return { repo: lib.repo, owner: parsed.owner, name: parsed.repo, commit: lib.commit };
}

/** A module's folder inside a library, checked: a relative path that stays inside it. */
export function moduleFolder(source) {
  const s = String(source || "");
  if (!s || s.startsWith("/") || s.split("/").includes("..") || !/^[A-Za-z0-9._\/-]+$/.test(s)) {
    throw new ModuleUnusable(`the catalog names the module's folder as ${JSON.stringify(s)}, which is not a folder inside the library`);
  }
  return s.replace(/^\.\/+/, "").replace(/\/+$/, "") || ".";
}

/**
 * The library at one commit, on disk, fetched if it is not here yet.
 *
 * @param {{ owner: string, name: string, commit: string, repo: string }} lib
 * @param {{ reader?: object }} [options]  a githubReader, for tests
 * @returns {Promise<string>} the folder
 */
export async function libraryAt(lib, { reader } = {}) {
  const dir = path.join(librariesDir(), `${lib.owner}--${lib.name}--${lib.commit}`);
  if (fs.existsSync(path.join(dir, ".complete"))) return dir;
  const github = reader?.archive ? reader : await githubReader({ owner: lib.owner, repo: lib.name, ref: lib.commit });
  let gz;
  try {
    gz = await github.archive(lib.commit, { maxBytes: LIMITS.maxBytes });
  } finally {
    await github.close?.();
  }
  const files = untar(gz, { maxBytes: LIMITS.maxBytes, maxFiles: LIMITS.maxFiles, subject: `The library ${lib.repo}` });
  // Written beside its final place, then moved in whole, so a half-written copy is never used.
  const tmp = `${dir}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of files) {
    const target = path.join(tmp, f.path);
    if (!target.startsWith(tmp + path.sep)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.bytes(), { mode: 0o444 });
  }
  fs.writeFileSync(path.join(tmp, ".complete"), `${lib.repo}@${lib.commit}\n`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  return dir;
}

/**
 * The module's code, ready to be called: the library's folder and the module's folder in
 * it, after checking again that it runs nothing on the platform's server.
 *
 * @returns {Promise<{ libraryDir: string, source: string, library: object }>}
 */
export async function moduleCode(catalog, entry, options = {}) {
  // At its release when the library releases it (the commit its tag points to, recorded
  // by discovery), else at the commit the catalog was read at (core/module-versions.js).
  if (entry?.unreleased) throw new ModuleUnusable(`your organization's library has not released ${entry.source || "this module"} yet, so the platform does not build it`);
  const read = libraryOf(catalog);
  const library = SHA.test(String(entry?.commit || ""))
    ? { ...read, commit: entry.commit, version: entry.version || null, tag: entry.tag || null }
    : read;
  const source = moduleFolder(entry?.source);
  const libraryDir = await libraryAt(library, options);
  const dir = path.join(libraryDir, source);
  if (!fs.existsSync(dir) || !fs.readdirSync(dir).some(f => f.endsWith(".tf"))) {
    throw new ModuleUnusable(`${source} is not a module in ${library.repo} at ${library.commit.slice(0, 12)}`);
  }
  const runs = moduleRuns(libraryDir, source);
  if (runs.length) {
    throw new ModuleUnusable(`the module ${source} would run commands on the platform's server (${runs.join(", ")}), so the platform does not build it`);
  }
  return { libraryDir, source, library };
}
