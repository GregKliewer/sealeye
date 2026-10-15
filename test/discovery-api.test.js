// Discovery's endpoints (PHASE4-PLAN Step 6): who may use them, and what they say when
// there is nothing to run. A run itself is tested in discovery-run.test.js, with a
// scripted model; here the real API, with no library named and no model.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { startApi, token } from "./helpers/api-with-aws.js";

const ANA = token("a");
const LEE = token("l");
let api;

before(async () => {
  api = await startApi({
    tokens: [
      { token: ANA, id: "ana", team: "default", name: "Ana Pereira" },
      { token: LEE, id: "lee", team: "platform", scope: "org", name: "Lee Admin" }
    ],
    records: [],
    aws: "",
    env: { SEALEYE_LIBRARY_REPOS: "", ANTHROPIC_API_KEY: "" }
  });
});

after(() => api?.stop());

test("discovery is for an organization-wide token only", async () => {
  for (const [method, route] of [["POST", "/discoveries"], ["GET", "/discoveries"], ["GET", "/discoveries/dsc_x"], ["POST", "/discoveries/dsc_x/answers"], ["GET", "/discoveries/dsc_x/events"], ["GET", "/discoveries/dsc_x/catalog"]]) {
    const r = await api.call(route, { token: ANA, method, ...(method === "POST" ? { body: {} } : {}) });
    assert.equal(r.status, 403, `${method} ${route}`);
    assert.equal(r.body.error.code, "ORG_WIDE_ONLY");
  }
  assert.equal((await api.call("/discoveries")).status, 401, "and never without a token");
});

test("with no library named, a run says so and starts nothing", async () => {
  const r = await api.call("/discoveries", { token: LEE, method: "POST", body: {} });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "NO_LIBRARY");
  assert.doesNotMatch(r.body.error.message, /SEALEYE_/, "a person reads it, not an operator");
  const list = await api.call("/discoveries", { token: LEE });
  assert.deepEqual(list.body.discoveries, []);
});

test("a run that is not there, or not this organization's, is not found", async () => {
  for (const route of ["/discoveries/dsc_nope", "/discoveries/dsc_nope/catalog", "/discoveries/dsc_nope/events"]) {
    const r = await api.call(route, { token: LEE });
    assert.equal(r.status, 404, route);
  }
  const answered = await api.call("/discoveries/dsc_nope/answers", { token: LEE, method: "POST", body: { question: "q_x", answer: "yes" } });
  assert.equal(answered.status, 404);
});
