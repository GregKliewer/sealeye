// An app's settings in the organization's store (PHASE2-PLAN Step 8): put in through the
// API, kept in the team's own folder, listed by name and never by value, and every
// change recorded with who made it. The value must never appear on a command line, in
// a response, in the server's log, in a record or in the change log. A laptop API with
// tokens and a stand-in aws that keeps parameters in a file; no AWS.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const SECRET = "s3cr3t-value-that-must-never-show-9f2c";
let home, api, server, log = "";
const env = () => ({ ...process.env, HOME: home, SEALEYE_HOME: home, DATABASE_URL: "", SEALEYE_AUTH: "", PATH: `${path.join(home, "bin")}:${process.env.PATH}` });
const issue = (email, name, ...flags) =>
  execFileSync(process.execPath, ["scripts/tokens.js", "add", email, name, ...flags], { cwd: root, env: env(), encoding: "utf8" }).match(/sl_[A-Za-z0-9_-]{43}/)[0];
const call = (route, { token, method = "GET", body, raw } = {}) =>
  fetch(`${api}${route}`, {
    method,
    headers: { ...(body || raw ? { "content-type": "application/json" } : {}), authorization: `Bearer ${token}` },
    ...(raw ? { body: raw } : body ? { body: JSON.stringify(body) } : {})
  });

