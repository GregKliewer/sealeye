// api/discovery/library.js
// Reading a platform library (PHASE4-PLAN Step 5, D3): what the discovery run's first
// node does, before any model is called.
//
// 1. One commit of each named repository is fetched, read-only (api/discovery/github.js).
//    The run records which commit, so what it learned can be traced to what it read.
// 2. It is walked by the rules every upload follows (core/upload-rules.js, purpose
//    "discovery"): what its .gitignore leaves out stays out, secret files (Terraform
//    variables and state, keys, .env) arrive as their names only, and every file is
//    scanned with the shared rules.
// 3. What is kept is written to a scratch folder of the run's own, and scanned again
//    with gitleaks (api/secret-scan.js), as an interview's upload is.
// 4. Each line with a value that looks like a secret is replaced by one that says why;
//    a value over several lines leaves its file empty (Greg, Oct 15, 2026: lines
//    redacted, the rest of the file read). Archives and files that are not text, which
//    neither scanner can see into, are kept as names only. Nothing a library holds can
//    wave a finding through: its .sealeye-allow and .gitleaksignore are not used.
//
// What comes back is a folder a worker may read and the facts about it: the commit,
// the files, the secret files held back, and each finding as file, line, rule and kind,
// never the value. The folder is the run's to remove.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import ignore from "ignore";

import { onePerLine } from "../../core/scan.js";
import { collectUpload, rulesOf, treeFromPaths } from "../../core/upload-rules.js";
import { collectFolder } from "../../core/upload.js";
import { redactScanned, scanApp } from "../secret-scan.js";
import { githubReader, repoName } from "./github.js";
import { untar } from "./tar.js";

const RULES = rulesOf("discovery");

/**
 * Read one repository at a commit (or at what `ref` names now, or its default branch).
 *
 * @param {{ owner: string, repo: string, ref?: string|null }} target
 * @param {object} [options]
 * @param {string} [options.scratchBase]  where the run's folders go (default: the system's temp)
 * @param {object} [options.reader]       a githubReader, or the options for one
 * @returns {Promise<LibrarySnapshot>}
 *
 * @typedef {object} LibrarySnapshot
 * @property {string} repo         owner/repo
 * @property {string|null} commit  the full commit read (null for a folder read from disk)
 * @property {string} via          "app", "token" or "folder"
 * @property {string} dir          the folder a worker may read
 * @property {number} files
 * @property {number} bytes
 * @property {string[]} secretFiles  secret files, present as their names only
 * @property {string[]} unreadFiles  archives and files that are not text, present as their names only
 * @property {object[]} findings   file, line, rule, kind and whole; never a value
 * @property {"ran"|"not installed"} gitleaks
 * @property {() => void} remove
 */
export async function readLibrary(target, { scratchBase, reader, ...readerOptions } = {}) {
  const github = reader?.archive ? reader : await githubReader(target, reader || readerOptions);
  let commit;
  let gz;
  try {
    commit = await github.commitOf(target.ref || null);
    gz = await github.archive(commit, { maxBytes: RULES.maxBytes });
  } finally {
    await github.close?.();
  }
  const name = repoName(target);
  const files = untar(gz, { maxBytes: RULES.maxBytes, maxFiles: RULES.maxFiles, subject: `The library ${name}` });
  const walked = await collectUpload(treeFromPaths(target.repo, files), { purpose: "discovery", ignore });
  return settle({ repo: name, commit, via: github.via, folderName: target.repo, walked, scratchBase });
}

/**
 * Read a library already on this machine, a clone say, by the same rules. For tests and
 * `npm run eval:discovery`; a run on the server always reads from GitHub.
 */
export async function readLibraryFolder(dir, { repo = path.basename(path.resolve(dir)), scratchBase } = {}) {
  const walked = await collectFolder(dir, { purpose: "discovery" });
  return settle({ repo, commit: null, via: "folder", folderName: path.basename(path.resolve(dir)), walked, scratchBase });
}

async function settle({ repo, commit, via, folderName, walked, scratchBase }) {
  const base = scratchBase || os.tmpdir();
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const root = fs.mkdtempSync(path.join(base, "library-"));
  const dir = path.join(root, folderName.replace(/[^A-Za-z0-9._-]/g, "-") || "library");
  const remove = () => fs.rmSync(root, { recursive: true, force: true });
  try {
    fs.mkdirSync(dir);
    for (const [rel, data] of Object.entries(walked.entries)) {
      // gitleaks reads its ignore file from the folder it scans, so scanApp keeps it out
      // of gitleaks' copy; it means nothing to discovery, so it is left out altogether.
      if (path.posix.basename(rel) === ".gitleaksignore") continue;
      const target = path.join(dir, ...rel.split("/"));
      if (!target.startsWith(dir + path.sep)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // Archives and files that are not text arrive empty from the walk
      // (core/upload-rules.js), as secret files do.
      fs.writeFileSync(target, data, { flag: "wx" });
    }
    const scanned = await scanApp(dir, { library: true });
    const deeper = redactScanned(dir, scanned);
    const all = [...walked.findings, ...deeper];
    const findings = onePerLine(all).map(f => ({ ...f, whole: all.some(g => g.file === f.file && g.whole) }));
    return {
      repo,
      commit,
      via,
      dir,
      files: walked.files,
      bytes: walked.bytes,
      secretFiles: walked.withheld,
      unreadFiles: walked.unread,
      findings,
      gitleaks: scanned.gitleaks,
      remove
    };
  } catch (err) {
    remove();
    throw err;
  }
}
