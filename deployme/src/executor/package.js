// src/executor/package.js
// Build the Lambda artifact and put it in S3. The developer's folder is read-only
// here: everything happens in dist/stage/<deploymentId>/, which is a copy.
// This is the sequence in docs/DAY2-COMMANDS.md, transcribed.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { repoRoot, loadEnv, requireEnv } from "./env.js";

const RSYNC_EXCLUDES = ["node_modules", ".git", ".do", ".github"];

/** Run a command, no shell. Resolves with stdout; rejects with stderr on a non-zero exit. */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "";
    let err = "";
    child.stdout.on("data", d => (out += d));
    child.stderr.on("data", d => (err += d));
    child.on("error", e => reject(new Error(`${cmd}: ${e.message}`)));
    child.on("close", code => {
      if (code === 0) return resolve(out);
      reject(new Error(`${cmd} ${args.join(" ")} exited ${code}\n${(err || out).trim()}`));
    });
  });
}

/**
 * Stage, install, inject run.sh, zip and upload the app.
 *
 * @param {string} appPath       the developer's folder (never written to)
 * @param {string} deploymentId  names the stage dir, the zip and the S3 key
 * @param {object} composed      the compose() result — kind and parameters.AppName
 * @param {(line: string) => void} [onStep]  optional progress line per step
 * @returns {Promise<string|null>} the S3 key, or null for kind "static"
 */
export async function stage(appPath, deploymentId, composed, onStep = () => {}) {
  loadEnv();

  const kind = composed?.kind;
  if (!kind) throw new Error("stage() needs the compose() result (its kind)");

  // A static site has no artifact: the files are synced into the bucket the stack
  // creates, which does not exist yet.
  if (kind === "static") return null;

  if (!deploymentId) throw new Error("deploymentId is required");

  const appName = composed?.parameters?.AppName;
  if (!appName) throw new Error("stage() needs the compose() result (its parameters.AppName)");

  const bucket = requireEnv("DEPLOYME_BUCKET");

  const src = path.resolve(appPath);
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    throw new Error(`app path is not a directory: ${src}`);
  }

  const stageDir = path.join(repoRoot, "dist", "stage", deploymentId);
  const zipPath = path.join(repoRoot, "dist", `${deploymentId}.zip`);
  const runSh = path.join(repoRoot, "templates", "run.sh");

  // rm -rf dist/stage/<id> && mkdir -p dist/stage/<id>
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  // rsync -a --exclude ... <app>/ dist/stage/<id>/   (trailing slashes matter)
  onStep(`Copying your app into a staging folder (your folder is not modified)`);
  await run("rsync", [
    "-a",
    ...RSYNC_EXCLUDES.flatMap(e => ["--exclude", e]),
    `${src}/`,
    `${stageDir}/`
  ]);

  // npm install --omit=dev in the *stage* dir, never the developer's
  onStep("Installing production dependencies");
  await run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: stageDir });

  // The adapter's Handler is run.sh; zip preserves the executable bit, and losing it
  // shows up only as "Permission denied" in the Lambda logs.
  onStep("Adding the platform start script");
  fs.copyFileSync(runSh, path.join(stageDir, "run.sh"));
  fs.chmodSync(path.join(stageDir, "run.sh"), 0o755);

  onStep("Packaging the artifact");
  fs.rmSync(zipPath, { force: true });
  await run("zip", ["-qr", zipPath, "."], { cwd: stageDir });

  // <app>/<deploymentId>.zip, so every deploy changes S3Key
  const key = `${appName}/${deploymentId}.zip`;
  onStep(`Uploading the artifact to s3://${bucket}/${key}`);
  await run("aws", ["s3", "cp", zipPath, `s3://${bucket}/${key}`]);

  return key;
}

/** Where stage() put things, for the dev script and later for cleanup. */
export function stagePaths(deploymentId) {
  return {
    stageDir: path.join(repoRoot, "dist", "stage", deploymentId),
    zipPath: path.join(repoRoot, "dist", `${deploymentId}.zip`)
  };
}
