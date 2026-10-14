// deploy/spikes/agentgateway/mock.mjs
// A stand-in for Anthropic's Messages API, so the spike can check the gateway with no
// key and no spend. It answers POST /v1/messages the way Anthropic does (tool use,
// streaming, usage with cache reads and writes), and remembers what reached it, so the
// probe can see what the gateway forwarded: GET /seen.
//
// What a request asks for is written in its last user message:
//   "USE TOOL"       answer with a tool call to the first tool offered
//   "WAIT <n>"       wait n seconds before answering (or between streamed events)
//   "SENTINEL <x>"   answer with "SENTINEL-REPLY-<x>", so the probe can look for it in logs
// Every reply's usage is fixed, so the probe can do the gateway's sums: 8,000 input,
// 1,000 output, 1,000 written to the cache and 1,000 read from it.
import http from "node:http";

const PORT = Number(process.env.PORT || 8080);
const EXPECTED_KEY = process.env.MOCK_UPSTREAM_KEY || "";
const USAGE = { input_tokens: 8000, output_tokens: 1000, cache_creation_input_tokens: 1000, cache_read_input_tokens: 1000 };

const seen = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function lastUserText(body) {
  const users = (body.messages || []).filter(m => m.role === "user");
  const last = users[users.length - 1];
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  return (last.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
}

function countCacheMarks(value) {
  if (!value || typeof value !== "object") return 0;
  let n = value.cache_control ? 1 : 0;
  for (const v of Object.values(value)) n += countCacheMarks(v);
  return n;
}

/** What reached the upstream, as facts the probe checks: never a header's value but the key's match. */
function record(req, body) {
  const entry = {
    at: new Date().toISOString(),
    path: req.url,
    model: body.model,
    stream: Boolean(body.stream),
    upstreamKeyMatches: Boolean(EXPECTED_KEY) && req.headers["x-api-key"] === EXPECTED_KEY,
    hasAuthorization: "authorization" in req.headers,
    hasGatewayKey: "x-sealeye-gateway-key" in req.headers,
    anthropicVersion: req.headers["anthropic-version"] || null,
    anthropicBeta: req.headers["anthropic-beta"] || null,
    tools: (body.tools || []).map(t => t.name),
    cacheMarks: countCacheMarks({ system: body.system, tools: body.tools, messages: body.messages }),
    maxTokens: body.max_tokens
  };
  seen.push(entry);
  if (seen.length > 200) seen.shift();
}

function reply(body) {
  const text = lastUserText(body);
  const tool = /USE TOOL/.test(text) && (body.tools || [])[0];
  const sentinel = (text.match(/SENTINEL (\S+)/) || [])[1];
  const content = tool
    ? [{ type: "tool_use", id: `toolu_mock_${Date.now()}`, name: tool.name, input: { path: "README.md" } }]
    : [{ type: "text", text: sentinel ? `SENTINEL-REPLY-${sentinel}` : "Hello from the stand-in model." }];
  return {
    id: `msg_mock_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: body.model,
    content,
    stop_reason: tool ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: USAGE
  };
}

async function stream(res, message, waitMs) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  const { output_tokens, ...startUsage } = message.usage;
  send("message_start", { message: { ...message, content: [], stop_reason: null, usage: { ...startUsage, output_tokens: 1 } } });
  for (const [index, block] of message.content.entries()) {
    if (block.type === "text") {
      send("content_block_start", { index, content_block: { type: "text", text: "" } });
      await sleep(waitMs);
      send("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
    } else {
      send("content_block_start", { index, content_block: { ...block, input: {} } });
      await sleep(waitMs);
      send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    }
    send("content_block_stop", { index });
  }
  send("message_delta", { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens } });
  send("message_stop", {});
  res.end();
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/seen") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(seen));
  }
  if (req.method === "GET" && req.url === "/health") return res.end("ok");
  if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `mock has no ${req.method} ${req.url}` } }));
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "body is not JSON" } }));
  }
  record(req, body);
  const waitMs = Number((lastUserText(body).match(/WAIT (\d+)/) || [])[1] || 0) * 1000;
  const message = reply(body);
  if (body.stream) return stream(res, message, waitMs);
  await sleep(waitMs);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(message));
});

server.listen(PORT, () => console.log(`stand-in model on :${PORT}`));
