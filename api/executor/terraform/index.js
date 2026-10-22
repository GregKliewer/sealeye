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
import { firstSentence, moduleEntry } from "../../../core/catalog.js";
import { moduleName } from "../../../core/names.js";
import { settingNamesFor } from "../../../core/setting-names.js";
import { connectionProblems, doorLogsOutput, inNetwork, isPart, ownOtherLogGroup, partLogKind, partLogsOutputs, terraformBuilds } from "../../../core/terraform-modules.js";
import { putDeployment } from "../../store.js";
import { changesIn, versionBuilt, versionMove } from "./versions.js";
import { valuesAt } from "../../platform.js";
import { closeSiblings, settersFor } from "../index.js";
import { deleteInterface, emptyBucket, fetchArtifact, leftoverInterfaces, recentLogs, refreshSite, syncSite } from "../cfn.js";
import { kindOf, redactedLine, scanText } from "../../../core/scan.js";
import { platformLine } from "../../../core/platform-lines.js";
import { cleanStage, entryPointOfFolder, sha256File, stage, stagePaths } from "../package.js";
import { renderReport } from "../report.js";
import { moduleCode } from "./library.js";
import { connectionInputs, inputsFor, lockedProviders, outputsWanted, rootModule, shapedFor, stateKeyFor, writeRoot } from "./root.js";
import { moduleInputs } from "../../discovery/terraform.js";

/** Whether a plan's modules put the app in the private network: one of the parts lives there. */
const joinsNetwork = parts => (parts || []).some(p => inNetwork(p.entry));

/** What a tear-down says while it removes an environment that joined the private network. */
export const NETWORK_TEARDOWN_STEP = "Removing everything your environment is made of, and its connections into the private network, which can take up to 20 minutes";

/**
 * Sweep the network interfaces an environment's functions in the private network left
 * behind (DESIGN.md, "A tear-down waits for the private network, and sweeps what it
 * leaves"). The platform removes a function's interface with the function's own role,
 * up to 20 minutes after the function is gone, and the library's module deletes that
 * role at once, so an interface the platform did not get to stays detached. Run after
 * a tear-down and before a build, through the Terraform role, which may delete a
 * detached interface and nothing in use. A sweep that cannot run never fails the
 * environment: the record says what was swept, or why nothing could be.
 */
async function sweepInterfaces(record) {
  const name = record.resourceName;
  if (!name) return;
  const profile = terraformProfile();
  const found = await leftoverInterfaces(name, { profile });
  if (!found.ok) {
    record.terraform.swept = { at: now(), error: found.error };
    return;
  }
  const swept = [];
  const kept = [];
  for (const i of found.interfaces) {
    const r = await deleteInterface(i.id, { profile });
    if (r.ok) swept.push(i.id); else kept.push({ id: i.id, error: r.error });
  }
  record.terraform.swept = { at: now(), interfaces: swept, ...(kept.length ? { notDeleted: kept } : {}) };
}

/**
 * A catalog entry with each input's declared shape read from the code that runs, so a
 * catalog discovered before shapes were recorded still gives a list input a list.
 */
function withCodeTypes(entry, moduleDir) {
  let read = {};
  try { read = moduleInputs(moduleDir); } catch { return entry; }
  const inputs = Object.fromEntries(Object.entries(entry.inputs || {}).map(([name, spec]) => [name, read[name]?.type ? { ...spec, type: read[name].type } : spec]));
  return { ...entry, inputs };
}

/** Each input's value in the shape its module declares (shapedFor), however it was kept. */
const shapedAll = (entry, given) => Object.fromEntries(Object.entries(given || {}).map(([k, v]) => [k, shapedFor(entry.inputs?.[k], v)]));
import {
  AWS_PROVIDER_VERSION, TOFU_VERSION, appliedResources, builtParts, changeSummary, driftDetail, driftedResources, firstError, invokedFunction,
  homeFor, lockHeld, runTofu, terraformNotReady, terraformProfile
} from "./tofu.js";

const now = () => new Date().toISOString();

/** How many of a setup step's last lines a failure reason carries. */
export const SETUP_LINES = 5;

