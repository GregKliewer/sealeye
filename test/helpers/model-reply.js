// A stand-in model's answer, as the model API sends it: a whole message as JSON, or,
// when the request asked for a stream (as every call does since replies are streamed,
// askModel in api/interview/model.js), the same message as server-sent events.

/**
 * Answer one request with `message` ({ content, stop_reason, usage, ... }).
 * @param {import("node:http").ServerResponse} res
 * @param {object} message
 * @param {string|object} request the request's body, as text or parsed
 */
export function answerModel(res, message, request) {
  let asked = request;
  if (typeof asked === "string") {
    try {
      asked = JSON.parse(asked || "{}");
    } catch {
      asked = {};
    }
  }
  const whole = { id: `msg_${Date.now()}`, type: "message", role: "assistant", model: "claude-sonnet-5", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, ...message };
  if (!asked?.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(whole));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const { content = [], stop_reason, stop_sequence = null, usage = {}, ...rest } = whole;
  send("message_start", { message: { ...rest, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } } });
  content.forEach((block, index) => {
    if (block.type === "tool_use") {
      send("content_block_start", { index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } });
    } else {
      send("content_block_start", { index, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index, delta: { type: "text_delta", text: block.text ?? "" } });
    }
    send("content_block_stop", { index });
  });
  send("message_delta", { delta: { stop_reason, stop_sequence }, usage: { output_tokens: usage.output_tokens ?? 0 } });
  send("message_stop", {});
  res.end();
}
