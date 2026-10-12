// The command and seaLeye.online send the same folder the same way (PHASE2-PLAN D6):
// one walk, core/upload-rules.js, over the disk for the command and over the browser's
// folder for the portal. This runs both against one folder and compares what each
// would send, for an interview and for a deploy.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import ignore from "ignore";
import { unzipSync } from "fflate";

import { zipFolder } from "../core/upload.js";
import { collectUpload, treeFromPaths } from "../core/upload-rules.js";

function folder() {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-parity-")), "my-app");
  const put = (rel, body = "x") => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  };
  put(".gitignore", "dist/\n*.log\n.venv/\n");
  put("index.js", "console.log('hi')");
  put("package.json", "{}");
  put("dist/bundle.js", "built");
  put("debug.log", "noise");
  put("logs/.gitignore", "!keep.log\n");
  put("logs/keep.log", "kept");
  put(".venv/lib/x.py", "venv");
  put(".env", "KEY=sk-live-never");
  put("config/.env.production", "KEY=sk-live-never");
  put(".env.example", "KEY=");
  put("certs/server.pem", "cert");
  put("node_modules/x/index.js", "dep");
  put(".git/HEAD", "ref");
  put(".github/workflows/ci.yml", "ci");
  put(".sealeye/state", "ours");
  put("src/routes/users.js", "routes");
  return dir;
}

/** Every file in the folder, as a browser's folder input lists it: everything, flat. */
function asBrowserList(dir) {
  const out = [];
  const walk = rel => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) {
        const abs = path.join(dir, r);
        out.push({ path: r, size: fs.statSync(abs).size, bytes: async () => new Uint8Array(fs.readFileSync(abs)), text: async () => fs.readFileSync(abs, "utf8") });
      }
    }
  };
  walk("");
  return out;
}

const contents = entries => Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, Buffer.from(v).toString()]).sort(([a], [b]) => (a < b ? -1 : 1)));

for (const purpose of ["interview", "deploy"]) {
  test(`a ${purpose} upload is the same from the command and from the portal`, async () => {
    const dir = folder();
    const command = await zipFolder(dir, { purpose });
    const portal = await collectUpload(treeFromPaths("my-app", asBrowserList(dir)), { purpose, ignore });

    assert.deepEqual(contents(portal.entries), contents(unzipSync(command.zip)));
    assert.deepEqual([...portal.withheld].sort(), [...command.withheld].sort());
    assert.equal(portal.ignored, command.ignored);
    assert.ok(!(".env" in portal.entries) || portal.entries[".env"].length === 0, "a .env value never travels");
  });
}

test("what each upload carries, spelled out", async () => {
  const dir = folder();
  const interview = await collectUpload(treeFromPaths("my-app", asBrowserList(dir)), { purpose: "interview", ignore });
  assert.deepEqual(Object.keys(interview.entries).sort(), [
    ".env", ".env.example", ".gitignore", "certs/server.pem", "config/.env.production",
    "index.js", "logs/.gitignore", "logs/keep.log", "package.json", "src/routes/users.js"
  ]);
  assert.equal(interview.entries[".env"].length, 0);
  assert.equal(interview.entries["certs/server.pem"].length, 0);

  const deploy = await collectUpload(treeFromPaths("my-app", asBrowserList(dir)), { purpose: "deploy" });
  assert.ok("dist/bundle.js" in deploy.entries, "a deploy ships build output .gitignore names");
  assert.ok(!(".env" in deploy.entries));
  assert.ok(!Object.keys(deploy.entries).some(k => k.startsWith("node_modules/") || k.startsWith(".git/")));
});

test("an app folder that is a link is followed, and a .gitignore that is one is still read", async () => {
  const dir = folder();
  fs.renameSync(path.join(dir, ".gitignore"), path.join(dir, "..", "shared.gitignore"));
  fs.symlinkSync(path.join(dir, "..", "shared.gitignore"), path.join(dir, ".gitignore"));
  const link = path.join(path.dirname(dir), "linked-app");
  fs.symlinkSync(dir, link);
  const { zip } = await zipFolder(link);
  const names = Object.keys(unzipSync(zip));
  assert.ok(names.includes("index.js"));
  assert.ok(!names.includes("debug.log"), "the linked .gitignore's rules still apply");
  assert.ok(!names.includes(".gitignore"), "a link itself never travels");
});
