// api/executor/terraform/index.js
// A Terraform environment's lifecycle (PHASE4-PLAN Step 9; DESIGN.md, "A Terraform
// executor builds an organization's own modules" and "A Terraform environment's names,
// status and operations"): fetch the organization's module, write the root module,
// `init`, `plan`, `apply`, read the outputs back, and for a site upload its files.
// Tearing down runs `destroy` and then reads the state, empty or not.
//
// Status is real (principle 4): each status is what OpenTofu said by exiting, and what
// the outputs read back say. A restart during a build is never resumed as if it were
// still going: OpenTofu's apply does not carry on without us, as CloudFormation does.
import fs from "node:fs";
import path from "node:path";

import { requireSetting, sealeyeHome } from "../../../core/config.js";
import { moduleEntry } from "../../../core/catalog.js";
import { moduleName } from "../../../core/names.js";
import { settingNamesFor } from "../../../core/setting-names.js";
import { terraformBuilds } from "../../../core/terraform-modules.js";
import { putDeployment } from "../../store.js";
import { valuesAt } from "../../platform.js";
import { closeSiblings, settersFor } from "../index.js";
import { emptyBucket, fetchArtifact, refreshSite, syncSite } from "../cfn.js";
import { cleanStage, entryPointOfFolder, sha256File, stage, stagePaths } from "../package.js";
import { renderReport } from "../report.js";
import { moduleCode } from "./library.js";
import { inputsFor, lockedProviders, outputsWanted, rootModule, stateKeyFor, writeRoot } from "./root.js";
import {
  AWS_PROVIDER_VERSION, TOFU_VERSION, appliedResources, builtParts, changeSummary, driftDetail, driftedResources, firstError,
  homeFor, lockHeld, runTofu, terraformNotReady, terraformProfile
} from "./tofu.js";

const now = () => new Date().toISOString();

/** Where an environment's root module is written for one deployment, removed after. */
export const workDirFor = deploymentId => path.join(sealeyeHome(), "tofu", deploymentId);

/** The words for a state another change holds. */
const LOCKED = "Another change to this environment holds its lock, so nothing was changed. If nothing else is under way, ask your platform team to release it, then try again.";

/** A Terraform plan's one module, and its catalog entry, or an error in words. */
export function terraformModuleOf(plan, catalog) {
  const enabled = (plan?.modules || []).filter(m => m && m.enabled !== false);
  const entries = enabled.map(m => ({ planModule: m, entry: moduleEntry(m.id, catalog) }));
  const tf = entries.filter(e => e.entry?.builds_with === "terraform");
  if (!tf.length) return null;
  if (tf.length !== enabled.length) {
    throw new Error("this plan uses modules built two different ways, and the platform builds a plan one way, so nothing was built");
  }
  if (tf.length > 1) {
    throw new Error("this plan uses more than one module, and the platform does not connect your organization's modules to each other yet, so nothing was built");
  }
  return tf[0];
}

/** Whether a plan is built by this executor, from the catalog it names. */
export function builtWithTerraform(plan, catalog) {
  return (plan?.modules || []).some(m => m && m.enabled !== false && moduleEntry(m.id, catalog)?.builds_with === "terraform");
}

/**
 * What can be checked before a record is written: one module, buildable, no settings,
 * and an app folder it can start (or files to serve). Throws in words.
 */
export function checkBuildable(plan, catalog) {
  const found = terraformModuleOf(plan, catalog);
  if (!found) throw new Error("this plan uses no module your organization's library builds");
  const why = terraformBuilds(found.entry, catalog?.platform).why;
  if (why) throw new Error(`the platform cannot build ${found.entry.id}: ${why}`);
  const settings = settingNamesFor(plan);
  if (settings.length) {
    throw new Error(`this plan gives the app settings (${settings.join(", ")}), and settings do not reach an app built from your organization's modules yet, so nothing was built`);
  }
  return found;
}

/** A minimal zip with nothing in it: what a tear-down hands a module that reads its package. */
const EMPTY_ZIP = Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);

/**
 * The root module for a record, written to its working folder, ready for `init`: the
 * module at the commit the record was built from, with the inputs it was built with.
 */
