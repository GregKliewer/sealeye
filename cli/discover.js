// cli/discover.js
// `sealeye discover` (PHASE4-PLAN Step 6b): start a discovery run over the organization's
// platform library, follow it, and answer each question it raises as it arrives
// (Greg, Oct 15, 2026: inline, never holding the run up). The run never waits on the
// engineer: a question skipped stays on the draft, for `sealeye discover answers` or the
// portal's Discovery page, which say the same things (core/discovery-words.js).
//
// In a terminal the run is a small window at the top, moving as the run goes, with the
// question being answered under it (cli/discover-screen.js; Greg, Oct 15, 2026). Without
// one, each line is printed as it comes and the questions are listed with their guesses.
//
//   sealeye discover               start a run and follow it, answering as it goes
//   sealeye discover answers [id]  the open questions of the latest run, or of run id
//   sealeye discover status [id]   the latest run, or run id
import { c, spinnerFrame, step } from "./brand.js";
import { answerDiscovery, followDiscovery, getDiscovery, listDiscoveries, startDiscovery } from "./client.js";
import { createScreen, fitText, pick, stopped, typeLine } from "./discover-screen.js";
import {
  activityWords, ANSWER_LIMIT, choicesFor, discoveryEventLine, discoveryStateWords, elapsedWords, isOpen, LATER,
  modulesDone, nextProgress, progressSummary, SOMETHING_ELSE
} from "../core/discovery-words.js";

export { pick } from "./discover-screen.js";

/** How many of the run's lines the window keeps on the screen. */
const WINDOW_LINES = 4;

/** Whether this terminal can be drawn on and typed in. */
const liveTerminal = json => Boolean(process.stdin.isTTY && process.stdout.isTTY) && process.env.TERM !== "dumb" && !json;

/** Send one answer. One the platform would not take is said, and the run is still followed. */
async function send({ apiBaseUrl, id, q, reply, print }) {
  try {
    await answerDiscovery({ apiBaseUrl, id, question: q.id, answer: reply });
    print(c.ok(`Answered: ${reply}`));
    return true;
  } catch (err) {
    if (!err.userFacing && !err.details) throw err;
    print(c.fail(`Not answered: ${err.message}`));
    return false;
  }
}

/** One question asked in the region: a choice, words of one's own, or later. */
async function askQuestion(q, { screen, label = "" }) {
  const header = [
    "",
    `${c.prompt("?")} ${q.question}${label ? c.dim(`  ${label}`) : ""}`,
    ...(q.evidence || []).map(e => step(`${e.file}${e.line ? `:${e.line}` : ""}: ${e.shows}`)),
    ...(q.touches?.length ? [step(`touches ${q.touches.join(", ")}`)] : []),
    c.dim("  The first choice is the run's guess. Arrow keys and Enter.")
  ];
  const choice = await pick([...choicesFor(q), SOMETHING_ELSE, LATER], { screen, header });
  if (choice === LATER) {
    screen.commit([c.dim("  Left for later. The draft rests on the guess until it is answered.")], []);
    return null;
  }
  if (choice !== SOMETHING_ELSE) return choice;
  return typeLine({ screen, limit: ANSWER_LIMIT });
}

/** Answer the open questions of one run, one at a time. */
async function answerOpen({ apiBaseUrl, run, say, json }) {
  const open = (run.questions || []).filter(isOpen);
  if (!open.length) return say("No questions are waiting on an answer.");
  if (!liveTerminal(json)) {
    for (const q of open) console.log(`${c.prompt("?")} ${q.question}  ${c.dim(`(guess: ${q.guess})`)}`);
    return say("Answering needs a terminal. Run this yourself, or answer on seaLeye.online's Discovery page.");
  }
  const screen = createScreen({ animate: false }).start();
  const print = line => screen.commit([line]);
  try {
    for (const [i, q] of open.entries()) {
      const reply = await askQuestion(q, { screen, label: `${i + 1} of ${open.length}` });
      if (reply !== null) await send({ apiBaseUrl, id: run.discoveryId, q, reply, print });
    }
  } finally {
    screen.close();
  }
}

/** Which run a command means: the one named, or the newest. */
async function runFor({ apiBaseUrl, id }) {
  if (id) return getDiscovery({ apiBaseUrl, id });
  const [latest] = await listDiscoveries({ apiBaseUrl });
  return latest ? getDiscovery({ apiBaseUrl, id: latest.discoveryId }) : null;
}

