// The interview's read_file tool never returns the contents of a secret file, while
// list_files still shows that the file exists (principle 6). Each refused name is its
// own test, so a failure says exactly which file leaked.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTool, secretFileReason } from "../cli/interview/tools.js";

const SECRET = "sk-live-do-not-leak";

function appWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-tools-"));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

const REFUSED = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.development.local",
  ".ENV",
  ".envrc",
  "server.pem",
  "private.key",
  "id_rsa",
  "id_rsa.pub",
  "id_ed25519",
  ".npmrc",
  "credentials",
  "config/.env",
  "deploy/certs/tls.pem"
];

for (const name of REFUSED) {
  test(`read_file refuses ${name}`, () => {
    const app = appWith({ [name]: `TOKEN=${SECRET}\n` });
    const result = runTool(app, "read_file", { path: name });
    assert.equal(result.isError, true);
    assert.match(result.content, /^refused: /);
    assert.ok(!result.content.includes(SECRET), "the contents must never reach the model");
  });
}

test("the .env refusal points the model at .env.example", () => {
  const app = appWith({ ".env": `KEY=${SECRET}\n` });
  const { content } = runTool(app, "read_file", { path: ".env" });
  assert.equal(content, "refused: .env holds secret values; read .env.example instead, if there is one");
});

test("the credential refusal says the contents are never read", () => {
  const app = appWith({ ".npmrc": `//registry.npmjs.org/:_authToken=${SECRET}\n` });
  const { content } = runTool(app, "read_file", { path: ".npmrc" });
  assert.equal(content, "refused: .npmrc is a credential file; its contents are never read");
});

for (const name of [".env.example", ".env.sample", ".ENV.EXAMPLE"]) {
  test(`read_file still reads ${name}`, () => {
    const app = appWith({ [name]: "API_KEY=\nPORT=3000\n" });
    const result = runTool(app, "read_file", { path: name });
    assert.equal(result.isError, false);
    assert.equal(result.content, "API_KEY=\nPORT=3000\n");
  });
}

test("ordinary files with env or key in the name are still readable", () => {
  for (const name of ["env.js", "environment.ts", "keys.json", "monkey.js", "credentials.md"]) {
    assert.equal(secretFileReason(name), null, `${name} should be readable`);
  }
});

test("a symlink with an innocent name that points at .env is refused", () => {
  const app = appWith({ ".env": `KEY=${SECRET}\n` });
  fs.symlinkSync(".env", path.join(app, "notes.txt"));
  const result = runTool(app, "read_file", { path: "notes.txt" });
  assert.equal(result.isError, true);
  assert.ok(!result.content.includes(SECRET));
});

test("list_files still shows secret file names, never their contents", () => {
  const app = appWith({
    ".env": `KEY=${SECRET}\n`,
    ".env.example": "KEY=\n",
    ".npmrc": `token=${SECRET}\n`,
    "server.js": "console.log('hi')\n"
  });
  const result = runTool(app, "list_files", { path: "." });
  assert.equal(result.isError, false);
  for (const name of [".env", ".env.example", ".npmrc", "server.js"]) {
    assert.ok(result.content.split("\n").includes(name), `${name} should be listed`);
  }
  assert.ok(!result.content.includes(SECRET));
});