async function prepare(record, catalog, { entry, planModule, inputs = null, codePackage = null, reader } = {}) {
  const dir = workDirFor(record.deploymentId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pinned = record.terraform?.module?.commit
    ? { ...catalog, discovery: { ...(catalog.discovery || {}), library: [{ repo: record.terraform.module.repo, commit: record.terraform.module.commit }] } }
    : catalog;
  const code = await moduleCode(pinned, entry, { reader });
  const bucket = requireSetting("BUCKET");
  const team = record.teamId || "default";
  const tags = { "sealeye:app": record.app?.name || "", "sealeye:team": team, "sealeye:environment": record.stackName };
  let given = inputs;
  let sources = record.terraform?.inputs || [];
  let ignored = record.terraform?.ignoredInputs || [];
  if (!given) {
    ({ inputs: given, sources, ignored } = inputsFor({
      entry, planModule, name: record.resourceName, tags, platform: valuesAt(record.orgId || "default"), code: { package: codePackage }
    }));
  } else if (entry.delivers?.kind === "package") {
    // A package input names a file in the working folder, which a later run has to have.
    const file = path.join(dir, "package.zip");
    fs.writeFileSync(file, EMPTY_ZIP);
    given = { ...given, [entry.delivers.package]: file };
  }
  const state = { bucket, key: record.terraform?.stateKey || stateKeyFor({ org: record.orgId || "default", environment: record.stackName }) };
  const root = rootModule({ moduleSource: `./library/${code.source}`, inputs: given, outputs: outputsWanted(entry), state, tags });
  const rootSha256 = writeRoot(dir, { root, libraryDir: code.libraryDir });
  return { dir, home: homeFor(dir), inputs: given, sources, ignored, state, rootSha256, library: code.library, source: code.source };
}

/** `tofu init`, with the image's lock file when it has one, which init may not change. */
async function init(dir, home) {
  return runTofu(["init", "-input=false", "-no-color", ...(lockedProviders(dir) ? ["-lockfile=readonly"] : [])], { cwd: dir, home });
}

/** The outputs OpenTofu reads back, as name -> value. */
async function readOutputs(dir, home) {
  const r = await runTofu(["output", "-no-color", "-json"], { cwd: dir, home });
  if (!r.ok) return { ok: false, error: firstError(r) };
  try {
    const parsed = JSON.parse(r.stdout || "{}");
    return { ok: true, outputs: Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, v?.value])) };
  } catch {
    return { ok: false, error: "OpenTofu's outputs were not JSON" };
  }
}

/** The outputs clients read, in the names they already know: the address, the bucket. */
export function clientOutputs(entry, raw = {}) {
  const d = entry?.delivers || {};
  const out = {};
  const address = d.address ? raw[d.address] : null;
  if (typeof address === "string" && address) out[d.kind === "files" ? "WebsiteUrl" : "ApiUrl"] = address;
  if (d.kind === "files" && typeof raw[d.output] === "string") out.BucketName = raw[d.output];
  return out;
}

const removeWork = record => {
  try { fs.rmSync(workDirFor(record.deploymentId), { recursive: true, force: true }); } catch {}
};

/**
 * Build one environment from the organization's module, mutating `record` as it goes.
 * Never rejects: a thrown error becomes status "failed".
 *
 * @param {object} record
 * @param {object} plan
 * @param {string|null} appPath  the uploaded copy (null when deployed again)
 * @param {object} catalog       the plan's catalog, with the organization's platform values
 * @param {{ reader?: object }} [options]
 */
