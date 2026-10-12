// The start-up reader that goes into every packaged API app (templates/sealeye-settings.mjs,
// PHASE2-PLAN Step 10): it signs one request to Parameter Store itself, sets the app's
// settings as environment variables before the app starts, never shows a value, and
// stops the app from starting when it cannot read them. No AWS: a stand-in store
// answers in place of Parameter Store.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { signedHeaders } from "../templates/sealeye-settings.mjs";
import { RESERVED_NAME } from "../core/settings.js";

const root = path.resolve(import.meta.dirname, "..");
const READER = path.join(root, "templates", "sealeye-settings.mjs");
const SECRET = "the-value-that-must-never-show-71c9";

// Expected signatures computed with AWS's own signer (@smithy/signature-v4 4.x) for the
// same request on Oct 12, 2026, with AWS's documented example credentials.
test("the request is signed exactly as AWS's own signer signs it", () => {
  const now = new Date("2026-10-12T09:30:15Z");
  const body = JSON.stringify({ Path: "/sealeye-apps/payments/lookup-api/", WithDecryption: true });
  const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
  const sign = extra => signedHeaders({ region: "ca-central-1", credentials: { ...credentials, ...extra }, target: "AmazonSSM.GetParametersByPath", body, now }).authorization;
  assert.equal(sign({}),
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261012/ca-central-1/ssm/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=1ba21125cf91e98d075501691776a7e95ea4b49e010a7fac7e9ab16321e91895");
  assert.equal(sign({ sessionToken: "FwoGZXIvYXdzEXAMPLETOKEN" }),
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261012/ca-central-1/ssm/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, Signature=c1f23711a5082f9e40fde3f27e4215472443d980e7e798e4131a6c6c4d9ba159");
});

test("the reader and the API agree on which names are reserved", () => {
  const reader = fs.readFileSync(READER, "utf8");
  const copy = /const RESERVED = (\/.*\/);/.exec(reader)?.[1];
  assert.equal(copy, String(RESERVED_NAME), "templates/sealeye-settings.mjs and core/settings.js must keep the same rule");
});

// Run the reader as run.sh will, `node --import <reader> <app>`, with a stand-in for
// fetch loaded first. The stand-in answers like Parameter Store and records what it was
// asked; the app prints the names it can see and the lengths of their values.
function start({ answers, settingsPath = "/sealeye-apps/payments/lookup-api/", env = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-reader-"));
  fs.writeFileSync(path.join(dir, "answers.json"), JSON.stringify(answers));
  fs.writeFileSync(path.join(dir, "store.mjs"), `
    import fs from "node:fs";
    const answers = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, "answers.json"))}, "utf8"));
    let n = 0;
    globalThis.fetch = async (url, init) => {
      fs.appendFileSync(${JSON.stringify(path.join(dir, "asked.log"))}, JSON.stringify({ url, target: init.headers["x-amz-target"], auth: init.headers.authorization.slice(0, 40), body: JSON.parse(init.body) }) + "\\n");
      const a = answers[Math.min(n++, answers.length - 1)];
      if (a.network) throw new TypeError("fetch failed");
      return new Response(JSON.stringify(a.body), { status: a.status || 200 });
    };`);
  fs.writeFileSync(path.join(dir, "app.mjs"), `
    const names = Object.keys(process.env).filter(n => /^(API_KEY|REGION_NAME|AWS_SECRET_ACCESS_KEY|PORT|SEALEYE_X)$/.test(n)).sort();
    console.log(JSON.stringify(Object.fromEntries(names.map(n => [n, process.env[n].length]))));`);
  const result = spawnSync(process.execPath, ["--import", path.join(dir, "store.mjs"), "--import", READER, path.join(dir, "app.mjs")], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, AWS_REGION: "ca-central-1", AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "secret-of-the-function", AWS_SESSION_TOKEN: "token-of-the-function", PORT: "8080", ...(settingsPath === null ? {} : { SEALEYE_SETTINGS_PATH: settingsPath }), ...env }
  });
  const asked = fs.existsSync(path.join(dir, "asked.log")) ? fs.readFileSync(path.join(dir, "asked.log"), "utf8").trim().split("\n").map(l => JSON.parse(l)) : [];
  return { ...result, asked };
}

const param = (name, value) => ({ Name: `/sealeye-apps/payments/lookup-api/${name}`, Value: value });

test("the app starts with its settings, across pages, and nothing shows a value", () => {
  const r = start({ answers: [
    { body: { Parameters: [param("API_KEY", SECRET)], NextToken: "page-2" } },
    { body: { Parameters: [param("REGION_NAME", "ca-central")] } }
  ] });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { API_KEY: SECRET.length, AWS_SECRET_ACCESS_KEY: 22, PORT: 4, REGION_NAME: 10 });
  assert.equal(r.asked.length, 2);
  assert.equal(r.asked[0].url, "https://ssm.ca-central-1.amazonaws.com/");
  assert.equal(r.asked[0].target, "AmazonSSM.GetParametersByPath");
  assert.deepEqual(r.asked[0].body, { Path: "/sealeye-apps/payments/lookup-api/", WithDecryption: true });
  assert.equal(r.asked[1].body.NextToken, "page-2");
  assert.match(r.asked[0].auth, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
  assert.ok(!(r.stdout + r.stderr).includes(SECRET));
});

test("a stored name the platform or the runtime owns is skipped, never set", () => {
  const r = start({ answers: [{ body: { Parameters: [param("AWS_SECRET_ACCESS_KEY", "stolen"), param("PORT", "1"), param("SEALEYE_X", "x"), param("API_KEY", SECRET), param("nested/NAME", "x")] } }] });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { API_KEY: SECRET.length, AWS_SECRET_ACCESS_KEY: 22, PORT: 4 }, "the function's own key and port are untouched");
});

