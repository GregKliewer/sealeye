// Reading a platform library (PHASE4-PLAN Step 5; api/discovery/). A stand-in for GitHub
// answers as GitHub does, so nothing here reaches the network. What is checked: which
// repositories are named and how, the two ways in (a GitHub App's narrowed token, or a
// read-only token), that the credential goes to GitHub's API and nowhere else, the
// archive read safely, and the snapshot a worker would read: secret files as names,
// flagged lines replaced, the pipeline read, no allow file honoured.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { appJwt, githubCredential, githubReader, libraryRepos, LibraryUnreadable, parseRepo } from "../api/discovery/github.js";
import { readLibrary, readLibraryFolder } from "../api/discovery/library.js";
import { untar } from "../api/discovery/tar.js";
import { isRedactedLine } from "../core/scan.js";
import { UploadRefused } from "../core/upload-rules.js";
import { githubTarball } from "./helpers/tarball.js";

const COMMIT = "a".repeat(40);
const TOKEN = "github_pat_ReadOnlyStandInNeverReal0123456789";
const PASSWORD_LINE = '  master_password = "Qv7r2Nx9Tb4Kw8Mz3Hc6Pd5"';

const LIBRARY = {
  "README.md": "# Acme's platform library\n",
  ".gitignore": ".terraform/\n*.log\n",
  ".terraform/providers/lock": "cache",
  "build.log": "noise",
  ".github/workflows/app-build.yml": "name: build\non: workflow_call\n",
  "modules/db/main.tf": `resource "x" "y" {\n  name = var.name\n${PASSWORD_LINE}\n}\n`,
  "modules/db/variables.tf": 'variable "name" {\n  type = string\n}\n',
  "modules/db/examples/x/terraform.tfvars": 'name = "real-value-never-read"\n',
  "modules/db/README.md": "Use this below staging.\n",
  // A library's own allow file names the line: it must not count.
  ".sealeye-allow": "modules/db/main.tf:3 assigned-secret\n",
  "modules/db/link.tf": { link: "/etc/passwd" }
};

/** A stand-in for GitHub: records every request, answers as GitHub does. */
function standInGitHub({ tarball = githubTarball(LIBRARY, { commit: COMMIT }), app = null, status = {} } = {}) {
  const calls = [];
  const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ host: u.host, path: u.pathname, method: init.method || "GET", headers, body: init.body ? JSON.parse(init.body) : undefined, redirect: init.redirect });
    if (status[u.pathname]) return new Response("{}", { status: status[u.pathname] });
    if (u.host === "codeload.github.com") return new Response(tarball, { status: 200 });
    if (u.pathname === "/repos/acme/library/installation") return json({ id: 42 });
    if (u.pathname === "/app/installations/42/access_tokens") return json({ token: "ghs_InstallationStandIn", expires_at: "2026-10-15T20:00:00Z" }, { status: 201 });
    if (u.pathname === "/repos/acme/library") return json({ default_branch: "main" });
    if (u.pathname.startsWith("/repos/acme/library/commits/")) return new Response(`${COMMIT}\n`, { status: 200 });
    if (u.pathname === `/repos/acme/library/tarball/${COMMIT}`) {
      return new Response(null, { status: 302, headers: { location: `https://codeload.github.com/acme/library/legacy.tar.gz/${COMMIT}?token=SHORTLIVED` } });
    }
    return new Response("{}", { status: 404 });
  };
  return { fetch, calls, app };
}

const target = { owner: "acme", repo: "library", ref: null };

