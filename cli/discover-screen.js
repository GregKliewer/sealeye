// cli/discover-screen.js
// The part of the terminal `sealeye discover` draws whole and draws again in place: a
// small window at the top with what the run is doing (a spinner, the step and how long
// it has taken, its last few lines and a line of totals) and, under it, the question
// being answered (Greg, Oct 15, 2026: "a small, multi-line window at the top of the run
// for scrolling updates ... while queuing questions in a longer window underneath",
// like a docker build's). What is done with goes up into the scrollback and stays: an
// answered question, a module that could not be read, the run's end.
//
// Each frame is one write, so a terminal never shows half of one, and the spinner moves
// between the run's events, so a long wait never looks like a stop. Colours come from
// brand.js; this file only places lines.
import { answer, c, SPINNER_MS, typed, typing } from "./brand.js";

// What a line takes on the screen once colours are left out and it wraps.
const visible = text => String(text).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const rowsOf = (line, columns) => Math.max(1, Math.ceil(visible(line).length / Math.max(20, columns || 80)));

/** Plain text cut to fit `width` characters, so a line in the window never wraps. */
export const fitText = (text, width) => {
  const t = String(text ?? "");
  return t.length > width ? `${t.slice(0, Math.max(1, width - 1))}…` : t;
};

/** Plain text padded with spaces to `width` visible characters, colours left out of the count. */
const padTo = (text, width) => `${text}${" ".repeat(Math.max(0, width - visible(text).length))}`;

/**
 * A box drawn with lines on all four sides, so the window reads as one thing apart from
 * the questions under it (Greg, Oct 15, 2026). `title` and `right` sit in the top edge,
 * `footer` in the bottom one; `rows` are the lines inside, already fitted to the width.
 * `edge` colours the lines. `width` is the whole box, edges included.
 */
export function boxed({ title = "", right = "", rows = [], footer = "", width = 80, edge = s => s }) {
  const inner = Math.max(10, width - 4);
  // An edge: its corners, a dash, the words with a space each side, and dashes to fill.
  const rule = (left, label, tail, close) => {
    const fixed = 4 + (label ? visible(label).length + 2 : 0) + (tail ? visible(tail).length + 2 : 0);
    const fill = "\u2500".repeat(Math.max(1, width - fixed));
    return `${edge(`${left}\u2500`)}${label ? ` ${label} ` : ""}${edge(fill)}${tail ? ` ${tail} ` : ""}${edge(`\u2500${close}`)}`;
  };
  return [
    rule("\u256d", title, right, "\u256e"),
    ...rows.map(row => `${edge("\u2502")} ${padTo(row, inner)} ${edge("\u2502")}`),
    rule("\u2570", footer, "", "\u256f")
  ];
}

/** Ctrl+C at the screen: the run goes on without this terminal. */
export const stopped = () => Object.assign(new Error("Stopped. The run goes on: sealeye discover answers, or the Discovery page on seaLeye.online, for its questions."), { interrupted: true, userFacing: true });

/**
 * A region of the terminal drawn whole: `top()` gives the window's lines each frame, and
 * the body is whatever is being asked. `commit(lines)` puts lines above the region, where
 * they stay. With `animate`, the region is drawn again every spinner frame.
 */
export function createScreen({ output = process.stdout, top = () => [], animate = true } = {}) {
  let drawn = 0;
  let body = [];
  let timer = null;
  let closed = false;
  const up = () => (drawn ? `\x1b[${drawn}A\r\x1b[J` : "");
  const paint = (above = []) => {
    if (closed) return;
    const lines = [...top(), ...body];
    output.write(up() + [...above, ...lines].map(line => `\x1b[2K${line}\n`).join(""));
    drawn = lines.reduce((n, line) => n + rowsOf(line, output.columns), 0);
  };
  const showCursor = () => output.write("\x1b[?25h");
  const screen = {
    columns: () => Math.max(20, output.columns || 80),
    render: () => paint(),
    setBody(next) {
      body = next;
      paint();
    },
    /** Lines that go up into the scrollback and stay; the body becomes `next`. */
    commit(above, next = body) {
      body = next;
      paint(above);
    },
    start() {
      if (animate && !timer) {
        output.write("\x1b[?25l");
        process.once("exit", showCursor);
        timer = setInterval(paint, SPINNER_MS);
        timer.unref?.();
      }
      paint();
      return screen;
    },
    /** Take the region off the screen, leaving `final` lines in its place. */
    close(final = []) {
      if (closed) return;
      if (timer) {
        clearInterval(timer);
        timer = null;
        showCursor();
        process.removeListener("exit", showCursor);
      }
      output.write(up() + final.map(line => `\x1b[2K${line}\n`).join(""));
      drawn = 0;
      closed = true;
    }
  };
  return screen;
}

