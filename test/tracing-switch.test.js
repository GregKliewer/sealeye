// Turning tracing off for a run (DESIGN.md, "Turning tracing off for a run"). Each case
// runs in its own process, because tracing starts once per process and the settings are
// read once. No network: LangFuse's address is a closed port, and the exporter is in
// memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");

const KEYS = {
  LANGFUSE_PUBLIC_KEY: "pk-lf-test",
  LANGFUSE_SECRET_KEY: "sk-lf-test-only",
  LANGFUSE_BASE_URL: "http://127.0.0.1:9"
};

/**
 * Start tracing in a fresh process and run one traced step. Returns whether tracing
 * started, the step's trace id, and how many spans would have left the machine.
 */
function tryTracing({ env = {}, config = null, off = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-switch-"));
  if (config) fs.writeFileSync(path.join(home, "config"), config);

  const clean = { ...process.env };
  for (const name of Object.keys(clean)) {
    if (/^(LANGFUSE_|SEALEYE_|DEPLOYME_)/.test(name)) delete clean[name];
  }

  const code = `
    import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";
    import { startTracing, flushTracing, traceRun } from "./core/tracing.js";
    const exporter = new InMemorySpanExporter();
    const on = startTracing({ exporter, off: ${off} });
    const traceId = await traceRun({ app: "static-website", mode: "new" }, async run => run.traceId);
    await flushTracing();
    console.log(JSON.stringify({ on, traceId: traceId ?? null, spans: exporter.getFinishedSpans().length }));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: root,
    env: { ...clean, ...env, HOME: home, SEALEYE_HOME: home },
    encoding: "utf8"
  });
  return JSON.parse(out.trim().split("\n").pop());
}

test("with LangFuse keys and no switch, a run is traced", () => {
  const r = tryTracing({ env: KEYS });
  assert.equal(r.on, true);
  assert.match(r.traceId, /^[0-9a-f]{32}$/);
  assert.equal(r.spans, 1);
});

test("--no-trace turns it off for the run: nothing is sent and there is no trace id", () => {
  const r = tryTracing({ env: KEYS, off: true });
  assert.deepEqual(r, { on: false, traceId: null, spans: 0 });
});

test("SEALEYE_TRACING=off in the environment turns it off", () => {
  const r = tryTracing({ env: { ...KEYS, SEALEYE_TRACING: "off" } });
  assert.deepEqual(r, { on: false, traceId: null, spans: 0 });
});

test("SEALEYE_TRACING=off in ~/.sealeye/config turns it off", () => {
  const r = tryTracing({ env: KEYS, config: "SEALEYE_TRACING=off\n" });
  assert.deepEqual(r, { on: false, traceId: null, spans: 0 });
});

test("the environment wins over the config file, as for every other setting", () => {
  const r = tryTracing({ env: { ...KEYS, SEALEYE_TRACING: "on" }, config: "SEALEYE_TRACING=off\n" });
  assert.equal(r.on, true);
});

for (const value of ["on", "true", "1", "yes", " On "]) {
  test(`SEALEYE_TRACING=${JSON.stringify(value)} leaves tracing to the keys`, () => {
    assert.equal(tryTracing({ env: { ...KEYS, SEALEYE_TRACING: value } }).on, true);
  });
}

for (const value of ["off", "false", "0", "no", "of", "disabled"]) {
  test(`SEALEYE_TRACING=${JSON.stringify(value)} is off, typos included`, () => {
    assert.equal(tryTracing({ env: { ...KEYS, SEALEYE_TRACING: value } }).on, false);
  });
}

test("the regression set refuses to run with tracing switched off", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-switch-"));
  let failed = null;
  try {
    execFileSync(process.execPath, ["scripts/eval-interview.js"], {
      cwd: root,
      env: { ...process.env, ...KEYS, ANTHROPIC_API_KEY: "sk-ant-test-only", SEALEYE_TRACING: "off", HOME: home, SEALEYE_HOME: home },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (err) {
    failed = err;
  }
  assert.ok(failed, "it should have stopped");
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /SEALEYE_TRACING turns tracing off/);
});

test("--no-trace is in the help, with run", () => {
  const out = execFileSync(process.execPath, ["cli/bin/sealeye", "--help"], { cwd: root, encoding: "utf8" });
  assert.match(out, /run \[[^\n]*--no-trace/);
  assert.match(out, /--no-trace\s+with run:/);
});
