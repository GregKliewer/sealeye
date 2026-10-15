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

/** Whether a question still waits on an answer. */
export const isOpen = q => q.answer === null || q.answer === undefined;

/** The choices a question offers, in order: the guess first, then the rest. */
export function choicesFor(q) {
  const options = (q.options || []).filter(o => typeof o === "string" && o.trim());
  const ordered = q.guess && options.includes(q.guess) ? [q.guess, ...options.filter(o => o !== q.guess)] : options;
  return ordered;
}
