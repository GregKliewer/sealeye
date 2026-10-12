// A seaLeye API for the portal's browser tests: the real API (../api/server.js) on a
// spare port, with tokens and sample records in a throwaway home, and a stand-in `aws`
// that lets a tear-down finish. No AWS, no model.
//
//   node tests/test-api.mjs     (Playwright starts it; see playwright.config.ts)
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export const TEST_TOKEN = `sl_${"t".repeat(43)}`;
export const OTHER_ORG_TOKEN = `sl_${"o".repeat(43)}`;
export const ORG_WIDE_TOKEN = `sl_${"z".repeat(43)}`;
const PORT = Number(process.env.SEALEYE_TEST_API_PORT || 3999);

const root = path.resolve(import.meta.dirname, "..", "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-portal-e2e-"));
const hash = t => createHash("sha256").update(t).digest("hex");
const now = Date.now();
const ago = ms => new Date(now - ms).toISOString();

fs.writeFileSync(path.join(home, "tokens.json"), JSON.stringify([
  { tokenId: "tok_greg", tokenHash: hash(TEST_TOKEN), email: "greg@example.com", name: "Greg Kliewer", org: "default", team: "default", createdAt: ago(0), revokedAt: null, lastUsedAt: null },
  { tokenId: "tok_wide", tokenHash: hash(ORG_WIDE_TOKEN), email: "lead@example.com", name: "Lee Admin", org: "default", team: "default", scope: "org", createdAt: ago(0), revokedAt: null, lastUsedAt: null },
  { tokenId: "tok_other", tokenHash: hash(OTHER_ORG_TOKEN), email: "x@other.example", name: "Other Org", org: "other-org", team: "default", createdAt: ago(0), revokedAt: null, lastUsedAt: null }
]));

