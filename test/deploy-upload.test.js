// Deployments package an uploaded copy of the app: what the deploy upload carries, and
// what the API does with it. The API runs on a spare port with no AWS settings, so a
// ready plan fails at the first AWS step (composing the template) and nothing reaches
// AWS. No model calls.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import YAML from "yaml";

import { unzipInto, zipFolder } from "../core/upload.js";
import { createDeployment } from "../cli/client.js";

const root = path.resolve(import.meta.dirname, "..");
const SECRET = "sk-live-never-in-an-upload";

function listAll(dir) {
  const all = [];
  const walk = (d, rel = "") => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else all.push(r);
    }
  };
  walk(dir);
  return all.sort();
}

test("a deploy upload carries what the packager would package, and never a .env", () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-deploy-up-")), "site");
  const put = (rel, body = "x") => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  };
  put(".gitignore", "dist/\n");
  put("index.js", "console.log('hi')");
  put("dist/bundle.js", "built");                 // ignored by git, still shipped
  put(".env", `KEY=${SECRET}`);
  put("config/.env", `KEY=${SECRET}`);
  put(".env.example", "KEY=");
  put("certs/server.pem", "cert");                // packaged as it always was
  put("node_modules/x/index.js");
  put(".git/HEAD");
  put(".github/workflows/ci.yml");

  const { zip } = zipFolder(dir, { purpose: "deploy" });
  assert.ok(!Buffer.from(zip).toString("latin1").includes(SECRET));

  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-deploy-unzip-")), "app");
  unzipInto(zip, dest, { purpose: "deploy" });
  assert.deepEqual(listAll(dest), [".env.example", ".gitignore", "certs/server.pem", "dist/bundle.js", "index.js"]);
});

let server;
let api;
let home;

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-deploy-api-"));
  const port = 4300 + Math.floor(Math.random() * 90);
  api = `http://localhost:${port}`;
  // A stand-in aws whose store has no settings for the app, so the deploy gets as far
  // as composing; it calls nothing else.
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  fs.writeFileSync(path.join(home, "bin", "aws"), "#!/bin/sh\n[ \"$2\" = get-parameters-by-path ] && { echo '[]'; exit 0; }\necho 'not in this stand-in' >&2; exit 254\n", { mode: 0o755 });
  const env = { ...process.env, PORT: String(port), SEALEYE_HOME: home, HOME: home, SEALEYE_AUTH: "off", PATH: `${path.join(home, "bin")}:${process.env.PATH}` };
  delete env.SEALEYE_LWA_VERSION;
  delete env.SEALEYE_BUCKET;
  server = spawn(process.execPath, ["api/server.js"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout.on("data", d => (log += d));
  server.stderr.on("data", d => (log += d));
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${api}/health`)).ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`API did not start:\n${log}`);
});

after(() => server?.kill());

const uploadsLeft = () => {
  const base = path.join(home, "deploy-uploads");
  return fs.existsSync(base) ? fs.readdirSync(base) : [];
};

test("a deployment from an upload never reads the folder, keeps its name, and cleans up", async () => {
  const app = path.join(home, "my-api");
  fs.cpSync(path.join(root, "apps", "beneficiary-lookup-api"), app, { recursive: true });
  const plan = YAML.parse(fs.readFileSync(path.join(root, "plans", "api-plan.yaml"), "utf8"));

  const created = await createDeployment({ apiBaseUrl: api, backend: "cloudformation", plan, appPath: app });
  assert.equal(created.source, "upload");
  assert.equal(created.appPath, app, "the developer's own name for the folder");

  // The folder is gone from where the API could look; the copy is what it packages.
  fs.rmSync(app, { recursive: true, force: true });

  let record;
  for (let i = 0; i < 50; i++) {
    record = await (await fetch(`${api}/deployments/${created.deploymentId}`)).json();
    if (record.status === "failed") break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(record.status, "failed");
  assert.match(record.failureReason, /SEALEYE_LWA_VERSION/, "it got as far as composing, and no further");

  for (let i = 0; i < 20 && uploadsLeft().length; i++) await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(uploadsLeft(), [], "the uploaded copy is gone once the deployment ended");
});

test("an upload that is not a zip is refused before anything is recorded", async () => {
  const plan = YAML.parse(fs.readFileSync(path.join(root, "plans", "api-plan.yaml"), "utf8"));
  const before_ = (await (await fetch(`${api}/deployments`)).json()).deployments.length;
  const res = await fetch(`${api}/deployments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ backend: "cloudformation", plan, appPath: "/somewhere/app", zip: Buffer.from("nope").toString("base64") })
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "UPLOAD_REFUSED");
  const after_ = (await (await fetch(`${api}/deployments`)).json()).deployments.length;
  assert.equal(after_, before_);
  assert.deepEqual(uploadsLeft(), []);
});

test("an appPath with no upload still means a folder on the API's machine", async () => {
  const plan = YAML.parse(fs.readFileSync(path.join(root, "plans", "api-plan.yaml"), "utf8"));
  const res = await fetch(`${api}/deployments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ backend: "cloudformation", plan, appPath: "/no/such/folder" })
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "INVALID_APP_PATH");
});