test("the platform team names repositories in a setting, each perhaps at a ref", () => {
  assert.deepEqual(libraryRepos(""), []);
  assert.deepEqual(libraryRepos("GregKliewer/sealeye-sample-platform"), [{ owner: "GregKliewer", repo: "sealeye-sample-platform", ref: null }]);
  assert.deepEqual(libraryRepos("acme/one@v1.2.0, acme/two@release/2026 acme/three@" + COMMIT).map(r => r.ref), ["v1.2.0", "release/2026", COMMIT]);
  for (const bad of ["acme", "acme/one/two", "-acme/x", "acme/..", "acme/x@../main", "acme/x@a..b", "acme/x@", "https://github.com/acme/x"]) {
    assert.equal(parseRepo(bad), null, bad);
  }
  assert.throws(() => libraryRepos("acme/ok, nope"), /SEALEYE_LIBRARY_REPOS has "nope"/);
});

test("with a read-only token: the commit is pinned, and the token goes to GitHub's API only", async () => {
  const gh = standInGitHub();
  const snapshot = await readLibrary(target, { credential: { kind: "token", token: TOKEN }, fetch: gh.fetch });
  try {
    assert.equal(snapshot.commit, COMMIT);
    assert.equal(snapshot.repo, "acme/library");
    assert.equal(snapshot.via, "token");
    assert.deepEqual(gh.calls.map(c => `${c.host}${c.path}`), [
      "api.github.com/repos/acme/library",
      "api.github.com/repos/acme/library/commits/main",
      `api.github.com/repos/acme/library/tarball/${COMMIT}`,
      `codeload.github.com/acme/library/legacy.tar.gz/${COMMIT}`
    ]);
    for (const c of gh.calls.filter(c => c.host === "api.github.com")) assert.equal(c.headers.authorization, `Bearer ${TOKEN}`);
    const download = gh.calls.find(c => c.host === "codeload.github.com");
    assert.equal(download.headers.authorization, undefined, "the download carries its own permission, never the token");
    assert.equal(gh.calls.find(c => c.path.includes("/tarball/")).redirect, "manual");
    assert.ok(gh.calls.every(c => c.method === "GET"), "nothing is written to GitHub");
  } finally {
    snapshot.remove();
  }
});

test("a ref is read where it points now; a named commit is read as it is", async () => {
  const gh = standInGitHub();
  const snapshot = await readLibrary({ ...target, ref: "v1.2.0" }, { credential: { kind: "token", token: TOKEN }, fetch: gh.fetch });
  snapshot.remove();
  assert.equal(gh.calls[0].path, "/repos/acme/library/commits/v1.2.0");
  assert.equal(gh.calls[0].headers.accept, "application/vnd.github.sha");
});

test("the snapshot: secret files as names, the flagged line replaced, the pipeline read, the allow file ignored", async () => {
  const gh = standInGitHub();
  const snapshot = await readLibrary(target, { credential: { kind: "token", token: TOKEN }, fetch: gh.fetch });
  try {
    const read = rel => fs.readFileSync(path.join(snapshot.dir, rel), "utf8");
    const exists = rel => fs.existsSync(path.join(snapshot.dir, rel));

    // The variables file is there by name, and empty.
    assert.deepEqual(snapshot.secretFiles, ["modules/db/examples/x/terraform.tfvars"]);
    assert.equal(read("modules/db/examples/x/terraform.tfvars"), "");

    // The password's line says why it is missing; every other line is as it was.
    const lines = read("modules/db/main.tf").split("\n");
    assert.ok(isRedactedLine(lines[2]));
    assert.deepEqual(lines.filter((_, i) => i !== 2), LIBRARY["modules/db/main.tf"].split("\n").filter((_, i) => i !== 2));
    assert.doesNotMatch(JSON.stringify(snapshot), /Qv7r2Nx9/);
    assert.deepEqual(snapshot.findings.map(f => [f.file, f.line, f.rule, f.whole]), [["modules/db/main.tf", 3, "assigned-secret", false]]);

    // The pipeline is read; what .gitignore leaves out and links are not.
    assert.equal(read(".github/workflows/app-build.yml"), LIBRARY[".github/workflows/app-build.yml"]);
    assert.ok(!exists(".terraform/providers/lock"));
    assert.ok(!exists("build.log"));
    assert.ok(!exists("modules/db/link.tf"));
    assert.equal(read("modules/db/README.md"), LIBRARY["modules/db/README.md"]);
  } finally {
    snapshot.remove();
  }
  assert.ok(!fs.existsSync(snapshot.dir), "remove() takes the snapshot away");
});

