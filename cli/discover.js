// cli/discover.js
// `sealeye discover` (PHASE4-PLAN Step 6b): start a discovery run over the organization's
// platform library, follow it, and answer each question it raises as it arrives
// (Greg, Oct 15, 2026: inline, never holding the run up). The run never waits on the
// engineer: a question skipped stays on the draft, for `sealeye discover answers` or the
// portal's Discovery page, which say the same things (core/discovery-words.js).
//
//   sealeye discover               start a run and follow it, answering as it goes
//   sealeye discover answers [id]  the open questions of the latest run, or of run id
//   sealeye discover status [id]   the latest run, or run id
import readline from "node:readline/promises";

import { answer, c, spinner, step, stopSpinner, typed, typing } from "./brand.js";
import { answerDiscovery, followDiscovery, getDiscovery, listDiscoveries, startDiscovery } from "./client.js";
import { ANSWER_LIMIT, choicesFor, discoveryEventLine, discoveryStateWords, isOpen, LATER, SOMETHING_ELSE } from "../core/discovery-words.js";

/** Ctrl+C at a question: the run goes on without this terminal. */
const stopped = () => Object.assign(new Error("Stopped. The run goes on: sealeye discover answers, or the Discovery page on seaLeye.online, for its questions."), { interrupted: true, userFacing: true });

/** Words of one's own, up to the limit the API keeps. Ctrl+C stops, as in the picker. */
async function ownWords() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const own = await new Promise((resolve, reject) => {
        rl.once("SIGINT", () => reject(stopped()));
        rl.question(typing()).then(resolve, reject);
      });
      process.stdout.write(typed());
      const words = own.trim();
      if (words.length <= ANSWER_LIMIT) return words || null;
      console.log(c.dim(`  That is longer than an answer is kept. A sentence or two, under ${ANSWER_LIMIT} characters.`));
    }
  } finally {
    rl.close();
  }
}

/** Send one answer. One the platform would not take is said, and the run is still followed. */
async function send({ apiBaseUrl, id, q, reply }) {
  try {
    await answerDiscovery({ apiBaseUrl, id, question: q.id, answer: reply });
    console.log(c.ok(`Answered: ${reply}`));
    return true;
  } catch (err) {
    if (!err.userFacing && !err.details) throw err;
    console.log(c.fail(`Not answered: ${err.message}`));
    return false;
  }
}

/** Pick one of `choices` with the arrow keys and Enter; the first is chosen to start. */
export function pick(choices, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve, reject) => {
    let at = 0;
    const draw = first => {
      if (!first) output.write(`\x1b[${choices.length}A`);
      choices.forEach((choice, i) => {
        output.write(`\x1b[2K${i === at ? `${c.prompt("›")} ${answer(choice)}` : `  ${c.fg(choice)}`}\n`);
      });
    };
    const done = (value, err) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      err ? reject(err) : resolve(value);
    };
    const onData = chunk => {
      const key = String(chunk);
      if (key === "\u0003") return done(null, stopped());
      if (key === "\r" || key === "\n") return done(choices[at]);
      if (key === "\u001b[A" || key === "k") at = (at - 1 + choices.length) % choices.length;
      else if (key === "\u001b[B" || key === "j") at = (at + 1) % choices.length;
      else if (/^[1-9]$/.test(key) && Number(key) <= choices.length) at = Number(key) - 1;
      else return;
      draw(false);
    };
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    input.on("data", onData);
    draw(true);
  });
}

/** One question shown, with what raised it, and answered: a choice, words of one's own, or later. */
async function askQuestion(q, { label = "" } = {}) {
  console.log("");
  console.log(`${c.prompt("?")} ${q.question}${label ? c.dim(`  ${label}`) : ""}`);
  for (const e of q.evidence || []) console.log(step(`${e.file}${e.line ? `:${e.line}` : ""}: ${e.shows}`));
  if (q.touches?.length) console.log(step(`touches ${q.touches.join(", ")}`));
  console.log(c.dim("  The first choice is the run's guess. Arrow keys and Enter."));
  const choice = await pick([...choicesFor(q), SOMETHING_ELSE, LATER]);
  if (choice === LATER) {
    console.log(c.dim("  Left for later. The draft rests on the guess until it is answered."));
    return null;
  }
  if (choice !== SOMETHING_ELSE) return choice;
  return ownWords();
}