// A ready plan for an API, as the interview writes one.
const apiPlan = name => ({
  planVersion: "0.4", app: { name, type: "api" }, profile: "dev",
  modules: [
    { id: "http_api_serverless", inputs: { runtime: "nodejs", entry_point: "index.js", trigger: "http" } },
    { id: "observability_basic", inputs: { target: "auto", retention_days: 30 } }
  ],
  outputs: ["public_url", "logs"]
});
const by = (name, user) => ({ user, name, host: "a-laptop", verified: "token" });
const base = { backend: "cloudformation", orgId: "default", teamId: "default", surface: "cli" };
fs.writeFileSync(path.join(home, "deployments.json"), JSON.stringify([
  { ...base, deploymentId: "dep_aaaaaaaaaaa1", app: { name: "payments-api" }, kind: "api", status: "succeeded", stackName: "sealeye-payments-api",
    plan: apiPlan("payments-api"), artifactKey: "sealeye-payments-api/dep_aaaaaaaaaaa1.zip", artifactSha256: "b".repeat(64), outputs: { ApiUrl: "https://abc123.lambda-url.ca-central-1.on.aws/" }, requestedBy: by("Ana Pereira", "ana@example.com"),
    startedAt: ago(2 * 3600_000), finishedAt: ago(2 * 3600_000 - 90_000) },
  { ...base, deploymentId: "dep_aaaaaaaaaaa0", app: { name: "payments-api" }, kind: "api", status: "succeeded", stackName: "sealeye-payments-api",
    plan: { profile: "dev" }, outputs: { ApiUrl: "https://abc123.lambda-url.ca-central-1.on.aws/" }, requestedBy: by("Ana Pereira", "ana@example.com"),
    startedAt: ago(3 * 86400_000), finishedAt: ago(3 * 86400_000 - 80_000) },
  { ...base, deploymentId: "dep_bbbbbbbbbbb1", app: { name: "marketing-site" }, kind: "static", status: "succeeded", stackName: "sealeye-marketing-site",
    plan: { profile: "poc" }, outputs: { WebsiteUrl: "http://sealeye-marketing-site.s3-website.ca-central-1.amazonaws.com" }, requestedBy: by("Greg Kliewer", "greg@example.com"),
    startedAt: ago(26 * 3600_000), finishedAt: ago(26 * 3600_000 - 60_000) },
  { ...base, deploymentId: "dep_ccccccccccc1", app: { name: "ledger-sync" }, status: "drafted", plan: { profile: "dev" }, outputs: {},
    needs: [{ kind: "relational_database", evidence: [{ file: "db.js", shows: "connects to Postgres" }] }], requestedBy: by("Ana Pereira", "ana@example.com"),
    startedAt: ago(5 * 3600_000) },
  { ...base, deploymentId: "dep_ddddddddddd1", app: { name: "report-builder" }, kind: "api", status: "failed", stackName: "sealeye-report-builder",
    plan: { profile: "dev" }, outputs: {}, failureReason: "The function could not start: index.js was not in the folder.", requestedBy: by("Greg Kliewer", "greg@example.com"),
    startedAt: ago(40 * 60_000) },
  { ...base, deploymentId: "dep_eeeeeeeeeee1", app: { name: "old-demo" }, kind: "static", status: "destroyed", stackName: "sealeye-old-demo",
    plan: { profile: "poc" }, outputs: {}, requestedBy: by("Greg Kliewer", "greg@example.com"), startedAt: ago(9 * 86400_000) },
  { ...base, teamId: "payments", deploymentId: "dep_99999999999a", app: { name: "another-teams-api" }, kind: "api", status: "succeeded", stackName: "sealeye-payments-another-teams-api-0a1b2c",
    plan: apiPlan("another-teams-api"), artifactKey: "sealeye-payments-another-teams-api-0a1b2c/dep_99999999999a.zip", outputs: {}, requestedBy: by("Pat Other", "pat@example.com"), startedAt: ago(3600_000) },
  // Being built right now, from the portal: the platform carries on following it when the
  // API starts (its stack stays in progress), and an earlier deploy it will replace.
  { ...base, surface: "portal", deploymentId: "dep_ggggggggggg1", app: { name: "inventory-api" }, kind: "api", status: "running", stackName: "sealeye-inventory-api",
    plan: apiPlan("inventory-api"), outputs: {}, requestedBy: by("Ana Pereira", "ana@example.com"), step: "Creating your AWS environment (stack sealeye-inventory-api)",
    startedAt: ago(150_000) },
  { ...base, deploymentId: "dep_ggggggggggg0", app: { name: "inventory-api" }, kind: "api", status: "succeeded", stackName: "sealeye-inventory-api",
    plan: apiPlan("inventory-api"), artifactKey: "sealeye-inventory-api/dep_ggggggggggg0.zip", outputs: { ApiUrl: "https://inv456.lambda-url.ca-central-1.on.aws/" }, requestedBy: by("Ana Pereira", "ana@example.com"),
    startedAt: ago(26 * 3600_000), finishedAt: ago(26 * 3600_000 - 90_000) },
  { ...base, orgId: "other-org", deploymentId: "dep_fffffffffff1", app: { name: "not-yours" }, kind: "api", status: "succeeded", stackName: "sealeye-not-yours",
    plan: { profile: "dev" }, outputs: {}, requestedBy: by("Other Org", "x@other.example"), startedAt: ago(3600_000) }
]));

// The stand-in `aws`: deleting a stack works, and afterwards that stack is gone; a
// deploy returns at once and the stack then reads as updated; an artifact is always
// there.
const bin = path.join(home, "bin");
fs.mkdirSync(bin);
// Two log lines from the last few minutes, inside whatever range is asked for.
fs.writeFileSync(path.join(bin, "logs.cjs"), `const args = process.argv.slice(2), opt = n => args[args.indexOf(n) + 1];
const from = Number(opt("--start-time")), to = args.includes("--end-time") ? Number(opt("--end-time")) : Infinity, now = Date.now();
const lines = [{ timestamp: now - 120000, message: "listening on 8080" }, { timestamp: now - 60000, message: "GET /orders with Bearer abcdefghijklmnopqrstuvwxyz0123" }];
process.stdout.write(JSON.stringify(lines.filter(l => l.timestamp >= from && l.timestamp < to)));
`);

