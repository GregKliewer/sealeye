// core/module-versions.js
// A module's version, from the library's tags (PHASE4-PLAN Step 9, the second pull
// request; DESIGN.md, "Each module is built at the version its library released").
//
// A library releases each module on its own, as a tag named after the module's folder:
// `http-api/v1.4.0`. Discovery reads each module at the commit its newest release points
// to, the catalog records the version and the commit, and the Terraform executor builds
// that commit. A pre-release (`v2.0.0-rc1`) is not a release. A library that tags none
// of its modules is read at one commit, as before; in one that tags any, a module with
// no release is not built ("not released yet").
//
// Runs in a browser too: no `node:` modules, no packages.

const TAG = /^(?<module>[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)\/v(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)$/;

/**
 * A tag's module and version, or null for a tag that is not a module's release (a
 * pre-release, a tag of the whole library, anything else).
 *
 * @returns {{ module: string, version: string, parts: number[] } | null}
 */
export function moduleRelease(tagName) {
  const m = TAG.exec(String(tagName || ""));
  if (!m) return null;
  const parts = [m.groups.major, m.groups.minor, m.groups.patch].map(Number);
  return { module: m.groups.module, version: parts.join("."), parts };
}

/** Negative, zero or positive, as `a` is older than, the same as or newer than `b`. */
export function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

export const majorOf = version => Number(String(version).split(".")[0]) || 0;

/**
 * Each module's newest release, by the name its tags give it (the folder's last part, or
 * the folder itself: `http-api` or `modules/http-api`).
 *
 * @param {{ name: string, commit: string }[]} tags
 * @returns {Map<string, { version: string, tag: string, commit: string }>}
 */
export function newestReleases(tags = []) {
  const out = new Map();
  for (const t of tags) {
    const r = moduleRelease(t?.name);
    if (!r || !t.commit) continue;
    const held = out.get(r.module);
    if (!held || compareVersions(r.version, held.version) > 0) out.set(r.module, { version: r.version, tag: t.name, commit: t.commit });
  }
  return out;
}

/** The release of the module in `folder` (`modules/http-api`), by its whole path or its last part. */
export function releaseFor(releases, folder) {
  const f = String(folder || "").replace(/^\.\/|\/$/g, "");
  return releases.get(f) || releases.get(f.split("/").pop()) || null;
}

/**
 * What changed between two versions of a module, from its CHANGELOG.md: each line under
 * a `## <version>` heading newer than `from` and no newer than `to`, newest first. Empty
 * when the module keeps no changelog or says nothing.
 */
export function changesBetween(changelog, from, to) {
  const lines = [];
  let inside = false;
  for (const raw of String(changelog || "").split("\n")) {
    const heading = /^##\s+v?(\d+\.\d+\.\d+)\s*$/.exec(raw.trim());
    if (heading) {
      inside = compareVersions(heading[1], from) > 0 && compareVersions(heading[1], to) <= 0;
      continue;
    }
    const item = /^\s*[-*]\s+(.*\S)\s*$/.exec(raw);
    if (inside && item) lines.push(item[1]);
  }
  return lines;
}