function printRun(run, say) {
  const library = (run.repos || []).map(r => `${r.repo}${r.commit ? ` at ${r.commit.slice(0, 7)}` : ""}`).join(", ");
  console.log(`${c.accent(run.discoveryId)}  ${discoveryStateWords(run)}`);
  if (library) console.log(step(`library ${library}`));
  const notRead = (run.modules || []).filter(m => m.status === "not_read").map(m => m.source);
  if (run.modules?.length) console.log(step(`${modulesDone(run) - notRead.length} of ${run.modules.length} modules read${notRead.length ? `; not read: ${notRead.join(", ")}` : ""}`));
  if (run.message && run.status !== "finished") console.log(step(run.message));
  const open = (run.questions || []).filter(isOpen);
  console.log(step(`${(run.questions || []).length} questions, ${open.length} open; spent US$${Number(run.spent || 0).toFixed(2)}`));
  if (open.length) say("sealeye discover answers to answer them here, or the Discovery page on seaLeye.online.");
}

/**
 * The `discover` command.
 * @param {{ apiBaseUrl: string, args: string[], say: (line: string) => void, json: boolean }} p
 */
export async function discover(options) {
  try {
    return await discoverCommand(options);
  } catch (err) {
    if (!err.interrupted) throw err;
    console.log("");
    options.say(err.message);
    process.exit(130);
  }
}

async function discoverCommand({ apiBaseUrl, args, say, json = false }) {
  const [sub, id] = args;

  if (sub === "status") {
    const run = await runFor({ apiBaseUrl, id });
    if (json) return console.log(JSON.stringify(run, null, 2));
    if (!run) return say("No discovery run yet. sealeye discover starts one.");
    console.log("");
    return printRun(run, say);
  }

  if (sub === "answers") {
    const run = await runFor({ apiBaseUrl, id });
    if (!run) return say("No discovery run yet. sealeye discover starts one.");
    console.log("");
    console.log(`${c.accent(run.discoveryId)}  ${discoveryStateWords(run)}`);
    return answerOpen({ apiBaseUrl, run, say, json });
  }

  if (sub) throw Object.assign(new Error(`sealeye discover takes answers or status, not ${sub}.`), { userFacing: true });

  // Start one, or follow the one already going: a run is the organization's, and only
  // one goes at a time.
  let run;
  try {
    run = await startDiscovery({ apiBaseUrl });
    say("Started a discovery run over your platform library. It reads, then writes a draft catalog; nothing goes live.");
  } catch (err) {
    if (err.code !== "RUN_GOING") throw err;
    const going = (await listDiscoveries({ apiBaseUrl })).find(r => r.status === "running");
    if (!going) throw err;
    run = going;
    say("A discovery run is already going for your organization. Following that one.");
  }

  if (json) {
    await followDiscovery({ apiBaseUrl, id: run.discoveryId, onEvent: event => console.log(JSON.stringify(event)) });
    return;
  }
  if (!liveTerminal(json)) return followPlain({ apiBaseUrl, run, say });
  return followLive({ apiBaseUrl, run, say });
}

/** No terminal to draw on: each line as it comes, and the questions listed for later. */
async function followPlain({ apiBaseUrl, run, say }) {
  const end = await followDiscovery({
    apiBaseUrl,
    id: run.discoveryId,
    onEvent: event => {
      if (event.type === "question") return console.log(`${c.prompt("?")} ${event.question.question}  ${c.dim(`(guess: ${event.question.guess})`)}`);
      if (["finished", "stopped", "failed", "reading"].includes(event.type)) return;
      const line = discoveryEventLine(event);
      if (line) console.log(event.type === "not_read" ? c.fail(line) : step(line));
    }
  });
  return finish({ apiBaseUrl, run, end, say, print: line => console.log(line) });
}

