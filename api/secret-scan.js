// api/secret-scan.js
// The API's scan of an app it received (PHASE3-PLAN Step 2, D3): the shared rules
// (core/scan.js) again, because the API cannot trust the client that ran them, and then
// gitleaks, the deeper check, which becomes the discovery swarm's first node in Phase 4.
//
// What it returns is file, line, rule and kind for each finding, never a value.
// gitleaks runs with --redact and its report is read for three fields and deleted; it
// is never logged. It always runs with seaLeye's own configuration, from an empty
// folder and with no GITLEAKS_* variables, and with gitleaks:allow comments ignored, so
// nothing in a developer's folder can switch it off. .sealeye-allow is the only way past
// a finding.
//
// Where gitleaks is not installed (a laptop API, CI), the shared rules are the scan and
// the result says so. Where it is installed and fails, the scan fails: an interview or
// a deploy that was meant to have the deeper check does not go ahead without it.
import { execFile } from "node:child_process";
import { Worker } from "node:worker_threads";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ALLOW_FILE, applyAllow, cleanFinding, onePerLine, parseAllowFile, uniqueFindings } from "../core/scan.js";
import { isLeftOutOfDeploy, UploadRefused } from "../core/upload-rules.js";

const CONFIG = path.join(import.meta.dirname, "gitleaks.toml");
const TIMEOUT_MS = 120_000;      // gitleaks, and the shared rules in their worker

/** The scan could not be done, so what depended on it must not go ahead. */
export class ScanFailed extends Error {}

/** gitleaks' path, or null when it is not installed. Looked up once. */
let found;
export function gitleaksPath() {
  if (found !== undefined) return found;
  found = null;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "gitleaks");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      found = candidate;
      break;
    } catch {}
  }
  return found;
}

/** For tests: use this binary (or none, with null), and look again with undefined. */
export function useGitleaks(binary) {
  found = binary;
}

function run(binary, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      // Nothing of the API's own environment: no GITLEAKS_CONFIG, no keys.
      { cwd, env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: cwd }, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, _stdout, stderr) => (err ? reject(Object.assign(err, { stderrLength: String(stderr || "").length })) : resolve())
    );
  });
}

// What the scan copy leaves out: what packaging leaves out (api/executor/package.js,
// matched as exactly as rsync matches it, so nothing packaged goes unscanned) and secret
// files, which are never packaged. gitleaks' own ignore file is kept out of the copy,
// since gitleaks reads it from the folder it scans whatever it is told (found in
// review), and is scanned by the shared rules from where it is instead.
const SKIP_FOLDERS = new Set(["node_modules", ".git", ".github", ".do"]);
const MAX_COPY_BYTES = 100 * 1024 * 1024;
const MAX_COPY_FILES = 20000;

/**
 * Copy an app folder to scan it: links followed, as packaging follows them (zip stores
 * what a link points at), each real folder once, so a loop of links ends. The copy is
 * the API's own, in a folder of a random name, so nothing in the app can name it.
 */
function scanCopy(dir, dest) {
  const seen = new Set();
  const root = fs.realpathSync(path.resolve(dir));
  const extra = [];
  let bytes = 0;
  let files = 0;
  const walk = (src, out, rel) => {
    const real = fs.realpathSync(src);
    if (seen.has(real)) return;
    seen.add(real);
    fs.mkdirSync(out, { recursive: true });
    for (const name of fs.readdirSync(real)) {
      const from = path.join(real, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let stat;
      try {
        stat = fs.statSync(from);   // follows links
      } catch {
        continue;                   // a dangling link: nothing to package either
      }
      // A link out of the app folder would package whatever it points at on this
      // machine, a file of the API's own say: refused rather than read.
      const target = fs.realpathSync(from);
      if (target !== root && !target.startsWith(root + path.sep)) {
        throw new UploadRefused(`${childRel} is a link to something outside your app folder, which the platform does not package`);
      }
      if (stat.isDirectory()) {
        if (SKIP_FOLDERS.has(name)) continue;
        walk(from, path.join(out, name), childRel);
        continue;
      }
      if (!stat.isFile() || isLeftOutOfDeploy(name)) continue;
      if (name === ".gitleaksignore") {
        extra.push({ abs: from, rel: childRel });
        continue;
      }
      files++;
      bytes += stat.size;
      if (files > MAX_COPY_FILES || bytes > MAX_COPY_BYTES) {
        throw new UploadRefused(`your folder is more than ${MAX_COPY_FILES} files or ${MAX_COPY_BYTES / 1024 / 1024} MB, leaving out node_modules, .git and secret files, which is more than the platform can package`);
      }
      fs.copyFileSync(from, path.join(out, name));
    }
  };
  walk(root, dest, "");
  return extra;
}

/**
 * The shared rules over every file in a folder, with no .gitignore and nothing cut
 * short, in a worker thread with a time limit (api/scan-worker.js).
 */
function sharedFindings(root, extra) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./scan-worker.js", import.meta.url), { workerData: { root, extra } });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new ScanFailed("the shared rules took too long"));
    }, TIMEOUT_MS);
    worker.once("message", found => {
      clearTimeout(timer);
      resolve(found);
      worker.terminate();
    });
    worker.once("error", () => {
      clearTimeout(timer);
      reject(new ScanFailed("the shared rules could not finish"));
    });
  });
}

