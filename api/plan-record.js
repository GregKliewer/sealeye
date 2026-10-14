// api/plan-record.js
// The plan a deployment was approved with, written down as the files the developer saw
// (DEPLOYMENT_PLAN.md and sealeye.yaml, core/plan-files.js), and kept on its record so
// either surface can show them later beside its DEPLOYMENT_REPORT.md.
//
// The interview's summary and assumptions are part of DEPLOYMENT_PLAN.md but not of the
// plan a client sends with POST /deployments. Both clients answer "Deploy this?" before
// they deploy, so when that answer arrives the API notes what the interview said,
// keyed by who answered and the plan's exact text, and a deploy of that same plan by
// that same person picks it up. Anything else (a plan from a file, one changed with
// Configure, an API restarted in between) is written down from the plan alone and says
// so, and never claims assumptions it does not know.
import crypto from "node:crypto";

import { upgradePlan } from "../core/schema.js";
import { planFiles } from "../core/plan-files.js";

const KEEP_MS = 60 * 60 * 1000;   // an hour: an answer and its deploy are seconds apart
const MAX_KEPT = 500;

const kept = new Map();   // key -> { summary, assumptions, at }

export const planDigest = plan =>
  crypto.createHash("sha256").update(JSON.stringify(upgradePlan(plan)), "utf8").digest("hex");

/** Whose notes these are: one person in one team. A laptop API with no tokens is one person. */
const whose = caller => (caller ? `${caller.org || "default"}/${caller.team || "default"}/${caller.email || caller.tokenId || ""}` : "local");

function sweep(now) {
  for (const [key, entry] of kept) if (now - entry.at > KEEP_MS) kept.delete(key);
  while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value);
}

/**
 * When "Deploy this?" is answered: note what the interview said about the plan it showed.
 * `result` is the interview's result (plan, summary, assumptions).
 */
export function noteInterviewPlan(caller, result, now = Date.now()) {
  if (!result?.plan || typeof result.plan !== "object") return;
  sweep(now);
  const key = `${whose(caller)}|${planDigest(result.plan)}`;
  kept.delete(key);
  kept.set(key, {
    summary: typeof result.summary === "string" ? result.summary : "",
    assumptions: Array.isArray(result.assumptions) ? result.assumptions.filter(a => typeof a === "string") : [],
    at: now
  });
}

/**
 * The interview's notes for this exact plan from this caller. Left in place, so a deploy
 * refused for a reason the developer then fixes (a secret moved to a setting, a change
 * that was under way) still finds them when it is sent again within the hour.
 */
export function interviewNotesFor(caller, plan, now = Date.now()) {
  sweep(now);
  const entry = kept.get(`${whose(caller)}|${planDigest(plan)}`);
  return entry ? { summary: entry.summary, assumptions: entry.assumptions } : null;
}

/**
 * The two files for a record, written now. With the interview's notes, they are the files
 * the developer saw; without, the notes section says they were not kept. A plan the files
 * cannot be written for gets the reason instead, and the deployment goes ahead: a file
 * that will not render is a reporting problem, not a reason to refuse a deploy.
 */
export function planFilesFor(plan, notes, date = new Date()) {
  try {
    // An old plan (0.2, 0.3) is read as the contract reads it: a module it names that
    // seaLeye cannot build becomes the need it described (core/schema.js).
    const current = upgradePlan(plan);
    const submission = notes
      ? { plan: current, summary: notes.summary, assumptions: notes.assumptions }
      : { plan: current, notesKept: false };
    return { planFiles: { files: planFiles(submission, { date }), notesKept: Boolean(notes), writtenAt: date.toISOString() } };
  } catch (err) {
    // The reason goes to the server's log; the developer gets a sentence.
    console.error(`[plan-record] the plan's files could not be written: ${err.message}`);
    return { planFilesError: "the platform could not write this plan down as files" };
  }
}

/**
 * GET /deployments/{id}/plan: the plan as approved and the report, as the record holds
 * them. A record from before plans were kept is written down from its plan now, dated
 * when it started, and marked `rebuilt` so neither surface passes it off as the original.
 */
export function planView(record) {
  const view = {
    deploymentId: record.deploymentId,
    app: record.app?.name || null,
    status: record.status,
    failureReason: record.failureReason || null,
    // How the plan came to be, as the record says (an interview, a file, a plan reused),
    // so the words about a file without its notes claim nothing the record does not.
    planSource: record.origin?.planSource || (record.fromDeployment ? "again" : null),
    report: typeof record.report === "string" ? record.report : null,
    ...(record.reportError ? { reportError: record.reportError } : {})
  };

  if (record.planFiles?.files) {
    return { ...view, files: record.planFiles.files, notesKept: record.planFiles.notesKept === true, rebuilt: false };
  }
  if (record.planFilesError) return { ...view, files: null, filesError: record.planFilesError, rebuilt: false };
  if (!record.plan) return { ...view, files: null, filesError: "this deployment's record holds no plan", rebuilt: false };

  const started = record.startedAt ? new Date(record.startedAt) : new Date();
  const written = planFilesFor(record.plan, null, Number.isNaN(started.getTime()) ? new Date() : started);
  if (written.planFilesError) return { ...view, files: null, filesError: written.planFilesError, rebuilt: true };
  return { ...view, files: written.planFiles.files, notesKept: false, rebuilt: true };
}
