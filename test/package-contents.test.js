// What `curl -fsSL https://sealeye.run/install | sh` installs: the package release.sh
// packs (package.json "files"). The command and what it reads, never the API or the
// interview's prompt. The installer's own test (the last) installs the package's
// libraries from the npm registry, as a developer's machine does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
  assert.ok(!files.includes("prompts/interview-starter.yaml"), "nor the passages it is filled in with");
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
  // The starter's passages for that prompt (PHASE4-PLAN Step 3): the API's, like it.
  read.delete("prompts/interview-starter.yaml");
  assert.ok(read.size >= 5, "found the files the command reads");
  for (const f of read) assert.ok(files.has(f), `${f} is read by the command but not in the package`);
});

// Oct 21, 2026: 2.46.0's command did not start on any machine that installed it. A
// global npm install ignores the package's lock file and takes the newest libraries, and
// one released after the lock was written did not fit another. The package carries the
// tested lock as npm-shrinkwrap.json (deploy/release.sh), and the installer installs from
// it with npm ci (sites/run/install.sh). This runs that installer, for real, on a package
// packed the way release.sh packs it.
test("the installer installs the libraries the release was tested with, and the command starts", { timeout: 300000 }, () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-install-"));
  const pack = path.join(scratch, "pack");
  const home = path.join(scratch, "home");
  const prefix = path.join(scratch, "npm-global");
  fs.mkdirSync(pack);
  fs.mkdirSync(home);
  const shrinkwrap = path.join(root, "npm-shrinkwrap.json");
  fs.copyFileSync(path.join(root, "package-lock.json"), shrinkwrap);
  try {
    execFileSync("npm", ["pack", "--silent", "--pack-destination", pack], { cwd: root, encoding: "utf8" });
  } finally {
    fs.rmSync(shrinkwrap, { force: true });
  }
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const tgz = path.join(pack, `sealeye-${version}.tgz`);
  const installer = path.join(scratch, "install.sh");
  fs.writeFileSync(installer, fs.readFileSync(path.join(root, "sites", "run", "install.sh"), "utf8").replaceAll("{{VERSION}}", version));
  const env = { ...process.env, HOME: home, SEALEYE_HOME: path.join(home, ".sealeye"), SEALEYE_INSTALL_PACKAGE: `file://${tgz}`, npm_config_prefix: prefix, PATH: `${path.join(prefix, "bin")}:${process.env.PATH}` };
  execFileSync("sh", [installer], { env, encoding: "utf8", stdio: "pipe" });
  const out = execFileSync(path.join(prefix, "bin", "sealeye"), ["-v"], { env, encoding: "utf8" });
  assert.match(out, new RegExp(`sealeye ${version.replace(/\./g, "\\.")}`));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8")).packages;
  const installed = path.join(home, ".sealeye", "command", version);
  for (const dep of ["@langfuse/otel", "@opentelemetry/api", "@opentelemetry/exporter-trace-otlp-http"]) {
    const got = JSON.parse(fs.readFileSync(path.join(installed, "node_modules", dep, "package.json"), "utf8")).version;
    assert.equal(got, lock[`node_modules/${dep}`].version, `${dep} is the version GitHub tested`);
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});
