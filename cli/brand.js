// cli/brand.js
// seaLeye.run brand, "Terminal" direction (chosen Sept 20, 2026).
// One place for every colour the CLI prints. Honour NO_COLOR and non-TTY output.

const enabled = !process.env.NO_COLOR && process.stdout.isTTY && process.env.TERM !== "dumb";
const rgb = (r, g, b) => (enabled ? `\x1b[38;2;${r};${g};${b}m` : "");
const RESET = enabled ? "\x1b[0m" : "";
const BOLD = enabled ? "\x1b[1m" : "";

export const palette = {
  ground: "#13181D",   // terminal background (set in the terminal app, not printed)
  fg: "#D9E0E6",       // default text
  accent: "#7FD8C2",   // phosphor: wordmark, success, values the developer chose
  prompt: "#E8B04B",   // amber: the $ prompt and every question
  dim: "#8A96A3",      // secondary text, timestamps, "what the platform is doing"
};

export const c = {
  accent: (s) => `${rgb(127, 216, 194)}${s}${RESET}`,
  prompt: (s) => `${rgb(232, 176, 75)}${s}${RESET}`,
  dim: (s) => `${rgb(138, 150, 163)}${s}${RESET}`,
  fg: (s) => `${rgb(217, 224, 230)}${s}${RESET}`,
  bold: (s) => `${BOLD}${s}${RESET}`,
  ok: (s) => `${rgb(127, 216, 194)}✓ ${s}${RESET}`,
  fail: (s) => `${rgb(232, 176, 75)}✗ ${s}${RESET}`,  // amber, not red: the brand has two colours
};

export const product = {
  name: "seaLeye.run",
  command: "sealeye",
  tagline: "cd your-app && sealeye run",
  spoken: "C-L-I dot run",
};

// Print the banner once per command. `bannerText` is the contents of prompts/banner.txt,
// read by the CLI relative to its own location (never the developer's folder).
export function banner(bannerText, meta = "") {
  const [figlet, tag] = splitBanner(bannerText);
  const lines = [c.accent(figlet), c.dim(meta ? `${tag}   ${meta}` : tag), ""];
  return lines.join("\n");
}

function splitBanner(text) {
  const rows = text.replace(/\s+$/, "").split("\n");
  const tag = rows.pop();
  return [rows.join("\n"), tag];
}

// One-line "what the platform is doing" messages, all through this so they look the same.
export const step = (msg) => c.dim(`  ${msg}`);
export const ask = (q) => `${c.prompt("?")} ${q} `;
export const answer = (a) => c.accent(a);

// An open question is answered on a line of its own: a phosphor prompt, and the colour
// left on so the answer is phosphor while it is typed, not only after Enter. `typed()`
// turns it off again once the line is in.
export const typing = () => (enabled ? `${BOLD}${rgb(127, 216, 194)}>${RESET}${rgb(127, 216, 194)} ` : "> ");
export const typed = () => RESET;

// A spinner for the waits with nothing on the screen. It owns one line: frames are
// rewritten in place with \r, and the real line lands on top of it when it arrives.
// It never replaces a step line. The step lines are the persuasive part of the demo;
// the spinner only fills the gaps between them.
const FRAMES = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];
const FRAME_MS = 80;             // about twelve frames a second
const COUNTER_AFTER_MS = 3000;   // a short wait shows no count, a long one always does

// True when there is a live terminal to animate on. A pipe, a file, a transcript and
// --json output must never receive a frame.
export const animations = () => Boolean(enabled) && !process.argv.includes("--json");

// The Ctrl+C path has no way to reach whichever spinner is running, so the module
// remembers the live one. There is only ever one: the CLI does one thing at a time.
let active = null;
let exitHookInstalled = false;

/** Clear the spinner that is running, if one is. Safe to call when none is. */
export function stopSpinner() {
  if (active) active.stop();
}

// Whatever happens, the line a spinner owns is not left behind on the screen.
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", stopSpinner);
}

/**
 * Start a spinner on the current line.
 *
 * @param   {string} label  what the platform is doing, in the language of a step line
 * @returns {{label: (next: string) => void, stop: (finalLine?: string) => void}}
 *
 * `.label(next)` changes the label and restarts the count, because the count belongs
 * to the thing being waited on rather than to the run. `.label(next, { keepCount: true })`
 * keeps it, for when the words change but the wait does not. `.stop(finalLine)` clears
 * the line completely and optionally prints one line in its place.
 */
export function spinner(label = "") {
  if (!animations()) {
    // Silent, but a final line is real output and still belongs in the transcript.
    return { label: () => {}, stop: (finalLine) => { if (finalLine) console.log(finalLine); } };
  }

  stopSpinner();   // two spinners would fight over the same line

  let current = label;
  let since = Date.now();
  let frame = 0;
  let width = 0;
  let stopped = false;

  const draw = () => {
    const elapsed = Date.now() - since;
    const counted =
      elapsed >= COUNTER_AFTER_MS ? `${current}  ${Math.floor(elapsed / 1000)}s` : current;
    const line = fit(`  ${FRAMES[frame++ % FRAMES.length]} ${counted}`);

    // The widest thing drawn since the last clear, so clearing always covers it.
    width = Math.max(width, line.length);
    process.stdout.write(`\r${c.dim(line)}`);
  };

  // One line means one line. A label that wrapped would survive the \r and be left on
// the screen, so the terminal's width wins over anything a caller asks for.
const fit = (line) => {
  const room = (process.stdout.columns || 80) - 1;
  return line.length > room ? `${line.slice(0, Math.max(0, room - 1))}\u2026` : line;
};

// Spaces and \r, not a newline: the line has to be given back, not scrolled past.
  const clear = () => {
    process.stdout.write(`\r${" ".repeat(width)}\r`);
    width = 0;
  };

  const timer = setInterval(draw, FRAME_MS);
  timer.unref();   // a forgotten spinner must never hold the CLI open

  const handle = {
    label(next, { keepCount = false } = {}) {
      if (stopped || !next || next === current) return;
      clear();
      current = next;
      if (!keepCount) since = Date.now();
      draw();
    },
    stop(finalLine) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      clear();
      if (active === handle) active = null;
      if (finalLine) console.log(finalLine);
    }
  };

  active = handle;
  installExitHook();
  draw();

  return handle;
}
