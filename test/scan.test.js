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

test("bytes are read as text, and a binary file is not read", () => {
  const bytes = new TextEncoder().encode(`x\nSTRIPE=${FAKE.stripeKey}\n`);
  assert.deepEqual(scanText("a.env.js", bytes).map(f => [f.line, f.rule]), [[2, "stripe-key"]]);
  const binary = new Uint8Array([0x89, 0x50, 0x00, ...new TextEncoder().encode(FAKE.stripeKey)]);
  assert.deepEqual(scanText("logo.png", binary), []);
});

test("Windows and old Mac line endings count lines the same way", () => {
  assert.equal(scanText("a", `a\r\nb\r\nkey=${FAKE.githubToken}`)[0].line, 3);
  assert.equal(scanText("a", `a\rb\rkey=${FAKE.githubToken}`)[0].line, 3);
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
  assert.match(interviewFindingWords([f]).join(" "), /sent as names only/);

  for (const rule of RULES) assert.doesNotMatch(rule.kind, /AWS|IAM|Amazon/, rule.id);
  assert.doesNotMatch(refusal, /—/);
});
