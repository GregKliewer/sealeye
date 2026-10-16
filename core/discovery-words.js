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
    case "plain_words":
      return `Writing ${plural((event.sources || []).length, "entry", "entries")} again in plain words: ${(event.sources || []).join(", ")}`;
    case "plain_words_not_done":
      return `Could not write ${(event.sources || []).join(", ")} again in plain words: ${event.why}. The self-test will say what to change.`;
    case "merged":
      return `${plural((event.questions || []).length, "question", "questions")} merged into one that asks the same thing`;
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
 * question). A module counts once its reader is done with it, read or not. `doing` is
 * what the run is busy with now and `since` when it began (the event's own time, so a
 * page opened part way through says the same as the terminal that watched it start).
 */
export function nextProgress(p, event) {
  const next = { modules: 0, read: 0, writing: false, drafted: false, over: false, reading: [], doing: "starting", since: null, ...(p || {}) };
  next.reading = [...next.reading];
  const type = event?.type;
  if (type === "modules") next.modules = (event.modules || []).length;
  if (type === "reading" && event.source && !next.reading.includes(event.source)) next.reading.push(event.source);
  if (type === "read" || type === "not_read") {
    next.reading = next.reading.filter(s => s !== event.source);
    if (event.source !== ".") next.read += 1;
  }
  if (type === "writing") next.writing = true;
  if (["draft", "finished", "stopped", "failed"].includes(type)) next.writing = false;
  if (type === "draft") next.drafted = true;
  if (["finished", "stopped", "failed"].includes(type)) next.over = true;
  const doing = next.over ? "over" : next.writing ? "writing" : next.drafted ? "drafted" : next.reading.length ? `reading:${next.reading.join(",")}` : next.modules ? "between" : "library";
  if (event && doing !== next.doing) {
    next.doing = doing;
    next.since = event.at || null;
  }
  return next;
}

const and = list => (list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`);

/** What the run is busy with now, in a few words. */
export function activityWords(p) {
  if (!p || p.doing === "starting" || p.doing === "library") return "Reading your platform library";
  if (p.over) return "The run has finished";
  if (p.writing) return "Writing the draft catalog";
  if (p.drafted) return "Finishing the draft catalog";
  if (p.reading?.length) return `Reading ${and(p.reading)}`;
  return "Working out what to read next";
}

/** How long something has taken, as a person would say it: 8s, 2m 05s, 1h 02m. */
export function elapsedWords(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** The run so far in a line: modules read, and questions waiting on someone. */
export function progressSummary(p, waiting = 0) {
  const parts = [];
  if (p?.modules) parts.push(`${p.read} of ${p.modules} modules read`);
  if (waiting > 0) parts.push(`${plural(waiting, "question", "questions")} waiting for you`);
  return parts.join(", ") || "Starting";
}

/** Modules whose readers are done, from a run as the API gives it. */
export const modulesDone = run => (run?.modules || []).filter(m => m.status === "read" || m.status === "not_read").length;

/**
 * Where an answered question's answer stands, from the question and its run as the API
 * gives them: in the draft, being written in now, or not yet and why. `moving` is true
 * while a rewrite is going, for a surface to show something turning.
 */
export function answerStateWords(q, run) {
  if (q.usedAt) return { words: "in the draft", moving: false };
  if (run?.rewriting) return { words: "being written into the draft", moving: true };
  if (run?.answerProblem) return { words: `not written into the draft yet: ${run.answerProblem}. The answer is kept.`, moving: false };
  return { words: "waiting to be written into the draft", moving: false };
}

/** Whether a question still waits on an answer. */
export const isOpen = q => q.answer === null || q.answer === undefined;

/** The choices a question offers, in order: the guess first, then the rest. */
export function choicesFor(q) {
  const options = (q.options || []).filter(o => typeof o === "string" && o.trim());
  const ordered = q.guess && options.includes(q.guess) ? [q.guess, ...options.filter(o => o !== q.guess)] : options;
  return ordered;
}

/**
 * What each check of the self-test is called on both surfaces (PHASE4-PLAN Step 7). The
 * API sends each check's id and its problems in words; this is its title.
 */
export const SELF_TEST_CHECKS = Object.freeze({
  shape: "The catalog is well formed",
  questions: "No question about the whole catalog is waiting",
  refused: "Plans using what it must not build are refused",
  accepted: "Plans using what it builds are accepted",
  words: "Nothing a developer reads uses a word they never should"
});

/** A self-test's result in one line. */
export function selfTestSummary(result) {
  if (!result) return "";
  const failed = (result.checks || []).filter(c => !c.passed);
  const problems = failed.reduce((n, c) => n + (c.problems || []).length, 0);
  return failed.length
    ? `The self-test found ${plural(problems, "problem", "problems")} in catalog ${result.version}.`
    : `Catalog ${result.version} passed its self-test.`;
}

/** A catalog's status in words, the same on both surfaces. */
export function catalogStatusWords(status) {
  return { draft: "Draft", approved: "Approved, not live", live: "Live", retired: "Retired" }[status] || String(status || "");
}

/**
 * What can be done with a catalog of this status next: approve a draft, make an approved
 * or retired one live. Null for the live one.
 */
export function nextCatalogStep(status) {
  return status === "draft" ? "approve" : status === "approved" || status === "retired" ? "live" : null;
}

/** One catalog in a list: where it came from, how big, what rests on a question. */
export function catalogSummaryWords(c) {
  const parts = [];
  if (c.discovery) parts.push(`from run ${c.discovery}`);
  if (typeof c.modules === "number") parts.push(plural(c.modules, "module", "modules"));
  if (c.open) parts.push(`${c.open} resting on a question`);
  if (c.approvedBy && c.status !== "draft") parts.push(`approved by ${c.approvedBy}`);
  if (c.madeLiveBy && (c.status === "live" || c.status === "retired")) parts.push(`made live by ${c.madeLiveBy}`);
  return parts.join(" · ");
}

/** What an entry resting on an open question means, now that a catalog can go live without it. */
export const RESTS_ON_QUESTION =
  "Until it is answered, the modules it touches are never built, even in a live catalog. An answer writes a new draft.";

/** What approving and making live say once done. */
export const approvedWords = v => `Catalog ${v} is approved. Nothing changes for developers until it is made live.`;
export const madeLiveWords = v => `Catalog ${v} is live: your organization's developers plan against it now.`;