export async function startTerraformDeployment(record, plan, appPath, catalog, options = {}) {
  const { set, fail } = settersFor(record);
  const step = line => set(record.status, { step: line });
  try {
    set("packaging", { step: "Reading your plan and your organization's module" });
    const notReady = terraformNotReady();
    if (notReady) throw new Error(notReady);
    const { entry, planModule } = checkBuildable(plan, catalog);
    const again = record.source === "again";
    record.backend = "terraform";
    record.kind = entry.delivers.kind === "files" ? "static" : "api";
    record.stackName = record.environment;
    record.resourceName = record.resourceName || moduleName({ org: record.orgId || "default", team: record.teamId || "default", app: plan.app.name });
    putDeployment(record);

    // The app's code, for a module that takes a package: packaged as any other, with the
    // adapter beside the platform's start script, and kept for deploying again.
    let codePackage = null;
    if (entry.delivers.kind === "package") {
      const { zipPath } = stagePaths(record.deploymentId);
      if (again) {
        step(`Finding the code ${record.packagedBy || record.fromDeployment} packaged`);
        fs.mkdirSync(path.dirname(zipPath), { recursive: true });
        const fetched = await fetchArtifact(requireSetting("BUCKET"), record.artifactKey, zipPath);
        if (!fetched.ok) throw new Error(`the platform could not fetch the code ${record.packagedBy || record.fromDeployment} packaged (${fetched.error}), so nothing was built`);
      } else {
        const entryPoint = entryPointOfFolder(appPath);
        if (!entryPoint) {
          throw new Error("the platform cannot tell which file your app starts from: give package.json a main, or a start script that runs node with a file, or add index.js");
        }
        record.entryPoint = entryPoint;
        record.artifactKey = await stage(appPath, record.deploymentId, { kind: "api", parameters: { AppName: record.resourceName }, entryPoint, adapter: "handler" }, step);
        try { record.artifactSha256 = sha256File(zipPath); } catch (err) { record.artifactSha256 = null; record.artifactSha256Error = err.message; }
      }
      codePackage = zipPath;
    }

    step("Fetching your organization's module");
    const ready = await prepare(record, catalog, { entry, planModule, codePackage, reader: options.reader });
    record.terraform = {
      tofuVersion: TOFU_VERSION,
      providerVersion: AWS_PROVIDER_VERSION,
      module: { id: entry.id, source: ready.source, repo: ready.library.repo, commit: ready.library.commit },
      stateKey: ready.state.key,
      rootSha256: ready.rootSha256,
      // Each input by name and where it came from. The values are the platform's ids and
      // the plan's own words, kept so a tear-down builds the same root; never a setting.
      inputs: ready.sources,
      inputValues: Object.fromEntries(Object.entries(ready.inputs).filter(([k]) => k !== entry.delivers?.package)),
      ignoredInputs: ready.ignored,
      phase: null
    };
    putDeployment(record);

    set("running", { step: "Getting your organization's module ready to build" });
    record.terraform.phase = "init";
    const inited = await init(ready.dir, ready.home);
    if (!inited.ok) throw new Error(firstError(inited));

    step("Working out what to build");
    record.terraform.phase = "plan";
    putDeployment(record);
    const planned = await runTofu(["plan", "-input=false", "-no-color", "-json", "-lock-timeout=60s", "-out=tfplan"], { cwd: ready.dir, home: ready.home });
    if (!planned.ok) throw new Error(lockHeld(planned) ? LOCKED : firstError(planned));
    record.terraform.planned = changeSummary(planned.messages);

    step("Building your environment");
    record.terraform.phase = "apply";
    record.terraform.applyStartedAt = now();
    putDeployment(record);
    const applied = await runTofu(["apply", "-input=false", "-no-color", "-json", "-lock-timeout=60s", "tfplan"], { cwd: ready.dir, home: ready.home });
    record.terraform.phase = null;
    record.terraform.applied = changeSummary(applied.messages);
    record.terraform.resources = appliedResources(applied.messages);
    if (!applied.ok) throw new Error(lockHeld(applied) ? LOCKED : firstError(applied));

    step("Reading back your environment's address");
    const read = await readOutputs(ready.dir, ready.home);
    if (!read.ok) throw new Error(`your environment was built, and the platform could not read back its address (${read.error})`);
    record.moduleOutputs = read.outputs;
    record.outputs = clientOutputs(entry, read.outputs);

    if (record.kind === "static") {
      const bucket = record.outputs.BucketName;
      if (!bucket) throw new Error(`the module came up without the ${entry.delivers.output} output, so there is nowhere to put your files`);
      step("Uploading your site's files");
      const synced = await syncSite(appPath, bucket, { profile: terraformProfile() });
      if (!synced.ok) throw new Error(`could not upload your files: ${synced.stderr.trim() || `exit ${synced.code}`}`);
      record.syncedFrom = "the uploaded copy of your folder";
      // A site already up shows its new files at once, not when the network's copies expire.
      const refreshed = await refreshSite(bucket, { profile: terraformProfile() });
      record.siteRefreshed = refreshed.ok ? true : `not refreshed: ${refreshed.error}`;
    }

    await set("succeeded", { failureReason: null, finishedAt: now(), step: null });
    try {
      record.report = renderReport(record, plan);
    } catch (err) {
      record.reportError = err.message;
    }
    return putDeployment(record);
  } catch (err) {
    return fail(err.message);
  } finally {
    removeWork(record);
  }
}

/** The catalog entry and plan module a record was built with. */
function builtModuleOf(record, catalog) {
  const id = record.terraform?.module?.id;
  const entry = id ? moduleEntry(id, catalog) : null;
  const planModule = (record.plan?.modules || []).find(m => m?.id === id) || { id, inputs: {} };
  if (!entry) throw new Error(`the catalog this environment was built from no longer has ${id || "its module"}, so the platform cannot read it`);
  return { entry, planModule };
}

/**
 * Tear down a Terraform environment. Mutates `record`; never rejects. Safe to start
 * again after a restart: every step of it is.
 */
