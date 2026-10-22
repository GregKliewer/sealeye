// sealeye logs and GET /deployments/{id}/logs (PHASE2-PLAN Step 16): an app's recent
// lines, newest first, with anything that looks like a secret, and the value of any
// setting the app has in the store, taken out before either surface sees it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { startApi, token } from "./helpers/api-with-aws.js";

const root = path.resolve(import.meta.dirname, "..");
const ANA = token("a");
const PAT = token("p");
let api;

const base = { backend: "cloudformation", orgId: "default", teamId: "default", surface: "cli", outputs: {}, startedAt: new Date().toISOString() };

before(async () => {
  api = await startApi({
    tokens: [{ token: ANA, id: "ana", team: "default" }, { token: PAT, id: "pat", team: "payments" }],
    records: [
      { ...base, deploymentId: "dep_api00000001", app: { name: "orders-api" }, kind: "api", status: "succeeded", stackName: "sealeye-default-orders-api-aaaaaa", resourceName: "sealeye-default-orders-api-aaaaaa" },
      { ...base, deploymentId: "dep_quiet000001", app: { name: "quiet-api" }, kind: "api", status: "succeeded", stackName: "sealeye-default-quiet-api-bbbbbb", resourceName: "sealeye-default-quiet-api-bbbbbb" },
      { ...base, deploymentId: "dep_site0000001", app: { name: "site" }, kind: "static", status: "succeeded", stackName: "sealeye-default-site-cccccc" },
      { ...base, deploymentId: "dep_draft000001", app: { name: "draft-api" }, status: "drafted" }
    ],
    aws: `
if (args[1] === "get-parameters-by-path") out([{ name: opt("--path") + "GREETING", changedAt: null }]);
if (args[1] === "filter-log-events") {
  if (opt("--log-group-name").includes("quiet")) fail("An error occurred (ResourceNotFoundException) when calling the FilterLogEvents operation: The specified log group does not exist.");
  const t = Number(process.env.LOGS_NOW || 0) || Date.now();
  const from = Number(opt("--start-time")), to = args.includes("--end-time") ? Number(opt("--end-time")) : Infinity;
  out([
    { timestamp: t - 3000, message: "starting with GREETING=hello-from-the-store\\n" },
    { timestamp: t - 2000, message: "called with Authorization: Bearer abcdefghijklmnopqrstuvwxyz and sk-ant-api03-supersecretvalue" },
    { timestamp: t - 1000, message: "token sl_${"z".repeat(43)} and API_KEY=plain-text-key" },
    // What the platform itself wrote, in its own words, beside the app's.
    { timestamp: t - 500, message: "REPORT RequestId: 62454822-d102-425d-9aa1-fd18c63f8ce5\tDuration: 3000.00 ms\tBilled Duration: 3000 ms\tMemory Size: 128 MB\tMax Memory Used: 97 MB\tStatus: timeout" }
  ].filter(e => e.timestamp >= from && e.timestamp < to));
}
`
  });
});

after(() => api?.stop());

test("an app's lines come newest first, with secrets and stored setting values taken out", async () => {
  const { status, body } = await api.call("/deployments/dep_api00000001/logs?since=15m", { token: ANA });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.since, "15m");
  assert.equal(body.lines.length, 4);
  assert.match(body.lines[1].message, /^token \[value redacted\] and API_KEY=\[value redacted\]$/);
  assert.match(body.lines[2].message, /Bearer \[value redacted\] and \[value redacted\]$/);
  assert.equal(body.lines[3].message, "starting with GREETING=[value redacted]");
  const all = JSON.stringify(body);
  for (const secret of ["hello-from-the-store", "abcdefghijklmnop", "supersecret", "plain-text-key", "zzzzzzzzzz"]) assert.ok(!all.includes(secret), secret);

  // Read backwards from now in widening steps, never past the window asked for.
  const calls = api.awsCalls().filter(l => l.startsWith("logs filter-log-events"));
  assert.ok(calls.every(c => /--log-group-name \/aws\/lambda\/sealeye-default-orders-api-aaaaaa/.test(c)));
  const starts = calls.map(c => Number(/--start-time (\d+)/.exec(c)[1]));
  assert.ok(Date.now() - starts[0] < 2 * 60_000, "the newest minute first");
  const oldest = Math.min(...starts);
  assert.ok(Date.now() - oldest < 16 * 60_000 && Date.now() - oldest > 14 * 60_000, "as far back as the window, and no further");
});

