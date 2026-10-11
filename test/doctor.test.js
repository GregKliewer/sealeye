// sealeye doctor checks what this machine needs: with the hosted API, Node, the API and
// a token, and nothing about AWS, since the platform does the building; with an API on
// this machine, the local tools too. A stand-in API on a spare port; no AWS.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { isLocalApi, runDoctor } from "../cli/doctor.js";

let server, api;
before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") return res.end(JSON.stringify({ ok: true, version: "2.17.0", deployments: 3 }));
    if (req.url === "/whoami") return res.end(JSON.stringify({ email: "ana@example.com", name: "Ana P", org: "default", team: "payments", scope: "team" }));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  api = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

test("an API on this machine is local; the hosted one is not", () => {
  for (const url of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) assert.equal(isLocalApi(url), true, url);
  for (const url of ["https://api.sealeye.online", "https://localhost.example.com", "not a url"]) assert.equal(isLocalApi(url), false, url);
});

test("with the hosted API, doctor checks Node, the API and the token, and nothing about AWS", async () => {
  process.env.SEALEYE_TOKEN = `sl_${"a".repeat(43)}`;
  try {
    const result = await runDoctor({ apiBaseUrl: api, local: false });
    assert.equal(result.local, false);
    assert.deepEqual(result.checks.map(c => c.name), ["Platform API", "Signed in", "Node", "Notices"]);
    assert.equal(result.ok, true, JSON.stringify(result.checks));
    assert.match(result.checks[1].detail, /Ana P \(ana@example.com\), team payments/);
    assert.ok(!JSON.stringify(result).match(/aws|bucket|adapter|ANTHROPIC/i), "no laptop checks");
  } finally {
    delete process.env.SEALEYE_TOKEN;
  }
});

test("with the hosted API down, the fix is to tell the platform team, not to start it", async () => {
  const result = await runDoctor({ apiBaseUrl: "http://127.0.0.1:9", local: false });
  const apiCheck = result.checks.find(c => c.name === "Platform API");
  assert.equal(apiCheck.ok, false);
  assert.match(apiCheck.fix, /tell your platform team/);
  assert.doesNotMatch(apiCheck.fix, /npm start/);
  assert.equal(result.ok, false);
});
