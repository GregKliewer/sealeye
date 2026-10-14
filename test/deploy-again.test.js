// Deploying again (PHASE2-PLAN Step 14): POST /deployments with fromDeployment deploys
// the code an earlier deployment packaged, with its plan or the one given, every setting
// from the store. The API runs on a spare port with tokens and sample records, and a
// stand-in `aws` that logs every call. No AWS, no model.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { freePort } from "./helpers/free-port.js";

const root = path.resolve(import.meta.dirname, "..");
const TEAM = `sl_${"a".repeat(43)}`;
const WIDE = `sl_${"w".repeat(43)}`;
const OTHER_TEAM = `sl_${"p".repeat(43)}`;
const hash = t => createHash("sha256").update(t).digest("hex");

let server, api, home, log;

const plan = (entry = "index.js", variables = { GREETING: "hello" }) => ({
  planVersion: "0.4",
  app: { name: "lookup-api", type: "api" },
  profile: "dev",
  modules: [
    { id: "http_api_serverless", inputs: { runtime: "nodejs", entry_point: entry, trigger: "http" } },
    { id: "observability_basic", inputs: { target: "auto", retention_days: 30 } },
    ...(variables ? [{ id: "config_basic", inputs: { variables } }] : [])
  ],
  outputs: ["public_url", "logs"]
});