test("a value gitleaks finds over several lines leaves its file empty", async () => {
  const key = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs1", format: "pem" });
  const gh = standInGitHub({ tarball: githubTarball({ "modules/tls/README.md": "Example\n", "modules/tls/example.txt": `here it is\n${key}` }, { commit: COMMIT }) });
  const snapshot = await readLibrary(target, { credential: { kind: "token", token: TOKEN }, fetch: gh.fetch });
  try {
    assert.equal(fs.readFileSync(path.join(snapshot.dir, "modules/tls/example.txt"), "utf8"), "");
    assert.ok(snapshot.findings.some(f => f.file === "modules/tls/example.txt" && f.whole));
  } finally {
    snapshot.remove();
  }
});

test("with a GitHub App: a signed request for a token narrowed to the one repository, read only", async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const gh = standInGitHub();
  const now = Date.parse("2026-10-15T17:00:00Z");
  const snapshot = await readLibrary(target, { credential: { kind: "app", appId: "123456", key: privateKey }, fetch: gh.fetch, now: () => now });
  snapshot.remove();
  assert.equal(snapshot.via, "app");

  const [find, issue, ...reads] = gh.calls;
  assert.equal(find.path, "/repos/acme/library/installation");
  assert.equal(issue.path, "/app/installations/42/access_tokens");
  assert.equal(issue.method, "POST");
  assert.deepEqual(issue.body, { repositories: ["library"], permissions: { contents: "read" } });

  // The app's statement is signed with its key, says which app, and is short-lived.
  for (const c of [find, issue]) {
    const jwt = c.headers.authorization.replace(/^Bearer /, "");
    const [h, p, s] = jwt.split(".");
    assert.ok(crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url")));
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    assert.equal(claims.iss, "123456");
    assert.ok(claims.exp - claims.iat <= 600 && claims.iat <= now / 1000);
  }
  // Everything after is read with the narrowed token, never the app's statement.
  for (const c of reads.filter(c => c.host === "api.github.com")) assert.equal(c.headers.authorization, "Bearer ghs_InstallationStandIn");
});

test("the app is used when both are set; a half-set app is said plainly", () => {
  const keep = { ...process.env };
  try {
    const pem = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs8", format: "pem" });
    Object.assign(process.env, { SEALEYE_GITHUB_APP_ID: "123456", SEALEYE_GITHUB_APP_KEY: pem.replace(/\n/g, "\\n"), SEALEYE_GITHUB_READ_TOKEN: TOKEN });
    assert.equal(githubCredential().kind, "app", "line breaks written as \\n are read too");
    process.env.SEALEYE_GITHUB_APP_KEY = "";
    assert.throws(() => githubCredential(), /SEALEYE_GITHUB_APP_KEY is not set/);
    process.env.SEALEYE_GITHUB_APP_ID = "";
    assert.equal(githubCredential().kind, "token");
    process.env.SEALEYE_GITHUB_READ_TOKEN = "";
    assert.equal(githubCredential(), null);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
    Object.assign(process.env, keep);
  }
});