/**
 * gitleaks over a folder: its findings as file, line, rule and kind. Pass it a folder
 * the API made (scanApp's copy), never an app's folder as it is.
 * @returns {Promise<object[]|null>} null when gitleaks is not installed
 */
export async function gitleaksFindings(dir, { binary = gitleaksPath() } = {}) {
  if (!binary) return null;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-gitleaks-"));
  const report = path.join(work, "report.json");
  const empty = path.join(work, "cwd");
  fs.mkdirSync(empty);
  try {
    await run(binary, [
      "dir", path.resolve(dir),
      "--config", CONFIG,
      "--report-format", "json",
      "--report-path", report,
      "--redact",
      "--no-banner",
      "--no-color",
      "--exit-code", "0",
      "--ignore-gitleaks-allow",
      "--gitleaks-ignore-path", empty,
      "--log-level", "error"
    ], empty);
    let rows;
    try {
      rows = JSON.parse(fs.readFileSync(report, "utf8"));
    } catch {
      throw new ScanFailed("gitleaks wrote no report it could read");
    }
    if (!Array.isArray(rows)) throw new ScanFailed("gitleaks wrote a report seaLeye does not understand");
    const root = path.resolve(dir);
    return rows.map(row => {
      const abs = path.resolve(empty, String(row?.File || ""));
      const rel = path.relative(root, abs).split(path.sep).join("/");
      const finding = cleanFinding({ file: rel, line: row?.StartLine, rule: row?.RuleID });
      // A finding seaLeye cannot place is not dropped: the scan did not do its job.
      if (!finding) throw new ScanFailed("gitleaks named a file seaLeye cannot place");
      return finding;
    });
  } catch (err) {
    if (err instanceof ScanFailed) throw err;
    // The error's own text may quote what gitleaks printed; it is not kept.
    throw new ScanFailed(err.killed ? "gitleaks took too long" : `gitleaks did not finish (exit ${err.code ?? "unknown"})`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Scan an app folder the API holds, an upload's copy or, for a laptop API, a folder on
 * its own machine: copied first (scanCopy), then the shared rules over every file and
 * gitleaks over the copy, then .sealeye-allow. Nothing is skipped for size and nothing
 * for .gitignore: the API does not trust what the client chose to send.
 *
 * @returns {Promise<{ found: object[], allowed: object[], gitleaks: "ran"|"not installed" }>}
 *          one finding per file and line (core/scan.js onePerLine)
 * @throws ScanFailed when gitleaks is installed and could not finish
 * @throws UploadRefused when the folder is more than the platform can package
 */
export async function scanApp(dir, { binary } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-scan-"));
  const copy = path.join(work, "app");
  try {
    const extra = scanCopy(dir, copy);
    const [shared, deeper] = await Promise.all([
      sharedFindings(copy, extra),
      gitleaksFindings(copy, binary === undefined ? {} : { binary })
    ]);

    let allowEntries = [];
    try {
      allowEntries = parseAllowFile(fs.readFileSync(path.join(copy, ALLOW_FILE), "utf8")).entries;
    } catch {}

    const all = uniqueFindings([...shared, ...(deeper || [])].map(cleanFinding).filter(Boolean));
    const { found, allowed } = applyAllow(all, allowEntries);
    return { found: onePerLine(found), allowed: onePerLine(allowed), gitleaks: deeper ? "ran" : "not installed" };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