const base = { backend: "cloudformation", orgId: "default", teamId: "default", surface: "cli", outputs: {} };
const at = m => new Date(Date.now() - m * 60_000).toISOString();

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-again-"));
  log = path.join(home, "aws.log");
  const port = await freePort();
  api = `http://localhost:${port}`;

  const tok = (t, id, team, scope) => ({ tokenId: id, tokenHash: hash(t), email: `${id}@example.com`, name: id, org: "default", team, ...(scope ? { scope } : {}), createdAt: at(0), revokedAt: null, lastUsedAt: null });
  fs.writeFileSync(path.join(home, "tokens.json"), JSON.stringify([tok(TEAM, "ana", "default"), tok(WIDE, "lee", "platform", "org"), tok(OTHER_TEAM, "pat", "payments")]));

  const stack = "sealeye-default-lookup-api-abc123";
  fs.writeFileSync(path.join(home, "deployments.json"), JSON.stringify([
    { ...base, deploymentId: "dep_nopackage01", app: { name: "lookup-api" }, kind: "api", status: "failed", stackName: stack, plan: plan(), startedAt: at(5) },
    { ...base, deploymentId: "dep_source00001", app: { name: "lookup-api" }, kind: "api", status: "succeeded", stackName: stack, resourceName: stack,
      plan: plan(), settings: [{ name: "GREETING", source: "sent" }], artifactKey: `${stack}/dep_source00001.zip`, artifactSha256: "a".repeat(64), startedAt: at(60) },
    { ...base, deploymentId: "dep_gone0000001", app: { name: "old-api" }, kind: "api", status: "succeeded", stackName: "sealeye-default-old-api-def456",
      plan: { ...plan(), app: { name: "old-api", type: "api" }, modules: plan(undefined, null).modules }, artifactKey: "sealeye-default-old-api-def456/dep_gone0000001.zip", startedAt: at(90) },
    { ...base, deploymentId: "dep_static00001", app: { name: "site" }, kind: "static", status: "succeeded", stackName: "sealeye-default-site-0a0a0a", plan: plan(), startedAt: at(70) },
    { ...base, teamId: "payments", deploymentId: "dep_payments001", app: { name: "lookup-api" }, kind: "api", status: "succeeded", stackName: "sealeye-payments-lookup-api-999999",
      plan: plan(), artifactKey: "sealeye-payments-lookup-api-999999/dep_payments001.zip", startedAt: at(80) }
  ]));

  // The stand-in aws: logs every call; the store is a file of names; an artifact exists
  // when its key is listed in artifacts.txt; a deploy returns at once and the stack then
  // reads as updated.
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(home, "stored.txt"), "");
  fs.writeFileSync(path.join(home, "artifacts.txt"), "sealeye-default-lookup-api-abc123/dep_source00001.zip\n");
  fs.writeFileSync(path.join(bin, "aws"), `#!/bin/sh
echo "$*" >> "${log}"
case "$2" in
  get-parameters-by-path)
    printf '['; sep=''; while read -r n; do [ -n "$n" ] && printf '%s{"name":"/sealeye-apps/default/lookup-api/%s","changedAt":null}' "$sep" "$n" && sep=','; done < "${home}/stored.txt"; echo ']'; exit 0 ;;
  head-object)
    key=$(echo "$*" | sed 's/.*--key \\([^ ]*\\).*/\\1/')
    grep -qx "$key" "${home}/artifacts.txt" && { echo '{}'; exit 0; }
    echo 'An error occurred (404) when calling the HeadObject operation: Not Found' >&2; exit 254 ;;
  deploy) exit 0 ;;
  describe-stacks) echo '{"Stacks":[{"StackStatus":"UPDATE_COMPLETE","Outputs":[{"OutputKey":"ApiUrl","OutputValue":"https://example.lambda-url.ca-central-1.on.aws/"}]}]}' ;;
  *) echo '{}' ;;
esac
`, { mode: 0o755 });

  const env = {
    ...process.env, PORT: String(port), HOME: home, SEALEYE_HOME: home, PATH: `${bin}:${process.env.PATH}`,
    SEALEYE_TRACING: "off", SEALEYE_TEST_POLL_MS: "50", DATABASE_URL: "",
    SEALEYE_BUCKET: "artifacts-bucket", SEALEYE_LWA_VERSION: "25", SEALEYE_FUNCTION_BOUNDARY_ARN: "arn:aws:iam::123456789012:policy/boundary"
  };
  delete env.SEALEYE_AUTH;
  server = spawn(process.execPath, ["api/server.js"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  server.stdout.on("data", d => (out += d));
  server.stderr.on("data", d => (out += d));
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${api}/health`)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`API did not start:\n${out}`);
});

after(() => server?.kill());

const again = (token, body) => fetch(`${api}/deployments`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ backend: "cloudformation", ...body })
}).then(async r => ({ status: r.status, body: await r.json() }));

const records = async () => (await (await fetch(`${api}/deployments`, { headers: { authorization: `Bearer ${WIDE}` } })).json()).deployments;

async function settled(id) {
  for (let i = 0; i < 100; i++) {
    const r = await (await fetch(`${api}/deployments/${id}`, { headers: { authorization: `Bearer ${TEAM}` } })).json();
    if (r.status === "succeeded" || r.status === "failed") return r;
    await new Promise(res => setTimeout(res, 50));
  }
  throw new Error("never settled");
}

test("the list says which deployments' code can be deployed again", async () => {
  const all = await records();
  const by = id => all.find(d => d.deploymentId === id);
  assert.equal(by("dep_source00001").packaged, true);
  assert.equal(by("dep_nopackage01").packaged, false);
  assert.equal(by("dep_static00001").packaged, false);
});

test("what deploying again refuses, before any record is written", async () => {
  const count = (await records()).length;
  const cases = [
    [TEAM, { fromDeployment: "dep_doesnotexist" }, 404, "NOT_FOUND"],
    [OTHER_TEAM, { fromDeployment: "dep_source00001" }, 404, "NOT_FOUND"],
    [WIDE, { fromDeployment: "dep_source00001" }, 403, "NOT_YOUR_TEAM"],
    [TEAM, { fromDeployment: "dep_static00001" }, 409, "NOTHING_TO_DEPLOY_AGAIN"],
    [TEAM, { fromDeployment: "dep_nopackage01" }, 409, "NOTHING_TO_DEPLOY_AGAIN"],
    [TEAM, { fromDeployment: "dep_source00001", zip: "UEsDBA==" }, 400, "INVALID_FROM_DEPLOYMENT"],
    [TEAM, { fromDeployment: "dep_source00001", plan: { ...plan(), app: { name: "another-api", type: "api" } } }, 409, "DIFFERENT_APP"],
    [TEAM, { fromDeployment: "dep_source00001", plan: plan("server.js") }, 409, "DIFFERENT_ENTRY_POINT"],
    [TEAM, { fromDeployment: "dep_source00001", plan: { ...plan(), needs: [{ kind: "continuous_service", line: "x", evidence: [{ file: "w.js", shows: "a loop" }] }] } }, 422, "UNSUPPORTED_NEEDS"],
    // GREETING came from a developer's .env last time, and the store does not have it.
    [TEAM, { fromDeployment: "dep_source00001" }, 409, "SETTINGS_NOT_STORED"]
  ];
  for (const [token, body, status, code] of cases) {
    const r = await again(token, body);
    assert.equal(r.status, status, `${code}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, code);
  }
  const notStored = await again(TEAM, { fromDeployment: "dep_source00001" });
  assert.match(notStored.body.error.message, /^GREETING is not in your organization's settings store/);
  assert.equal((await records()).length, count, "nothing was recorded");
  assert.ok(!fs.readFileSync(log, "utf8").includes("cloudformation deploy"), "nothing was deployed");
});

