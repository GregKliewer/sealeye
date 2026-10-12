// What `curl -fsSL https://sealeye.run/install | sh` installs: the package release.sh
// packs (package.json "files"). The command and what it reads, never the API or the
// interview's prompt. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

const packed = () => {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" });
  return JSON.parse(out)[0].files.map(f => f.path).sort();
};

test("the installed package is the command, core, and the files they read", () => {
  const files = packed();
  for (const f of files) {
    assert.match(f, /^(cli\/|core\/|prompts\/|templates\/|package\.json$|README\.md$|LICENSE$|NOTICE$)/, `${f} should not be in the package`);
  }
  for (const needed of ["cli/bin/sealeye", "core/config.js", "prompts/banner.txt", "prompts/module-catalog.yaml",
    "prompts/plan-template.md", "prompts/refusal.md", "templates/http_api_serverless.yaml"]) {
    assert.ok(files.includes(needed), `${needed} is read by the command`);
  }
  assert.ok(!files.some(f => f.startsWith("api/")), "never the API");
  assert.ok(!files.includes("prompts/interview-system.md"), "never the interview's prompt");
});

test("every prompt or template the command and core read is in the package", () => {
  const files = new Set(packed());
  const read = new Set();
  const walk = dir => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.js$|^sealeye$/.test(e.name)) {
        const src = fs.readFileSync(path.join(root, rel), "utf8");
        for (const m of src.matchAll(/path\.join\(repoRoot, "(prompts|templates)", "([^"]+)"\)/g)) read.add(`${m[1]}/${m[2]}`);
      }
    }
  };
  walk("cli");
  walk("core");
  // Read only by the API, through core/tracing.js, to name the prompt version in a trace.
  read.delete("prompts/interview-system.md");
  assert.ok(read.size >= 5, "found the files the command reads");
  for (const f of read) assert.ok(files.has(f), `${f} is read by the command but not in the package`);
});
