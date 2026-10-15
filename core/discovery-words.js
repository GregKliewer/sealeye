// core/discovery-words.js
// What `sealeye discover` and seaLeye.online's Discovery page both say about a discovery
// run (PHASE4-PLAN Step 6b), so the two surfaces cannot drift: one line for each thing
// the run does, the run's state in words, and the two choices every question adds to its
// own (something else, or later).
//
// Runs in a browser: the portal imports it. No node: modules, no packages.

/** The choice that opens a box for an answer of the engineer's own. */
export const SOMETHING_ELSE = "Something else";
/** The choice that leaves a question on the draft, to answer later. */
export const LATER = "Answer later";
/** The longest answer the API keeps: a sentence, not a document. */
export const ANSWER_LIMIT = 600;

const short = commit => (typeof commit === "string" ? commit.slice(0, 7) : "");
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The line for one of a run's events, or null for an event that says nothing on its own
 * (a question, which each surface shows in its own way; a run started).
 */
export function discoveryEventLine(event) {
  switch (event?.type) {
    case "library":
      return `Read ${event.repo} at ${short(event.commit)}${event.replaced ? `, with ${plural(event.replaced, "line", "lines")} that looked like secrets replaced` : ""}`;
    case "modules":
      return `Found ${plural((event.modules || []).length, "module", "modules")} to read`;
    case "reading":
      return `Reading ${event.source}`;
    case "read":
      return event.source === "." ? "Read the library's README and pipeline" : `Read ${event.source}`;
    case "not_read":
      return event.source === "." ? `Could not read the library's README and pipeline: ${event.why}` : `Could not read ${event.source}: ${event.why}`;
    case "writing":
      return "Writing the draft catalog";
    case "draft":
      return `Draft catalog ${event.catalog?.version} written${event.open ? `, resting on ${plural(event.open, "question", "questions")} not yet answered` : ""}`;
    case "answered":
      return `Answer taken: ${event.question?.answer}`;
    case "answers_used":
      return `Answers written into draft catalog ${event.catalog?.version}`;
    case "answer_not_used":
      return `An answer could not be written in yet: ${event.why}. It is kept, and is used the next time the entries are written.`;
    case "finished":
      return `Finished: draft catalog ${event.catalog?.version}${event.open ? `, with ${plural(event.open, "question", "questions")} still open` : ", with every question answered"}`;
    case "stopped":
    case "failed":
      return event.message || "The run ended before it wrote a draft.";
    default:
      return null;
  }
}

/** A run's state in a few words, for a list or a heading. */
export function discoveryStateWords(run) {
  if (!run) return "No run yet";
  if (run.status === "running") return "Running";
  if (run.status === "finished") return run.catalog ? `Finished, draft catalog ${run.catalog.version}` : "Finished";
  if (run.status === "stopped") return run.reason === "restarted" ? "Stopped when the platform restarted" : run.reason === "spending_limit" ? "Stopped at its spending limit" : "Stopped";
  return "Did not finish";
}

/**
 * How far a run has got, kept up from its events, so a surface can say so while a
 * question is open (Greg, Oct 15, 2026: his first run looked paused at its first
 * question). A module counts once its reader is done with it, read or not.
 */
export function nextProgress(p, event) {
  const next = { modules: 0, read: 0, writing: false, over: false, ...(p || {}) };
  if (event?.type === "modules") next.modules = (event.modules || []).length;
  if ((event?.type === "read" || event?.type === "not_read") && event.source !== ".") next.read += 1;
  if (event?.type === "writing") next.writing = true;
  if (["draft", "finished", "stopped", "failed"].includes(event?.type)) next.writing = false;
  if (["finished", "stopped", "failed"].includes(event?.type)) next.over = true;
  return next;
}

/** What the run is doing, in a line, while someone answers. */
export function progressWords(p) {
  if (p?.over) return "The run has finished. What you leave is kept for later.";
  if (p?.writing) return "Still going in the background: writing the draft catalog.";
  if (p?.modules) return `Still going in the background: ${p.read} of ${p.modules} modules read.`;
  return "Still going in the background: reading your platform library.";
}

/** How many more questions wait after the one being answered, or null for none. */
export const moreWaitingWords = n => (n > 0 ? `${n === 1 ? "One more question is" : `${n} more questions are`} waiting after this one.` : null);

/** Said wherever a question is asked: answering is never in a hurry. */
export const TAKE_YOUR_TIME = "Take your time: the run does not wait on you, and every question is kept.";

/** Modules whose readers are done, from a run as the API gives it. */
export const modulesDone = run => (run?.modules || []).filter(m => m.status === "read" || m.status === "not_read").length;

/** Whether a question still waits on an answer. */
export const isOpen = q => q.answer === null || q.answer === undefined;

/** The choices a question offers, in order: the guess first, then the rest. */
export function choicesFor(q) {
  const options = (q.options || []).filter(o => typeof o === "string" && o.trim());
  const ordered = q.guess && options.includes(q.guess) ? [q.guess, ...options.filter(o => o !== q.guess)] : options;
  return ordered;
}
