// A failed setup step says its last lines (DESIGN.md, Oct 22, 2026): the database's setup
// function's log stays the platform team's, so when an apply fails there, its last lines
// go into the failure reason, read only from this environment's own function.
import assert from "node:assert/strict";
import { test } from "node:test";

import { invokedFunction } from "../api/executor/terraform/tofu.js";
import { setupLastLines, SETUP_LINES } from "../api/executor/terraform/index.js";

const NAME = "sealeye-account-notes-a1b2c3";
const FN = `${NAME}-dev-db-setup`;
const failed = detail => ({
  ok: false,
  messages: [{ type: "diagnostic", diagnostic: { severity: "error", summary: "invoking Lambda Function", address: "module.postgres.aws_lambda_invocation.setup[0]", detail } }]
});
const reader = events => {
  const asked = [];
  const read = async (group, options) => (asked.push({ group, ...options }), { ok: true, events: events.map((message, i) => ({ timestamp: i, message })) });
  return { read, asked };
};

test("the function is read from the provider's words, as a name or an ARN", () => {
  assert.equal(invokedFunction(failed(`Lambda function (${FN}) returned error: ({"errorMessage":"no route to the database"})`)), FN);
  assert.equal(invokedFunction(failed(`invoking Lambda Function (arn:aws:lambda:ca-central-1:123456789012:function:${FN}:1): timeout`)), FN);
  assert.equal(invokedFunction({ messages: [{ type: "diagnostic", diagnostic: { severity: "error", summary: "creating S3 Bucket", detail: "AccessDenied" } }] }), null);
});

test("the setup step's last lines join the reason: the platform's in its words, a secret never", async () => {
  const { read, asked } = reader([
    "INIT_START Runtime Version: nodejs:20.v40",
    "START RequestId: 1 Version: $LATEST",
    "connecting to the database",
    "password=Qv7r2Nx9Tb4Kw8Mz3Hc6Pd5 host=db.internal",
    "2026-10-22T12:00:00.000Z 1 Task timed out after 60.00 seconds",
    "END RequestId: 1",
    "REPORT RequestId: 1\tDuration: 60000.00 ms\tBilled Duration: 60000 ms\tMemory Size: 128 MB\tMax Memory Used: 80 MB\tStatus: timeout"
  ]);
  const words = await setupLastLines(failed(`Lambda function (${FN}) returned error: ({"errorMessage":"Task timed out"})`), { name: NAME, since: "2026-10-22T12:00:00Z", read, profile: "tf" });
  assert.equal(asked[0].group, `/aws/lambda/${FN}`);
  assert.equal(asked[0].profile, "tf");
  assert.equal(asked[0].sinceMs, Date.parse("2026-10-22T11:59:00Z"));
  assert.match(words, /^The setup step's last lines: "connecting to the database"; /);
  assert.doesNotMatch(words, /Qv7r2Nx9/, "never a value that looks like a secret");
  assert.match(words, /it looks like it holds/);
  assert.match(words, /"Ran out of time after 60 seconds, the limit the platform gives each request \(.*Task timed out after 60\.00 seconds\)"/);
  assert.doesNotMatch(words, /START RequestId|END RequestId/, "a request handed over or finished says nothing a failure needs");
  assert.ok(words.split('"; "').length <= SETUP_LINES);
});

test("nothing is read but this environment's own function, and an unreadable log adds nothing", async () => {
  const { read, asked } = reader(["a line"]);
  assert.equal(await setupLastLines(failed("Lambda function (sealeye-someone-else-dev-db-setup) returned error"), { name: NAME, since: null, read }), null);
  assert.equal(asked.length, 0);
  const broken = async () => ({ ok: false, error: "AccessDenied" });
  assert.equal(await setupLastLines(failed(`Lambda function (${FN}) returned error`), { name: NAME, read: broken }), null);
  assert.equal(await setupLastLines({ ok: false, messages: [] }, { name: NAME, read }), null);
});
