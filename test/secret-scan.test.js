// The secret scanner end to end (PHASE3-PLAN Step 2): the shared walk on the
// developer's side, gitleaks in the API, the interview that never reads a file with a
// finding, and the deploy that is refused. Every value is a fake, put together at run
// time (test/fixtures/fake-secrets.js); each test also checks the fake is nowhere it
// should not be.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { strToU8, unzipSync, zipSync } from "fflate";
import { MemorySaver } from "@langchain/langgraph";

import { collectFolder, SecretsFound, zipFolder } from "../core/upload.js";
import { createDeployment } from "../cli/client.js";
import { gitleaksFindings, gitleaksPath, scanApp, ScanFailed, useGitleaks } from "../api/secret-scan.js";
import { createInterviewService } from "../api/interview/service.js";
import { FAKE } from "./fixtures/fake-secrets.js";
import { freePort } from "./helpers/free-port.js";

const root = path.resolve(import.meta.dirname, "..");
const hasGitleaks = Boolean(gitleaksPath());

function folder(name, files) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-scan-")), name);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

const keyApp = extra => folder("orders-api", {
  "package.json": JSON.stringify({ name: "orders-api", main: "index.js" }),
  "index.js": "require('./config');\nrequire('http').createServer((q, s) => s.end('ok')).listen(process.env.PORT);\n",
  "config.js": `// settings\nmodule.exports = { stripe: "${FAKE.stripeKey}" };\n`,
  ".env": `GREETING=${FAKE.password}`,
  ...extra
});

const holds = (bytes, value) => Buffer.from(bytes).toString("latin1").includes(value);

// ---------------------------------------------------------------------------------
// On the developer's side: the walk both surfaces use.

test("an interview upload replaces each flagged line with one that says why, and keeps the rest", async () => {
  const dir = keyApp({ ".gitignore": "scratch/\n", "scratch/notes.txt": `token=${FAKE.githubToken}` });
  const { zip, findings, withheld } = await zipFolder(dir);
  const entries = unzipSync(zip);

  assert.deepEqual(findings, [{ file: "config.js", line: 2, rule: "stripe-key", kind: "a Stripe key" }]);
  assert.equal(Buffer.from(entries["config.js"]).toString("utf8"),
    "// settings\n[seaLeye: this line was not sent: it looks like it holds a Stripe key]\n", "line 2 says why; line 1 and the line count are kept");
  assert.ok(entries["index.js"].length > 0);
  assert.deepEqual(withheld, [".env"], "secret files are still names only, as before");
  assert.ok(!("scratch/notes.txt" in entries), "what .gitignore leaves out is neither sent nor scanned");
  assert.ok(!holds(zip, FAKE.stripeKey) && !holds(zip, FAKE.password));
});

test("a private key, which runs over many lines, sends its file as a name only", async () => {
  const body = ["MIIEowIBAAKCAQEA0", "b3BlbnNzaC1rZXktdjEAAAAA", "AAAAB3NzaC1yc2EAAAADAQAB"];
  const dir = keyApp({ "certs/dev-key.js": `module.exports = \`\n${FAKE.privateKeyHeader}\n${body.join("\n")}\n${FAKE.privateKeyFooter}\n\`;\n` });
  const { zip, findings } = await zipFolder(dir);
  const entries = unzipSync(zip);
  assert.equal(entries["certs/dev-key.js"].length, 0);
  assert.deepEqual(findings.filter(f => f.whole).map(f => f.file), ["certs/dev-key.js"]);
  assert.ok(body.every(b => !holds(zip, b)), "no line of the key's body travels");
});

test("a deploy with a finding is refused before anything is zipped, in words, with the line to allow", async () => {
  const dir = keyApp();
  await assert.rejects(zipFolder(dir, { purpose: "deploy" }), err => {
    assert.ok(err instanceof SecretsFound);
    assert.deepEqual(err.findings.map(f => `${f.file}:${f.line}:${f.rule}`), ["config.js:2:stripe-key"]);
    assert.match(err.message, /^Nothing was deployed: your code looks like it holds a secret\.\nconfig\.js, line 2, looks like it holds a Stripe key\./);
    assert.match(err.message, /\n  config\.js:2:stripe-key$/);
    assert.ok(!err.message.includes(FAKE.stripeKey));
    return true;
  });
});

test("a line in .sealeye-allow is let through, and said to be", async () => {
  const dir = keyApp({ ".sealeye-allow": "# a test key\nconfig.js:2:stripe-key\n" });
  const deploy = await collectFolder(dir, { purpose: "deploy" });
  assert.deepEqual(deploy.findings, []);
  assert.deepEqual(deploy.allowed.map(f => `${f.file}:${f.line}`), ["config.js:2"]);
  assert.ok(holds(deploy.entries["config.js"], FAKE.stripeKey), "allowed, so it travels as it is");

  const interview = await collectFolder(dir);
  assert.deepEqual(interview.findings, []);
  assert.ok(interview.entries["config.js"].length > 0, "and the interview may read it");
});