test("with its settings in the store, the earlier code is deployed again, uploading nothing", async () => {
  fs.writeFileSync(path.join(home, "stored.txt"), "GREETING\n");
  fs.writeFileSync(log, "");
  const r = await again(TEAM, { fromDeployment: "dep_source00001" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.source, "again");
  assert.equal(r.body.fromDeployment, "dep_source00001");
  assert.deepEqual(r.body.origin, { command: "deploy --again", planSource: "again", fromDeployment: "dep_source00001", packagedBy: "dep_source00001", planGiven: false });
  assert.equal(r.body.requestedBy.user, "ana@example.com");

  const done = await settled(r.body.deploymentId);
  assert.equal(done.status, "succeeded", done.failureReason);
  assert.equal(done.artifactKey, "sealeye-default-lookup-api-abc123/dep_source00001.zip");
  assert.equal(done.artifactSha256, "a".repeat(64));
  assert.equal(done.stackName, "sealeye-default-lookup-api-abc123", "the same environment");
  assert.deepEqual(done.settings, [{ name: "GREETING", source: "store" }]);

  const calls = fs.readFileSync(log, "utf8");
  assert.ok(!/ s3 cp /.test(` ${calls}`), "nothing was uploaded");
  const deployLine = calls.split("\n").find(l => l.startsWith("cloudformation deploy"));
  assert.match(deployLine, /ArtifactKey=sealeye-default-lookup-api-abc123\/dep_source00001\.zip/);
  assert.match(deployLine, /SettingsFolder=\/sealeye-apps\/default\/lookup-api/);
  assert.doesNotMatch(deployLine, /ConfigValue/);
  // Its own id goes with it, so the same code and settings are still a change that
  // restarts the function, never an empty change set read as someone else's status.
  assert.match(deployLine, new RegExp(`DeploymentId=${r.body.deploymentId}`));
  assert.deepEqual(done.expectStored, ["GREETING"]);
  assert.equal(done.appPath, null);
  assert.match(done.report, /Deployed again: the code `dep_source00001` packaged/);

  const evidence = await (await fetch(`${api}/deployments/${r.body.deploymentId}/evidence`, { headers: { authorization: `Bearer ${TEAM}` } })).json();
  assert.match(evidence.markdown, /the artifact `dep_source00001` packaged, deployed again without a new upload/);
});

test("a plan given with the request is the one deployed, and the record says so", async () => {
  const given = plan("index.js", { GREETING: "hello", COLOUR: "teal" });
  // COLOUR is new and not stored: with no .env here, it would deploy as the plan's
  // placeholder without anyone choosing that, so it is refused until it is stored.
  const r = await again(TEAM, { fromDeployment: "dep_source00001", plan: given, origin: { file: "sealeye.yaml" } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "SETTINGS_NOT_STORED");
  assert.match(r.body.error.message, /^COLOUR is not/);

  fs.writeFileSync(path.join(home, "stored.txt"), "GREETING\nCOLOUR\n");
  const ok = await again(TEAM, { fromDeployment: "dep_source00001", plan: given, origin: { file: "sealeye.yaml" } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.origin.planGiven, true);
  assert.equal(ok.body.origin.file, "sealeye.yaml");
  assert.equal(ok.body.plan.modules.find(m => m.id === "config_basic").inputs.variables.COLOUR, "teal");
  await settled(ok.body.deploymentId);
});

test("code that is no longer kept fails before anything changes, and says so", async () => {
  fs.writeFileSync(log, "");
  const r = await again(TEAM, { fromDeployment: "dep_gone0000001" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const done = await settled(r.body.deploymentId);
  assert.equal(done.status, "failed");
  assert.match(done.failureReason, /^the code dep_gone0000001 packaged is no longer kept, so nothing was built/);
  assert.ok(!fs.readFileSync(log, "utf8").includes("cloudformation deploy"));
});

test("sealeye deploy --again finds the app's latest packaged code and says a refusal plainly", async () => {
  const run = args => promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), "deploy", ...args, "--api", api, "--json"], {
    cwd: home, env: { ...process.env, HOME: home, SEALEYE_HOME: home, SEALEYE_TOKEN: TEAM, NO_COLOR: "1" }
  });
  const { stdout } = await run(["--again", "lookup-api"]);
  const created = JSON.parse(stdout.slice(stdout.indexOf("{")));
  // The newest packaged record of the app: an earlier deploy-again, carrying the same code.
  assert.equal(created.source, "again");
  assert.equal(created.packagedBy, "dep_source00001", "however many times it has been deployed again");
  assert.equal(created.artifactKey, "sealeye-default-lookup-api-abc123/dep_source00001.zip");
  await settled(created.deploymentId);

  await assert.rejects(run(["--again", "site"]), err => {
    assert.match(err.stderr + err.stdout, /There is no packaged code for site on record|static site's files are not kept/);
    return true;
  });
});