// The stand-in aws: ssm get-parameters-by-path, put-parameter and delete-parameter over
// a JSON file. Every command line it is given is appended to argv.log. A "fail" file
// makes a put fail the way AWS's validation does, quoting the value. Like the real CLI,
// put-parameter reads its input only from the file --cli-input-json names (the real one
// cannot read it from Node's standard input), and the stand-in records that file's mode.
const FAKE_AWS = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const dir = path.dirname(__dirname);
const store = path.join(dir, "ssm.json");
const read = () => { try { return JSON.parse(fs.readFileSync(store, "utf8")); } catch { return {}; } };
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "argv.log"), JSON.stringify(args) + "\\n");
const opt = n => args[args.indexOf(n) + 1];
const [svc, op] = args;
if (svc !== "ssm") { process.stderr.write("not in this stand-in"); process.exit(254); }
if (op === "get-parameters-by-path") {
  const p = opt("--path"), s = read();
  const rows = Object.keys(s).filter(k => k.startsWith(p) && !k.slice(p.length).includes("/")).map(k => ({ name: k, changedAt: s[k].at }));
  process.stdout.write(JSON.stringify(rows));
} else if (op === "put-parameter") {
  const named = opt("--cli-input-json");
  if (!String(named || "").startsWith("file:///") || String(named).startsWith("file:///dev/")) { process.stderr.write("Error parsing parameter '--cli-input-json': Unable to load paramfile " + named); process.exit(255); }
  const inputFile = named.slice("file://".length);
  fs.appendFileSync(path.join(dir, "inputs.log"), JSON.stringify({ file: inputFile, mode: (fs.statSync(inputFile).mode & 0o777).toString(8), dirMode: (fs.statSync(path.dirname(inputFile)).mode & 0o777).toString(8) }) + "\\n");
  const input = JSON.parse(fs.readFileSync(inputFile, "utf8"));
  if (process.env.AWS_FAIL || fs.existsSync(path.join(dir, "fail"))) {
    process.stderr.write("An error occurred (ValidationException) when calling the PutParameter operation: 1 validation error detected: Value '" + input.Value + "' at 'value' failed to satisfy constraint");
    process.exit(254);
  }
  const s = read(); s[input.Name] = { value: input.Value, type: input.Type, at: new Date().toISOString() };
  fs.writeFileSync(store, JSON.stringify(s));
  process.stdout.write(JSON.stringify({ Version: 1 }));
} else if (op === "delete-parameter") {
  const s = read(), n = opt("--name");
  if (!s[n]) { process.stderr.write("An error occurred (ParameterNotFound) when calling the DeleteParameter operation:"); process.exit(254); }
  delete s[n]; fs.writeFileSync(store, JSON.stringify(s));
} else { process.stderr.write("not in this stand-in"); process.exit(254); }
`;

let greg, ana, boss;

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-settings-"));
  fs.mkdirSync(path.join(home, "bin"));
  fs.writeFileSync(path.join(home, "bin", "aws"), FAKE_AWS, { mode: 0o755 });
  greg = issue("greg@example.com", "Greg K");
  ana = issue("ana@example.com", "Ana P", "--team", "payments");
  boss = issue("boss@example.com", "Boss Person", "--org-wide");
  // A record whose plan asks for two settings, so the list says which are wanted.
  fs.writeFileSync(path.join(home, "deployments.json"), JSON.stringify([{
    deploymentId: "dep_000000000001", app: { name: "lookup-api" }, orgId: "default", teamId: "payments", status: "succeeded",
    startedAt: "2026-10-11T12:00:00Z",
    plan: { modules: [{ id: "config_basic", enabled: true, inputs: { variables: { API_KEY: "", REGION_NAME: "ca-central" } } }] }
  }]));
  const port = 5300 + Math.floor(Math.random() * 90);
  api = `http://localhost:${port}`;
  server = spawn(process.execPath, ["api/server.js"], { cwd: root, env: { ...env(), PORT: String(port), SEALEYE_TRACING: "off" }, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", d => (log += d));
  server.stderr.on("data", d => (log += d));
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${api}/health`)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`API did not start:\n${log}`);
});

after(() => server?.kill());

const stored = () => { try { return JSON.parse(fs.readFileSync(path.join(home, "ssm.json"), "utf8")); } catch { return {}; } };

test("a setting is stored, encrypted, in its team's folder, and listed by name only", async () => {
  const put = await call("/apps/lookup-api/settings/API_KEY", { token: ana, method: "PUT", body: { value: SECRET } });
  assert.equal(put.status, 200, await put.clone().text());
  assert.deepEqual(await put.json(), { app: "lookup-api", team: "payments", name: "API_KEY", set: true });
  const kept = stored()["/sealeye-apps/payments/lookup-api/API_KEY"];
  assert.equal(kept.value, SECRET);
  assert.equal(kept.type, "SecureString");

  const listed = await (await call("/apps/lookup-api/settings", { token: ana })).json();
  assert.deepEqual(listed.settings.map(x => [x.name, x.wanted, x.set]), [["API_KEY", true, true], ["REGION_NAME", true, false]]);
  assert.deepEqual(listed.settings[0].changedBy, { name: "Ana P", email: "ana@example.com", surface: "cli", action: "set" });
  assert.ok(!JSON.stringify(listed).includes(SECRET));
});

test("the value is never on a command line, in a response, in the log, a record or the change log", async () => {
  await call("/apps/lookup-api/settings/REGION_NAME", { token: ana, method: "PUT", body: { value: SECRET } });
  const argv = fs.readFileSync(path.join(home, "argv.log"), "utf8");
  assert.ok(argv.includes("put-parameter"), "the stand-in was called");
  assert.ok(!argv.includes(SECRET), "never on a command line, where any process could read it");
  // In a file only the API can read, in a folder of its own, gone once the call ends.
  const inputs = fs.readFileSync(path.join(home, "inputs.log"), "utf8").trim().split("\n").map(l => JSON.parse(l));
  for (const i of inputs) {
    assert.deepEqual([i.mode, i.dirMode], ["600", "700"]);
    assert.equal(fs.existsSync(i.file), false, "removed after the call");
    assert.equal(fs.existsSync(path.dirname(i.file)), false);
  }
  for (const file of ["deployments.json", "setting-changes.json", "tokens.json"]) {
    const text = fs.existsSync(path.join(home, file)) ? fs.readFileSync(path.join(home, file), "utf8") : "";
    assert.ok(!text.includes(SECRET), file);
  }
  assert.ok(fs.readFileSync(path.join(home, "setting-changes.json"), "utf8").includes("REGION_NAME"), "the change itself is recorded");
  assert.ok(!log.includes(SECRET), "nor in the server's log");
});

test("when the store refuses a value, the answer names the error and never quotes the value", async () => {
  fs.writeFileSync(path.join(home, "fail"), "");
  try {
    const res = await call("/apps/lookup-api/settings/API_KEY", { token: ana, method: "PUT", body: { value: SECRET } });
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.match(text, /ValidationException/);
    assert.ok(!text.includes(SECRET));
    assert.ok(!log.includes(SECRET));
  } finally {
    fs.rmSync(path.join(home, "fail"));
  }
});

test("a body that is not JSON is refused without being quoted back or logged", async () => {
  const res = await call("/apps/lookup-api/settings/API_KEY", { token: ana, method: "PUT", raw: `{"value": ${SECRET}` });
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.match(text, /INVALID_JSON/);
  assert.ok(!text.includes(SECRET));
  await new Promise(r => setTimeout(r, 100));
  assert.ok(!log.includes(SECRET), "nor in the server's log");
});

test("names and values are checked before anything is stored", async () => {
  for (const [name, value, code] of [["PORT", "x", "INVALID_NAME"], ["1BAD", "x", "INVALID_NAME"], ["has-dash", "x", "INVALID_NAME"], ["OK_NAME", "", "INVALID_VALUE"], ["OK_NAME", "x".repeat(4097), "INVALID_VALUE"], ["OK_NAME", 42, "INVALID_VALUE"]]) {
    const res = await call(`/apps/lookup-api/settings/${name}`, { token: ana, method: "PUT", body: { value } });
    assert.equal(res.status, 400, `${name}`);
    assert.equal((await res.json()).error.code, code, `${name}`);
  }
  assert.ok(!stored()["/sealeye-apps/payments/lookup-api/OK_NAME"]);
});

test("a team reaches only its own folder; an organization-wide token may name a team", async () => {
  // Greg's team (default) has its own lookup-api folder, which is empty.
  const gregs = await (await call("/apps/lookup-api/settings", { token: greg })).json();
  assert.equal(gregs.team, "default");
  assert.deepEqual(gregs.settings, [], "another team's app of the same name is another folder");
  assert.equal((await call("/apps/lookup-api/settings?team=payments", { token: greg })).status, 404, "a team token cannot name another team");
  assert.equal((await call("/apps/lookup-api/settings/API_KEY?team=payments", { token: greg, method: "DELETE" })).status, 404);

  const theirs = await (await call("/apps/lookup-api/settings?team=payments", { token: boss })).json();
  assert.deepEqual(theirs.settings.filter(x => x.set).map(x => x.name), ["API_KEY", "REGION_NAME"]);
  assert.equal((await call("/apps/lookup-api/settings?team=Not_A_Team", { token: boss })).status, 404);
});

test("removing a setting takes it out of the store and records who did it", async () => {
  const res = await call("/apps/lookup-api/settings/REGION_NAME", { token: ana, method: "DELETE" });
  assert.equal(res.status, 200);
  assert.equal(stored()["/sealeye-apps/payments/lookup-api/REGION_NAME"], undefined);
  const listed = await (await call("/apps/lookup-api/settings", { token: ana })).json();
  const region = listed.settings.find(x => x.name === "REGION_NAME");
  assert.deepEqual([region.set, region.changedBy.action], [false, "removed"]);
  assert.equal((await call("/apps/lookup-api/settings/NEVER_SET", { token: ana, method: "DELETE" })).status, 200, "removing one that is not there is fine");
});

test("sealeye settings set reads the value from a pipe, never from the command line", () => {
  const devHome = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-settings-cli-"));
  const app = path.join(devHome, "lookup-api");
  fs.mkdirSync(app);
  const cli = (args, input) => spawnSync(process.execPath, [path.join(root, "cli/bin/sealeye"), ...args, "--api", api], {
    cwd: app, input, encoding: "utf8", env: { ...env(), HOME: devHome, SEALEYE_HOME: path.join(devHome, ".sealeye"), SEALEYE_TOKEN: ana, NO_COLOR: "1" }
  });
  const set = cli(["settings", "set", "API_KEY"], `${SECRET}-two\n`);
  assert.equal(set.status, 0, set.stderr + set.stdout);
  assert.ok(!set.stdout.includes(SECRET), "never printed");
  assert.equal(stored()["/sealeye-apps/payments/lookup-api/API_KEY"].value, `${SECRET}-two`, "the pipe, without its trailing newline");

  const list = cli(["settings"]);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /API_KEY\s+set/);
  assert.match(list.stdout, /REGION_NAME\s+not set/);
  assert.ok(!list.stdout.includes(SECRET));

  const pem = `-----BEGIN KEY-----\n${SECRET}\n-----END KEY-----`;
  const whole = cli(["settings", "set", "API_KEY"], `${pem}\n`);
  assert.equal(whole.status, 0, whole.stderr);
  assert.equal(stored()["/sealeye-apps/payments/lookup-api/API_KEY"].value, pem, "a piped value arrives whole, less one trailing line break");

  const refused = cli(["settings", "set", "API_KEY", "a-value-on-the-command-line"]);
  assert.notEqual(refused.status, 0, "a value is never taken as an argument");

  const unset = cli(["settings", "unset", "API_KEY"]);
  assert.equal(unset.status, 0, unset.stderr);
  assert.equal(stored()["/sealeye-apps/payments/lookup-api/API_KEY"], undefined);
});

test("a deploy does not send .env values that are already in the store", async () => {
  const http = await import("node:http");
  const { createDeployment } = await import("../cli/client.js");
  let received;
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", () => { received = JSON.parse(body); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ deploymentId: "dep_000000000abc" })); });
  });
  await new Promise(r => stub.listen(0, "127.0.0.1", r));
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-omit-"));
  fs.writeFileSync(path.join(app, "index.js"), "");
  fs.writeFileSync(path.join(app, ".env"), `API_KEY=${SECRET}\nREGION_NAME=ca-central\n`);
  const plan = { app: { name: "lookup-api" }, modules: [{ id: "config_basic", enabled: true, inputs: { variables: { API_KEY: "", REGION_NAME: "" } } }] };
  try {
    await createDeployment({ apiBaseUrl: `http://127.0.0.1:${stub.address().port}`, backend: "cloudformation", plan, appPath: app, storedNames: ["API_KEY"] });
  } finally {
    stub.close();
  }
  assert.deepEqual(received.settings, { REGION_NAME: "ca-central" });
  assert.ok(!JSON.stringify(received).includes(SECRET), "the stored one never leaves the laptop");
});