test("no way in, a refusal or a strange download link: said in words, never with the credential", async () => {
  await assert.rejects(githubReader(target, { credential: null }), /seaLeye has no way to read acme\/library: set SEALEYE_GITHUB_APP_ID/);

  const denied = standInGitHub({ status: { "/repos/acme/library": 401 } });
  await assert.rejects(readLibrary(target, { credential: { kind: "token", token: TOKEN }, fetch: denied.fetch }), err => {
    assert.ok(err instanceof LibraryUnreadable);
    assert.match(err.message, /could not read acme\/library: the credential seaLeye reads with was not accepted/);
    assert.ok(!err.message.includes(TOKEN));
    return true;
  });

  const missing = standInGitHub({ status: { "/repos/acme/library/commits/nope": 404 } });
  await assert.rejects(readLibrary({ ...target, ref: "nope" }, { credential: { kind: "token", token: TOKEN }, fetch: missing.fetch }), /could not find "nope" in acme\/library/);

  const elsewhere = async (url, init) => {
    if (String(url).includes("/tarball/")) return new Response(null, { status: 302, headers: { location: "https://evil.example.com/x.tgz" } });
    return standInGitHub().fetch(url, init);
  };
  await assert.rejects(readLibrary(target, { credential: { kind: "token", token: TOKEN }, fetch: elsewhere }), /download link is not GitHub's/);
});

test("the archive is read safely: no climbing out, no links, damage refused, size capped", () => {
  const gz = githubTarball({ "a.txt": "a", ["deep/" + "x".repeat(120) + ".tf"]: "long", "l": { link: "a.txt" } }, {
    raw: [{ name: "top/../../escape.txt", body: "no" }, { name: "/etc/abs.txt", body: "no" }, { name: "beside-top.txt", body: "no" }]
  });
  const files = untar(gz, { maxBytes: 1024 * 1024, maxFiles: 100 });
  assert.deepEqual(files.map(f => f.path).sort(), ["a.txt", "deep/" + "x".repeat(120) + ".tf"]);
  assert.equal(files.find(f => f.path === "a.txt").text(), "a");

  assert.throws(() => untar(githubTarball({ "a.txt": "x".repeat(2000) }), { maxBytes: 1000, maxFiles: 100 }), err => err instanceof UploadRefused && /bigger than/.test(err.message));
  assert.throws(() => untar(githubTarball({ "a": "1", "b": "2", "c": "3" }), { maxBytes: 1000, maxFiles: 2 }), /more than 2 files/);
  assert.throws(() => untar(new Uint8Array([1, 2, 3]), { maxBytes: 1000, maxFiles: 2 }), /not arrive as an archive/);

  // A header whose checksum is wrong is refused, not read.
  const raw = gunzipSync(githubTarball({ "a.txt": "a" }));
  raw[1536 + 1] ^= 0xff;   // a.txt's own header, after the global header and the top folder
  assert.throws(() => untar(new Uint8Array(gzipSync(raw)), { maxBytes: 1000, maxFiles: 10 }), /not arrive as an archive/);
});

test("a folder on this machine is read by the same rules", async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-lib-")), "library");
  for (const [rel, body] of Object.entries(LIBRARY)) {
    if (typeof body !== "string") continue;
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  const snapshot = await readLibraryFolder(dir);
  try {
    assert.equal(snapshot.via, "folder");
    assert.equal(snapshot.commit, null);
    assert.deepEqual(snapshot.secretFiles, ["modules/db/examples/x/terraform.tfvars"]);
    assert.ok(isRedactedLine(fs.readFileSync(path.join(snapshot.dir, "modules/db/main.tf"), "utf8").split("\n")[2]));
    assert.ok(fs.existsSync(path.join(snapshot.dir, ".github/workflows/app-build.yml")));
  } finally {
    snapshot.remove();
  }
});

test("odd headers: a pax size is honoured, and an old GNU header's times are not a folder name", () => {
  const files = untar(githubTarball({}, {
    raw: [
      { name: "acme-library-0123456/sized.tf", body: "sized by pax", paxSize: true },
      { name: "acme-library-0123456/after.tf", body: "still in step" },
      // An old GNU header: the bytes ustar keeps a prefix in hold times there.
      { name: "acme-library-0123456/gnu.tf", body: "gnu", magic: "ustar  \0", prefix: "14712345670" }
    ]
  }), { maxBytes: 1024 * 1024, maxFiles: 10 });
  assert.deepEqual(files.map(f => [f.path, f.text()]), [["sized.tf", "sized by pax"], ["after.tf", "still in step"], ["gnu.tf", "gnu"]]);
});

test("a path that runs into a file is skipped, never moved somewhere else", async () => {
  const gh = standInGitHub({ tarball: githubTarball({ "x": "a file", "x/y.tf": "under a file", "keep.tf": "kept" }, { commit: COMMIT }) });
  const snapshot = await readLibrary(target, { credential: { kind: "token", token: TOKEN }, fetch: gh.fetch });
  try {
    assert.equal(fs.readFileSync(path.join(snapshot.dir, "x"), "utf8"), "a file");
    assert.ok(!fs.existsSync(path.join(snapshot.dir, "y.tf")), "not moved to the top");
    assert.ok(fs.existsSync(path.join(snapshot.dir, "keep.tf")));
  } finally {
    snapshot.remove();
  }
});

test("archives and files that are not text stay names only; gitleaks' ignore file is left out", async () => {
  const gh = standInGitHub({ tarball: githubTarball({
    "modules/db/README.md": "text\n",
    "modules/db/fixtures/old.zip": "PK\u0003\u0004 anything at all",
    "modules/db/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]),
    ".gitleaksignore": "modules/db/main.tf:assigned-secret:3\n"
  }, { commit: COMMIT }) });
  const snapshot = await readLibrary(target, { credential: { kind: "token", token: TOKEN }, fetch: gh.fetch });
  try {
    const size = rel => fs.statSync(path.join(snapshot.dir, rel)).size;
    assert.deepEqual(snapshot.unreadFiles.sort(), ["modules/db/fixtures/old.zip", "modules/db/logo.png"]);
    assert.equal(size("modules/db/fixtures/old.zip"), 0);
    assert.equal(size("modules/db/logo.png"), 0);
    assert.ok(size("modules/db/README.md") > 0);
    assert.ok(!fs.existsSync(path.join(snapshot.dir, ".gitleaksignore")));
  } finally {
    snapshot.remove();
  }
});

test("an app's token is revoked once the archive is read; a personal token is left alone", async () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const gh = standInGitHub();
  (await readLibrary(target, { credential: { kind: "app", appId: "123456", key: privateKey }, fetch: gh.fetch })).remove();
  const last = gh.calls.at(-1);
  assert.equal(`${last.method} ${last.path}`, "DELETE /installation/token");
  assert.equal(last.headers.authorization, "Bearer ghs_InstallationStandIn");

  const plain = standInGitHub();
  (await readLibrary(target, { credential: { kind: "token", token: TOKEN }, fetch: plain.fetch })).remove();
  assert.ok(!plain.calls.some(c => c.method === "DELETE"));
});

