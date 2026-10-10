// api/executor/uploads.js
// A deployment's own copy of the app, unpacked from the zip the CLI sent with
// POST /deployments (DESIGN.md, "Deployments package an uploaded copy"). A hosted API
// cannot read the developer's folder, so this copy is what the packager stages and,
// for a static site, what is synced. It lives only as long as the deployment is in
// flight: removed when the deployment reaches a final status, and swept after a day if
// the API stopped before that.
import fs from "node:fs";
import path from "node:path";

import { sealeyeHome } from "../../core/config.js";
import { unzipInto } from "../../core/upload.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Where uploads are unpacked, in the API user's own folder rather than a shared one. */
export function uploadsBase() {
  return path.join(sealeyeHome(), "deploy-uploads");
}

/**
 * Unpack a deploy upload for one deployment. Throws UploadRefused, with a sentence,
 * when it breaks a rule.
 *
 * @returns {string} the folder to package, named "app"
 */
export function stageUpload(zip, deploymentId) {
  if (!/^dep_[0-9a-f]{12}$/.test(deploymentId)) throw new Error(`not a deployment id: ${deploymentId}`);
  fs.mkdirSync(uploadsBase(), { recursive: true, mode: 0o700 });
  const root = path.join(uploadsBase(), deploymentId);
  fs.mkdirSync(root, { mode: 0o700 });
  const appDir = path.join(root, "app");
  try {
    unzipInto(zip, appDir, { purpose: "deploy" });
  } catch (err) {
    fs.rmSync(root, { recursive: true, force: true });
    throw err;
  }
  return appDir;
}

/** Remove one deployment's copy. Never throws. */
export function removeUpload(deploymentId) {
  try {
    if (/^dep_[0-9a-f]{12}$/.test(deploymentId)) {
      fs.rmSync(path.join(uploadsBase(), deploymentId), { recursive: true, force: true });
    }
  } catch {}
}

/** Remove copies older than a day: one left by an API that stopped mid-deploy. */
export function sweepUploads(now = Date.now()) {
  let names = [];
  try {
    names = fs.readdirSync(uploadsBase());
  } catch {
    return;
  }
  for (const name of names) {
    const dir = path.join(uploadsBase(), name);
    try {
      if (name.startsWith("dep_") && fs.statSync(dir).mtimeMs < now - DAY_MS) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {}
  }
}
