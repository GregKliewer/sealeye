// src/executor/package.js
// Build the Lambda artifact and put it in S3. The developer's folder is read-only
// here: everything happens in dist/stage/<deploymentId>/, which is a copy.
// This is the sequence in docs/DAY2-COMMANDS.md, transcribed.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

import { repoRoot, loadEnv, requireSetting } from "../../core/config.js";
import { secretFileReason } from "../../core/secrets.js";

// .env is excluded deliberately: its values are passed to the function as real
// environment variables by config_basic, so shipping the file as well would put the
// developer's secrets inside the artifact for no gain.
/**
 * What npm install sees of the environment: where npm is, a home for its cache, a proxy
 * and certificates if the API has them. Never a key, a password or the database address.
 */
export function installEnv(env = process.env) {
  const keep = ["PATH", "HOME", "TMPDIR", "LANG", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
    "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "npm_config_registry",
    "NPM_CONFIG_REGISTRY", "npm_config_cache", "NPM_CONFIG_CACHE"];
  const out = {};
  for (const name of keep) if (env[name] !== undefined) out[name] = env[name];
  return out;
}

const RSYNC_EXCLUDES = ["node_modules", ".git", ".do", ".github", ".env"];

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

  const bucket = requireSetting("BUCKET");

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

  // Every secret file stays out of the artifact, wherever it is in the folder: .env and
  // .env.production alike, keys and credentials (core/secrets.js). An upload never
  // carried them; a folder on the API's own machine is copied whole, so they go here.
  removeSecretFiles(stageDir);

  // npm install --omit=dev in the *stage* dir, never the developer's.
  //
  // With --ignore-scripts and an environment holding only what npm needs: the app and
  // its dependencies are code seaLeye has not reviewed, and an install script runs as
  // the API. On the pilot server that is a process that can reach the server's role and
  // the database, so it gets neither the API's settings nor a chance to run at all
  // (DESIGN.md, "Installing an app's dependencies runs none of its code"). A dependency
  // that builds native code at install is not supported; it would not have run on the
  // function's runtime anyway unless built for it.
  onStep("Installing production dependencies");
  await run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts"], {
    cwd: stageDir,
    env: installEnv()
  });

  // A plan that names an entry point the folder does not have would deploy to
  // CREATE_COMPLETE and then fail on every request, which is a working URL serving an
  // error. Cheaper to say so here, before anything is created.
  const entryPoint = composed?.entryPoint || "index.js";
  const entryFile = path.join(stageDir, entryPoint);

  if (!fs.existsSync(entryFile) || !fs.statSync(entryFile).isFile()) {
    throw new Error(`the entry point in your plan, ${entryPoint}, is not a file in your app folder`);
  }

  // The adapter's Handler is run.sh; zip preserves the executable bit, and losing it
  // shows up only as "Permission denied" in the Lambda logs.
  onStep(`Adding the platform start script, which runs ${entryPoint}`);
  fs.writeFileSync(path.join(stageDir, "run.sh"), renderRunScript(runSh, entryPoint));
  fs.chmodSync(path.join(stageDir, "run.sh"), 0o755);
  addSettingsReader(stageDir);
  // A module that runs the app as a function the platform calls gets the adapter, which
  // starts run.sh and hands it each request (templates/sealeye-handler.mjs).
  if (composed.adapter === "handler") {
    onStep("Adding the platform's adapter, which hands your app each request");
    addHandlerAdapter(stageDir);
  }

  onStep("Packaging the artifact");
  fs.rmSync(zipPath, { force: true });
  await run("zip", ["-qr", zipPath, "."], { cwd: stageDir });

  // <app>/<deploymentId>.zip, so every deploy changes S3Key
  const key = `${appName}/${deploymentId}.zip`;
  onStep(`Uploading the artifact to s3://${bucket}/${key}`);
  await run("aws", ["s3", "cp", zipPath, `s3://${bucket}/${key}`]);

  return key;
}

/**
 * The adapter beside run.sh in the packaged copy (DESIGN.md, "An app that listens reaches
 * a module that calls a function"). A folder that already has a file of its name is
 * refused rather than overwritten: the developer's files are never changed.
 */
export function addHandlerAdapter(stageDir) {
  const target = path.join(stageDir, "sealeye-handler.mjs");
  if (fs.existsSync(target)) {
    throw new Error("your app folder has a sealeye-handler.mjs, which is where the platform puts the adapter that hands your app its requests; rename yours");
  }
  fs.copyFileSync(path.join(repoRoot, "templates", "sealeye-handler.mjs"), target);
}

