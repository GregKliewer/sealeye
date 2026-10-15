// The model gateway on the server (PHASE3-PLAN Step 5): its settings file, its place in
// compose, and how the server hands it its keys. CI does not run the gateway; the Step 4
// spike (deploy/spikes/agentgateway/) does. These keep the files to what the spike showed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { apiSettings } from "../deploy/settings.mjs";

const root = path.resolve(import.meta.dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const gatewayText = read("deploy/gateway.yaml");
const gateway = YAML.parse(gatewayText);
const compose = YAML.parse(read("deploy/compose.yaml"));
const updateSh = read("deploy/update.sh");
const gatewaySh = read("deploy/gateway.sh");

// What the gateway fills in when it starts, and gateway.sh writes into its env file.
const EXPANDED = ["ANTHROPIC_API_KEY", "SEALEYE_GATEWAY_KEY", "SEALEYE_GATEWAY_BUDGET"];

test("no comment in the gateway's settings holds a dollar sign, which it would try to fill in", () => {
  const lines = gatewayText.split("\n");
  assert.match(lines[0], /^# yaml-language-server: \$schema=/, "the one line the gateway leaves alone");
  lines.slice(1).forEach((line, i) => {
    const comment = line.includes("#") ? line.slice(line.indexOf("#")) : "";
    assert.ok(!comment.includes("$"), `line ${i + 2} has a dollar sign in a comment`);
  });
});

test("every name the gateway fills in is one gateway.sh writes for it, and none other", () => {
  const names = [...gatewayText.split("\n").slice(1).join("\n").matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(names)].sort(), [...EXPANDED].sort());
  for (const name of EXPANDED) assert.match(gatewaySh, new RegExp(`${name}=%s`), `gateway.sh writes ${name}`);
});

test("the gateway keeps prompts and replies out of its log and its database", () => {
  assert.doesNotMatch(gatewayText, /llm\.(prompt|completion)/);
  assert.equal(gateway.frontendPolicies.accessLog.database.llm, "metadata");
  assert.equal(gateway.config.adminAddr, "off");
  assert.equal(gateway.config.tracing, undefined, "no traces leave the gateway yet");
});

test("only the API's key is let through, and it carries the money budget", () => {
  const apiKey = gateway.llm.policies.apiKey;
  assert.equal(apiKey.mode, "strict");
  assert.equal(apiKey.location.header.name, "x-sealeye-gateway-key");
  assert.equal(apiKey.keys.length, 1);
  assert.equal(apiKey.keys[0].key, "$SEALEYE_GATEWAY_KEY");
  const [budget] = apiKey.keys[0].budgets;
  assert.deepEqual(budget.limit, { unit: "USD", amount: "$SEALEYE_GATEWAY_BUDGET" });
  assert.equal(budget.window.rolling, "30d");
  assert.equal(budget.onBudgetExceeded, "Block");
  assert.match(gatewaySh, /GATEWAY_BUDGET="\$\{GATEWAY_BUDGET:-20\}"/, "twenty dollars when nothing says otherwise (D5)");
  assert.match(gateway.config.database.url, /^sqlite:\/\/\/data\//, "the budget's database is the gateway's own folder");
});

test("the gateway is pinned by digest, publishes no port, and only the API can reach it", () => {
  const svc = compose.services.gateway;
  assert.match(svc.image, /^ghcr\.io\/agentgateway\/agentgateway:v[\d.]+@sha256:[0-9a-f]{64}$/);
  assert.equal(svc.ports, undefined);
  assert.deepEqual(svc.networks, ["model"]);
  assert.ok(compose.services.api.networks.includes("model"));
  for (const other of ["caddy", "postgres"]) {
    assert.ok(!(compose.services[other].networks || []).includes("model"), `${other} stays off the gateway's network`);
  }
  assert.equal(svc.env_file, "./secrets/gateway.env");
  assert.ok(!JSON.stringify(compose.services.api).includes("ANTHROPIC_API_KEY"), "the API's container is never handed the model key");
});

test("the gateway's image is the one the spike ran", () => {
  const spike = YAML.parse(read("deploy/spikes/agentgateway/compose.yaml")).services.gateway.image;
  const digest = s => s.match(/sha256:[0-9a-f]{64}/)[0];
  assert.equal(digest(compose.services.gateway.image), digest(spike));
});

test("the release sends the gateway's settings and its script, and writes its keys before starting it", () => {
  const release = read("deploy/release.sh");
  assert.match(release, /for f in [^;]*\bgateway\.yaml\b/);
  assert.match(release, /for f in [^;]*\bgateway\.sh\b/);
  assert.match(updateSh, /server\/gateway\.yaml" gateway\.yaml/);
  const at = text => updateSh.indexOf(text);
  assert.ok(at("bash ./gateway.sh settings") > 0 && at("bash ./gateway.sh settings") < at("docker compose up -d --remove-orphans"));
  assert.ok(at("bash ./gateway.sh ready") > at('echo "The API is up'));
});

test("the API never takes the gateway's own parameters into its environment", () => {
  const loaded = apiSettings([
    { Name: "/sealeye/gateway/ANTHROPIC_API_KEY", Value: "model-key" },
    { Name: "/sealeye/SEALEYE_GATEWAY_KEY", Value: "gateway-key" },
    { Name: "/sealeye/SEALEYE_MODEL_URL", Value: "http://gateway:4000" },
    { Name: "/sealeye/ANTHROPIC_API_KEY", Value: "direct-key" }
  ]);
  assert.deepEqual(loaded, {
    SEALEYE_GATEWAY_KEY: "gateway-key",
    SEALEYE_MODEL_URL: "http://gateway:4000",
    ANTHROPIC_API_KEY: "direct-key"
  });
  assert.ok(!Object.values(loaded).includes("model-key"));
  assert.deepEqual(apiSettings([{ Name: "/other/gateway/X", Value: "1" }], "/other"), {});
});

test("the gateway requires the API's signed token, checked with the public half the release writes", async () => {
  const { AUDIENCE, ISSUER } = await import("../api/gateway-token.js");
  const jwt = gateway.llm.policies.jwtAuth;
  assert.equal(jwt.mode, "strict", "the gateway's default lets a call with no token through");
  assert.equal(jwt.issuer, ISSUER);
  assert.deepEqual(jwt.audiences, [AUDIENCE]);
  assert.deepEqual(jwt.jwtValidationOptions.requiredClaims, ["exp", "iss", "aud", "sub"]);
  assert.ok(compose.services.gateway.volumes.includes(`./gateway-jwks.json:${jwt.jwks.file}:ro`));
  assert.match(gatewaySh, /> gateway-jwks\.json\.new/);
  assert.match(gatewaySh, /\/sealeye\/SEALEYE_GATEWAY_SIGNING_KEY/, "the release stops when the API has no key to sign with");
  assert.match(gatewaySh, /cat gateway\.yaml "\$ENV_FILE" gateway-jwks\.json/, "a new key set restarts the gateway");
  assert.match(gatewaySh, /scripts\/gateway-key-id\.js/, "a release checks the API signs with the key the gateway checks");
  assert.ok(fs.existsSync(path.join(root, "scripts", "gateway-key-id.js")));
  const at = text => updateSh.indexOf(text);
  assert.ok(at("bash ./gateway.sh validate") > at("docker compose pull") && at("bash ./gateway.sh validate") < at("docker compose up -d --remove-orphans"), "settings are checked before anything restarts");
  // The spike checks the same issuer and audience against the API's own signer.
  for (const f of ["config.mock.yaml", "config.real.yaml", "config.bedrock.yaml"]) {
    const spike = YAML.parse(read(`deploy/spikes/agentgateway/${f}`)).llm.policies.jwtAuth;
    assert.equal(spike.issuer, ISSUER, f);
    assert.deepEqual(spike.audiences, [AUDIENCE], f);
  }
});

test("each call's line in the gateway's log names who made it, from the token", () => {
  assert.deepEqual(gateway.frontendPolicies.accessLog.add, {
    org: "jwt.org",
    team: "jwt.team",
    run: "jwt.run",
    worker: "jwt.worker",
    surface: "jwt.surface",
    trace: "jwt.trace"
  });
});

test("the server's scripts ask Parameter Store only what the server's role may ask", () => {
  // The role names /sealeye/ parameters one by one (deploy/server.yaml), and listing
  // them needs a permission it does not have: a release using it stopped (Oct 14, 2026).
  const role = read("deploy/server.yaml");
  assert.doesNotMatch(role, /ssm:DescribeParameters/);
  for (const file of ["deploy/gateway.sh", "deploy/update.sh", "deploy/settings.mjs"]) {
    assert.doesNotMatch(read(file), /ssm describe-parameters|"describe-parameters"/, file);
  }
});

test("one run cannot use up what every run shares: a token limit keyed on the run", () => {
  const [limit] = gateway.llm.policies.localRateLimit;
  assert.equal(limit.type, "tokens");
  assert.equal(limit.key, "jwt.run");
  assert.equal(limit.maxTokens, limit.tokensPerFill);
  assert.equal(limit.fillInterval, "24h");
});

test("the record of calls is read as the gateway's own user, never asks for content, and keeps 90 days", () => {
  const calls = gatewaySh.slice(gatewaySh.indexOf("  calls)"), gatewaySh.indexOf("  prune)"));
  assert.match(calls, /--user 65532:65532/);
  assert.match(calls, /-readonly/);
  assert.doesNotMatch(calls, /request_prompt_json|response_completion_json|request_log_payloads/);
  assert.match(calls, /=~ \^\[A-Za-z0-9@\._\+-\]\+\$/, "a name or run is checked before it reaches the query");
  const prune = gatewaySh.slice(gatewaySh.indexOf("  prune)"));
  assert.match(prune, /unixepoch\('now', '-90 days'\)/);
  assert.match(prune, /--user 65532:65532/);
  assert.match(updateSh, /sealeye-gateway-prune\.timer/);
  assert.match(read("Dockerfile"), /\bsqlite3\b/, "the API's image carries sqlite3 to read it with");
  assert.match(read("deploy/server.sh"), /gateway-calls\)/);
});

test("the named routes are the gateway's and the API's alike, each to a priced model", async () => {
  const { ROUTES, requestModel, routePrice } = await import("../api/model-routes.js");
  const models = gateway.llm.models;
  const named = Object.fromEntries(models.filter(m => !m.name.includes("*")).map(m => [m.name, m.params.model]));
  assert.deepEqual(named, { ...ROUTES }, "deploy/gateway.yaml and api/model-routes.js name the same routes and models");
  for (const route of Object.keys(ROUTES)) {
    const m = models.find(x => x.name === route);
    assert.equal(m.provider, "anthropic", `${route} is on the Anthropic route for now (D5)`);
    assert.equal(m.params.apiKey, "$ANTHROPIC_API_KEY");
    assert.ok(routePrice(route), `${route} is priced`);
  }
  // Named routes come before the catch-all, which still carries the interview's own model.
  assert.equal(models.at(-1).name, "claude-*");
  assert.equal(requestModel("small", { gatewayKey: "k" }), "small", "through the gateway, the route's name");
  assert.equal(requestModel("small", "sk-ant-direct"), "claude-haiku-5-5", "directly, the model");
  assert.throws(() => requestModel("medium", null), /no model route called medium/);
});
