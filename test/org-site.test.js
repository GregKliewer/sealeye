// sealeye.org (sites/org/): its version is stamped from package.json when it is
// published, and it loads nothing from any other site (DESIGN.md, "seaLeye.org serves
// its own fonts, and its version is read").
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stampVersion, versionWords } from "../scripts/org-site.js";

const root = path.resolve(import.meta.dirname, "..");
const site = path.join(root, "sites", "org");
const read = f => fs.readFileSync(path.join(site, f), "utf8");

test("the version is said as the release and its month", () => {
  assert.equal(versionWords("2.48.1", new Date("2026-10-22T21:00:00Z")), "2.48.1, October 2026");
});

test("stamping replaces only the version line", () => {
  const html = `<dl><dt>Version</dt><dd data-version>1.0.0, May 2026</dd><dt>License</dt><dd>AGPL-3.0</dd></dl>`;
  assert.equal(stampVersion(html, "2.0.0, June 2026"),
    `<dl><dt>Version</dt><dd data-version>2.0.0, June 2026</dd><dt>License</dt><dd>AGPL-3.0</dd></dl>`);
  assert.throws(() => stampVersion("<dl></dl>", "2.0.0, June 2026"), /data-version/);
});

test("the built page carries package.json's version", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "org-site-"));
  try {
    execFileSync("node", [path.join(root, "scripts", "org-site.js"), out], { cwd: root });
    const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
    assert.match(html, new RegExp(`<dd data-version>${version.replaceAll(".", "\\.")}, [A-Z][a-z]+ \\d{4}</dd>`));
    assert.ok(fs.existsSync(path.join(out, "fonts", "source-serif-4-latin-opsz-normal.woff2")), "the fonts travel with it");
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("the page loads nothing from another site", () => {
  const html = read("index.html");
  const css = read("style.css");
  for (const tag of html.match(/<(link|script|img)\b[^>]*>/g) ?? []) {
    if (/rel="canonical"/.test(tag)) continue;
    assert.doesNotMatch(tag, /(href|src)="(https?:)?\/\//, `${tag} loads from another site`);
  }
  assert.doesNotMatch(css, /url\(\s*["']?(https?:)?\/\//, "style.css loads from another site");
  assert.doesNotMatch(css, /@import/, "style.css imports nothing");
});

test("every font the stylesheet names is in fonts/, with its licence", () => {
  const css = read("style.css");
  const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map(m => m[1].replace(/["']/g, ""));
  assert.ok(urls.length >= 4);
  for (const u of urls) assert.ok(fs.existsSync(path.join(site, u)), `${u} is missing`);
  for (const l of ["OFL-source-serif-4.txt", "OFL-ibm-plex-mono.txt"]) {
    assert.match(read(path.join("fonts", l)), /SIL Open Font License/);
  }
});