test("sealeye deploy refuses on the developer's machine, and never calls the platform", async () => {
  const dir = keyApp();
  const plan = { planVersion: "0.4", app: { name: "orders-api", type: "api" }, profile: "dev", modules: [], outputs: [] };
  // Nothing listens here: a request would fail as unreachable, not as a refusal.
  await assert.rejects(createDeployment({ apiBaseUrl: "http://127.0.0.1:9", backend: "cloudformation", plan, appPath: dir }), err => {
    assert.equal(err.userFacing, true);
    assert.match(err.message, /^Nothing was deployed/);
    return true;
  });
});

// ---------------------------------------------------------------------------------
// In the API: gitleaks, always on seaLeye's terms.

test("without gitleaks the API's scan is the shared rules, and says so", async () => {
  useGitleaks(null);
  try {
    const out = await scanApp(keyApp());
    assert.equal(out.gitleaks, "not installed");
    assert.deepEqual(out.found.map(f => f.rule), ["stripe-key"]);
  } finally {
    useGitleaks(undefined);
  }
});

test("gitleaks that cannot finish fails the scan, so nothing goes ahead without it", async () => {
  const bin = folder("bin", { gitleaks: "#!/bin/sh\necho 'something went wrong' >&2\nexit 2\n" });
  fs.chmodSync(path.join(bin, "gitleaks"), 0o755);
  await assert.rejects(scanApp(keyApp(), { binary: path.join(bin, "gitleaks") }), ScanFailed);
});

test("gitleaks finds what it knows, and nothing in the app can switch it off", { skip: !hasGitleaks && "gitleaks is not installed here" }, async () => {
  const dir = folder("app", {
    "src/keys.js": `const a = "${FAKE.cloudAccessKey}";\nconst b = "${FAKE.githubToken}"; // gitleaks:allow\n`,
    ".gitleaks.toml": "[allowlist]\npaths = ['''.*''']\n",
    "node_modules/pkg/index.js": `k = "${FAKE.githubToken}"`
  });
  // gitleaks reads a .gitleaksignore in the folder it scans whatever it is told, and
  // matches it by absolute path (found in review): name this folder's lines exactly.
  const real = fs.realpathSync(dir);
  fs.writeFileSync(path.join(dir, ".gitleaksignore"), [`${real}/src/keys.js:aws-access-token:1`, `${real}/src/keys.js:github-pat:2`].join("\n"));

  const direct = await gitleaksFindings(dir);
  assert.equal(direct.length, 0, "run on the folder itself, its own ignore file silences gitleaks: so it never is");

  useGitleaks(null);
  const sharedOnly = await scanApp(dir);
  useGitleaks(undefined);
  assert.equal(sharedOnly.gitleaks, "not installed");

  // A JWT is a shape only gitleaks knows, so only gitleaks can have found this line.
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkFsZXgifQ", "c2lnbmF0dXJlLWZvci10ZXN0cy1vbmx5LTEyMzQ1Ng"].join(".");
  fs.writeFileSync(path.join(dir, "src/session.js"), `const session = "${jwt}";\n`);
  fs.appendFileSync(path.join(dir, ".gitleaksignore"), `\n${real}/src/session.js:jwt:1\n`);
  const out = await scanApp(dir);
  assert.equal(out.gitleaks, "ran");
  assert.deepEqual(out.found.map(f => `${f.file}:${f.line}`), ["src/keys.js:1", "src/keys.js:2", "src/session.js:1"]);
  assert.ok(out.found.every(f => Object.keys(f).join() === "file,line,rule,kind"), "file, line, rule and kind, nothing else");
  assert.ok(!JSON.stringify(out).includes(FAKE.githubToken) && !JSON.stringify(out).includes(jwt));
});

