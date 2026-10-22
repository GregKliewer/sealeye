#!/usr/bin/env node
// Builds sealeye.org for GitHub Pages: copies sites/org/ to a folder and writes the
// release into its facts block, read from package.json, with the month that version
// was set in. The page in the repo carries the version it was last built with, but
// the published page never relies on that: nothing on it is typed in (CLAUDE.md,
// principle 7; DESIGN.md, "seaLeye.org serves its own fonts, and its version is read").
//
//   node scripts/org-site.js <out-folder>
//
// .github/workflows/pages.yml runs it on every push to main that changes sites/org/
// or package.json, so a release republishes the page.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const site = path.join(root, "sites", "org");

// The facts block's version line: <dd data-version>2.48.1, October 2026</dd>.
const VERSION_LINE = /(<dd data-version>)[^<]*(<\/dd>)/;

export const versionWords = (version, date) =>
  `${version}, ${date.toLocaleString("en-CA", { month: "long", year: "numeric", timeZone: "UTC" })}`;

export const stampVersion = (html, words) => {
  if (!VERSION_LINE.test(html)) throw new Error("sites/org/index.html has no <dd data-version> line to stamp");
  return html.replace(VERSION_LINE, `$1${words}$2`);
};

// When package.json last changed: the commit that set this version. A clone without
// that history (a shallow checkout) falls back to the last commit, then to today.
const versionDate = () => {
  for (const args of [["log", "-1", "--format=%cI", "--", "package.json"], ["log", "-1", "--format=%cI"]]) {
    try {
      const out = execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
      if (out) return new Date(out);
    } catch { /* not a git checkout */ }
  }
  return new Date();
};

const main = () => {
  const out = process.argv[2];
  if (!out) {
    console.error("usage: node scripts/org-site.js <out-folder>");
    process.exit(2);
  }
  const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(site, out, { recursive: true });
  const page = path.join(out, "index.html");
  const words = versionWords(version, versionDate());
  fs.writeFileSync(page, stampVersion(fs.readFileSync(page, "utf8"), words));
  console.log(`sealeye.org built in ${out}: ${words}`);
};

if (import.meta.url === `file://${process.argv[1]}`) main();
