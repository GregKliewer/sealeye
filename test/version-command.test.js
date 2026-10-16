// `sealeye --version` and `-v`: the version and nothing else (Greg, Oct 16, 2026).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const root = path.resolve(import.meta.dirname, "..");
const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

for (const flag of ["--version", "-v"]) {
  test(`sealeye ${flag} prints the version alone`, async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), flag], { env: { ...process.env, NO_COLOR: "1" } });
    assert.equal(stdout, `sealeye ${version}\n`);
  });
}
