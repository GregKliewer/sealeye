// cli/interview/follow.js
// The terminal's side of an interview that runs in the API: upload the folder, show
// each line the platform says with a spinner holding the wait, ask the developer each
// question, and hand back the plan at "Deploy this?".
import { spinner } from "../brand.js";
import { answerInterview, followInterview, startInterview } from "../client.js";

// What the spinner calls a long wait. A plan-writing turn measured 25 to 45 seconds on
// healthy runs, so warning at 30 fired on runs where nothing was wrong. This is past
// every healthy turn measured and still inside the model call's 120 second timeout.
const SPINNER_WARN_MS = 75_000;
const STILL_WORKING = "Still working on it";

// A line naming a file is true while the file is being read and stops being true a
// moment later: the model has the contents and is thinking about them. After this
// long, the spinner says what is happening now instead of what has already finished.
const THINKING_AFTER_MS = 3_000;
const NAMES_A_FILE = /^(Reading |Looking at |Nothing to read at )/;

/**
 * Run one interview through the API.
 *
 * @param {object}   options
 * @param {string}   options.apiBaseUrl
 * @param {string}   options.appPath     the developer's folder, read only
 * @param {object}   [options.deployed]  the plan the live environment was built from
 * @param {string}   [options.user]
 * @param {boolean}  [options.trace]     false turns tracing off for this interview
 * @param {function} options.ask         (question, lead[]) => Promise<string>
 * @param {function} options.onStep      (line) => void
 * @returns {Promise<{status, plan?, summary?, assumptions?, questions?, message?, errors?, traceId?, interviewId}>}
 *          At "submitted", the interview is waiting in the API for "Deploy this?".
 */
export async function interviewThroughApi({ apiBaseUrl, appPath, deployed = null, user, trace = true, ask, onStep }) {
  // A redeploy is working out what moved; a first run is working out what the app needs
  // at all. Either way it is what the model is doing once the reading has stopped.
  const thinkingLabel = deployed ? "Working out what changed" : "Working out what your app needs";

  let waiting = null;
  let slowTimer = null;
  let thinkingTimer = null;
  let lastLine = "reading your app";   // before the platform has said anything

  const startWaiting = () => {
    waiting = spinner(lastLine);

    // A label that names a file goes stale the moment the read finishes.
    if (NAMES_A_FILE.test(lastLine)) {
      thinkingTimer = setTimeout(() => waiting?.label(thinkingLabel, { keepCount: true }), THINKING_AFTER_MS);
      thinkingTimer.unref();
    }

    // The words change, the count does not: the developer is owed the whole wait.
    slowTimer = setTimeout(() => waiting?.label(STILL_WORKING, { keepCount: true }), SPINNER_WARN_MS);
    slowTimer.unref();
  };

  const stopWaiting = () => {
    clearTimeout(slowTimer);
    clearTimeout(thinkingTimer);
    slowTimer = thinkingTimer = null;
    if (waiting) { waiting.stop(); waiting = null; }
  };

  // Every line goes through here, so the spinner is off the line before anything else
  // writes to it, and the last thing said is the label for what is still going on.
  const announce = line => {
    stopWaiting();
    onStep(line);
    lastLine = line;
    startWaiting();
  };

  startWaiting();
  try {
    const started = await startInterview({ apiBaseUrl, appPath, deployed, user, trace });
    const interviewId = started.interviewId;

    const end = await followInterview({
      apiBaseUrl,
      interviewId,
      onEvent: async event => {
        if (event.type === "step") return announce(event.line);

        if (event.type === "question") {
          stopWaiting();   // a question owns the line, and the developer owns the wait
          const reply = await ask(event.question, event.lead || []);
          // What the platform does next is write the plan, which takes half a minute.
          lastLine = "Writing your plan";
          startWaiting();
          await answerInterview({ apiBaseUrl, interviewId, answer: reply || "" });
          return;
        }

        if (event.type === "plan") return "stop";
      }
    });

    stopWaiting();

    if (end.type === "failed") {
      const err = new Error(end.message);
      err.userFacing = true;
      throw err;
    }

    const { type, seq, at, lastSeq, approved, ...result } = end;
    return { ...result, interviewId: end.type === "plan" ? interviewId : undefined };
  } finally {
    stopWaiting();
  }
}
