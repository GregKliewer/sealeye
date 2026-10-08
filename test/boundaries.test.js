// The CLI and the API are two clients of one contract, and either may one day ship
// without the other. So: cli/ and api/ may each import core/, never each other, and
// core/ imports nothing of ours outside itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

function sources(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(rel));
    else if (entry.name.endsWith(".js") || entry.name === "sealeye") out.push(rel);
  }
  return out;
}

function localImports(file) {
  const text = fs.readFileSync(path.join(root, file), "utf8");
  const specs = [...text.matchAll(/(?:from\s+|import\s*\(\s*|new URL\(\s*)["'](\.{1,2}\/[^"']+)["']/g)].map(m => m[1]);
  return specs.map(s => path.relative(root, path.resolve(root, path.dirname(file), s)));
}

const rules = {
  cli: ["cli", "core"],
  api: ["api", "core"],
  core: ["core"]
};

for (const [area, allowed] of Object.entries(rules)) {
  test(`${area}/ imports only from ${allowed.join(" and ")}/`, () => {
    const crossings = [];
    for (const file of sources(area)) {
      for (const target of localImports(file)) {
        if (target === "package.json") continue;   // the version, read from the root
        const top = target.split(path.sep)[0];
        if (!allowed.includes(top)) crossings.push(`${file} -> ${target}`);
      }
    }
    assert.deepEqual(crossings, []);
  });
}

test("every local import resolves to a file", () => {
  const missing = [];
  for (const area of Object.keys(rules)) {
    for (const file of sources(area)) {
      for (const target of localImports(file)) {
        if (!fs.existsSync(path.join(root, target))) missing.push(`${file} -> ${target}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});
