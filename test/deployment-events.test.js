// GET /deployments/events (DESIGN.md, "The portal follows changes as they happen"): an
// event each time a deployment the caller can see is saved, naming the deployment and
// nothing more, so the portal shows a change made from the command line without being
// refreshed. Another team's changes are never heard of, and a stream ends on its own so
// the next one is checked again.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { startApi, token } from "./helpers/api-with-aws.js";

const ANA = token("a");
const PAT = token("p");
const LEE = token("l");
let api;

const record = (id, app, team) => ({
  deploymentId: id, app: { name: app, type: "node-api" }, status: "succeeded", kind: "api",
  teamId: team, orgId: "default", outputs: { ApiUrl: `https://${app}.example.com` },
  startedAt: "2026-10-15T11:00:00.000Z", finishedAt: "2026-10-15T11:05:00.000Z"
});

before(async () => {
  api = await startApi({
    tokens: [
      { token: ANA, id: "ana", team: "default", name: "Ana Pereira" },
      { token: PAT, id: "pat", team: "payments", name: "Pat Other" },
      { token: LEE, id: "lee", team: "platform", scope: "org", name: "Lee Admin" }
    ],
    // No stack, so a tear-down finishes at once, with nothing asked of AWS.
    records: [record("dep_ana000000001", "ana-app", "default"), record("dep_pat000000001", "pat-app", "payments")],
    aws: "",
    env: { SEALEYE_TEST_STREAM_MS: "1500", SEALEYE_TEST_STREAMS_PER_PERSON: "2" }
  });
});

after(() => api?.stop());

/** Open the stream and gather what arrives until `stop()` or it ends. */
async function follow(tok) {
  const controller = new AbortController();
  const res = await fetch(`${api.api}/deployments/events`, {
    headers: tok ? { authorization: `Bearer ${tok}` } : {},
    signal: controller.signal
  });
  const events = [];
  let text = "";
  let ended = false;
  const done = (async () => {
    if (!res.ok) return;
    const decoder = new TextDecoder();
    try {
      for await (const chunk of res.body) {
        text += decoder.decode(chunk, { stream: true });
        let cut;
        while ((cut = text.indexOf("\n\n")) >= 0) {
          const block = text.slice(0, cut);
          text = text.slice(cut + 2);
          const type = block.match(/^event: (.*)$/m)?.[1];
          const data = block.match(/^data: (.*)$/m)?.[1];
          if (type) events.push({ type, data: JSON.parse(data) });
        }
      }
      ended = true;
    } catch {}
  })();
  return { res, events, done, ended: () => ended, stop: () => controller.abort() };
}

const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return check();
};

test("a stream needs a token, like every read", async () => {
  const { res } = await follow(null);
  assert.equal(res.status, 401);
});

test("a tear-down from the command line is heard by its team and the organization, never by another team", async () => {
  const ana = await follow(ANA);
  const pat = await follow(PAT);
  const lee = await follow(LEE);
  assert.equal(ana.res.status, 200);
  assert.match(ana.res.headers.get("content-type"), /text\/event-stream/);

  const { status } = await api.call("/deployments/dep_ana000000001", { token: ANA, method: "DELETE" });
  assert.equal(status, 202);

  assert.ok(await until(() => ana.events.length > 0), "Ana hears of her own change");
  assert.ok(await until(() => lee.events.length > 0), "an organization-wide token hears of it");
  await new Promise(r => setTimeout(r, 200));
  assert.equal(pat.events.length, 0, "another team hears nothing");

  for (const e of [...ana.events, ...lee.events]) {
    assert.equal(e.type, "changed");
    assert.deepEqual(Object.keys(e.data), ["deploymentId"], "an event names the deployment and nothing more");
    assert.equal(e.data.deploymentId, "dep_ana000000001");
  }

  // What the page reads next says it is gone.
  const { body } = await api.call("/deployments", { token: ANA });
  assert.equal(body.deployments.find(d => d.deploymentId === "dep_ana000000001").status, "destroyed");

  for (const s of [ana, pat, lee]) s.stop();
});

test("a stream ends on its own, so the next one is checked again", async () => {
  const ana = await follow(ANA);
  assert.equal(ana.res.status, 200);
  assert.ok(await until(() => ana.ended(), 4000), "the stream ended by itself");
});

test("events is not read as a deployment id", async () => {
  const ana = await follow(ANA);
  assert.equal(ana.res.status, 200);
  assert.match(ana.res.headers.get("content-type"), /text\/event-stream/);
  ana.stop();
});

test("one person may hold only so many streams open, and closing one frees it", async () => {
  const one = await follow(PAT);
  const two = await follow(PAT);
  const three = await follow(PAT);
  assert.equal(one.res.status, 200);
  assert.equal(two.res.status, 200);
  assert.equal(three.res.status, 429);
  one.stop();
  await new Promise(r => setTimeout(r, 200));
  const again = await follow(PAT);
  assert.equal(again.res.status, 200);
  two.stop();
  again.stop();
});
