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
import { boxed, createScreen, fitText, pick, stopped, typeLine } from "./discover-screen.js";
import { commandLine } from "../core/operations.js";
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
    ...(q.merged?.length ? [step(`also asked as: ${q.merged.map(m => `"${m.question}"`).join("; ")}`)] : []),
    c.dim("  The first choice is the run's guess. Arrow keys and Enter.")
  ];
  const choice = await pick([...choicesFor(q), SOMETHING_ELSE, LATER], { screen, header });
  if (choice === LATER) {
    screen.commit([c.dim("  Left for later. Until it is answered, the modules it touches are never built.")], []);
    return null;
  }
  if (choice !== SOMETHING_ELSE) return choice;
  return typeLine({ screen, limit: ANSWER_LIMIT });
}

/**
 * Whether answers are being written into the draft, read from the run every second. A
 * run's own stream has ended by the time most late answers come, so the run says it
 * (`rewriting`, `answerProblem`). `sent()` marks one just given: it counts as being
 * written until a look that began after it says otherwise.
 */
function watchRewrites({ apiBaseUrl, id }) {
  const w = { rewriting: false, problem: null, since: null, run: null, sentAt: 0 };
  let timer = null;
  const look = async () => {
    const asked = Date.now();
    const run = await getDiscovery({ apiBaseUrl, id }).catch(() => null);
    if (!run) return;
    w.run = run;
    w.problem = run.answerProblem || null;
    if (asked < w.sentAt) return;   // it began before the last answer went: its word is old
    if (run.rewriting && !w.rewriting) w.since = Date.now();
    w.rewriting = Boolean(run.rewriting);
    if (!w.rewriting) w.since = null;
  };
  w.start = () => {
    if (timer) return w;
    timer = setInterval(look, 1000);
    timer.unref?.();
    look();
    return w;
  };
  w.stop = () => clearInterval(timer);
  w.sent = () => {
    w.sentAt = Date.now();
    if (!w.rewriting) w.since = Date.now();
    w.rewriting = true;
  };
  /** Until nothing is being written in, or a few minutes have gone. */
  w.settle = async (ms = 300000) => {
    const end = Date.now() + ms;
    while (w.rewriting && Date.now() < end) await new Promise(r => setTimeout(r, 300));
    await look();
  };
  return w;
}

/** The status line for answers being written in, or null when none are. */
function rewriteStatus(watch, inner, now = Date.now()) {
  if (watch?.rewriting) {
    const elapsed = elapsedWords(now - (watch.since || now));
    return `${c.accent(spinnerFrame(now))} ${c.fg(fitText("Writing your answer into the draft", inner - elapsed.length - 4))}  ${c.dim(elapsed)}`;
  }
  return null;
}

/** What became of the answers given: in the draft, or not yet and why. */
function rewriteResult(run, ids) {
  const mine = (run?.questions || []).filter(q => ids.includes(q.id));
  if (!mine.length) return null;
  if (mine.every(q => q.usedAt)) return c.ok(`${mine.length === 1 ? "Your answer is" : "Your answers are"} written into draft catalog ${run.catalog?.version}`);
  return c.fail(`Not written into the draft yet: ${run.answerProblem || "seaLeye is still writing it in"}. ${mine.length === 1 ? "Your answer is" : "Your answers are"} kept.`);
}

