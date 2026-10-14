// One list of words for both surfaces (core/operations.js). The command takes every
// word in it, its help shows each command and no alias, and the portal shows every
// operation it labels through the list, never a command line it wrote itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { OPERATIONS, commandFor, commandLine, label, wordsFor } from "../core/operations.js";

const root = path.resolve(import.meta.dirname, "..");
const cliSource = fs.readFileSync(path.join(root, "cli/bin/sealeye"), "utf8");
const first = op => op.command.split(" ")[0];

test("every alias means one command, and no alias is a command of its own", () => {
  const commands = new Set(OPERATIONS.map(first));
  const seen = new Set();
  for (const op of OPERATIONS) {
    for (const alias of op.aliases) {
      assert.ok(!commands.has(alias), `${alias} is both a command and an alias`);
      assert.ok(!seen.has(alias), `${alias} is an alias twice`);
      seen.add(alias);
      assert.equal(commandFor(alias), first(op));
    }
  }
  assert.equal(commandFor("destroy"), "teardown");
  assert.equal(commandFor("logs"), "logs");
  assert.equal(commandFor("nonsense"), "nonsense");
});

test("a command line names its target only when it acts on one environment", () => {
  assert.equal(commandLine("teardown", "shop-api"), "sealeye teardown shop-api");
  assert.equal(commandLine("deploy-again", "shop-api"), "sealeye deploy --again shop-api");
  assert.equal(commandLine("teardown"), "sealeye teardown");
  assert.equal(commandLine("costs", "shop-api"), "sealeye costs");
  assert.equal(label("teardown"), "Tear down");
  assert.deepEqual(wordsFor("online"), ["online", "portal", "open"]);
  assert.throws(() => label("explode"));
});

test("the command handles every operation in the list", () => {
  const handled = word =>
    new RegExp(`command === "${word}"`).test(cliSource) ||
    (word === "online" && /ONLINE\.has\(command\)/.test(cliSource));
  const missing = OPERATIONS.map(first).filter(word => !handled(word));
  assert.deepEqual(missing, []);
  // Aliases are turned into their command once, before anything is dispatched.
  assert.match(cliSource, /const command = commandFor\(process\.argv\[2\]\)/);
});

test("the command's help shows every command and none of the aliases", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), "--help"], {
    env: { ...process.env, NO_COLOR: "1" }
  });
  for (const op of OPERATIONS) {
    assert.match(stdout, new RegExp(`sealeye ${first(op)}\\b`), `help shows ${first(op)}`);
    for (const alias of op.aliases) assert.doesNotMatch(stdout, new RegExp(`sealeye ${alias}\\b`), `help hides ${alias}`);
  }
});

// The portal's TypeScript, with comments taken out: a comment may name a command for
// whoever reads the code; the page may not.
function portalText() {
  const out = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push([rel, fs.readFileSync(path.join(root, rel), "utf8")]);
    }
  };
  walk("portal/src");
  return out.map(([file, text]) => [file, text
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1")]);
}

test("the portal shows every operation it labels, through the list", () => {
  const used = new Set();
  for (const [, text] of portalText()) {
    for (const m of text.matchAll(/(?:label|commandLine)\(\s*"([a-z-]+)"|\bop="([a-z-]+)"/g)) used.add(m[1] || m[2]);
  }
  const missing = OPERATIONS.filter(op => op.label && !used.has(op.id)).map(op => op.id);
  assert.deepEqual(missing, []);
});

test("the portal writes no command line of its own", () => {
  const words = OPERATIONS.flatMap(op => [first(op), ...op.aliases]);
  const typed = new RegExp(`\\bsealeye (?:${words.join("|")})\\b`);
  const found = [];
  for (const [file, text] of portalText()) {
    text.split("\n").forEach((line, i) => { if (typed.test(line)) found.push(`${file}:${i + 1}: ${line.trim()}`); });
  }
  assert.deepEqual(found, []);
});
