// The secret scanner's shared rules (core/scan.js): what they find, what they leave
// alone, the allow file, and the words. Every value here is a fake, put together at run
// time (test/fixtures/fake-secrets.js).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  allowLine,
  applyAllow,
  cleanFinding,
  deployRefusalMessage,
  findingSentence,
  interviewFindingWords,
  kindOf,
  parseAllowFile,
  RULES,
  scanText,
  uniqueFindings
} from "../core/scan.js";
import { FAKE } from "./fixtures/fake-secrets.js";

const rulesIn = text => scanText("app.js", text).map(f => f.rule);

test("each rule finds the value it is for, on its own line", () => {
  const cases = [
    [`${FAKE.privateKeyHeader}`, "private-key"],
    [`const id = "${FAKE.cloudAccessKey}";`, "cloud-access-key"],
    [`token: ${FAKE.githubToken}`, "github-token"],
    [`GITLAB=${FAKE.gitlabToken}`, "gitlab-token"],
    [`slack("${FAKE.slackToken}")`, "slack-token"],
    [`stripe(${JSON.stringify(FAKE.stripeKey)})`, "stripe-key"],
    [`new Anthropic({ apiKey: "${FAKE.anthropicKey}" })`, "anthropic-key"],
    [`const k = "${FAKE.openaiKey}"`, "openai-key"],
    [`maps?key=${FAKE.googleKey}`, "google-api-key"],
    [`//registry.npmjs.org/:_authToken=${FAKE.npmToken}`, "npm-token"],
    [`sg.setApiKey("${FAKE.sendgridKey}")`, "sendgrid-key"],
    [`DB_PASSWORD=${FAKE.password}`, "assigned-secret"],
    [`aws_secret_access_key = ${FAKE.cloudSecret}`, "assigned-secret"]
  ];
  for (const [line, rule] of cases) assert.ok(rulesIn(line).includes(rule), `${rule} in: ${line.slice(0, 20)}...`);
});

test("a long random value is found under the names code gives secrets", () => {
  for (const line of [
    `const clientSecret = '${FAKE.password}';`,
    `"apiKey": "${FAKE.password}",`,
    `  auth_token: "${FAKE.password}"`,
    `export SESSION_SECRET="${FAKE.password}"`,
    `privateKey := "${FAKE.password}"`,
    `$config['db_password'] => '${FAKE.password}'`
  ]) {
    assert.deepEqual(rulesIn(line), ["assigned-secret"], line.slice(0, 30));
  }
});

test("names that only mention a secret, references, placeholders and words are left alone", () => {
  for (const line of [
    `const tokenUrl = "https://auth.example.org/oauth2/token";`,
    `passwordField: "input[name=password]",`,
    `const apiKey = process.env.API_KEY;`,
    `API_KEY=\${API_KEY}`,
    `password: "your-password-goes-here"`,
    `SECRET_KEY=changeme-before-you-deploy`,
    `token = req.headers.authorization.split(" ")[1]`,
    `const secret = config.auth.clientSecret;`,
    `DB_PASSWORD=postgrespostgres`,
    `token: "aaaaaaaaaaaaaaaaaaaaaaaa"`,
    `SECRET_PATH=/etc/app/secrets/db.json`,
    `password = "{{ vault_db_password }}"`,
    `const publishable = "pk_test_${"x".repeat(24)}";`,
    `"integrity": "sha512-abcdefghijABCDEFGHIJ0123456789abcdefghij=="`
  ]) {
    assert.deepEqual(rulesIn(line), [], line);
  }
});

test("a finding is a file, a line, a rule and a kind, and never the value", () => {
  const text = ["// config", "", `module.exports = { key: "${FAKE.cloudAccessKey}" };`].join("\n");
  const findings = scanText("src/config.js", text);
  assert.deepEqual(findings, [{ file: "src/config.js", line: 3, rule: "cloud-access-key", kind: "a cloud access key" }]);
  assert.ok(!JSON.stringify(findings).includes(FAKE.cloudAccessKey));
});

test("bytes are read as text, and a NUL byte near the start does not hide a key", () => {
  const bytes = new TextEncoder().encode(`x\nSTRIPE=${FAKE.stripeKey}\n`);
  assert.deepEqual(scanText("a.env.js", bytes).map(f => [f.line, f.rule]), [[2, "stripe-key"]]);
  const binaryish = new Uint8Array([0x89, 0x50, 0x00, 0x0a, ...new TextEncoder().encode(FAKE.stripeKey)]);
  assert.deepEqual(scanText("data.bin", binaryish).map(f => [f.line, f.rule]), [[2, "stripe-key"]]);
});

test("lines end at a newline, as gitleaks counts them, so both name the same line", () => {
  assert.equal(scanText("a", `a\r\nb\r\nkey=${FAKE.githubToken}`)[0].line, 3);
  assert.equal(scanText("a", `a\nb\nkey=${FAKE.githubToken}`)[0].line, 3);
});

test("a key at the end of a large file is found: nothing is cut short", () => {
  const big = `${"// filler line for a bundle\n".repeat(150_000)}const t = "${FAKE.githubToken}";\n`;
  assert.ok(big.length > 4 * 1024 * 1024);
  assert.deepEqual(scanText("dist/bundle.js", big).map(f => f.rule), ["github-token"]);
});

