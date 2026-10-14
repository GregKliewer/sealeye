// `sealeye online` (also `portal` and `open`): the portal in the browser, at
// Environments or at one environment's page, keyed the way the portal keys it
// (core/environments.js). The browser here is a stand-in named by BROWSER that writes
// down the address it was given.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { startApi, token } from "./helpers/api-with-aws.js";
import { environmentKey, environmentPath } from "../core/environments.js";
import { portalFor } from "../core/config.js";

const root = path.resolve(import.meta.dirname, "..");
const ANA = token("a");
let api;
const base = { backend: "cloudformation", orgId: "default", teamId: "default", surface: "cli", outputs: {}, startedAt: new Date().toISOString() };

before(async () => {
  api = await startApi({
    tokens: [{ token: ANA, id: "ana", team: "default" }],
    records: [
      { ...base, deploymentId: "dep_api00000002", app: { name: "orders-api" }, kind: "api", status: "succeeded", stackName: "sealeye-default-orders-api-aaaaaa" },
      { ...base, deploymentId: "dep_api00000001", app: { name: "orders-api" }, kind: "api", status: "succeeded", stackName: "sealeye-default-orders-api-aaaaaa" },
      { ...base, deploymentId: "dep_draft000001", app: { name: "ledger-sync" }, kind: "api", status: "drafted" },
      { ...base, teamId: "payments", deploymentId: "dep_theirs00001", app: { name: "theirs-api" }, kind: "api", status: "succeeded", stackName: "sealeye-payments-theirs-api-bbbbbb" }
    ],
    aws: ""
  });
});

after(() => api?.stop());

function browserStandIn() {
  const seen = path.join(api.home, `opened-${Math.random().toString(36).slice(2)}.txt`);
  const script = path.join(api.home, `browser-${path.basename(seen, ".txt")}.sh`);
  fs.writeFileSync(script, `#!/bin/sh\nprintf '%s' "$1" > "${seen}"\n`, { mode: 0o755 });
  return { script, opened: () => fs.readFileSync(seen, "utf8") };
}

const run = (args, env = {}) => promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), ...args, "--api", api.api], {
  cwd: api.home,
  env: { ...process.env, HOME: api.home, SEALEYE_HOME: api.home, SEALEYE_TOKEN: ANA, SEALEYE_PORTAL: "https://portal.example", NO_COLOR: "1", ...env }
});

test("the portal's address goes with the API's", () => {
  const saved = process.env.SEALEYE_PORTAL;
  delete process.env.SEALEYE_PORTAL;
  try {
    assert.equal(portalFor("https://api.sealeye.online"), "https://sealeye.online");
    assert.equal(portalFor("https://api.sealeye.online/"), "https://sealeye.online");
    assert.equal(portalFor("https://sealeye.online/api"), "https://sealeye.online");
    assert.equal(portalFor("http://api.example.test:8080"), "http://example.test:8080");
    assert.equal(portalFor("http://localhost:3000"), null, "a laptop API has no portal anyone can know");
    assert.equal(portalFor("not a url"), null);
    process.env.SEALEYE_PORTAL = "http://localhost:5173/";
    assert.equal(portalFor("http://localhost:3000"), "http://localhost:5173");
  } finally {
    if (saved === undefined) delete process.env.SEALEYE_PORTAL;
    else process.env.SEALEYE_PORTAL = saved;
  }
});

test("an environment's key is its stack, or for a draft its team's app", () => {
  assert.equal(environmentKey({ deploymentId: "d", stackName: "sealeye-x" }), "sealeye-x");
  assert.equal(environmentKey({ deploymentId: "d", teamId: "payments", app: { name: "a" } }), "payments:a");
  assert.equal(environmentKey({ deploymentId: "d" }), "d");
  assert.equal(environmentPath({ deploymentId: "d", app: { name: "a" } }), "/environments/default%3Aa");
});

test("with no name it opens Environments in the browser", async () => {
  const browser = browserStandIn();
  const { stdout } = await run(["online"], { BROWSER: browser.script });
  assert.equal(browser.opened(), "https://portal.example/");
  assert.match(stdout, /Opening https:\/\/portal\.example\//);
});

test("with an app's name it opens that environment's page, and portal and open do the same", async () => {
  for (const word of ["online", "portal", "open"]) {
    const browser = browserStandIn();
    await run([word, "orders-api"], { BROWSER: browser.script });
    assert.equal(browser.opened(), "https://portal.example/environments/sealeye-default-orders-api-aaaaaa", word);
  }
});

test("a deployment id and a draft each reach their page", async () => {
  const { stdout: byId } = await run(["online", "dep_api00000001", "--print"]);
  assert.equal(byId.trim(), "https://portal.example/environments/sealeye-default-orders-api-aaaaaa");
  const { stdout: draft } = await run(["online", "ledger-sync", "--print"]);
  assert.equal(draft.trim(), "https://portal.example/environments/default%3Aledger-sync");
});

test("--print and --json give the address and open nothing", async () => {
  const browser = browserStandIn();
  const { stdout } = await run(["online", "--print"], { BROWSER: browser.script });
  assert.equal(stdout, "https://portal.example/\n", "nothing but the address when piped");
  const { stdout: json } = await run(["online", "orders-api", "--json"], { BROWSER: browser.script });
  assert.deepEqual(JSON.parse(json), { url: "https://portal.example/environments/sealeye-default-orders-api-aaaaaa" });
  assert.throws(() => browser.opened(), /ENOENT/);
});

test("with nowhere to open it, it gives the address to open by hand", async () => {
  const { stdout } = await run(["online"], { BROWSER: path.join(api.home, "no-such-browser") });
  assert.match(stdout, /No browser could be opened from here/);
  assert.match(stdout, /^ {2}https:\/\/portal\.example\/$/m);
});

test("another team's app, or none at all, is said and opens nothing", async () => {
  for (const name of ["theirs-api", "nothing-here"]) {
    await assert.rejects(run(["online", name, "--print"]), err => {
      assert.match(err.stderr, new RegExp(`no environment called ${name} that your team has`));
      return true;
    });
  }
});

test("an API with no known portal says how to name one", async () => {
  await assert.rejects(run(["online", "--print"], { SEALEYE_PORTAL: "" }), err => {
    assert.match(err.stderr, /no portal address for the API at http:\/\/localhost/);
    assert.match(err.stdout, /SEALEYE_PORTAL/);
    return true;
  });
});