test("without a settings folder it does nothing and asks for nothing", () => {
  const r = start({ answers: [{ body: {} }], settingsPath: null });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.asked, []);
});

test("when the store refuses, the app does not start, and says why by name only", () => {
  const r = start({ answers: [{ status: 400, body: { __type: "com.amazonaws.ssm#AccessDeniedException", message: `User is not authorized ... ${SECRET}` } }] });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "", "the app never ran");
  assert.match(r.stderr, /could not read this app's settings .*\(AccessDeniedException\), so the app was not started/);
  assert.ok(!r.stderr.includes(SECRET), "the store's message is not passed on");
  assert.equal(r.asked.length, 1, "a refusal is not retried");
});

test("a dropped connection or throttling is tried once more", () => {
  const ok = start({ answers: [{ network: true }, { body: { Parameters: [param("API_KEY", SECRET)] } }] });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.asked.length, 2);
  const down = start({ answers: [{ status: 400, body: { __type: "ThrottlingException" } }, { status: 400, body: { __type: "ThrottlingException" } }] });
  assert.equal(down.status, 1);
  assert.match(down.stderr, /\(ThrottlingException\)/);
});

test("an answer that is not the store's, or more pages than it takes, stops the app", () => {
  const html = start({ answers: [{ body: "not the store" }] });
  assert.equal(html.status, 1);
  assert.match(html.stderr, /could not be read/);
  const many = start({ answers: [{ body: { Parameters: [param("API_KEY", SECRET)], NextToken: "always-more" } }] });
  assert.equal(many.status, 1, "it never starts with only some of them");
  assert.equal(many.stdout, "");
  assert.equal(many.asked.length, 20);
});

test("a settings folder that is not an app's, or missing credentials, stops the app", () => {
  for (const settingsPath of ["/", "/sealeye/", "/sealeye-apps/payments/", "/sealeye-apps/../x/"]) {
    const r = start({ answers: [{ body: {} }], settingsPath });
    assert.equal(r.status, 1, settingsPath);
    assert.deepEqual(r.asked, [], `${settingsPath}: nothing asked`);
  }
  const r = start({ answers: [{ body: {} }], env: { AWS_ACCESS_KEY_ID: "" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /credentials are not in its environment/);
});

test("the packaged start script runs the reader, then the app, from wherever it is called", async () => {
  const { addSettingsReader, renderRunScript } = await import("../api/executor/package.js");
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-stage-"));
  fs.mkdirSync(path.join(stage, "src"));
  fs.writeFileSync(path.join(stage, "src", "server.js"), `console.log("app ran with " + (process.env.API_KEY || "nothing"))`);
  fs.writeFileSync(path.join(stage, "run.sh"), renderRunScript(path.join(root, "templates", "run.sh"), "src/server.js"), { mode: 0o755 });
  addSettingsReader(stage);
  assert.equal(fs.readFileSync(path.join(stage, ".sealeye", "settings.mjs"), "utf8"), fs.readFileSync(READER, "utf8"));
  assert.throws(() => addSettingsReader(stage), /\.sealeye\/settings\.mjs/, "an app's own file of that name is never overwritten");

  // Without a settings folder, as every app without stored settings runs.
  const plain = spawnSync("bash", [path.join(stage, "run.sh")], { cwd: stage, encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout.trim(), "app ran with nothing");

  // With one it cannot read (no credentials here), the app never starts.
  const stopped = spawnSync("bash", [path.join(stage, "run.sh")], { cwd: os.tmpdir(), encoding: "utf8", env: { PATH: process.env.PATH, SEALEYE_SETTINGS_PATH: "/sealeye-apps/payments/lookup-api/" } });
  assert.equal(stopped.status, 1);
  assert.equal(stopped.stdout, "");
  assert.match(stopped.stderr, /so the app was not started/);
});