test("a branch with a slash keeps it; an answer that is not JSON is refused without quoting it", async () => {
  const gh = standInGitHub();
  (await readLibrary({ ...target, ref: "release/2026-q4" }, { credential: { kind: "token", token: TOKEN }, fetch: gh.fetch })).remove();
  assert.equal(gh.calls[0].path, "/repos/acme/library/commits/release/2026-q4");

  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const garbled = async (url, init) => String(url).endsWith("/access_tokens")
    ? new Response('{"token":"ghs_LeakedIfQuoted', { status: 201 })
    : standInGitHub().fetch(url, init);
  await assert.rejects(readLibrary(target, { credential: { kind: "app", appId: "123456", key: privateKey }, fetch: garbled }), err => {
    assert.match(err.message, /GitHub's answer was not what it expected/);
    assert.ok(!err.message.includes("ghs_"));
    return true;
  });
});

test("the archive is downloaded only from GitHub's download host", async () => {
  const other = async (url, init) => String(url).includes("/tarball/")
    ? new Response(null, { status: 302, headers: { location: "https://gist.githubusercontent.com/x.tgz" } })
    : standInGitHub().fetch(url, init);
  await assert.rejects(readLibrary(target, { credential: { kind: "token", token: TOKEN }, fetch: other }), /download link is not GitHub's/);
});
