// deployme/src/brand.js
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
  tagline: "cd your-app && sealeye init",
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