// Metrics for any function: a day of requests shaped like a working day.
fs.writeFileSync(path.join(bin, "metrics.cjs"), `const args = process.argv.slice(2), opt = n => args[args.indexOf(n) + 1];
const start = Date.parse(opt("--start-time")), queries = JSON.parse(opt("--metric-data-queries"));
const period = queries[0].MetricStat.Period * 1000, count = Math.round((Date.parse(opt("--end-time")) - start) / period);
const shape = i => Math.max(0, Math.round(40 * Math.sin((i / count) * Math.PI)));
const per = { requests: shape, errors: i => (i % 7 === 3 ? 1 : 0), refused: () => 0, average: i => 80 + (i % 5) * 10, slowest: i => 200 + (i % 5) * 40 };
const total = { totalRequests: Array.from({ length: count }, (_, i) => shape(i)).reduce((a, b) => a + b, 0), totalErrors: 3, totalRefused: 0, totalAverage: 96, totalSlowest: 310 };
process.stdout.write(JSON.stringify(queries.map(q => q.Id in per
  ? { Id: q.Id, Timestamps: Array.from({ length: count }, (_, i) => new Date(start + i * period).toISOString()), Values: Array.from({ length: count }, (_, i) => per[q.Id](i)) }
  : { Id: q.Id, Timestamps: [new Date(start).toISOString()], Values: [total[q.Id]] })));
`);

// Its settings calls keep parameters in a file, names and values, so a test can check a
// value reached the store and never came back to the page.
fs.writeFileSync(path.join(bin, "ssm.cjs"), `const fs = require("fs");
const store = ${JSON.stringify(path.join(home, "ssm.json"))};
const read = () => { try { return JSON.parse(fs.readFileSync(store, "utf8")); } catch { return {}; } };
const args = process.argv.slice(2), opt = n => args[args.indexOf(n) + 1], s = read();
if (args[1] === "get-parameters-by-path") {
  const p = opt("--path");
  process.stdout.write(JSON.stringify(Object.keys(s).filter(k => k.startsWith(p)).map(k => ({ name: k, changedAt: s[k].at }))));
} else if (args[1] === "put-parameter") {
  const input = JSON.parse(fs.readFileSync(opt("--cli-input-json").slice("file://".length), "utf8"));
  s[input.Name] = { value: input.Value, at: new Date().toISOString() };
  fs.writeFileSync(store, JSON.stringify(s));
  process.stdout.write("{}");
} else if (args[1] === "delete-parameter") {
  delete s[opt("--name")];
  fs.writeFileSync(store, JSON.stringify(s));
}
`);
fs.writeFileSync(path.join(bin, "aws"), `#!/bin/sh
[ "$1" = ssm ] && exec node "${path.join(bin, "ssm.cjs")}" "$@"
[ "$2" = get-metric-data ] && exec node "${path.join(bin, "metrics.cjs")}" "$@"
[ "$2" = filter-log-events ] && exec node "${path.join(bin, "logs.cjs")}" "$@"
case "$2" in
  delete-stack) touch "${home}/deleted-$4"; echo '{}' ;;
  describe-stacks)
    if [ "$4" = sealeye-inventory-api ]; then echo '{"Stacks":[{"StackStatus":"UPDATE_IN_PROGRESS","Outputs":[]}]}'; exit 0; fi
    if [ -f "${home}/deleted-$4" ]; then echo "Stack does not exist" >&2; exit 254; fi
    echo '{"Stacks":[{"StackStatus":"UPDATE_COMPLETE","Outputs":[{"OutputKey":"ApiUrl","OutputValue":"https://abc123.lambda-url.ca-central-1.on.aws/"}]}]}' ;;
  put-function-concurrency) echo '{"ReservedConcurrentExecutions":0}' > "${home}/concurrency-$4"; cat "${home}/concurrency-$4" ;;
  delete-function-concurrency) rm -f "${home}/concurrency-$4" ;;
  get-function-concurrency) cat "${home}/concurrency-$4" 2>/dev/null || echo '{}' ;;
  get-cost-and-usage) echo '{"ResultsByTime":[{"Groups":[{"Keys":["sealeye:app$payments-api"],"Metrics":{"UnblendedCost":{"Amount":"3.4","Unit":"USD"}}},{"Keys":["sealeye:app$marketing-site"],"Metrics":{"UnblendedCost":{"Amount":"0.12","Unit":"USD"}}}]}]}' ;;
  *) echo '{}' ;;
esac
`, { mode: 0o755 });

