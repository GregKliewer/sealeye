// A tear-down that deletes data says so before the question, and asks even when the
// app's name was typed, so the words can change the answer (Greg, Oct 20, 2026, the
// first connected build). A script with no terminal has the words and goes on.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { startApi, token } from "./helpers/api-with-aws.js";

const root = path.resolve(import.meta.dirname, "..");
const ANA = token("a");
const base = { orgId: "default", teamId: "default", outputs: {}, kind: "api", settings: [], surface: "cli", status: "succeeded", startedAt: new Date().toISOString() };
const plan = name => ({ planVersion: "0.6", catalog: 3, app: { name, type: "api" }, profile: "dev", modules: [{ id: "http_api", enabled: true }, { id: "document_table", enabled: true, connect: { table_name: "ORDERS_TABLE" } }], outputs: ["public_url"] });
const table = { id: "document_table", source: "modules/document-table", line: "A table of documents, each found by its key." };

let api;
before(async () => {
  api = await startApi({
    tokens: [{ token: ANA, id: "ana", name: "Ana", team: "default" }],
    records: [
      { ...base, deploymentId: "dep_orders000001", app: { name: "orders-api" }, backend: "terraform", stackName: null, resourceName: "sealeye-default-orders-api-aaaaaa", plan: plan("orders-api"), terraform: { parts: [table], settings: { ORDERS_TABLE: "document_table.table_name" } } },
      { ...base, deploymentId: "dep_plain0000001", app: { name: "plain-api" }, backend: "cloudformation", stackName: "sealeye-default-plain-api-aaaaaa", resourceName: "sealeye-default-plain-api-aaaaaa", plan: { planVersion: "0.4", app: { name: "plain-api", type: "api" }, profile: "dev", modules: [{ id: "http_api_serverless", inputs: { runtime: "nodejs", entry_point: "index.js", trigger: "http" } }], outputs: ["public_url"] } }
    ],
    aws: `
if (args[1] === "describe-stacks") out({ Stacks: [{ StackStatus: "CREATE_COMPLETE", Outputs: [] }] });
if (args[1] === "delete-stack") out("");
if (args[1] === "describe-stack-events") out({ StackEvents: [] });
`
  });
});
after(() => api?.stop());

const env = () => ({ ...process.env, HOME: api.home, SEALEYE_HOME: api.home, SEALEYE_TOKEN: ANA, NO_COLOR: "1", SEALEYE_TRACING: "off", TERM: "dumb" });

/** The command in a terminal of its own, typing each reply once the screen shows what it waits for. */
function inTerminal(args, replies) {
  const line = [process.execPath, path.join(root, "cli/bin/sealeye"), ...args, "--api", api.api].map(a => `'${a}'`).join(" ");
  const child = spawn("script", ["-qec", line, "/dev/null"], { env: env(), cwd: api.home });
  let out = "";
  let next = 0;
  let seen = 0;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`stuck after:\n${out}`)); }, 20_000);
    child.stdout.on("data", d => {
      out += d;
      while (next < replies.length) {
        const [waitFor, reply] = replies[next];
        const i = out.indexOf(waitFor, seen);
        if (i === -1) break;
        seen = i + waitFor.length;
        next += 1;
        if (reply !== null) child.stdin.write(reply);
      }
    });
    child.on("close", code => { clearTimeout(timer); resolve({ out, code, typed: next }); });
  });
}

const record = async id => (await fetch(`${api.api}/deployments/${id}`, { headers: { authorization: `Bearer ${ANA}` } })).json();

test("with the name typed, an environment that holds data is still asked about, after the words say what it holds", async () => {
  const { out, typed } = await inTerminal(["teardown", "orders-api"], [["Tear down orders-api, and everything it holds? [y/N]", "n\n"]]);
  assert.equal(typed, 1, out);
  const words = out.indexOf("This also deletes a table of documents, each found by its key, and everything in it.");
  const question = out.indexOf("Tear down orders-api, and everything it holds?");
  assert.ok(words >= 0 && question > words, `the words come before the question:\n${out}`);
  assert.match(out, /Nothing was torn down\./);
  assert.equal((await record("dep_orders000001")).status, "succeeded", "n leaves the environment as it was");
});

test("with the name typed and nothing that holds data, the tear-down goes ahead without a question", async () => {
  const { out } = await inTerminal(["teardown", "plain-api"], [["Asking seaLeye.run to tear down plain-api", null]]);
  assert.doesNotMatch(out, /\[y\/N\]/);
  assert.doesNotMatch(out, /This also deletes/);
});

test("a script with no terminal has the words and goes on, as it typed the name", async () => {
  const run = promisify(execFile);
  const res = await run(process.execPath, [path.join(root, "cli/bin/sealeye"), "teardown", "orders-api", "--json", "--api", api.api], { env: env(), cwd: api.home }).catch(e => e);
  assert.match(res.stdout, /This also deletes a table of documents/);
  assert.doesNotMatch(res.stdout, /\[y\/N\]/);
});
