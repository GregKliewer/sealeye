// A model reply is streamed (askModel in api/interview/model.js): a long reply is never
// cut off by a limit on the whole call, only by the model going quiet (Greg, Oct 16,
// 2026: Juniper's payment events plan took longer than two minutes, every time).
// Against a stand-in that speaks the model API's own server-sent events, with the
// real SDK.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import Anthropic from "@anthropic-ai/sdk";

import { askModel, createWithOneRetry, watchedFetch } from "../api/interview/model.js";
import { withCallerToken } from "../api/gateway-token.js";

const servers = [];
after(() => servers.forEach(s => s.close()));

const sse = (res, type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);

/** A stand-in model that writes `chunks` pieces of text, `gapMs` apart, or stops after `stallAfter`. */
async function standIn({ chunks = 5, gapMs = 20, stallAfter = null, pings = 0, onRequest = () => {} } = {}) {
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    calls += 1;
    onRequest(req, calls);
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    sse(res, "message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    // Thinking before it writes: only pings, which the SDK drops.
    for (let i = 0; i < pings; i++) {
      await new Promise(r => setTimeout(r, gapMs));
      res.write("event: ping\ndata: {\"type\": \"ping\"}\n\n");
    }
    sse(res, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    for (let i = 0; i < chunks; i++) {
      if (stallAfter !== null && i >= stallAfter && calls === 1) return; // goes quiet, connection left open
      await new Promise(r => setTimeout(r, gapMs));
      sse(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: `part${i} ` } });
    }
    sse(res, "content_block_stop", { index: 0 });
    sse(res, "message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: chunks } });
    sse(res, "message_stop", {});
    res.end();
  });
  await new Promise(r => server.listen(0, r));
  servers.push(server);
  return { url: `http://127.0.0.1:${server.address().port}`, calls: () => calls };
}

const params = { model: "claude-sonnet-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }] };

test("a reply longer than the whole-call limit arrives whole, as long as it keeps coming", async () => {
  const model = await standIn({ chunks: 12, gapMs: 50 });
  // The SDK's own limit is shorter than the whole reply takes.
  const client = new Anthropic({ apiKey: "test", baseURL: model.url, timeout: 300, maxRetries: 0 });
  const reply = await askModel(client, params, { idleMs: 1000 });
  assert.equal(reply.content[0].text.trim().split(" ").length, 12);
  assert.equal(reply.stop_reason, "end_turn");
  assert.equal(reply.usage.output_tokens, 12);
});

test("a model that goes quiet mid-reply is given up as a timeout, and the retry finishes it", async () => {
  const model = await standIn({ chunks: 4, gapMs: 10, stallAfter: 2 });
  const client = new Anthropic({ apiKey: "test", baseURL: model.url, timeout: 5000, maxRetries: 0 });
  await assert.rejects(askModel(client, params, { idleMs: 200 }), err => err instanceof Anthropic.APIConnectionTimeoutError);

  // The stand-in stalls only on its first call: the retry gets the whole reply.
  const once = await standIn({ chunks: 3, gapMs: 10, stallAfter: 1 });
  const steps = [];
  const ok = await createWithOneRetry(new Anthropic({ apiKey: "test", baseURL: once.url, maxRetries: 0 }), params, line => steps.push(line), 0, { traceAs: "discovery", idleMs: 200 });
  assert.equal(ok.content[0].text.trim(), "part0 part1 part2");
  assert.equal(once.calls(), 2);
  assert.equal(steps.length, 1, "the retry is said once");
});

test("a streamed call through the gateway carries its own signed token", async () => {
  const seen = [];
  const model = await standIn({ chunks: 2, onRequest: req => seen.push(req.headers.authorization) });
  const base = new Anthropic({ apiKey: "test", baseURL: model.url, maxRetries: 0 });
  const signer = { sign: claims => `signed-${claims.run}` };
  const client = withCallerToken(base, signer, () => ({ run: "int_1" }));
  assert.equal(typeof client.messages.stream, "function");
  const reply = await askModel(client, params);
  assert.equal(reply.content[0].text.trim(), "part0 part1");
  assert.deepEqual(seen, ["Bearer signed-int_1"]);
});

test("a stand-in with no stream is called the old way", async () => {
  const reply = await askModel({ messages: { create: async () => ({ content: [{ type: "text", text: "old" }] }) } }, params);
  assert.equal(reply.content[0].text, "old");
});

test("a model thinking before it writes is still answering: its pings count (Greg's run, Oct 16)", async () => {
  // Pings for longer than the quiet limit, then the reply.
  const model = await standIn({ chunks: 2, gapMs: 50, pings: 10 });
  const watched = new Anthropic({ apiKey: "test", baseURL: model.url, maxRetries: 0, fetch: watchedFetch() });
  const reply = await askModel(watched, params, { idleMs: 200 });
  assert.equal(reply.content[0].text.trim(), "part0 part1");

  // Without it, the SDK's events alone took the thinking for silence: the old fault.
  const unwatched = new Anthropic({ apiKey: "test", baseURL: model.url, maxRetries: 0 });
  await assert.rejects(askModel(unwatched, params, { idleMs: 200 }), err => err instanceof Anthropic.APIConnectionTimeoutError);
});

test("the mark that ties a call to its watch is never sent on", async () => {
  const seen = [];
  const model = await standIn({ chunks: 1, onRequest: req => seen.push(Object.keys(req.headers)) });
  const watched = new Anthropic({ apiKey: "test", baseURL: model.url, maxRetries: 0, fetch: watchedFetch() });
  await askModel(watched, params);
  assert.ok(!seen[0].includes("x-sealeye-watch"));
});

test("silence before the reply starts is given the longer wait", async () => {
  const model = await standIn({ chunks: 1, gapMs: 300 });
  const watched = new Anthropic({ apiKey: "test", baseURL: model.url, maxRetries: 0, fetch: watchedFetch() });
  // The first byte comes at once (headers), so this checks the start wait does not end a slow first event.
  const reply = await askModel(watched, params, { idleMs: 500, startMs: 2000 });
  assert.equal(reply.content[0].text.trim(), "part0");
});
