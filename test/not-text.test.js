// Archives and files that are not text travel as their names only, for an interview as
// for a library (DESIGN.md, "Archives and files that are not text travel as names"):
// neither scanner sees inside an archive, and neither the interview nor a discovery
// worker reads a file that is not text. A deploy still carries them: they are the app.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { unzipSync } from "fflate";

import { zipFolder } from "../core/upload.js";
import { holdNotText } from "../api/interview/service.js";
import { readFile, runTool } from "../api/interview/tools.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

function app() {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-nottext-")), "shop");
  const put = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  };
  put("index.js", "console.log('hi')\n");
  put("public/logo.png", PNG);
  put("fixtures/seed.zip", "PK\u0003\u0004 a compressed seed");
  put("fixtures/data.tgz", "\u001f\u008b not really gzip");
  put("notes.txt", "plain text\n");
  return dir;
}

test("an interview sends archives and files that are not text as names only, and says which", async () => {
  const dir = app();
  const packed = await zipFolder(dir);
  const entries = unzipSync(packed.zip);
  assert.deepEqual(packed.unread.sort(), ["fixtures/data.tgz", "fixtures/seed.zip", "public/logo.png"]);
  for (const file of packed.unread) assert.equal(entries[file].length, 0, file);
  assert.ok(entries["index.js"].length > 0);
  assert.ok(entries["notes.txt"].length > 0);
});

test("a deploy still carries them: they are part of the app", async () => {
  const packed = await zipFolder(app(), { purpose: "deploy" });
  const entries = unzipSync(packed.zip);
  assert.deepEqual(Buffer.from(entries["public/logo.png"]), PNG);
  assert.ok(entries["fixtures/seed.zip"].length > 0);
});

test("the API empties them whatever the client sent, and takes a claim only for a file that arrived empty", () => {
  const dir = app();   // as an older client would send it: everything with contents
  fs.writeFileSync(path.join(dir, "empty.js"), "");
  const held = holdNotText(dir, ["empty.js", "index.js", "../escape", 7]);
  assert.deepEqual(held, ["empty.js", "fixtures/data.tgz", "fixtures/seed.zip", "public/logo.png"]);
  assert.equal(fs.statSync(path.join(dir, "public/logo.png")).size, 0);
  assert.ok(fs.statSync(path.join(dir, "index.js")).size > 0, "a claim on a file with contents is ignored");
});

test("read_file refuses a file sent as its name only, and says why", () => {
  const dir = app();
  const unread = holdNotText(dir);
  assert.throws(() => readFile(dir, "fixtures/seed.zip", { unread }), /fixtures\/seed\.zip is an archive or a file that is not text, so only its name was sent/);
  const { content, isError } = runTool(dir, "read_file", { path: "public/logo.png" }, { unread });
  assert.equal(isError, true);
  assert.match(content, /^refused: public\/logo\.png is an archive or a file that is not text/);
  assert.equal(readFile(dir, "notes.txt", { unread }), "plain text\n");
});
