// core/plan-report-words.js
// What `sealeye plan` and seaLeye.online's Plan and report card say about one
// deployment's plan and report (GET /deployments/{id}/plan), so the two surfaces say it
// the same way. Runs in a browser too: nothing here imports a node: module or a package.

/** Where the plan's files came from, in a sentence. */
export function planOrigin(view) {
  if (view?.rebuilt) {
    return "Written now from the plan this deployment used, because it was made before seaLeye kept the approved files. The interview's summary and assumptions are not in it.";
  }
  if (view?.notesKept) return "The plan as it was approved, the same files sealeye run writes into the app's folder.";
  return "The plan this deployment used. It did not come straight from an interview, so its summary and assumptions are not in it.";
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