export async function startTerraformDestroy(record, catalog, options = {}) {
  const set = (status, patch = {}) => {
    Object.assign(record, { status, ...patch });
    return putDeployment(record);
  };
  const fail = reason => set("failed", { failureReason: reason, step: null });
  const done = note => {
    try { cleanStage(record.deploymentId); } catch {}
    closeSiblings(record);
    return set("destroyed", { destroyedAt: now(), failureReason: null, step: null, ...(note ? { note } : {}) });
  };
  try {
    set("destroying", { step: "Checking what is still there" });
    if (!record.terraform?.stateKey || !record.terraform?.inputValues) return done("Nothing was ever built for this deployment.");
    const notReady = terraformNotReady();
    if (notReady) return fail(notReady.replace("nothing was built", "nothing was torn down"));
    const { entry, planModule } = builtModuleOf(record, catalog);
    const ready = await prepare(record, catalog, { entry, planModule, inputs: record.terraform.inputValues, reader: options.reader });
    const inited = await init(ready.dir, ready.home);
    if (!inited.ok) return fail(firstError(inited));

    // A bucket with files in it is not removed, so a site's files go first.
    const bucket = record.outputs?.BucketName;
    if (record.kind === "static" && bucket) {
      set("destroying", { step: "Emptying your site's storage" });
      const emptied = await emptyBucket(bucket, { profile: terraformProfile() });
      if (!emptied.ok && !/NoSuchBucket/.test(emptied.stderr)) return fail(`could not empty your site's storage: ${emptied.stderr.trim() || `exit ${emptied.code}`}`);
    }

    set("destroying", { step: "Removing everything your environment is made of" });
    const destroyed = await runTofu(["destroy", "-auto-approve", "-input=false", "-no-color", "-json", "-lock-timeout=60s"], { cwd: ready.dir, home: ready.home });
    if (!destroyed.ok) return fail(lockHeld(destroyed) ? LOCKED : firstError(destroyed));
    record.terraform.destroyed = changeSummary(destroyed.messages);

    // Gone only when the state says nothing is left.
    const listed = await runTofu(["state", "list", "-no-color"], { cwd: ready.dir, home: ready.home });
    if (!listed.ok) return fail(`your environment was torn down, and the platform could not read its record afterwards to be sure (${firstError(listed)})`);
    const left = builtParts(listed.stdout);
    if (left.length) return fail(`the tear-down finished with parts of your environment still there: ${left.join(", ")}`);
    return done();
  } catch (err) {
    return fail(err.message);
  } finally {
    removeWork(record);
  }
}

/**
 * Checked now, for the evidence: whether anything changed outside seaLeye, read-only
 * (`plan -refresh-only`, no lock), and what the state holds.
 *
 * @returns {Promise<{ ok: boolean, drift?: object[], resources?: string[], error?: string }>}
 */
export async function checkTerraformNow(record, catalog, options = {}) {
  const scratch = { ...record, deploymentId: `${record.deploymentId}-check` };
  try {
    if (!record.terraform?.inputValues) return { ok: false, error: "nothing was built" };
    const { entry, planModule } = builtModuleOf(record, catalog);
    const ready = await prepare(scratch, catalog, { entry, planModule, inputs: record.terraform.inputValues, reader: options.reader });
    const inited = await init(ready.dir, ready.home);
    if (!inited.ok) return { ok: false, error: firstError(inited) };
    const listed = await runTofu(["state", "list", "-no-color"], { cwd: ready.dir, home: ready.home });
    if (!listed.ok) return { ok: false, error: firstError(listed) };
    const resources = builtParts(listed.stdout);
    const checked = await runTofu(["plan", "-refresh-only", "-detailed-exitcode", "-lock=false", "-input=false", "-no-color", "-json", "-out=check.tfplan"], { cwd: ready.dir, home: ready.home });
    if (checked.code !== 0 && checked.code !== 2) return { ok: false, resources, error: firstError(checked) };
    if (checked.code === 0) return { ok: true, resources, drift: [] };
    // Which attributes changed, from the saved plan; the part alone if it cannot be read.
    const shown = await runTofu(["show", "-json", "-no-color", "check.tfplan"], { cwd: ready.dir, home: ready.home });
    let drift = null;
    if (shown.ok) {
      try { drift = driftDetail(JSON.parse(shown.stdout)); } catch {}
    }
    return { ok: true, resources, drift: drift && drift.length ? drift : driftedResources(checked.messages) };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    removeWork(scratch);
  }
}

/**
 * A Terraform deployment the API was building when it stopped: failed, saying so, with
 * the state's lock kept for a person to release (`deploy/server.sh tofu-unlock`).
 */
export function interruptedBuild(record) {
  const { fail } = settersFor(record);
  const during = record.terraform?.phase;
  record.lockKept = during === "plan" || during === "apply";
  return fail(during === "apply"
    ? "The platform restarted while building your environment, so it may be part-built. Ask your platform team to release it, then deploy again to finish it, or tear it down."
    : "The platform restarted while getting this deployment ready, before your environment was built. Run it again.");
}