test("no line, however long or strange, makes the scan slow", () => {
  // Lines built to make a backtracking regex try every start: the review's case, and others.
  const lines = [
    ".a".repeat(500_000),
    "-a".repeat(500_000),
    "token=".repeat(150_000),
    "token: ".repeat(150_000) + "x",
    `"password": "${"a".repeat(1_000_000)}`,
    `-----BEGIN ${"A ".repeat(400_000)}`,
    `postgres://${"u:".repeat(300_000)}`,
    "x".repeat(1_000_000),
    // The second review's case, and the same trick on every rule with a prefix.
    "sk-".repeat(400_000),
    "sk-".repeat(200_000) + "T3BlbkFJ",
    "github_pat_".repeat(100_000),
    "glpat-".repeat(200_000),
    "xoxb-".repeat(200_000),
    "sk_live_".repeat(150_000),
    "sk-ant-api03-".repeat(100_000),
    "AIza".repeat(300_000),
    "SG.".repeat(400_000),
    "https://hooks.slack.com/services/T".repeat(30_000)
  ];
  for (const line of lines) {
    const started = Date.now();
    scanText("crafted.js", line);
    const took = Date.now() - started;
    assert.ok(took < 1500, `${line.slice(0, 12)}... took ${took} ms`);
  }
});

test("passwords with symbols, short names and connection addresses are found", () => {
  const symbols = ["Zq8v", "!R2#", "mK9@", "pL4x", "$Wt7"].join("");
  for (const line of [
    `password: "${symbols}"`,
    `DB_PASSWORD=${symbols}`,
    `pwd = "${symbols}"`,
    `DATABASE_URL=postgres://app_user:${FAKE.password}@orders.c9xyz.ca-central-1.rds.amazonaws.com:5432/orders`
  ]) {
    assert.equal(rulesIn(line).length, 1, line.slice(0, 24));
  }
  for (const line of [
    "DATABASE_URL=postgres://postgres:postgres@localhost:5432/dev",
    "REDIS_URL=redis://default:password123@redis:6379",
    `DATABASE_URL=postgres://app:\${DB_PASSWORD}@db.example.org/app`,
    "DB_PASSWORD=$DB_PASSWORD_FROM_VAULT",
    'echo "$(pwd)/scripts/run.sh"'
  ]) {
    assert.deepEqual(rulesIn(line), [], line);
  }
});

test("the allow file excuses a line for every rule on it, and a typo excuses nothing", () => {
  const { entries, ignored } = parseAllowFile([
    "# test keys used by the fixtures",
    "test/fixtures/keys.js:4:stripe-key   # a Stripe test key",
    "./src/demo.js:9:generic-api-key",
    "src/demo.js 9 stripe-key",
    "../outside.js:1:stripe-key",
    "/abs.js:1:stripe-key",
    ""
  ].join("\n"));
  assert.deepEqual(entries, [
    { file: "test/fixtures/keys.js", line: 4, rule: "stripe-key" },
    { file: "src/demo.js", line: 9, rule: "generic-api-key" }
  ]);
  assert.equal(ignored, 3);

  const findings = [
    { file: "test/fixtures/keys.js", line: 4, rule: "stripe-key" },
    { file: "test/fixtures/keys.js", line: 5, rule: "stripe-key" },
    { file: "src/demo.js", line: 9, rule: "assigned-secret" }
  ];
  const { found, allowed } = applyAllow(findings, entries);
  assert.deepEqual(found.map(f => f.line), [5]);
  assert.deepEqual(allowed.map(f => f.rule), ["stripe-key", "assigned-secret"], "the same line, named by another scanner, is allowed too");
});

test("findings from two scanners are one list, once each, in order", () => {
  const list = uniqueFindings([
    { file: "b.js", line: 2, rule: "x" },
    { file: "a.js", line: 9, rule: "x" },
    { file: "a.js", line: 3, rule: "x" },
    { file: "a.js", line: 3, rule: "x" }
  ]);
  assert.deepEqual(list.map(f => `${f.file}:${f.line}`), ["a.js:3", "a.js:9", "b.js:2"]);
});

test("a finding from a client is cut down to its four fields, or dropped", () => {
  assert.deepEqual(cleanFinding({ file: "a.js", line: 3, rule: "stripe-key", match: "sk_live_...", kind: "anything" }), {
    file: "a.js",
    line: 3,
    rule: "stripe-key",
    kind: "a Stripe key"
  });
  for (const bad of [null, { file: "../x", line: 1, rule: "r" }, { file: "/x", line: 1, rule: "r" }, { file: "a", line: 0, rule: "r" }, { file: "a", line: 1, rule: "r r" }, { file: "a\nb", line: 1, rule: "r" }]) {
    assert.equal(cleanFinding(bad), null, JSON.stringify(bad));
  }
});

test("gitleaks' rule ids read as kinds a developer knows, and anything else as a secret", () => {
  assert.equal(kindOf("aws-access-token"), "a cloud access key");
  assert.equal(kindOf("github-pat"), "a GitHub token");
  assert.equal(kindOf("generic-api-key"), "a secret");
  assert.equal(kindOf("stripe-key"), "a Stripe key");
});

test("the words name the file, the line and the kind, with no cloud provider's terms", () => {
  const f = { file: "config.js", line: 12, rule: "cloud-access-key", kind: "a cloud access key" };
  assert.equal(findingSentence(f), "config.js, line 12, looks like it holds a cloud access key.");
  assert.equal(allowLine(f), "config.js:12:cloud-access-key");

  const refusal = deployRefusalMessage([f]);
  assert.match(refusal, /^Nothing was deployed/);
  assert.match(refusal, /sealeye settings set NAME/);
  assert.match(refusal, /\n  config\.js:12:cloud-access-key$/);
  assert.match(interviewFindingWords([f]).join(" "), /That line was not sent: the interview reads the rest of the file without it\./);
  assert.match(interviewFindingWords([{ ...f, rule: "private-key", whole: true }]).join(" "), /config\.js was sent as a name only, since a private key runs over many lines\./);

  for (const rule of RULES) assert.doesNotMatch(rule.kind, /AWS|IAM|Amazon/, rule.id);
  assert.doesNotMatch(refusal, /—/);
});