test("what has no logs says why, and nobody else's are readable", async () => {
  const quiet = await api.call("/deployments/dep_quiet000001/logs", { token: ANA });
  assert.equal(quiet.status, 200);
  assert.match(quiet.body.note, /has not written anything yet/);

  const site = await api.call("/deployments/dep_site0000001/logs", { token: ANA });
  assert.equal(site.status, 409);
  assert.match(site.body.error.message, /static site has no code of its own running/);

  const draft = await api.call("/deployments/dep_draft000001/logs", { token: ANA });
  assert.equal(draft.status, 409);
  assert.match(draft.body.error.message, /Nothing was built/);

  assert.equal((await api.call("/deployments/dep_api00000001/logs?since=1y", { token: ANA })).status, 400);
  assert.equal((await api.call("/deployments/dep_api00000001/logs", { token: PAT })).status, 404, "another team's");
});

test("sealeye logs prints them oldest first, by app name", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), "logs", "orders-api", "--since", "15m", "--api", api.api], {
    cwd: api.home, env: { ...process.env, HOME: api.home, SEALEYE_HOME: api.home, SEALEYE_TOKEN: ANA, NO_COLOR: "1" }
  });
  const lines = stdout.split("\n").filter(l => /^\d\d:\d\d:\d\d {2}/.test(l));
  assert.equal(lines.length, 4);
  assert.match(lines[0], /starting with GREETING=\[value redacted\]/);
  assert.ok(!stdout.includes("hello-from-the-store"));
});

test("masking catches JSON logs, values with spaces, and settings named by the app's deploys", async () => {
  const { maskerFor } = await import("../api/logs.js");
  const mask = maskerFor(["DB_URL", "GREETING"]);
  assert.equal(mask('{"DB_URL":"postgres://u:p@h/db","level":"info"}'), '{"DB_URL":[value redacted],"level":"info"}');
  assert.equal(mask('{"apiKey": "abc123", "ok": true}'), '{"apiKey": [value redacted], "ok": true}');
  assert.equal(mask("DB_URL=pass word, more"), "DB_URL=[value redacted]");
  assert.equal(mask("GREETING: hello there"), "GREETING: [value redacted]");
  assert.equal(mask("nothing secret here"), "nothing secret here");
  assert.equal(mask('PAYLOAD_SECRET="a \\" quoted" tail'), "PAYLOAD_SECRET=[value redacted] tail");
});

test("with no name, the command uses the app this folder's sealeye.yaml plans", async () => {
  const fs = await import("node:fs");
  const folder = fs.mkdtempSync(path.join(api.home, "orders-api-"));
  fs.writeFileSync(path.join(folder, "sealeye.yaml"), "planVersion: \"0.4\"\napp: { name: orders-api, type: api }\nprofile: dev\nmodules: []\noutputs: []\n");
  const run = (...args) => promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), ...args, "--api", api.api], {
    cwd: folder, env: { ...process.env, HOME: api.home, SEALEYE_HOME: api.home, SEALEYE_TOKEN: ANA, NO_COLOR: "1" }
  });
  const { stdout } = await run("logs", "--since", "15m");
  assert.match(stdout, /Using orders-api, the app sealeye\.yaml in this folder plans/);
  assert.match(stdout, /starting with GREETING=\[value redacted\]/);

  // Nowhere to read a name from: it says how to give one.
  await assert.rejects(promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), "logs", "--api", api.api], {
    cwd: api.home, env: { ...process.env, HOME: api.home, SEALEYE_HOME: api.home, SEALEYE_TOKEN: ANA, NO_COLOR: "1" }
  }), err => /Missing name: sealeye logs/.test(err.stderr) && /run this in its folder/.test(err.stdout));

  // A tear-down is never taken from the folder without a person to ask.
  await assert.rejects(run("teardown"), err => /Missing name: sealeye teardown/.test(err.stderr) && /A tear-down needs the app named/.test(err.stderr));
  await assert.rejects(run("destroy"), err => /A tear-down needs the app named/.test(err.stderr));
  assert.ok(!api.awsCalls().some(l => /delete-stack/.test(l)));

  // A flag before the name does not hide it.
  assert.match((await run("status", "--json", "orders-api")).stdout, /"deploymentId": "dep_api00000001"/);

  // status takes the app's name too.
  assert.match((await run("status", "orders-api", "--json")).stdout, /"deploymentId": "dep_api00000001"/);
});

