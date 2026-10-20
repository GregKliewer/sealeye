// api/executor/terraform/versions.js
// Which release of an organization's module a deploy builds (PHASE4-PLAN Step 9, the
// second pull request; DESIGN.md, "Each module is built at the version its library
// released"). Greg, Oct 17, 2026 (V3): an environment keeps its module's version until a
// newer catalog goes live; its next deploy, or deploy again, then builds the live
// catalog's release of the same module and says what changed. A new major version may
// take different inputs, so it is refused, and `sealeye run` plans against it again.
import fs from "node:fs";
import path from "node:path";

import { listDeployments } from "../../store.js";
import { changesBetween, compareVersions, majorOf } from "../../../core/module-versions.js";

/**
 * The plan's catalog, each of its Terraform modules at the release the live catalog
 * builds of the same module. A module the live catalog does not release, or does not
 * have, stays as the plan's catalog has it.
 */
export function withLiveReleases(planDoc, liveDoc) {
  if (!planDoc || !liveDoc || planDoc === liveDoc) return planDoc;
  const live = new Map((liveDoc.modules || []).filter(m => m?.builds_with === "terraform").map(m => [m.id, m]));
  return {
    ...planDoc,
    modules: (planDoc.modules || []).map(m => {
      const l = live.get(m?.id);
      if (!l || m?.builds_with !== "terraform" || !l.version || !l.commit || l.source !== m.source) return m;
      return { ...m, version: l.version, tag: l.tag, commit: l.commit, unreleased: undefined };
    })
  };
}

/** The version the environment's last build used, or null (none yet, or not released). */
export function versionBuilt(environment, { except = null } = {}) {
  const last = listDeployments().find(d =>
    d.deploymentId !== except && d.backend === "terraform" && (d.stackName || d.environment) === environment &&
    d.terraform?.module?.version && d.status === "succeeded");
  return last ? { version: last.terraform.module.version, source: last.terraform.module.source, deploymentId: last.deploymentId } : null;
}

/**
 * From the version an environment has to the one this deploy builds: null when it is
 * the same or there was none, else { from, to, major }.
 */
export function versionMove(before, entry) {
  if (!before?.version || !entry?.version || before.source !== entry.source) return null;
  if (compareVersions(before.version, entry.version) === 0) return null;
  return { from: before.version, to: entry.version, major: majorOf(before.version) !== majorOf(entry.version) };
}

/** The refusal for a new major version, in words. */
export function majorVersionWords(entry, move) {
  return `Your organization's library has released a new major version of ${entry.source} (${move.from} to ${move.to}), which may take what your app gives it differently. Run sealeye run again to plan against it. Nothing was deployed.`;
}

/** What the module's changelog says changed from one version to the next, in its words. */
export function changesIn(moduleDir, move) {
  if (!move) return [];
  try {
    return changesBetween(fs.readFileSync(path.join(moduleDir, "CHANGELOG.md"), "utf8"), move.from, move.to).slice(0, 20);
  } catch {
    return [];
  }
}