test("sealeye run offers once to store .env values, names them, and remembers a no", async () => {
  const { settingsFromTheStore } = await import("../cli/store-offer.js");
  const devHome = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-offer-"));
  const app = path.join(devHome, "offer-api");
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, ".env"), `OFFER_KEY=${SECRET}\nOFFER_REGION=ca\n`);
  const plan = { app: { name: "offer-api" }, modules: [{ id: "config_basic", enabled: true, inputs: { variables: { OFFER_KEY: "", OFFER_REGION: "" } } }] };
  const saved = { home: process.env.SEALEYE_HOME, token: process.env.SEALEYE_TOKEN };
  process.env.SEALEYE_HOME = path.join(devHome, ".sealeye");
  process.env.SEALEYE_TOKEN = ana;
  const run = async reply => {
    const lines = [], asked = [];
    const names = await settingsFromTheStore({ apiBaseUrl: api, plan, appPath: app, app: "offer-api", interactive: true,
      prompt: async q => { asked.push(q); return reply; }, say: l => lines.push(l), done: l => lines.push(l) });
    return { names, lines: lines.join("\n"), asked };
  };
  try {
    const no = await run("n");
    assert.equal(no.asked.length, 1);
    assert.deepEqual(no.names, []);
    assert.match(no.lines, /Your .env has values for OFFER_KEY, OFFER_REGION/);
    assert.ok(!no.lines.includes(SECRET));
    assert.equal((await run("y")).asked.length, 0, "a no is not asked again");

    fs.rmSync(path.join(devHome, ".sealeye", "store-offers.json"));
    const yes = await run("y");
    assert.deepEqual(yes.names.sort(), ["OFFER_KEY", "OFFER_REGION"]);
    assert.equal(stored()["/sealeye-apps/payments/offer-api/OFFER_KEY"].value, SECRET);
    assert.match(yes.lines, /reads OFFER_KEY, OFFER_REGION from your organization's store, not from your .env/);

    const after = await run("y");
    assert.equal(after.asked.length, 0, "nothing left to offer");
    assert.match(after.lines, /not from your .env/, "and it says where they come from, every run");
    assert.ok(!(yes.lines + after.lines).includes(SECRET));
  } finally {
    process.env.SEALEYE_HOME = saved.home ?? "";
    if (saved.token) process.env.SEALEYE_TOKEN = saved.token; else delete process.env.SEALEYE_TOKEN;
  }
});

