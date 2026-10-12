// A seaLeye API for the portal's browser tests: the real API (../api/server.js) on a
// spare port, with tokens and sample records in a throwaway home, and a stand-in `aws`
// that lets a tear-down finish. No AWS, no model.
//
//   node tests/test-api.mjs     (Playwright starts it; see playwright.config.ts)
import fs from "node:fs";
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

const by = (name, user) => ({ user, name, host: "a-laptop", verified: "token" });
const base = { backend: "cloudformation", orgId: "default", teamId: "default", surface: "cli" };
fs.writeFileSync(path.join(home, "deployments.json"), JSON.stringify([
  { ...base, deploymentId: "dep_aaaaaaaaaaa1", app: { name: "payments-api" }, kind: "api", status: "succeeded", stackName: "sealeye-payments-api",
    plan: { profile: "dev" }, outputs: { ApiUrl: "https://abc123.lambda-url.ca-central-1.on.aws/" }, requestedBy: by("Ana Pereira", "ana@example.com"),
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
    plan: { profile: "dev" }, outputs: {}, requestedBy: by("Pat Other", "pat@example.com"), startedAt: ago(3600_000) },
  { ...base, orgId: "other-org", deploymentId: "dep_fffffffffff1", app: { name: "not-yours" }, kind: "api", status: "succeeded", stackName: "sealeye-not-yours",
    plan: { profile: "dev" }, outputs: {}, requestedBy: by("Other Org", "x@other.example"), startedAt: ago(3600_000) }
]));

// The stand-in `aws`: deleting a stack works, and afterwards it is gone.
const bin = path.join(home, "bin");
fs.mkdirSync(bin);
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
case "$2" in
  delete-stack) touch "${home}/deleted"; echo '{}' ;;
  describe-stacks)
    if [ -f "${home}/deleted" ]; then echo "Stack does not exist" >&2; exit 254; fi
    echo '{"Stacks":[{"StackStatus":"DELETE_IN_PROGRESS","Outputs":[]}]}' ;;
  *) echo '{}' ;;
esac
`, { mode: 0o755 });

const env = { ...process.env, PORT: String(PORT), HOME: home, SEALEYE_HOME: home, PATH: `${bin}:${process.env.PATH}`,
  SEALEYE_TRACING: "off", SEALEYE_TEST_POLL_MS: "200", ORG: "Northwind Payments", DATABASE_URL: "" };
delete env.SEALEYE_AUTH;
const child = spawn(process.execPath, ["api/server.js"], { cwd: root, env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { child.kill(signal); process.exit(0); });
child.on("exit", code => process.exit(code ?? 0));