// A stand-in for the model, so the New environment page can hold a whole interview: it
// lists the folder, reads a file, asks one question and submits a plan. An app with a
// worker.js gets a drafted plan instead, without a question. Which turn it is comes from
// how many messages the conversation has.
const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });
const apiModules = variables => [
  { id: "http_api_serverless", inputs: { runtime: "nodejs", entry_point: "index.js", trigger: "http" } },
  { id: "observability_basic", inputs: { target: "auto", retention_days: 30 } },
  ...(variables ? [{ id: "config_basic", inputs: { variables } }] : [])
];
const readyPlan = { planVersion: "0.4", app: { name: "orders-api", type: "api" }, profile: "dev", modules: apiModules({ GREETING: "hello" }), outputs: ["public_url", "logs"] };
const draftedPlan = {
  planVersion: "0.4", app: { name: "ledger-worker", type: "api" }, profile: "dev", modules: apiModules(null), outputs: ["public_url", "logs"],
  needs: [{ kind: "continuous_service", line: "a service that runs continuously", evidence: [{ file: "worker.js", shows: "reads a queue in a loop" }] }]
};
const model = http.createServer((req, res) => {
  let body = "";
  req.on("data", d => (body += d));
  req.on("end", () => {
    const sent = JSON.parse(body || "{}");
    const turn = Math.floor(((sent.messages || []).length - 1) / 2);
    const worker = body.includes("worker.js");
    const turns = worker
      ? [
          { content: [toolUse("t1", "list_files", { path: "." })], stop_reason: "tool_use" },
          { content: [toolUse("t2", "read_file", { path: "worker.js" })], stop_reason: "tool_use" },
          { content: [toolUse("t3", "submit_plan", { plan: draftedPlan, summary: "A worker that runs all the time.", assumptions: [] })], stop_reason: "tool_use" }
        ]
      : [
          { content: [toolUse("t1", "list_files", { path: "." })], stop_reason: "tool_use" },
          { content: [toolUse("t2", "read_file", { path: "index.js" })], stop_reason: "tool_use" },
          { content: [{ type: "text", text: "It looks like an API for orders.\nWho calls this API?" }], stop_reason: "end_turn" },
          { content: [toolUse("t3", "submit_plan", { plan: readyPlan, summary: "An orders API.", assumptions: ["It listens on PORT."] })], stop_reason: "tool_use" }
        ];
    const reply = turns[turn] || { content: [{ type: "text", text: "Done." }], stop_reason: "end_turn" };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: `msg_${Date.now()}`, type: "message", role: "assistant", model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 10 }, ...reply }));
  });
});
await new Promise(r => model.listen(0, "127.0.0.1", r));

const env = { ...process.env, PORT: String(PORT), HOME: home, SEALEYE_HOME: home, PATH: `${bin}:${process.env.PATH}`,
  SEALEYE_TRACING: "off", SEALEYE_TEST_POLL_MS: "200",
  ANTHROPIC_API_KEY: "sk-ant-test-api-key", SEALEYE_MODEL_URL: `http://127.0.0.1:${model.address().port}`,
  SEALEYE_BUCKET: "artifacts-bucket", SEALEYE_LWA_VERSION: "25", SEALEYE_FUNCTION_BOUNDARY_ARN: "arn:aws:iam::123456789012:policy/boundary", ORG: "Northwind Payments", DATABASE_URL: "" };
delete env.SEALEYE_AUTH;
const child = spawn(process.execPath, ["api/server.js"], { cwd: root, env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { child.kill(signal); model.close(); process.exit(0); });
child.on("exit", code => process.exit(code ?? 0));