test("nothing is cut short for size, and a link is read as packaging reads it", async () => {
  const dir = folder("big-app", {
    "index.js": "x",
    "dist/bundle.js": `${"/* filler */\n".repeat(900_000)}const t = "${FAKE.githubToken}";\n`,
    ".env": `STRIPE=${FAKE.stripeKey}`
  });
  assert.ok(fs.statSync(path.join(dir, "dist/bundle.js")).size > 11 * 1024 * 1024);
  // A link to a file packaging leaves out, so only the link can carry it in.
  fs.mkdirSync(path.join(dir, "node_modules", "cfg"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "cfg", "real.js"), `module.exports = "${FAKE.stripeKey}";\n`);
  fs.symlinkSync(path.join(dir, "node_modules", "cfg", "real.js"), path.join(dir, "config.js"));
  fs.symlinkSync(dir, path.join(dir, "loop"));   // a loop of links ends
  // rsync's --exclude node_modules matches exactly, so this is packaged, and scanned.
  fs.mkdirSync(path.join(dir, "Node_Modules"));
  fs.writeFileSync(path.join(dir, "Node_Modules", "x.js"), `t = "${FAKE.gitlabToken}"\n`);
  // Kept from gitleaks, still read by the shared rules.
  fs.writeFileSync(path.join(dir, ".gitleaksignore"), `# ${FAKE.npmToken}\n`);

  const out = await scanApp(dir);
  assert.deepEqual(out.found.map(f => `${f.file}:${f.rule}`), [".gitleaksignore:npm-token", "Node_Modules/x.js:gitlab-token", "config.js:stripe-key", "dist/bundle.js:github-token"],
    "the bundle past any limit, the link's target, and not .env, which is never packaged");

  const outside = folder("outside-link", { "index.js": "x" });
  fs.symlinkSync("/etc/hostname", path.join(outside, "host.txt"));
  await assert.rejects(scanApp(outside), /host\.txt is a link to something outside your app folder/);

  // What packaging never takes may point anywhere: a shared .env, a monorepo's modules.
  const mono = folder("mono", { "shared.env": `KEY=${FAKE.stripeKey}`, "node_modules/x/i.js": "x", "app/index.js": "x" });
  fs.symlinkSync(path.join(mono, "shared.env"), path.join(mono, "app", ".env"));
  fs.symlinkSync(path.join(mono, "node_modules"), path.join(mono, "app", "node_modules"));
  assert.deepEqual((await scanApp(path.join(mono, "app"))).found, []);

  const linked = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-link-"));
  fs.symlinkSync(dir, path.join(linked, "app"));
  assert.equal((await scanApp(path.join(linked, "app"))).found.length, 4, "an app folder that is itself a link is scanned through it");
});

test("a binary file is never handed to the model", async () => {
  const { runTool } = await import("../api/interview/tools.js");
  const dir = folder("bin-app", { "data.bin": Buffer.concat([Buffer.from([0x89, 0, 0x0a]), Buffer.from(`password = "${FAKE.password}"\n`)]) });
  const out = runTool(dir, "read_file", { path: "data.bin" });
  assert.equal(out.isError, true);
  assert.match(out.content, /data\.bin is a binary file, not text/);
});

// ---------------------------------------------------------------------------------
// The interview: a file with a finding is never read, whoever sent it.

function recordingModel(turns) {
  const seen = [];
  let i = 0;
  return { seen, messages: { create: async params => { seen.push(JSON.stringify(params)); return turns[Math.min(i++, turns.length - 1)]; } } };
}

test("an upload that still holds a key has that line replaced by the API, and the rest is read", async () => {
  const model = recordingModel([
    { content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "config.js" } }], stop_reason: "tool_use", usage: {} },
    { content: [{ type: "text", text: "This version cannot build that." }], stop_reason: "end_turn", usage: {} }
  ]);
  const scratchBase = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-svc-"));
  const service = createInterviewService({ client: model, scratchBase, checkpointer: new MemorySaver() });

  // As an older client, or a tampered one, would send it: the key in the file.
  const zip = zipSync({
    "index.js": strToU8("require('./config')"),
    "config.js": strToU8(`module.exports = {\n  key: "${FAKE.cloudAccessKey}",\n  region: "ca-central-1"\n};\n`),
    "notes.md": strToU8("# notes\n")
  });
  // And claims that cannot be true: a line that arrived as it was, and a path outside.
  const started = await service.startFromUpload({ zip, app: "orders-api", findings: [{ file: "notes.md", line: 1, rule: "stripe-key" }, { file: "../x", line: 1, rule: "r" }] });
  assert.deepEqual(started.findings.map(f => `${f.file}:${f.line}:${f.rule}`), ["config.js:2:cloud-access-key"]);

  await service.settled(started.interviewId);
  const all = model.seen.join("\n");
  assert.ok(!all.includes(FAKE.cloudAccessKey), "the model never saw the key");
  assert.match(all, /\[seaLeye: this line was not sent: it looks like it holds a cloud access key\]/);
  assert.match(all, /region: \\"ca-central-1\\"/, "and read the rest of the file");
  service.close();
});

