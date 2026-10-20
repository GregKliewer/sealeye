// core/plan-report-words.js
// What `sealeye plan` and seaLeye.online's Plan and report card say about one
// deployment's plan and report (GET /deployments/{id}/plan), so the two surfaces say it
// the same way. Runs in a browser too: nothing here imports a node: module or a package.

/** Where the plan's files came from, in a sentence. */
export function planOrigin(view) {
  if (view?.rebuilt) {
    return "Written from the plan this deployment used, and dated when it started, because it was made before seaLeye kept the approved files. The interview's summary and assumptions are not in it.";
  }
  if (view?.notesKept) return "The plan as it was approved, the same files sealeye run writes into the app's folder.";
  if (view?.planSource === "file") return "The plan this deployment used, deployed from a plan file, so the interview's summary and assumptions are not in it.";
  if (view?.planSource === "again") return "The plan this deployment used when it deployed earlier code again. The interview's summary and assumptions were not kept with it.";
  return "The plan this deployment used. The interview's summary and assumptions were not kept with this deployment, so they are not in it.";
}

/** Why a deployment has no report, from its own status. */
export function noReportWords({ status, failureReason, reportError } = {}) {
  if (reportError) return `The environment was built, but its report could not be written: ${reportError}`;
  switch (status) {
    case "drafted": return "Nothing was built for a drafted plan, so there is no report.";
    case "failed": return failureReason ? `This deployment failed, so there is no report. The platform said: ${failureReason}` : "This deployment failed, so there is no report.";
    case "queued":
    case "packaging":
    case "running": return "The report is written when this deployment succeeds.";
    default: return "This deployment has no report.";
  }
}

/**
 * What a tear-down deletes that holds an app's data, in the catalog's words: each module
 * the app uses that was built beside it (a table, a bucket, a queue, a database), from
 * the record. Empty for an environment with none. A tear-down still runs: it is dev
 * (Greg, Oct 17, 2026, W6). Both surfaces say it before asking the platform.
 */
export function teardownDataWords(record) {
  const parts = Array.isArray(record?.terraform?.parts) ? record.terraform.parts : [];
  return parts.map(p => {
    const what = String(p?.line || "").trim().replace(/[.!?]+$/, "");
    const named = what ? what.charAt(0).toLowerCase() + what.slice(1) : `the module ${p?.id || ""}`.trim();
    return `This also deletes ${named}, and everything in it.`;
  });
}
