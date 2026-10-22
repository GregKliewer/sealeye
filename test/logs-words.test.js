// Logs are found by the command, never by a path (DESIGN.md, Oct 22, 2026): the card, the
// report and `sealeye status` tell a developer to read what the app prints with
// `sealeye logs <app>` or the portal's Logs card, and never show them a path on the
// platform, which they have no way to open.
import assert from "node:assert/strict";
import { test } from "node:test";

import { forbiddenWords } from "../core/developer-words.js";
import { renderPlanMarkdown } from "../core/plan-files.js";
import { logsHowWords } from "../core/plan-report-words.js";
import { renderReport } from "../api/executor/report.js";

const plan = {
  planVersion: "0.5", catalog: "starter", app: { name: "orders-api", type: "api" }, profile: "dev",
  modules: [{ id: "http_api_serverless", enabled: true, inputs: { runtime: "nodejs", entry_point: "index.js", trigger: "http" } }, { id: "observability_basic", enabled: true, inputs: { retention_days: 7 } }],
  outputs: ["public_url", "logs"]
};

test("the words say the command and the portal's card, and pass the word rule", () => {
  const words = logsHowWords("orders-api");
  assert.equal(words, "Read them with `sealeye logs orders-api` (the last hour; `--since 1d` for a day), or Logs on seaLeye.online.");
  assert.deepEqual(forbiddenWords(words), []);
});

test("the card says how to read the logs it promises", () => {
  const card = renderPlanMarkdown({ plan, summary: "An API.", assumptions: [] });
  assert.match(card, /Logs: everything your app prints, from the first request, with no setup\. Read them with `sealeye logs orders-api`/);
  assert.doesNotMatch(card, /\/aws\/|aws logs/);
});

test("the report says the command, never the platform's path", () => {
  const record = {
    deploymentId: "dep_orders00001", app: plan.app, backend: "cloudformation", kind: "api", status: "succeeded",
    stackName: "sealeye-default-orders-api-aaaaaa", finishedAt: "2026-10-22T12:00:00Z",
    outputs: { ApiUrl: "https://abc.execute-api.ca-central-1.amazonaws.com/", LogGroup: "/aws/lambda/sealeye-default-orders-api-aaaaaa" },
    settings: []
  };
  const report = renderReport(record, plan);
  assert.match(report, /## Logs\n\nEverything your app prints, from the first request\. Read them with `sealeye logs orders-api`/);
  assert.doesNotMatch(report, /aws logs tail|\/aws\/lambda/, "a developer has no way to open the platform's path");
  assert.doesNotMatch(report, /—/, "no em dashes in anything a developer reads");
});
