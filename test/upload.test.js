// The app folder as it travels to the API: what is left out, what travels as a name
// only, and what the API refuses to unpack. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync } from "fflate";

import { unzipInto, UploadRefused, zipFolder } from "../core/upload.js";

const SECRET = "sk-live-never-leaves-the-laptop";

function app() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-upload-"));
  const root = path.join(dir, "my-app");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "left-pad"), { recursive: true });
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"my-app"}');
  fs.writeFileSync(path.join(root, "src", "server.js"), "console.log('hi')");
  fs.writeFileSync(path.join(root, ".env"), `STRIPE_KEY=${SECRET}\n`);
  fs.writeFileSync(path.join(root, ".env.example"), "STRIPE_KEY=\n");
  fs.writeFileSync(path.join(root, "src", "server.pem"), "-----BEGIN PRIVATE KEY-----");
  fs.writeFileSync(path.join(root, "node_modules", "left-pad", "index.js"), "x");
  fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref");
  fs.symlinkSync("/etc/passwd", path.join(root, "passwords"));
  return root;
}

test("the zip leaves out dependencies, git and links, and carries secret files as names only", () => {
  const { zip, withheld } = zipFolder(app());
  assert.deepEqual(withheld.sort(), [".env", "src/server.pem"]);

  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-unzip-")), "my-app");
  unzipInto(zip, dest);

  const all = [];
  const walk = (d, rel = "") => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else all.push(r);
    }
  };
  walk(dest);

  assert.deepEqual(all.sort(), [".env", ".env.example", "package.json", "src/server.js", "src/server.pem"]);
  assert.equal(fs.readFileSync(path.join(dest, ".env"), "utf8"), "", "the .env arrives empty");
  assert.equal(fs.readFileSync(path.join(dest, "src", "server.pem"), "utf8"), "");
  assert.equal(fs.readFileSync(path.join(dest, ".env.example"), "utf8"), "STRIPE_KEY=\n");
  assert.ok(!Buffer.from(zip).toString("latin1").includes(SECRET), "no secret anywhere in the zip");
});

function unpack(entries) {
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-unzip-")), "app");
  unzipInto(zipSync(entries), dest);
  return dest;
}

test("the API refuses paths that climb out of the folder or start at the root", () => {
  const body = new Uint8Array([1]);
  assert.throws(() => unpack({ "../escape.js": body }), UploadRefused);
  assert.throws(() => unpack({ "a/../../escape.js": body }), UploadRefused);
  assert.throws(() => unpack({ "/etc/cron.d/x": body }), UploadRefused);
  assert.throws(() => unpack({ "node_modules/x/index.js": body }), UploadRefused);
});

test("a secret file that arrives with contents is written empty", () => {
  const dest = unpack({ ".env": new TextEncoder().encode(`KEY=${SECRET}`), "index.html": new Uint8Array([60]) });
  assert.equal(fs.readFileSync(path.join(dest, ".env"), "utf8"), "");
});

test("something that is not a zip is refused in a sentence", () => {
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-unzip-")), "app");
  assert.throws(() => unzipInto(new TextEncoder().encode("not a zip"), dest), /not a zip file/);
});

test("an upload that unpacks too big is refused before it is unpacked", () => {
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-unzip-")), "app");
  const zeros = zipSync({ "big.bin": new Uint8Array(26 * 1024 * 1024) });
  assert.ok(zeros.length < 1024 * 1024, "small on the wire");
  assert.throws(() => unzipInto(zeros, dest), /more than 25 MB/);
  assert.ok(!fs.existsSync(dest), "nothing written");
});
