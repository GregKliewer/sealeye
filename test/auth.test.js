// Who is calling (PHASE1-PLAN Step 13): every request but the health check needs a
// token issued to a person; the person, not the command line, is who the record says
// asked; an interview is its starter's; a team sees only its own records, an
// organization-wide token every team's, and no organization another's; and
// `sealeye login` keeps the token for the developer. A laptop API with tokens in a
// file, no AWS, no model calls.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import YAML from "yaml";

const root = path.resolve(import.meta.dirname, "..");
let home, api, server, log = "";
const env = () => ({ ...process.env, HOME: home, SEALEYE_HOME: home, DATABASE_URL: "", SEALEYE_AUTH: "" });

function issue(email, name, ...flags) {
  const out = execFileSync(process.execPath, ["scripts/tokens.js", "add", email, name, ...flags], { cwd: root, env: env(), encoding: "utf8" });
  return out.match(/sl_[A-Za-z0-9_-]{43}/)[0];
}
const call = (route, { token, method = "GET", body, headers = {} } = {}) =>
  fetch(`${api}${route}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {})
  }).catch(err => {
    // A request that never got an answer says why, and whether the API was still
    // running, so a failure on CI explains itself without its logs.
    const state = server.exitCode !== null || server.signalCode ? `exited (${server.exitCode ?? server.signalCode})` : "still running";
    throw new Error(`${method} ${route}: ${err.message} (${err.cause?.code || err.cause?.message || "no cause"}); the API is ${state}. Its last output:\n${log.slice(-1500)}`);
  });

let greg, ana, outsider, boss;

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-auth-"));
  greg = issue("greg@example.com", "Greg K");
  ana = issue("ana@example.com", "Ana P", "--team", "payments");
  outsider = issue("x@other.example", "Other Org", "--org", "other-org");
  boss = issue("boss@example.com", "Boss Person", "--org-wide");
  const port = 4900 + Math.floor(Math.random() * 90);
  api = `http://localhost:${port}`;
  const e = { ...env(), PORT: String(port), SEALEYE_TRACING: "off", ANTHROPIC_API_KEY: "sk-ant-test", SEALEYE_MODEL_URL: "http://127.0.0.1:9" };
  delete e.SEALEYE_LWA_VERSION;
  delete e.SEALEYE_BUCKET;
  server = spawn(process.execPath, ["api/server.js"], { cwd: root, env: e, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", d => (log += d));
  server.stderr.on("data", d => (log += d));
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${api}/health`)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`API did not start:\n${log}`);
});

after(() => server?.kill());

test("an idle connection stays open longer than Node's default five seconds", async () => {
  // A client that reuses a connection the API has just closed gets "socket closed" for
  // a request the API never saw: a 502 through Caddy, or a flaky test on a slow runner.
  const http = await import("node:http");
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const get = () => new Promise((resolve, reject) => {
    http.get(`${api}/health`, { agent }, res => {
      const port = res.socket.localPort;
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, port }));
    }).on("error", reject);
  });
  const first = await get();
  await new Promise(r => setTimeout(r, 6000));
  const second = await get();
  agent.destroy();
  assert.equal(second.status, 200);
  assert.equal(second.port, first.port, "the same connection, still open after six idle seconds");
});

test("the health check is open; everything else asks who is calling", async () => {
  assert.equal((await call("/health")).status, 200);
  assert.equal((await call("/health", { method: "HEAD" })).status, 200, "a load balancer may check with HEAD");
  for (const variant of ["/Sessions", "/sessions/", "/Health/"]) {
    assert.notEqual((await call(variant, { method: variant.includes("ealth") ? "POST" : "GET" })).status, 200, variant);
  }
  for (const [route, method] of [["/deployments", "GET"], ["/needs", "GET"], ["/whoami", "GET"], ["/plans/validate", "POST"], ["/interviews", "POST"], ["/deployments/dep_000000000000", "DELETE"]]) {
    const res = await call(route, { method });
    assert.equal(res.status, 401, `${method} ${route}`);
    assert.match(res.headers.get("www-authenticate"), /^Bearer/);
    assert.equal((await res.json()).error.code, "NOT_SIGNED_IN");
  }
  const forged = await call("/deployments", { token: `sl_${"A".repeat(43)}` });
  assert.equal((await forged.json()).error.code, "TOKEN_REFUSED");
});

test("a request without a token is refused before its body is read", async () => {
  const res = await call("/deployments", { method: "POST", body: "{ not json at all" });
  assert.equal(res.status, 401, "not a 400 for the body: nobody uploads anything without a token");
});

test("a token says who is calling, and is only ever kept as a hash", async () => {
  const me = await (await call("/whoami", { token: ana })).json();
  assert.deepEqual({ email: me.email, name: me.name, org: me.org, team: me.team }, { email: "ana@example.com", name: "Ana P", org: "default", team: "payments" });
  const stored = fs.readFileSync(path.join(home, "tokens.json"), "utf8");
  for (const t of [greg, ana, outsider]) assert.ok(!stored.includes(t), "no token in the file");
  assert.equal(fs.statSync(path.join(home, "tokens.json")).mode & 0o777, 0o600);
});

test("the person on a deployment is the token's, whatever the command line says", async () => {
  const { createDeployment } = await import("../cli/client.js");
  const app = path.join(home, "my-api");
  fs.cpSync(path.join(root, "apps", "beneficiary-lookup-api"), app, { recursive: true });
  const plan = YAML.parse(fs.readFileSync(path.join(root, "plans", "api-plan.yaml"), "utf8"));
  process.env.SEALEYE_TOKEN = greg;
  try {
    const created = await createDeployment({ apiBaseUrl: api, backend: "cloudformation", plan, appPath: app, requestedBy: { user: "someone-else", host: "gregs-mac" } });
    const record = await (await call(`/deployments/${created.deploymentId}`, { token: greg })).json();
    assert.deepEqual(record.requestedBy, { user: "greg@example.com", name: "Greg K", host: "gregs-mac", verified: "token" });
    assert.equal(record.orgId, "default");
    assert.equal(record.teamId, "default");

    // Another organization sees none of it.
    assert.equal((await call(`/deployments/${created.deploymentId}`, { token: outsider })).status, 404);
    assert.deepEqual((await (await call("/deployments", { token: outsider })).json()).deployments, []);
    assert.equal((await call(`/deployments/${created.deploymentId}`, { method: "DELETE", token: outsider })).status, 404);
    // Another team in the same organization does not either; an organization-wide token does.
    assert.equal((await call(`/deployments/${created.deploymentId}`, { token: ana })).status, 404);
    assert.equal((await call(`/deployments/${created.deploymentId}`, { token: boss })).status, 200);
  } finally {
    delete process.env.SEALEYE_TOKEN;
  }
});

test("a team sees its own environments; an organization-wide token sees every team's", async () => {
  const { createDeployment } = await import("../cli/client.js");
  const plan = YAML.parse(fs.readFileSync(path.join(root, "plans", "static-plan.yaml"), "utf8"));
  const deploy = async (token, app) => {
    const folder = path.join(home, app);
    fs.cpSync(path.join(root, "apps", "static-website"), folder, { recursive: true });
    process.env.SEALEYE_TOKEN = token;
    try {
      return (await createDeployment({ apiBaseUrl: api, backend: "cloudformation", plan: { ...plan, app: { ...plan.app, name: app } }, appPath: folder })).deploymentId;
    } finally {
      delete process.env.SEALEYE_TOKEN;
    }
  };
  const ours = await deploy(greg, "team-default-site");
  const theirs = await deploy(ana, "team-payments-site");
  const ids = async token => (await (await call("/deployments", { token })).json()).deployments.map(d => d.deploymentId);

  assert.ok((await ids(greg)).includes(ours));
  assert.ok(!(await ids(greg)).includes(theirs), "the list leaves out another team's");
  assert.ok((await ids(ana)).includes(theirs));
  assert.ok(!(await ids(ana)).includes(ours));
  assert.ok((await ids(boss)).includes(ours) && (await ids(boss)).includes(theirs), "organization-wide sees both");
  assert.ok(!(await ids(outsider)).includes(theirs), "never another organization's");

  // Status, evidence and tear down answer as if the record were not there.
  for (const [route, method] of [[`/deployments/${theirs}`, "GET"], [`/deployments/${theirs}/evidence`, "GET"], [`/deployments/${theirs}`, "DELETE"]]) {
    const res = await call(route, { method, token: greg });
    assert.equal(res.status, 404, `${method} ${route}`);
    assert.equal((await res.json()).error.code, "NOT_FOUND");
  }
  const after = await (await call(`/deployments/${theirs}`, { token: ana })).json();
  assert.equal(after.destroyRequestedBy, undefined, "the refused tear down changed nothing");

  // whoami says what each token sees.
  assert.equal((await (await call("/whoami", { token: ana })).json()).scope, "team");
  assert.equal((await (await call("/whoami", { token: boss })).json()).scope, "org");
  const listed = execFileSync(process.execPath, ["scripts/tokens.js", "list"], { cwd: root, env: env(), encoding: "utf8" });
  assert.match(listed, /Boss Person \(boss@example.com\)  team default \(sees every team\)/);
  assert.match(listed, /Ana P \(ana@example.com\)  team payments  issued/);
});

test("two teams can each have an app of the same name, as two environments", async () => {
  const { createDeployment } = await import("../cli/client.js");
  const plan = YAML.parse(fs.readFileSync(path.join(root, "plans", "static-plan.yaml"), "utf8"));
  const deploy = async token => {
    const folder = fs.mkdtempSync(path.join(home, "test-app-"));
    fs.cpSync(path.join(root, "apps", "static-website"), folder, { recursive: true });
    process.env.SEALEYE_TOKEN = token;
    try {
      const { deploymentId } = await createDeployment({ apiBaseUrl: api, backend: "cloudformation", plan: { ...plan, app: { ...plan.app, name: "test-app" } }, appPath: folder });
      // The name is decided before anything reaches AWS; wait for it on the record.
      for (let i = 0; i < 50; i++) {
        const record = await (await call(`/deployments/${deploymentId}`, { token })).json();
        if (record.stackName) return record;
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error(`no stack name on ${deploymentId}:\n${log}`);
    } finally {
      delete process.env.SEALEYE_TOKEN;
    }
  };
  const gregs = await deploy(greg);
  const anas = await deploy(ana);
  assert.match(gregs.stackName, /^sealeye-default-test-app-[0-9a-f]{6}$/);
  assert.match(anas.stackName, /^sealeye-payments-test-app-[0-9a-f]{6}$/);
  assert.equal(gregs.parameters.AppName, gregs.stackName, "the bucket and everything else are named after it too");
  assert.equal(gregs.app.name, "test-app", "the developer's app keeps its own name");

  // The same team deploying the same app again is the same environment.
  assert.equal((await deploy(greg)).stackName, gregs.stackName);
});

test("the needs ledger is the organization's; another team's evidence is left out of it", async () => {
  const plan = YAML.parse(fs.readFileSync(path.join(root, "plans", "api-plan.yaml"), "utf8"));
  // A plan with a need is drafted and saved, and creates nothing.
  const drafted = {
    ...plan,
    app: { ...plan.app, name: "payments-needs-queue" },
    status: "drafted",
    needs: [{ kind: "work_queue", line: "a queue between it and the work it hands off", evidence: [{ file: "index.js", shows: "hands work to a queue" }] }]
  };
  const res = await call("/deployments", { method: "POST", token: ana, body: { backend: "cloudformation", plan: drafted, appPath: root } });
  assert.equal(res.status, 422, await res.clone().text());
  const ledger = async token => {
    const { generatedAt, ...rest } = await (await call("/needs", { token })).json();
    return rest;
  };
  const forAna = await ledger(ana);
  assert.ok(forAna.apps >= 1);
  const apps = (l, name) => l.needs.flatMap(n => n.apps).filter(a => a.name === name);
  const [own] = apps(forAna, "payments-needs-queue");
  assert.equal(own.team, "payments");
  assert.match(own.deploymentId, /^dep_/);
  assert.equal(own.evidence[0].shows, "hands work to a queue", "a team sees its own app's evidence");

  // Another team sees the same apps and needs, without the evidence or the id.
  const forGreg = await ledger(greg);
  assert.equal(forGreg.apps, forAna.apps);
  assert.deepEqual(forGreg.needs.map(n => [n.kind, n.count]), forAna.needs.map(n => [n.kind, n.count]));
  const [seen] = apps(forGreg, "payments-needs-queue");
  assert.deepEqual([seen.team, seen.deploymentId, seen.evidence], ["payments", null, []]);
  assert.ok(!JSON.stringify(forGreg).includes("hands work to a queue"), "another team's code is not in it");

  // An organization-wide token sees all of it.
  assert.deepEqual(await ledger(boss), forAna);
  assert.equal((await ledger(outsider)).apps, 0, "another organization's ledger is its own");
});

test("evidence shows only the record's own team's history, even for the same app name", async () => {
  const plan = YAML.parse(fs.readFileSync(path.join(root, "plans", "api-plan.yaml"), "utf8"));
  const drafted = {
    ...plan,
    app: { ...plan.app, name: "shared-name-app" },
    status: "drafted",
    needs: [{ kind: "work_queue", line: "a queue between it and the work it hands off", evidence: [{ file: "index.js", shows: "hands work to a queue" }] }]
  };
  const draft = async token => (await (await call("/deployments", { method: "POST", token, body: { backend: "cloudformation", plan: drafted, appPath: root } })).json()).error.details.deploymentId;
  const gregs = await draft(greg);
  const anas = await draft(ana);
  const res = await call(`/deployments/${anas}/evidence`, { token: ana });
  assert.equal(res.status, 200, await res.clone().text());
  const { evidence, markdown } = await res.json();
  const ids = evidence.history.map(h => h.deploymentId);
  assert.ok(ids.includes(anas));
  assert.ok(!ids.includes(gregs), "another team's draft of the same name is not in the history");
  assert.ok(!markdown.includes("greg@example.com"), "nor is its person");
});

test("a token issued before scopes existed sees its own team", async () => {
  const before = issue("before@example.com", "Before Scopes", "--team", "payments");
  const file = path.join(home, "tokens.json");
  const rows = JSON.parse(fs.readFileSync(file, "utf8")).map(r => {
    if (r.email !== "before@example.com") return r;
    const { scope, ...rest } = r;
    return rest;
  });
  fs.writeFileSync(file, JSON.stringify(rows), { mode: 0o600 });
  const me = await (await call("/whoami", { token: before })).json();
  assert.deepEqual([me.team, me.scope], ["payments", "team"]);
  assert.throws(() => execFileSync(process.execPath, ["scripts/tokens.js", "add-hash", Buffer.from(JSON.stringify({ tokenHash: "a".repeat(64), email: "y@example.com", name: "Y", scope: "admin" })).toString("base64")], { cwd: root, env: env(), stdio: "pipe" }), /scope is team or org/);
});

test("an interview is its starter's: anyone else gets not found", async () => {
  const { zipSync } = await import("fflate");
  const zip = Buffer.from(zipSync({ "index.html": new TextEncoder().encode("<h1>hi</h1>") })).toString("base64");
  const started = await call("/interviews", { method: "POST", token: greg, body: { app: "site", zip, user: "claims-to-be-ana" } });
  assert.equal(started.status, 201);
  const { interviewId } = await started.json();

  assert.equal((await call(`/interviews/${interviewId}/events`, { token: ana })).status, 404);
  assert.equal((await call(`/interviews/${interviewId}/answers`, { method: "POST", token: ana, body: { answer: "x" } })).status, 404);
  assert.equal((await call(`/interviews/${interviewId}`, { method: "DELETE", token: ana })).status, 404);

  const own = await call(`/interviews/${interviewId}/events`, { token: greg });
  assert.equal(own.status, 200);
  await own.body.cancel();
  assert.equal((await call(`/interviews/${interviewId}`, { method: "DELETE", token: greg })).status, 200);
});

test("a revoked token stops working at once", async () => {
  const temp = issue("temp@example.com", "Temp Person");
  assert.equal((await call("/whoami", { token: temp })).status, 200);
  const out = execFileSync(process.execPath, ["scripts/tokens.js", "revoke", "temp@example.com"], { cwd: root, env: env(), encoding: "utf8" });
  assert.match(out, /Revoked 1 token/);
  const res = await call("/whoami", { token: temp });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, "TOKEN_REFUSED");
  const listed = execFileSync(process.execPath, ["scripts/tokens.js", "list"], { cwd: root, env: env(), encoding: "utf8" });
  assert.match(listed, /Temp Person \(temp@example.com\).*revoked/);
  assert.ok(!/sl_/.test(listed), "the list never shows a token");
});

test("an API with a database cannot be told to stop asking", () => {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", "import { authMode } from './api/tokens.js'; authMode();"],
    { cwd: root, env: { ...env(), SEALEYE_AUTH: "off", DATABASE_URL: "postgres://nobody@127.0.0.1:1/x" }, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /laptop API only/);
});

test("sealeye login checks the token, keeps it for you alone; logout removes it", async () => {
  const devHome = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-login-"));
  fs.mkdirSync(path.join(devHome, ".sealeye"));
  fs.writeFileSync(path.join(devHome, ".sealeye", "config"), "ORG=Example Org\n");
  const devEnv = { ...process.env, HOME: devHome, SEALEYE_HOME: path.join(devHome, ".sealeye"), NO_COLOR: "1" };
  delete devEnv.SEALEYE_TOKEN;
  const cli = (args, input) => spawnSync(process.execPath, ["cli/bin/sealeye", ...args, "--api", api], {
    cwd: root, input, encoding: "utf8", env: devEnv
  });
  const config = () => fs.readFileSync(path.join(devHome, ".sealeye", "config"), "utf8");

  const bad = cli(["login"], `sl_${"B".repeat(43)}\n`);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr + bad.stdout, /did not accept that token/);
  assert.ok(!config().includes("SEALEYE_TOKEN"), "nothing saved");

  const notAToken = cli(["login"], "hello\n");
  assert.match(notAToken.stderr + notAToken.stdout, /not a seaLeye token/);

  const good = cli(["login"], `${ana}\n`);
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /Signed in as Ana P \(ana@example.com\), team payments/);
  assert.ok(!good.stdout.includes(ana), "the token is never printed");
  assert.match(config(), /^ORG=Example Org\nSEALEYE_TOKEN=sl_/, "the rest of the file is kept");
  assert.equal(fs.statSync(path.join(devHome, ".sealeye", "config")).mode & 0o777, 0o600);

  const who = cli(["whoami"]);
  assert.match(who.stdout, /Ana P \(ana@example.com\), team payments/);

  const out = cli(["logout"]);
  assert.equal(out.status, 0);
  assert.equal(config(), "ORG=Example Org\n");
  assert.match(cli(["whoami"]).stdout, /Not signed in/);
  assert.match(cli(["list"]).stderr + cli(["list"]).stdout, /Run sealeye login/);
});

// ---------------------------------------------------------------------------------
// The portal's sign-in (PHASE1-PLAN Step 14): the token is traded for a session cookie.

const cookieFrom = res => /__Host-sealeye_session=([^;]*)/.exec(res.headers.get("set-cookie") || "")?.[1];
const signIn = token => call("/sessions", { method: "POST", body: { token }, headers: { "x-sealeye-portal": "1" } });

test("the portal trades a token for a 12-hour cookie no script can read", async () => {
  const unmarked = await call("/sessions", { method: "POST", body: { token: greg } });
  assert.equal(unmarked.status, 403, "signing in must come from the portal itself");
  const bad = await signIn(`sl_${"C".repeat(43)}`);
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get("set-cookie"), null);

  const res = await signIn(greg);
  assert.equal(res.status, 201);
  const set = res.headers.get("set-cookie");
  for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Max-Age=43200", "Path=/"]) assert.ok(set.includes(attr), `${attr} in ${set}`);
  const body = await res.json();
  assert.equal(body.email, "greg@example.com");
  assert.ok(!JSON.stringify(body).includes(greg), "the token is not sent back");

  const value = cookieFrom(res);
  const who = await (await call("/whoami", { headers: { cookie: `__Host-sealeye_session=${value}` } })).json();
  assert.equal(who.email, "greg@example.com");
  assert.equal(who.surface, "portal");
  assert.ok(!fs.readFileSync(path.join(home, "sessions.json"), "utf8").includes(value), "only the session's hash is kept");

  // A second cookie of the same name, planted by something else, is refused, not chosen.
  const shadowed = await call("/whoami", { headers: { cookie: `__Host-sealeye_session=planted; __Host-sealeye_session=${value}` } });
  assert.equal(shadowed.status, 401);
});

test("a change made with the cookie must come from the portal, and the record says so", async () => {
  const value = cookieFrom(await signIn(greg));
  const cookie = { cookie: `__Host-sealeye_session=${value}` };
  const list = await (await call("/deployments", { headers: cookie })).json();
  const dep = list.deployments[0];
  assert.ok(dep, "the portal reads the same list the command does");

  const forged = await call(`/deployments/${dep.deploymentId}`, { method: "DELETE", headers: cookie });
  assert.equal(forged.status, 403);
  assert.equal((await forged.json()).error.code, "NOT_FROM_THE_PORTAL");

  const torn = await call(`/deployments/${dep.deploymentId}`, { method: "DELETE", headers: { ...cookie, "x-sealeye-portal": "1" } });
  assert.equal(torn.status, 202);
  const record = await (await call(`/deployments/${dep.deploymentId}`, { headers: cookie })).json();
  assert.equal(record.destroyRequestedBy.surface, "portal");
  assert.equal(record.destroyRequestedBy.user, "greg@example.com");
});

test("signing out ends the session; so does revoking the token behind it", async () => {
  const value = cookieFrom(await signIn(greg));
  const cookie = { cookie: `__Host-sealeye_session=${value}` };
  assert.equal((await call("/whoami", { headers: cookie })).status, 200);
  const out = await call("/sessions", { method: "DELETE", headers: { ...cookie, "x-sealeye-portal": "1" } });
  assert.equal(out.status, 200);
  assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
  const after = await call("/whoami", { headers: cookie });
  assert.equal((await after.json()).error.code, "SESSION_ENDED");

  const temp = issue("temp2@example.com", "Temp Two");
  const v2 = cookieFrom(await signIn(temp));
  assert.equal((await call("/whoami", { headers: { cookie: `__Host-sealeye_session=${v2}` } })).status, 200);
  execFileSync(process.execPath, ["scripts/tokens.js", "revoke", "temp2@example.com"], { cwd: root, env: env() });
  assert.equal((await call("/whoami", { headers: { cookie: `__Host-sealeye_session=${v2}` } })).status, 401);
});

test("a session ends after twelve hours", async () => {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { addToken, hashToken, startSession, callerForSession } from "./api/tokens.js";
    const t = await addToken({ tokenHash: hashToken("sl_x"), email: "clock@example.com", name: "Clock" });
    const s = await startSession(t, Date.now());
    const now = await callerForSession(s.value, Date.now() + 11 * 3600_000);
    const later = await callerForSession(s.value, Date.now() + 13 * 3600_000);
    console.log(JSON.stringify([Boolean(now), Boolean(later)]));`],
    { cwd: root, env: { ...env(), SEALEYE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-clock-")) }, encoding: "utf8" });
  assert.deepEqual(JSON.parse(r.stdout.trim()), [true, false], r.stderr);
});

test("the catalog says what the platform builds and what apps can need", async () => {
  const catalog = await (await call("/catalog", { token: ana })).json();
  assert.deepEqual(catalog.modules.map(m => m.id), ["static_site_edge", "http_api_serverless", "observability_basic", "config_basic"]);
  assert.ok(catalog.needs.length >= 5);
  for (const n of catalog.needs) assert.ok(n.kind && n.line && !n.line.includes("—"));
});