/**
 * When an apply failed at a step the module invokes itself (the database's one-time
 * setup function), that step's last lines, for the failure reason (DESIGN.md, "A failed
 * setup step says its last lines"): its log stays the platform team's, so this is the one
 * place a developer reads it. Only a function named for this environment's own module
 * (`<name>-...`), read through the Terraform role since the apply began; a line that looks
 * like it holds a secret is replaced, as anywhere a file's lines travel; the platform's
 * own lines are said in its words (`platformLine`). Null when there is nothing to add,
 * or the log cannot be read: the reason stands without it.
 */
export async function setupLastLines(result, { name, since, read = recentLogs, profile = terraformProfile() } = {}) {
  const fn = invokedFunction(result);
  if (!fn || !name || !fn.startsWith(`${name}-`)) return null;
  const sinceMs = Date.parse(since || "") - 60_000;
  const got = await read(`/aws/lambda/${fn}`, { sinceMs: Number.isFinite(sinceMs) ? sinceMs : Date.now() - 3_600_000, maxItems: 200, profile }).catch(() => ({ ok: false }));
  if (!got?.ok || !got.events?.length) return null;
  const said = got.events
    .map(e => String(e.message || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    // A request handed over or finished says nothing a failure needs.
    .filter(line => !["request-start", "request-end", "cold-start"].includes(platformLine(line)?.kind))
    .map(line => {
      const found = scanText("setup.log", line);
      if (found.length) return redactedLine(kindOf(found[0].rule));
      const platform = platformLine(line);
      return platform ? `${platform.words} (${line})` : line;
    })
    .slice(-SETUP_LINES)
    .map(line => (line.length > 400 ? `${line.slice(0, 400)}...` : line));
  return said.length ? `The setup step's last lines: ${said.map(l => `"${l}"`).join("; ")}.` : null;
}

/** Where an environment's root module is written for one deployment, removed after. */
export const workDirFor = deploymentId => path.join(sealeyeHome(), "tofu", deploymentId);

/** The words for a state another change holds. */
const LOCKED = "Another change to this environment holds its lock, so nothing was changed. If nothing else is under way, ask your platform team to release it, then try again.";

/**
 * A Terraform plan's modules: the one that runs the app (`entry`, `planModule`), and the
 * modules the app uses, connected to it (`parts`, DESIGN.md, "Modules are connected
 * through what the library offers"). Null when it uses none; an error in words when it
 * cannot be built as one environment.
 */
export function terraformModuleOf(plan, catalog) {
  const enabled = (plan?.modules || []).filter(m => m && m.enabled !== false);
  const entries = enabled.map(m => ({ planModule: m, entry: moduleEntry(m.id, catalog) }));
  const tf = entries.filter(e => e.entry?.builds_with === "terraform");
  if (!tf.length) return null;
  if (tf.length !== enabled.length) {
    throw new Error("this plan uses modules built two different ways, and the platform builds a plan one way, so nothing was built");
  }
  const apps = tf.filter(e => e.entry.delivers);
  const parts = tf.filter(e => !e.entry.delivers && isPart(e.entry));
  if (apps.length + parts.length !== tf.length) {
    const odd = tf.find(e => !e.entry.delivers && !isPart(e.entry));
    throw new Error(`this plan uses ${odd.entry.id}, which neither runs the app nor offers it anything to connect to, so nothing was built`);
  }
  if (apps.length !== 1) {
    throw new Error(apps.length ? "this plan uses more than one module that runs the app, and an environment has one, so nothing was built" : "this plan uses no module that runs the app, so there is nothing to connect the others to, and nothing was built");
  }
  return { ...apps[0], parts };
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
  for (const { entry } of [found, ...found.parts]) {
    const why = terraformBuilds(entry, catalog?.platform).why;
    if (why) throw new Error(`the platform cannot build ${entry.id}: ${why}`);
  }
  const wiring = connectionProblems(plan, catalog);
  if (wiring.length) throw new Error(`the plan cannot be built as one environment: ${wiring[0].message}`);
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
 * app's module and each module the app uses, at the commit the record was built from,
 * with the inputs they were built with.
 */
async function prepare(record, catalog, { entry, planModule, parts = [], inputs = null, codePackage = null, reader } = {}) {
  const dir = workDirFor(record.deploymentId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pinnedTo = built => built?.commit
    ? { ...catalog, discovery: { ...(catalog.discovery || {}), library: [{ repo: built.repo, commit: built.commit }] } }
    : catalog;
  // What was built is torn down with the same code: the record's commit and release,
  // whatever the catalog releases now.
  const pinnedEntry = (e, built) => built?.commit ? { ...e, commit: built.commit, version: built.version, tag: built.tag, unreleased: false } : e;
  const built = record.terraform?.module;
  const code = await moduleCode(pinnedTo(built), pinnedEntry(entry, built), { reader });
  const bucket = requireSetting("BUCKET");
  const team = record.teamId || "default";
  const tags = { "sealeye:app": record.app?.name || "", "sealeye:team": team, "sealeye:environment": record.stackName };
  const platform = valuesAt(record.orgId || "default");

  // Each module the app uses, as the record has it when it was built before.
  const builtParts = new Map((record.terraform?.parts || []).map(p => [p.id, p]));
  const libraries = {};
  const readyParts = [];
  for (const part of parts) {
    const was = builtParts.get(part.entry.id);
    const partCode = await moduleCode(pinnedTo(was), pinnedEntry(part.entry, was), { reader });
    const partEntry = withCodeTypes(part.entry, path.join(partCode.libraryDir, partCode.source));
    const folder = partCode.library.commit === code.library.commit ? "library" : `library-${partCode.library.commit.slice(0, 12)}`;
    if (folder !== "library") libraries[folder] = partCode.libraryDir;
    let given = was?.inputValues;
    let sources = was?.inputs || [];
    let ignored = was?.ignoredInputs || [];
    if (!given) ({ inputs: given, sources, ignored } = inputsFor({ entry: partEntry, planModule: part.planModule, name: record.resourceName, tags, platform }));
    given = shapedAll(partEntry, given);
    readyParts.push({
      key: part.entry.id, entry: part.entry, planModule: part.planModule, moduleSource: `./${folder}/${partCode.source}`,
      inputs: given, sources, ignored, library: partCode.library, source: partCode.source, moduleDir: path.join(partCode.libraryDir, partCode.source)
    });
  }
  const connected = connectionInputs(entry, readyParts);
  const appEntry = withCodeTypes(entry, path.join(code.libraryDir, code.source));

  let given = inputs;
  let sources = record.terraform?.inputs || [];
  let ignored = record.terraform?.ignoredInputs || [];
  if (!given) {
    ({ inputs: given, sources, ignored } = inputsFor({
      entry: appEntry, planModule, name: record.resourceName, tags, platform, code: { package: codePackage }, connected: new Set(Object.keys(connected.inputs)), parts: readyParts
    }));
    given = { ...given, ...connected.inputs };
    sources = [...sources, ...connected.sources];
  } else if (entry.delivers?.kind === "package") {
    // A package input names a file in the working folder, which a later run has to have.
    const file = path.join(dir, "package.zip");
    fs.writeFileSync(file, EMPTY_ZIP);
    given = { ...given, [entry.delivers.package]: file };
  }
  given = shapedAll(appEntry, given);
  const state = { bucket, key: record.terraform?.stateKey || stateKeyFor({ org: record.orgId || "default", environment: record.stackName }) };
  const root = rootModule({ moduleSource: `./library/${code.source}`, inputs: given, outputs: outputsWanted(entry), state, tags, parts: readyParts });
  const rootSha256 = writeRoot(dir, { root, libraryDir: code.libraryDir, libraries });
  return {
    dir, home: homeFor(dir), inputs: given, sources, ignored, state, rootSha256, library: code.library, source: code.source,
    moduleDir: path.join(code.libraryDir, code.source), parts: readyParts, settings: connected.settings
  };
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
export function clientOutputs(entry, raw = {}, { name = null } = {}) {
  const d = entry?.delivers || {};
  const out = {};
  const address = d.address ? raw[d.address] : null;
  if (typeof address === "string" && address) out[d.kind === "files" ? "WebsiteUrl" : "ApiUrl"] = address;
  if (d.kind === "files" && typeof raw[d.output] === "string") out.BucketName = raw[d.output];
  // Where the app's logs are kept, when the module says: `sealeye logs` reads there,
  // and only there. A group is kept only when it is this environment's own (named for
  // the module's name, which every function of the environment starts with) and not the
  // database setup function's, which stays the platform team's (DESIGN.md, "A Terraform
  // environment's logs are read where its module says they are").
  if (d.kind === "package" && d.logs && ownLogGroup(raw[d.logs], name)) out.LogGroup = raw[d.logs];
  return out;
}

/**
 * Where the environment's other lines are kept (DESIGN.md, "The front door's and the
 * database's lines, beside the app's"): the front door's record, from the app's module,
 * and each module the app uses' own logs, each by where it came from. A group is kept
 * only when it is the environment's own (`ownOtherLogGroup`), as the app's is.
 * @returns {{ from: string, group: string }[]}
 */
export function otherLogs(entry, parts = [], raw = {}, name = null) {
  const out = [];
  const door = doorLogsOutput(entry);
  if (door && ownOtherLogGroup(raw[door], name)) out.push({ from: "door", kind: "door", words: "the front door", group: raw[door] });
  // A database is "your database" and read by its phrasebook; another module is named by
  // its catalog line, its lines shown as they are. Two databases go by their ids.
  const kinds = parts.map(p => partLogKind(p.entry));
  for (const [i, p] of parts.entries()) {
    const kind = kinds[i];
    const many = kinds.filter(k => k === "database").length > 1;
    const from = kind === "database" && !many ? "database" : p.key;
    const words = kind === "database" && !many ? "your database" : lineWords(p.entry, p.key);
    for (const o of partLogsOutputs(p.entry)) {
      const group = raw[`${p.key}__${o}`];
      if (ownOtherLogGroup(group, name)) out.push({ from, kind, words, group });
    }
  }
  return out;
}

/** A module's catalog line as a place's name: "a table of documents your app finds by key". */
function lineWords(entry, id) {
  const line = String(entry?.line || "").trim().replace(/[.!?]+$/, "");
  return line ? line.charAt(0).toLowerCase() + line.slice(1) : String(id);
}

/** Whether a log group a module output is the environment's own app group. */
export function ownLogGroup(group, name) {
  if (typeof group !== "string" || !name) return false;
  return group.startsWith(`/aws/lambda/${name}-`) && !group.endsWith("-db-setup");
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
    const { entry, planModule, parts } = checkBuildable(plan, catalog);
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
    const ready = await prepare(record, catalog, { entry, planModule, parts, codePackage, reader: options.reader });
    record.terraform = {
      tofuVersion: TOFU_VERSION,
      providerVersion: AWS_PROVIDER_VERSION,
      module: { id: entry.id, source: ready.source, repo: ready.library.repo, commit: ready.library.commit, ...(ready.library.version ? { version: ready.library.version, tag: ready.library.tag } : {}) },
      stateKey: ready.state.key,
      rootSha256: ready.rootSha256,
      // Each input by name and where it came from. The values are the platform's ids and
      // the plan's own words, kept so a tear-down builds the same root; never a setting.
      inputs: ready.sources,
      inputValues: Object.fromEntries(Object.entries(ready.inputs).filter(([k]) => k !== entry.delivers?.package)),
      ignoredInputs: ready.ignored,
      // Each module the app uses, built beside it: its release, its inputs as the app's
      // are kept, and the setting each of its values reaches the app under, by name.
      ...(ready.parts.length ? {
        parts: ready.parts.map(p => ({
          id: p.entry.id, source: p.source, repo: p.library.repo, commit: p.library.commit,
          // The catalog's own words for it, what the report and a tear-down name it by.
          line: firstSentence(p.entry.short_line || p.entry.line || "") || null,
          ...(p.library.version ? { version: p.library.version, tag: p.library.tag } : {}),
          inputs: p.sources, inputValues: p.inputs, ignoredInputs: p.ignored
        })),
        settings: ready.settings
      } : {}),
      // Whether the app joined the private network, which a tear-down waits on.
      ...(joinsNetwork(parts) ? { network: true } : {}),
      phase: null
    };
    // A newer release than the environment had: which, and what its changelog says
    // changed, for the report and the evidence (versions.js).
    const move = versionMove(versionBuilt(record.environment || record.stackName, { except: record.deploymentId }), { source: ready.source, version: ready.library.version });
    if (move) record.terraform.module.versionChange = { from: move.from, to: move.to, changes: changesIn(ready.moduleDir, move) };
    putDeployment(record);

    // What an earlier tear-down of this environment may have left in the private network.
    if (joinsNetwork(parts)) await sweepInterfaces(record);

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
    if (!applied.ok) {
      if (lockHeld(applied)) throw new Error(LOCKED);
      const lines = await setupLastLines(applied, { name: record.resourceName, since: record.terraform.applyStartedAt });
      throw new Error(lines ? `${firstError(applied)} ${lines}` : firstError(applied));
    }

    step("Reading back your environment's address");
    const read = await readOutputs(ready.dir, ready.home);
    if (!read.ok) throw new Error(`your environment was built, and the platform could not read back its address (${read.error})`);
    record.moduleOutputs = read.outputs;
    record.outputs = clientOutputs(entry, read.outputs, { name: record.resourceName });
    // The front door's record of requests and each module's own logs, when the modules
    // say where they keep them, read back beside the app's own lines.
    record.terraform.logs = otherLogs(entry, ready.parts, read.outputs, record.resourceName);
    if (entry.delivers?.logs && !record.outputs.LogGroup) {
      record.terraform.logsNotKept = typeof read.outputs[entry.delivers.logs] === "string" ? "the module named a group that is not this environment's own" : "the module gave no group";
    }

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
  // Each module the app uses, as the record has it: its folder and release are enough to
  // read it again, whatever the catalog says of it now.
  const parts = (record.terraform?.parts || []).map(p => ({
    entry: moduleEntry(p.id, catalog) || { id: p.id, source: p.source, builds_with: "terraform", inputs: {} },
    planModule: (record.plan?.modules || []).find(m => m?.id === p.id) || { id: p.id, inputs: {} }
  }));
  return { entry, planModule, parts };
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
    const { entry, planModule, parts } = builtModuleOf(record, catalog);
    const ready = await prepare(record, catalog, { entry, planModule, parts, inputs: record.terraform.inputValues, reader: options.reader });
    const inited = await init(ready.dir, ready.home);
    if (!inited.ok) return fail(firstError(inited));

    // A bucket with files in it is not removed, so a site's files go first.
    const bucket = record.outputs?.BucketName;
    if (record.kind === "static" && bucket) {
      set("destroying", { step: "Emptying your site's storage" });
      const emptied = await emptyBucket(bucket, { profile: terraformProfile() });
      if (!emptied.ok && !/NoSuchBucket/.test(emptied.stderr)) return fail(`could not empty your site's storage: ${emptied.stderr.trim() || `exit ${emptied.code}`}`);
    }

    // And the files in a bucket a module the app uses made (file-bucket's bucket_name).
    for (const part of record.terraform.parts || []) {
      const name = Object.entries(record.moduleOutputs || {}).find(([k, v]) => k.startsWith(`${part.id}__`) && /bucket/.test(k) && typeof v === "string")?.[1];
      if (!name) continue;
      set("destroying", { step: "Emptying the storage your app kept its files in" });
      const emptied = await emptyBucket(name, { profile: terraformProfile() });
      if (!emptied.ok && !/NoSuchBucket/.test(emptied.stderr)) return fail(`could not empty the storage your app kept its files in: ${emptied.stderr.trim() || `exit ${emptied.code}`}`);
    }

    // An environment in the private network waits for the platform to let go of its
    // functions' interfaces (up to 20 minutes), and says so.
    const network = record.terraform.network === true || joinsNetwork(parts);
    set("destroying", { step: network ? NETWORK_TEARDOWN_STEP : "Removing everything your environment is made of" });
    const destroyed = await runTofu(["destroy", "-auto-approve", "-input=false", "-no-color", "-json", "-lock-timeout=60s"], { cwd: ready.dir, home: ready.home });
    if (!destroyed.ok) return fail(lockHeld(destroyed) ? LOCKED : firstError(destroyed));
    record.terraform.destroyed = changeSummary(destroyed.messages);
    if (network) {
      set("destroying", { step: "Removing what the private network left behind" });
      await sweepInterfaces(record);
    }

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
    const { entry, planModule, parts } = builtModuleOf(record, catalog);
    const ready = await prepare(scratch, catalog, { entry, planModule, parts, inputs: record.terraform.inputValues, reader: options.reader });
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
    // What `show` read decides, even when it leaves nothing: the streamed messages count
    // the cloud's own differences as changes too.
    return { ok: true, resources, drift: drift ?? driftedResources(checked.messages) };
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