test("what the client held back is believed only where it arrived held back", async () => {
  const model = recordingModel([
    { content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "./src/../package.json" } }], stop_reason: "tool_use", usage: {} },
    { content: [{ type: "text", text: "This version cannot build that." }], stop_reason: "end_turn", usage: {} }
  ]);
  const scratchBase = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-svc-"));
  const service = createInterviewService({ client: model, scratchBase, checkpointer: new MemorySaver() });
  const zip = zipSync({
    "package.json": new Uint8Array(0),
    "src/a.js": strToU8("one\n[seaLeye: this line was not sent: it looks like it holds a GitHub token]\nthree\n"),
    "src/b.js": strToU8("one\ntwo\n")
  });
  const started = await service.startFromUpload({ zip, app: "orders-api", findings: [
    { file: "package.json", line: 3, rule: "npm-token" },
    { file: "src/a.js", line: 2, rule: "github-token" },
    { file: "src/b.js", line: 2, rule: "github-token" }
  ] });
  assert.deepEqual(started.findings, [
    { file: "package.json", line: 3, rule: "npm-token", kind: "an npm token", whole: true },
    { file: "src/a.js", line: 2, rule: "github-token", kind: "a GitHub token", whole: false }
  ], "src/b.js line 2 arrived as it was, so the claim is dropped");
  await service.settled(started.interviewId);
  assert.match(model.seen[0], /package\.json: present, but not read: it looks like it holds a secret/);
  assert.match(model.seen[1], /package\.json looks like it holds a secret on line 3 \(an npm token\)/);
  service.close();
});

// ---------------------------------------------------------------------------------
// The deploy, through the API.

let server;
let api;

before(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-scan-api-"));
  const port = await freePort();
  api = `http://localhost:${port}`;
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  fs.writeFileSync(path.join(home, "bin", "aws"), "#!/bin/sh\n[ \"$2\" = get-parameters-by-path ] && { echo '[]'; exit 0; }\necho 'not in this stand-in' >&2; exit 254\n", { mode: 0o755 });
  const env = { ...process.env, PORT: String(port), SEALEYE_HOME: home, HOME: home, SEALEYE_AUTH: "off", PATH: `${path.join(home, "bin")}:${process.env.PATH}` };
  delete env.SEALEYE_LWA_VERSION;
  delete env.SEALEYE_BUCKET;
  server = spawn(process.execPath, ["api/server.js"], { cwd: root, env, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${api}/health`)).ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("API did not start");
});

after(() => server?.kill());

const readyPlan = name => ({
  planVersion: "0.4", app: { name, type: "api" }, profile: "dev",
  modules: [{ id: "http_api_serverless", inputs: { runtime: "nodejs", entry_point: "index.js", trigger: "http" } }],
  outputs: ["public_url"]
});
const post = async body => {
  const res = await fetch(`${api}/deployments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const zipOf = files => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))).toString("base64");

test("a deploy upload that holds a key is refused by the API, keeps nothing and records nothing", async () => {
  const before_ = (await (await fetch(`${api}/deployments`)).json()).deployments.length;
  const res = await post({
    backend: "cloudformation", plan: readyPlan("keyed-api"), appPath: "keyed-api",
    zip: zipOf({ "index.js": "x", "lib/aws.js": `const id = '${FAKE.cloudAccessKey}';\n` })
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, "SECRETS_FOUND");
  assert.match(res.body.error.message, /lib\/aws\.js, line 1, looks like it holds a cloud access key\./);
  assert.deepEqual(res.body.error.details.findings.map(f => `${f.file}:${f.line}:${f.rule}`), ["lib/aws.js:1:cloud-access-key"]);
  assert.ok(!JSON.stringify(res.body).includes(FAKE.cloudAccessKey));
  assert.equal((await (await fetch(`${api}/deployments`)).json()).deployments.length, before_, "no record");
});

test("an allowed line deploys, and the record and evidence say what was let through", async () => {
  const res = await post({
    backend: "cloudformation", plan: readyPlan("allowed-api"), appPath: "allowed-api",
    zip: zipOf({ "index.js": "x", "test/keys.js": `const id = '${FAKE.cloudAccessKey}';\n`, ".sealeye-allow": "test/keys.js:1:cloud-access-key\n" })
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual(res.body.secretScan.allowed, [{ file: "test/keys.js", line: 1, rule: "cloud-access-key" }]);
  assert.equal(res.body.secretScan.gitleaks, hasGitleaks ? "ran" : "not installed");

  const evidence = await (await fetch(`${api}/deployments/${res.body.deploymentId}/evidence`)).text();
  assert.match(evidence, /Let through on the developer's word, in `\.sealeye-allow`/);
  assert.match(evidence, /`test\/keys\.js:1:cloud-access-key`/);
  assert.ok(!evidence.includes(FAKE.cloudAccessKey));
});