/** Answer the open questions of one run, one at a time. */
async function answerOpen({ apiBaseUrl, run, say, json }) {
  const open = (run.questions || []).filter(isOpen);
  if (!open.length) return say("No questions are waiting on an answer.");
  if (!liveTerminal(json)) {
    for (const q of open) console.log(`${c.prompt("?")} ${q.question}  ${c.dim(`(guess: ${q.guess})`)}`);
    return say("Answering needs a terminal. Run this yourself, or answer on seaLeye.online's Discovery page.");
  }
  // A box above the questions, as the run has, saying when an answer is being written in.
  const watch = watchRewrites({ apiBaseUrl, id: run.discoveryId }).start();
  const given = [];
  const screen = createScreen({
    top: () => {
      const width = Math.min(screen.columns() - 2, 100);
      const inner = width - 4;
      const status = rewriteStatus(watch, inner)
        || (watch.problem && given.length ? c.fail(fitText(`Not written into the draft yet: ${watch.problem}`, inner - 2))
          : given.length ? `${c.accent("\u2713")} ${c.fg("Your answers so far are in the draft")}`
            : c.dim("Each answer is written into the draft as you give it"));
      return ["", ...boxed({
        width,
        edge: c.dim,
        title: c.fg("Discovery answers"),
        right: c.dim(run.catalog ? `draft catalog ${run.catalog.version}` : run.discoveryId),
        rows: [status],
        footer: c.dim(`${given.length} of ${open.length} answered`)
      }).map(line => ` ${line}`)];
    }
  });
  screen.start();
  const print = line => screen.commit([line]);
  try {
    for (const [i, q] of open.entries()) {
      const reply = await askQuestion(q, { screen, label: `${i + 1} of ${open.length}` });
      if (reply !== null && (await send({ apiBaseUrl, id: run.discoveryId, q, reply, print }))) {
        given.push(q.id);
        watch.sent();
      }
    }
    // The last answer is seen into the draft before the box comes off.
    if (given.length) await watch.settle();
  } finally {
    watch.stop();
    screen.close();
  }
  const result = rewriteResult(watch.run, given);
  if (result) console.log(result);
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
  // Once the draft is written, an answer rewrites its entries: the box says so.
  const watch = watchRewrites({ apiBaseUrl, id: run.discoveryId });

  const screen = createScreen({
    top: () => {
      // The whole box, edges and all, a little in from the terminal's edge.
      const width = Math.min(screen.columns() - 2, 100);
      const inner = width - 4;
      const now = Date.now();
      const lines = recent.slice(-WINDOW_LINES);
      while (lines.length < WINDOW_LINES) lines.unshift("");
      const waiting = queue.length + (current ? 1 : 0);
      // Once the run is over nothing moves: a tick, and how long it took.
      const elapsed = elapsedWords(now - doingSince);
      const status = (progress.drafted || progress.over ? rewriteStatus(watch, inner, now) : null) || (progress.over
        ? `${c.accent("\u2713")} ${c.fg(activityWords(progress))}`
        : `${c.accent(spinnerFrame(now))} ${c.fg(fitText(activityWords(progress), inner - elapsed.length - 4))}  ${c.dim(elapsed)}`);
      const took = progress.over ? `took ${elapsedWords(overAt - startedAt)}` : `${elapsedWords(now - startedAt)} so far`;
      const summary = progressSummary(progress, waiting);
      return [
        "",
        ...boxed({
          width,
          edge: c.dim,
          title: c.fg("Discovery"),
          right: c.dim(took),
          rows: [status, "", ...lines.map(line => c.dim(fitText(line, inner)))],
          footer: c.dim(fitText(summary, width - 8))
        }).map(line => ` ${line}`)
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
      // Answered already, by someone else or on the page, or merged into another that
      // asks the same thing: nothing to ask.
      const latest = await getDiscovery({ apiBaseUrl, id: run.discoveryId }).catch(() => null);
      const fresh = latest?.questions?.find(x => x.id === q.id);
      if (latest && (!fresh || !isOpen(fresh))) continue;
      current = q;
      const reply = await askQuestion(fresh || q, { screen });
      current = null;
      if (reply !== null && (await send({ apiBaseUrl, id: run.discoveryId, q, reply, print })) && (progress.drafted || progress.over)) watch.sent();
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
        if (progress.drafted || progress.over) watch.start();
        if (event.type === "question") return enqueue(event.question);
        // Questions merged into another leave the queue; the one kept is asked once.
        if (event.type === "merged") for (let i = queue.length - 1; i >= 0; i--) if ((event.questions || []).includes(queue[i].id)) queue.splice(i, 1);
        if (["finished", "stopped", "failed", "reading"].includes(event.type)) return;
        const line = discoveryEventLine(event);
        if (!line) return;
        recent.push(line);
        if (recent.length > 50) recent.shift();
        // A module that could not be read stays in the scrollback, not only in the window.
        if (event.type === "not_read") print(c.fail(line));
      }
    });
    // The questions still on the screen are answered, or left, and what they change is
    // seen into the draft, before the run's end is said.
    while (asking) await asking;
    await watch.settle();
  } catch (err) {
    watch.stop();
    process.removeListener("SIGINT", onInterrupt);
    screen.close();
    throw err;
  }
  watch.stop();
  process.removeListener("SIGINT", onInterrupt);
  screen.close();
  const result = await finish({ apiBaseUrl, run, end, say, print: line => console.log(line), offering: true });
  if (!result?.open) return;
  // The ones left for later, offered now (Greg, Oct 15, 2026), or kept for later still.
  const later = result.open === 1 ? "the question" : `the ${result.open} questions`;
  const choice = await pick(["Yes", "Not now"], { header: ["", `${c.prompt("?")} Answer ${later} you left for later now?`] });
  if (choice === "Yes") return answerOpen({ apiBaseUrl, run: result.run, say, json: false });
  say(`${result.open === 1 ? "It is" : "They are"} kept: sealeye discover answers, or the Discovery page on seaLeye.online.`);
}

/** The run's end, said once: the draft, what is still open, and what comes next. */
async function finish({ apiBaseUrl, run, end, say, print, offering = false }) {
  if (end.type === "finished") {
    // Counted now, after the questions on the screen: some may have been answered since.
    const now = await getDiscovery({ apiBaseUrl, id: run.discoveryId }).catch(() => null);
    const open = now ? (now.questions || []).filter(isOpen).length : end.open;
    const notRead = (now?.modules || []).filter(m => m.status === "not_read").length;
    print("");
    if (now?.modules?.length) print(step(`${now.modules.length - notRead} of ${now.modules.length} modules read`));
    print(c.ok(discoveryEventLine({ ...end, open })));
    if (now?.answerProblem && (now.questions || []).some(q => !isOpen(q) && !q.usedAt)) print(c.fail(`An answer is not written into the draft yet: ${now.answerProblem}. It is kept.`));
    if (open && !offering) say(`${open === 1 ? "One question is" : `${open} questions are`} still open, kept for you: sealeye discover answers, or the Discovery page on seaLeye.online.`);
    say(`Nothing goes live until it passes its self-test and a platform engineer approves it and makes it live: ${commandLine("catalog-approve")}.`);
    return { open, run: now };
  } else if (end.type === "closed") {
    const now = await getDiscovery({ apiBaseUrl, id: run.discoveryId });
    print("");
    printRun(now, say);
  } else {
    print(c.fail(discoveryEventLine(end)));
    process.exitCode = 1;
  }
}