/** Answer the open questions of one run, one at a time. */
async function answerOpen({ apiBaseUrl, run, say }) {
  const open = (run.questions || []).filter(isOpen);
  if (!open.length) return say("No questions are waiting on an answer.");
  if (!process.stdin.isTTY) {
    for (const q of open) console.log(`${c.prompt("?")} ${q.question}  ${c.dim(`(guess: ${q.guess})`)}`);
    return say("Answering needs a terminal. Run this yourself, or answer on seaLeye.online's Discovery page.");
  }
  for (const [i, q] of open.entries()) {
    const reply = await askQuestion(q, { label: `${i + 1} of ${open.length}` });
    if (reply !== null) await send({ apiBaseUrl, id: run.discoveryId, q, reply });
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
  if (run.modules?.length) console.log(step(`${run.modules.length - notRead.length} of ${run.modules.length} modules read${notRead.length ? `; not read: ${notRead.join(", ")}` : ""}`));
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
    return answerOpen({ apiBaseUrl, run, say });
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

  const interactive = Boolean(process.stdin.isTTY) && !json;
  let waiting = null;
  const wait = label => {
    waiting?.stop();
    waiting = spinner(label);
  };
  const quiet = () => {
    waiting?.stop();
    waiting = null;
  };
  const skipped = [];

  wait("Reading your platform library");
  try {
    const end = await followDiscovery({
      apiBaseUrl,
      id: run.discoveryId,
      onEvent: async event => {
        if (json) return console.log(JSON.stringify(event));
        if (event.type === "question") {
          quiet();
          // Answered already, by someone else or on the page: nothing to ask.
          const fresh = (await getDiscovery({ apiBaseUrl, id: run.discoveryId })).questions?.find(q => q.id === event.question.id);
          if (fresh && !isOpen(fresh)) return wait("Reading");
          if (!interactive) {
            console.log(`${c.prompt("?")} ${event.question.question}  ${c.dim(`(guess: ${event.question.guess})`)}`);
            skipped.push(event.question);
            return wait("Reading");
          }
          const reply = await askQuestion(event.question);
          if (reply === null || !(await send({ apiBaseUrl, id: run.discoveryId, q: event.question, reply }))) skipped.push(event.question);
          return wait("Reading");
        }
        if (event.type === "answered") return;   // ours was said already; another's shows on the run
        // Four modules are read at once: which ones is the spinner's to say, not a line each.
        if (event.type === "reading") return wait(discoveryEventLine(event));
        const line = discoveryEventLine(event);
        if (!line) return;
        quiet();
        console.log(event.type === "stopped" || event.type === "failed" || event.type === "not_read" ? c.fail(line) : step(line));
        if (["read", "modules", "library", "answers_used"].includes(event.type)) wait("Reading");
        if (event.type === "writing") wait("Writing the draft catalog");
      }
    });
    quiet();
    if (json) return;
    if (end.type === "finished") {
      console.log("");
      console.log(c.ok(discoveryEventLine(end)));
      if (skipped.length) say(`${skipped.length === 1 ? "One question is" : `${skipped.length} questions are`} left for later: sealeye discover answers, or the Discovery page on seaLeye.online.`);
      say("Nothing goes live from here: a platform engineer approves a catalog after its self-test.");
    } else if (end.type === "closed") {
      const now = await getDiscovery({ apiBaseUrl, id: run.discoveryId });
      console.log("");
      printRun(now, say);
    } else {
      process.exitCode = 1;
    }
  } finally {
    quiet();
    stopSpinner();
  }
}
