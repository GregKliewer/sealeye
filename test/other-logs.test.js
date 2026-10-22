// The front door's and the database's lines, beside the app's (DESIGN.md, Oct 22, 2026):
// where each is kept is read by code from what a module outputs, asked for in the root
// module, and believed only when it is the environment's own.
import assert from "node:assert/strict";
import { test } from "node:test";

import { doorLogsOutput, ownOtherLogGroup, partLogsOutputs } from "../core/terraform-modules.js";
import { connectsOf } from "../api/discovery/terraform.js";
import { outputsWanted, rootModule } from "../api/executor/terraform/root.js";
import { otherLogs } from "../api/executor/terraform/index.js";

const NAME = "sealeye-notes-api-dddddd";
const app = {
  id: "http_api", delivers: { kind: "package", package: "package_path", handler: "handler", address: "url", logs: "log_group" },
  outputs: { url: {}, role_name: {}, log_group: {}, access_log_group: {} }
};
const postgres = {
  id: "postgres", meets: ["relational_database"], line: "A relational database for your app, below staging.", outputs: { address: {}, port: {}, database_name: {}, database_user: {}, access_policy_arn: {}, log_group: {}, sign_in_log_group: {}, password_secret_arn: {} },
  offers: { access: "access_policy_arn", values: ["address", "database_name", "database_user", "port"] }
};

test("a module that writes the account's log resource policy is not built", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { moduleRuns } = await import("../api/discovery/terraform.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-lib-"));
  fs.mkdirSync(path.join(dir, "modules/bad"), { recursive: true });
  fs.writeFileSync(path.join(dir, "modules/bad/main.tf"), 'resource "aws_cloudwatch_log_resource_policy" "all" {\n  policy_name = "x"\n}\n');
  assert.deepEqual(moduleRuns(dir, "modules/bad"), ["the account's log resource policy (aws_cloudwatch_log_resource_policy)"]);
});

test("which outputs say where the other lines are kept", () => {
  assert.equal(doorLogsOutput(app), "access_log_group");
  assert.equal(doorLogsOutput({ ...app, outputs: { url: {}, log_group: {} } }), null, "a front door that keeps no record");
  assert.deepEqual(partLogsOutputs(postgres), ["log_group", "sign_in_log_group"]);
  assert.deepEqual(partLogsOutputs(app), [], "the app's module's own group is delivers.logs");
  // Never a value the app looks up: the plan does not connect it to a setting.
  const offered = connectsOf({}, postgres.outputs).offers;
  assert.deepEqual(offered.values, ["address", "database_name", "database_user", "port"]);
});

test("the root module reads them back, and only the environment's own are believed", () => {
  assert.deepEqual(outputsWanted(app), ["url", "log_group", "access_log_group"]);
  const root = rootModule({ moduleSource: "./library/modules/http-api", inputs: {}, outputs: outputsWanted(app), state: { bucket: "b", key: "k" }, tags: {}, parts: [{ key: "postgres", entry: postgres, moduleSource: "./library/modules/postgres", inputs: {} }] });
  assert.deepEqual(root.output.postgres__log_group, { value: "${module.postgres.log_group}" });
  assert.deepEqual(root.output.postgres__sign_in_log_group, { value: "${module.postgres.sign_in_log_group}" });
  assert.equal(root.output.postgres__password_secret_arn, undefined, "never a secret");

  const raw = {
    access_log_group: `/aws/vendedlogs/apigateway/${NAME}-dev-api`,
    postgres__log_group: `/aws/rds/instance/${NAME}-dev/postgresql`,
    postgres__sign_in_log_group: "/aws/rds/instance/platform-sealeye-db/iam-db-auth-error"
  };
  assert.deepEqual(otherLogs(app, [{ key: "postgres", entry: postgres }], raw, NAME), [
    { from: "door", kind: "door", words: "the front door", group: `/aws/vendedlogs/apigateway/${NAME}-dev-api` },
    { from: "database", kind: "database", words: "your database", group: `/aws/rds/instance/${NAME}-dev/postgresql` }
  ], "a group named for another environment, or the platform's, is not read");
  assert.equal(ownOtherLogGroup(`/aws/lambda/${NAME}-dev-api`, NAME), false, "the app's own group is found as it always was");
  assert.equal(ownOtherLogGroup(`/aws/rds/instance/${NAME}x-dev/postgresql`, NAME), false);
  assert.equal(ownOtherLogGroup(`/aws/rds/instance/${NAME}-x-a1b2c3-dev/postgresql`, NAME), false, "another app whose name begins with this one's");
  assert.equal(ownOtherLogGroup(`/aws/apigateway/${NAME}-dev-api`, NAME), false, "only under /aws/vendedlogs/");

  // A module that is not a database is named by its catalog line and read as it is; two
  // databases go by their ids.
  const table = { id: "document_table", meets: ["document_database"], line: "A table of documents your app finds by key.", outputs: { log_group: {} } };
  const both = otherLogs(app, [{ key: "document_table", entry: table }, { key: "postgres", entry: postgres }, { key: "postgres_cluster", entry: { ...postgres, id: "postgres_cluster" } }], {
    document_table__log_group: `/aws/rds/instance/${NAME}-dev-table/x`, postgres__log_group: `/aws/rds/instance/${NAME}-dev/postgresql`, postgres_cluster__log_group: `/aws/rds/instance/${NAME}-dev-cluster/postgresql`
  }, NAME);
  assert.deepEqual(both.map(x => [x.from, x.kind, x.words]), [
    ["document_table", "module", "a table of documents your app finds by key"],
    ["postgres", "database", "a relational database for your app, below staging"],
    ["postgres_cluster", "database", "a relational database for your app, below staging"]
  ]);
});