test("settings-sources lists the live environments still on .env values, by name only", async () => {
  const { stillOnEnv } = await import("../scripts/settings-sources.js");
  const rec = (id, stack, status, startedAt, settings) => ({ deploymentId: id, stackName: stack, app: { name: stack }, teamId: "payments", status, startedAt, settings, requestedBy: { name: "Ana P" } });
  const rows = stillOnEnv([
    rec("d1", "on-env", "succeeded", "2026-10-12T10:00:00Z", [{ name: "API_KEY", source: "sent" }, { name: "REGION", source: "plan" }]),
    rec("d2", "moved", "succeeded", "2026-10-12T11:00:00Z", [{ name: "API_KEY", source: "store" }]),
    rec("d3", "moved", "succeeded", "2026-10-12T09:00:00Z", [{ name: "API_KEY", source: "sent" }]),
    rec("d4", "gone", "destroyed", "2026-10-12T10:00:00Z", [{ name: "API_KEY", source: ".env" }])
  ]);
  assert.deepEqual(rows.map(r => [r.app, r.names]), [["on-env", ["API_KEY"]]], "only the newest record of each live environment counts");
});

test("a deploy stops, building nothing, when settings the command found in the store are not there", async () => {
  const YAML = (await import("yaml")).default;
  const { createDeployment } = await import("../cli/client.js");
  const plan = YAML.parse(fs.readFileSync(path.join(root, "plans", "api-plan.yaml"), "utf8"));
  plan.app = { ...plan.app, name: "guard-api" };
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-guard-"));
  fs.cpSync(path.join(root, "apps", "beneficiary-lookup-api"), app, { recursive: true });
  process.env.SEALEYE_TOKEN = ana;
  let deploymentId;
  try {
    ({ deploymentId } = await createDeployment({ apiBaseUrl: api, backend: "cloudformation", plan, appPath: app, storedNames: ["GONE_KEY"] }));
  } finally {
    delete process.env.SEALEYE_TOKEN;
  }
  let record;
  for (let i = 0; i < 50; i++) {
    record = await (await call(`/deployments/${deploymentId}`, { token: ana })).json();
    if (record.status === "failed") break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(record.status, "failed");
  assert.match(record.failureReason, /found GONE_KEY in your organization's settings store .* nothing was built/);
  assert.equal(record.stackName, undefined, "it stopped before naming anything in AWS");
});