/** A terminal: the window at the top, and each question under it as it comes. */
async function followLive({ apiBaseUrl, run, say }) {
  let progress = nextProgress(null, null);
  let doingSince = Date.now();
  const startedAt = Date.now();
  let overAt = null;
  const recent = [];
  const queue = [];
  let current = null;

  const screen = createScreen({
    top: () => {
      const width = screen.columns() - 6;
      const now = Date.now();
      const lines = recent.slice(-WINDOW_LINES);
      while (lines.length < WINDOW_LINES) lines.unshift("");
      const waiting = queue.length + (current ? 1 : 0);
      // Once the run is over nothing moves: a tick, and how long it took.
      const status = progress.over
        ? `  ${c.accent("✓")} ${c.fg(activityWords(progress))}`
        : `  ${c.accent(spinnerFrame(now))} ${c.fg(fitText(activityWords(progress), width - 10))}  ${c.dim(elapsedWords(now - doingSince))}`;
      const took = progress.over ? `took ${elapsedWords(overAt - startedAt)}` : `${elapsedWords(now - startedAt)} so far`;
      return [
        status,
        ...lines.map(line => c.dim(`  │ ${fitText(line, width)}`)),
        c.dim(`  └ ${fitText(`${progressSummary(progress, waiting)}  ·  ${took}`, width)}`)
      ];
    }
  });
  const print = line => screen.commit([line]);

  // Ctrl+C with no question open: the window comes off cleanly before the command ends.
  const onInterrupt = () => {
    screen.close();
    say(stopped().message);
    process.exit(130);
  };
  process.once("SIGINT", onInterrupt);
  const bail = err => {
    screen.close();
    if (err?.interrupted) {
      say(err.message);
      process.exit(130);
    }
    console.error(c.fail(err?.userFacing ? err.message : err?.stack || String(err)));
    process.exit(1);
  };

  // Questions are asked one at a time from a queue, apart from the stream, so the
  // window keeps moving while one is on the screen.
  let asking = null;
  const askAll = async () => {
    while (queue.length) {
      const q = queue.shift();
      // Answered already, by someone else or on the page: nothing to ask.
      const fresh = (await getDiscovery({ apiBaseUrl, id: run.discoveryId }).catch(() => null))?.questions?.find(x => x.id === q.id);
      if (fresh && !isOpen(fresh)) continue;
      current = q;
      const reply = await askQuestion(fresh || q, { screen });
      current = null;
      if (reply !== null) await send({ apiBaseUrl, id: run.discoveryId, q, reply, print });
    }
  };
  const enqueue = q => {
    queue.push(q);
    if (asking) return;
    asking = askAll().then(() => {
      asking = null;
      if (queue.length) enqueue(queue.shift());
    }, bail);
  };

  screen.start();
  let end;
  try {
    end = await followDiscovery({
      apiBaseUrl,
      id: run.discoveryId,
      onEvent: event => {
        const before = progress.doing;
        progress = nextProgress(progress, event);
        if (progress.doing !== before) doingSince = Date.now();
        if (progress.over && !overAt) overAt = Date.now();
        if (event.type === "question") return enqueue(event.question);
        if (["finished", "stopped", "failed", "reading"].includes(event.type)) return;
        const line = discoveryEventLine(event);
        if (!line) return;
        recent.push(line);
        if (recent.length > 50) recent.shift();
        // A module that could not be read stays in the scrollback, not only in the window.
        if (event.type === "not_read") print(c.fail(line));
      }
    });
    // The questions still on the screen are answered, or left, before the run's end is said.
    while (asking) await asking;
  } catch (err) {
    process.removeListener("SIGINT", onInterrupt);
    screen.close();
    throw err;
  }
  process.removeListener("SIGINT", onInterrupt);
  screen.close();
  return finish({ apiBaseUrl, run, end, say, print: line => console.log(line) });
}

/** The run's end, said once: the draft, what is still open, and what comes next. */
async function finish({ apiBaseUrl, run, end, say, print }) {
  if (end.type === "finished") {
    // Counted now, after the questions on the screen: some may have been answered since.
    const now = await getDiscovery({ apiBaseUrl, id: run.discoveryId }).catch(() => null);
    const open = now ? (now.questions || []).filter(isOpen).length : end.open;
    const notRead = (now?.modules || []).filter(m => m.status === "not_read").length;
    print("");
    if (now?.modules?.length) print(step(`${now.modules.length - notRead} of ${now.modules.length} modules read`));
    print(c.ok(discoveryEventLine({ ...end, open })));
    if (open) say(`${open === 1 ? "One question is" : `${open} questions are`} still open, kept for you: sealeye discover answers, or the Discovery page on seaLeye.online.`);
    say("Nothing goes live from here: a platform engineer approves a catalog after its self-test.");
  } else if (end.type === "closed") {
    const now = await getDiscovery({ apiBaseUrl, id: run.discoveryId });
    print("");
    printRun(now, say);
  } else {
    print(c.fail(discoveryEventLine(end)));
    process.exitCode = 1;
  }
}
