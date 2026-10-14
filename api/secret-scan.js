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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ALLOW_FILE, applyAllow, cleanFinding, onePerLine, parseAllowFile, uniqueFindings } from "../core/scan.js";
import { collectFolder, SecretsFound } from "../core/upload.js";

const CONFIG = path.join(import.meta.dirname, "gitleaks.toml");
const TIMEOUT_MS = 120_000;

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

/**
 * gitleaks over a folder: its findings as file, line, rule and kind.
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
      "--max-target-megabytes", "10",
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
    return rows
      .map(row => {
        const abs = path.resolve(empty, String(row?.File || ""));
        const rel = path.relative(root, abs).split(path.sep).join("/");
        return cleanFinding({ file: rel, line: row?.StartLine, rule: row?.RuleID });
      })
      .filter(Boolean);
  } catch (err) {
    if (err instanceof ScanFailed) throw err;
    // The error's own text may quote what gitleaks printed; it is not kept.
    throw new ScanFailed(err.killed ? "gitleaks took too long" : `gitleaks did not finish (exit ${err.code ?? "unknown"})`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Scan an app folder the API holds: the shared rules over what would travel for
 * `purpose`, then gitleaks over the folder, then .sealeye-allow.
 *
 * @returns {Promise<{ found: object[], allowed: object[], gitleaks: "ran"|"not installed" }>}
 *          one finding per file and line (core/scan.js onePerLine)
 * @throws ScanFailed when gitleaks is installed and could not finish
 */
export async function scanApp(dir, { purpose = "interview", binary } = {}) {
  let shared = [];
  try {
    const collected = await collectFolder(dir, { purpose });
    shared = [...collected.findings, ...collected.allowed];
  } catch (err) {
    if (!(err instanceof SecretsFound)) throw err;
    shared = [...err.findings, ...(err.allowed || [])];
  }

  const deeper = await gitleaksFindings(dir, binary === undefined ? {} : { binary });

  let allowEntries = [];
  try {
    allowEntries = parseAllowFile(fs.readFileSync(path.join(dir, ALLOW_FILE), "utf8")).entries;
  } catch {}

  const all = uniqueFindings([...shared, ...(deeper || [])].map(cleanFinding).filter(Boolean));
  const { found, allowed } = applyAllow(all, allowEntries);
  return { found: onePerLine(found), allowed: onePerLine(allowed), gitleaks: deeper ? "ran" : "not installed" };
}