test("a line the platform wrote is read for the developer, with the platform's own text kept beside it", async () => {
  const { platformLine, allPlatformWords } = await import("../core/platform-lines.js");
  const { forbiddenWords } = await import("../core/developer-words.js");
  for (const words of allPlatformWords()) assert.deepEqual(forbiddenWords(words), [], words);
  assert.equal(platformLine("account-notes-api listening on port 8080"), null, "the app's own line is left alone");
  assert.deepEqual(platformLine("INIT_START Runtime Version: nodejs:20.v101\tRuntime Version ARN: arn:aws:lambda:ca-central-1::runtime:1867"), { kind: "cold-start", words: "The platform started a fresh copy of your app" });
  assert.deepEqual(platformLine("REPORT RequestId: 7ed6\tDuration: 74.18 ms\tBilled Duration: 548 ms\tMemory Size: 256 MB\tMax Memory Used: 102 MB\tInit Duration: 473.30 ms"), { kind: "request-cold", words: "Started cold and ready in 473 ms; this request then took 74 ms" });
  assert.deepEqual(platformLine("REPORT RequestId: 6245\tDuration: 3000.00 ms\tBilled Duration: 3000 ms\tMemory Size: 128 MB\tMax Memory Used: 97 MB\tStatus: timeout"), { kind: "timeout", words: "Ran out of time after 3 seconds, the limit the platform gives each request" });
  assert.deepEqual(platformLine("2026-10-22T12:02:44.000Z 6245 Task timed out after 3.00 seconds").kind, "timeout");
  assert.equal(platformLine("REPORT RequestId: y\tDuration: 1200.00 ms\tBilled Duration: 1200 ms\tMemory Size: 128 MB\tMax Memory Used: 128 MB\tStatus: error\tError Type: Runtime.OutOfMemory").kind, "out-of-memory");
  assert.equal(platformLine("INIT_REPORT Init Duration: 10000.00 ms\tPhase: init\tStatus: timeout").kind, "start-timeout");
  assert.equal(platformLine("RequestId: z Error: Runtime exited with error: signal: killed Runtime.ExitError").kind, "out-of-memory");
  assert.equal(platformLine("START RequestId: 7ed6 Version: $LATEST").kind, "request-start");

  // Through the API: the words beside the line, and the app's own lines untouched.
  const { status, body } = await api.call("/deployments/dep_api00000001/logs?since=15m", { token: ANA });
  assert.equal(status, 200, JSON.stringify(body));
  const report = body.lines.find(l => l.message.startsWith("REPORT "));
  assert.deepEqual(report.platform, { kind: "timeout", words: "Ran out of time after 3 seconds, the limit the platform gives each request" });
  assert.match(report.message, /Status: timeout/, "the platform's own line is kept");
  assert.equal(body.lines.find(l => l.message.startsWith("starting with")).platform, undefined);

  // The command: the words first, the platform's own text after them.
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), "logs", "orders-api", "--since", "15m", "--api", api.api], {
    cwd: api.home, env: { ...process.env, HOME: api.home, SEALEYE_HOME: api.home, SEALEYE_TOKEN: ANA, NO_COLOR: "1" }
  });
  const shown = stdout.split("\n").find(l => /Ran out of time/.test(l));
  assert.ok(shown, stdout);
  assert.match(shown, /^\d\d:\d\d:\d\d {2}Ran out of time after 3 seconds, the limit the platform gives each request {2}·  REPORT RequestId: .*Status: timeout$/);
});