/**
 * The file an app starts from, read from its folder: package.json's `main`, then a
 * `start` script that runs `node <file>`, then index.js. Null when none of them is a
 * file there, which the caller refuses in words before anything is built.
 */
export function entryPointOfFolder(dir) {
  const isFile = rel => {
    const safe = rel && !rel.startsWith("/") && !rel.split("/").includes("..") && /^[A-Za-z0-9._\/-]+$/.test(rel);
    return safe && fs.existsSync(path.join(dir, rel)) && fs.statSync(path.join(dir, rel)).isFile() ? rel : null;
  };
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) || {}; } catch {}
  const main = typeof pkg.main === "string" ? pkg.main.replace(/^\.\//, "") : null;
  const withJs = rel => rel && (isFile(rel) || isFile(`${rel}.js`));
  const start = typeof pkg.scripts?.start === "string" ? pkg.scripts.start.match(/^\s*node\s+(?:--?[\w-]+(?:=\S+)?\s+)*([^\s;&|]+)\s*$/)?.[1]?.replace(/^\.\//, "") : null;
  return withJs(main) || withJs(start) || isFile("index.js");
}

/** Remove every secret file under a staged copy (never the developer's folder). */
export function removeSecretFiles(stageDir) {
  const removed = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(abs);
      else if (secretFileReason(entry.name)) { fs.rmSync(abs, { force: true }); removed.push(path.relative(stageDir, abs)); }
    }
  };
  walk(stageDir);
  return removed;
}

/**
 * The platform's settings reader, beside run.sh in the packaged copy (PHASE2-PLAN Step
 * 10). It goes in .sealeye/, which an upload never carries; an app folder on the API's
 * own machine that already has .sealeye/settings.mjs is refused rather than overwritten,
 * since the developer's files are never changed.
 */
export function addSettingsReader(stageDir) {
  const target = path.join(stageDir, ".sealeye", "settings.mjs");
  if (fs.existsSync(target)) {
    throw new Error("your app folder has a .sealeye/settings.mjs, which is where the platform puts its settings reader; rename yours");
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "templates", "sealeye-settings.mjs"), target);
}

/**
 * templates/run.sh with the plan's entry point in it. Separate so it can be tested
 * without an AWS account: everything else in stage() talks to rsync, npm and S3.
 */
export function renderRunScript(templatePath, entryPoint) {
  return fs.readFileSync(templatePath, "utf8").split("__ENTRY_POINT__").join(entryPoint);
}

/** Where stage() put things, for the dev script and later for cleanup. */
export function stagePaths(deploymentId) {
  return {
    stageDir: path.join(repoRoot, "dist", "stage", deploymentId),
    zipPath: path.join(repoRoot, "dist", `${deploymentId}.zip`),
    // Written by compose() when the plan asks for settings; a copy of the module's
    // template with their names in it.
    templatePath: path.join(repoRoot, "dist", `${deploymentId}.template.yaml`)
  };
}

/**
 * Throw away this deployment's staged copy and zip. Platform-side files only —
 * nothing here is in the developer's folder.
 * @returns {string[]} what was removed
 */
export function cleanStage(deploymentId) {
  const { stageDir, zipPath, templatePath } = stagePaths(deploymentId);
  const removed = [];

  for (const target of [stageDir, zipPath, templatePath]) {
    if (!fs.existsSync(target)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(target);
  }

  return removed;
}

// ---------------------------------------------------------------------------
// Checksums, for the change record
// ---------------------------------------------------------------------------

/**
 * A template as text, the same way whatever wrote it: CRLF to LF, trailing whitespace
 * off every line, one newline at the end. CloudFormation hands the original back with
 * small differences of that kind, and a hash that changed because of a line ending is a
 * hash that lied about the template.
 */
export function normalizeTemplate(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(line => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n*$/, "\n");
}

/** sha256 hex of a string. */
export function sha256Text(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

/** sha256 hex of a file's bytes. Throws when the file is not there; callers decide. */
export function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/** sha256 of a template file after normalizeTemplate, so it compares with get-template. */
export function sha256Template(filePath) {
  return sha256Text(normalizeTemplate(fs.readFileSync(filePath, "utf8")));
}
