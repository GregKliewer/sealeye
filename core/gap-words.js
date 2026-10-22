// core/gap-words.js
// What the gap report says (PHASE4-PLAN Step 10; DESIGN.md, "The gap report"): what
// developers asked for that the live catalog cannot build, by how often and which
// teams, and what the library has for each. `sealeye gaps` and seaLeye.online's Gaps
// page both say these words. A platform team's report: it names modules and what the
// platform lacks, which a developer's words never do.
//
// Runs in a browser too: nothing here imports a node: module or a package.

/**
 * The checklist that breaks a tie, and only a tie (Greg, Oct 22, 2026: demand first;
 * more teams, then this). seaLeye's own order of what an app most often needs before it
 * can be trusted with real work: its secrets and its data first, then who may use it,
 * then the work it hands off and keeps, then how it runs and is reached. A need not on
 * it (one in the developer's own words) comes after every need that is.
 */
export const GAP_CHECKLIST = Object.freeze([
  "runtime_secrets",
  "relational_database",
  "user_sign_in",
  "work_queue",
  "file_storage",
  "continuous_service",
  "scheduled_task",
  "cache",
  "event_stream",
  "document_database",
  "internal_only",
  "custom_domain"
]);

/** A need's place on the checklist, or past the end of it. */
export const checklistPlace = kind => {
  const i = GAP_CHECKLIST.indexOf(kind);
  return i < 0 ? GAP_CHECKLIST.length : i;
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const day = iso => (iso ? String(iso).slice(0, 10) : null);

/** Who asked, in a line: "3 apps on 2 teams (lending, payments), last asked 2026-10-21". */
export function askedWords(gap) {
  const teams = (gap.teams || []).map(t => t.team);
  const last = day(gap.lastSeen);
  return `${plural(gap.count, "app")} on ${plural(teams.length, "team")} (${teams.join(", ")})${last ? `, last asked ${last}` : ""}`;
}

/** What the organization's library has for a gap, in a sentence. */
export function libraryWords(gap) {
  const lib = gap.library || {};
  switch (lib.status) {
    case "nothing":
      return "Nothing in your library meets this.";
    case "not_built": {
      const each = (lib.modules || []).map(m => `${m.id} (${m.why})`);
      return `Your library has ${each.join(" and ")}, which the platform cannot build yet.`;
    }
    case "unlisted":
      return "Not one of the needs the catalog knows: written in the developer's own words. Nothing can meet it until it is added to the list.";
    case "unknown":
    default:
      return "Not known: your live catalog was discovered before discovery said which needs each module meets. Discover the library again.";
  }
}

/** Why a gap is where it is, when that was not demand alone. */
export function rankWords(gap) {
  if (gap.tieBrokenBy === "teams") return "Ahead of a gap as many apps asked for: more teams asked for this one.";
  if (gap.tieBrokenBy === "checklist") return "Ahead of a gap as many apps and teams asked for: it comes first on the checklist of what apps most often need.";
  return null;
}

/** A need the live catalog builds now, that drafted plans still wait on. */
export function metWords(met) {
  const name = a => `${a.name} (${a.team})`;
  const ready = (met.apps || []).filter(a => !(a.stillWaiting || []).length);
  const waiting = (met.apps || []).filter(a => (a.stillWaiting || []).length);
  const parts = [`Your live catalog builds this now, with ${(met.modules || []).join(" or ")}.`];
  if (ready.length) parts.push(`${ready.length === 1 ? "The app that asked for it waits on nothing else, and" : `${ready.length} apps that asked for it wait on nothing else, and`} can be planned again with \`sealeye run\`: ${ready.map(name).join(", ")}.`);
  // Planning one of these again drafts it again: say what it still waits on.
  for (const a of waiting) parts.push(`${name(a)} still waits on ${a.stillWaiting.join("; ")}, so planning it again would draft it again.`);
  return parts.join(" ");
}

/** The report's heading line. */
export function gapsHeading(report) {
  const c = report?.catalog || {};
  const which = c.source === "starter" ? "the starter catalog" : `catalog ${c.version}`;
  return `What developers asked for that ${which} cannot build`;
}

/** What the report says when there is nothing in it. */
export function noGapsWords(report) {
  if (!report?.apps) return "No developer has a plan waiting on anything yet.";
  return "Nothing developers asked for is missing from what the platform builds.";
}