/** Keys from one chunk of input: typed fast or pasted, they arrive together. */
const keysOf = chunk => String(chunk).match(/\u001b\[[0-9;]*[A-Za-z~]|[\s\S]/g) || [];

function listen(input, onKey) {
  const onData = chunk => {
    for (const key of keysOf(chunk)) if (onKey(key) === "done") break;
  };
  input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();
  input.on("data", onData);
  return () => {
    input.setRawMode(false);
    input.pause();
    input.removeListener("data", onData);
  };
}

/**
 * Pick one of `choices` with the arrow keys and Enter; the first is chosen to start.
 * `header` is drawn above the choices (the question). Once chosen, the header and the
 * choice picked go up into the scrollback. Without a `screen`, it draws its own.
 */
export function pick(choices, { input = process.stdin, output = process.stdout, screen = null, header = [] } = {}) {
  const own = !screen;
  const region = screen || createScreen({ output, animate: false });
  return new Promise((resolve, reject) => {
    let at = 0;
    const show = () => region.setBody([...header, ...choices.map((choice, i) => (i === at ? `${c.prompt("›")} ${answer(choice)}` : `  ${c.fg(choice)}`))]);
    const done = (value, err) => {
      stop();
      region.commit(value === null ? header : [...header, `${c.prompt("›")} ${answer(value)}`], []);
      if (own) region.close();
      err ? reject(err) : resolve(value);
      return "done";
    };
    const stop = listen(input, key => {
      if (key === "\u0003") return done(null, stopped());
      if (key === "\r" || key === "\n") return done(choices[at]);
      if (key === "\u001b[A" || key === "k") at = (at - 1 + choices.length) % choices.length;
      else if (key === "\u001b[B" || key === "j") at = (at + 1) % choices.length;
      else if (/^[1-9]$/.test(key) && Number(key) <= choices.length) at = Number(key) - 1;
      else return;
      show();
    });
    show();
  });
}

/**
 * A line of one's own words, typed in the region so the window above keeps moving.
 * Backspace takes a character back and Ctrl+U the whole line; nothing past `limit` is
 * taken. Resolves with the words, or null for none.
 */
export function typeLine({ input = process.stdin, output = process.stdout, screen = null, limit = 600 } = {}) {
  const own = !screen;
  const region = screen || createScreen({ output, animate: false });
  return new Promise((resolve, reject) => {
    let text = "";
    let full = false;
    const line = caret => `${typing()}${text}${typed()}${caret ? c.dim("▏") : ""}`;
    const show = () => region.setBody([line(true), ...(full ? [c.dim(`  That is as long as an answer is kept: a sentence or two.`)] : [])]);
    const done = (value, err) => {
      stop();
      region.commit(value === null && err ? [] : [line(false)], []);
      if (own) region.close();
      err ? reject(err) : resolve(value);
      return "done";
    };
    const stop = listen(input, key => {
      if (key === "\u0003") return done(null, stopped());
      if (key === "\r" || key === "\n") return done(text.trim() || null);
      if (key === "\u007f" || key === "\b") text = text.slice(0, -1);
      else if (key === "\u0015") text = "";
      else if (key.length === 1 && key >= " ") {
        if (text.length >= limit) full = true;
        else text += key;
      } else return;
      if (text.length < limit) full = false;
      show();
    });
    show();
  });
}
