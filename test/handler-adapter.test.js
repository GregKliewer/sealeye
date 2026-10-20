// The adapter seaLeye puts into an app's package for a module that runs the app as a
// function (templates/sealeye-handler.mjs; DESIGN.md, "An app that listens reaches a
// module that calls a function"). Run here as the function's runtime would: imported
// from the packaged folder, with an event in the shape an HTTPS address sends.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { freePort } from "./helpers/free-port.js";
import { addHandlerAdapter, entryPointOfFolder } from "../api/executor/package.js";

const APP = `
const http = require("http");
http.createServer((req, res) => {
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    if (req.url.startsWith("/bin")) { res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end(Buffer.from([0, 255, 1])); }
    res.setHeader("set-cookie", ["a=1", "b=2"]);
    res.setHeader("x-seen", JSON.stringify({ method: req.method, url: req.url, cookie: req.headers.cookie || null, body, host: req.headers.host }));
    res.writeHead(201, { "content-type": "text/plain" });
    res.end("hello");
  });
}).listen(process.env.PORT);
`;

async function packaged() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-adapter-"));
  fs.writeFileSync(path.join(dir, "server.js"), APP);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { start: "node server.js" } }));
  // run.sh as the packager writes it, without the settings reader this test does not need.
  fs.writeFileSync(path.join(dir, "run.sh"), `#!/bin/sh\nexec "${process.execPath}" server.js\n`, { mode: 0o755 });
  addHandlerAdapter(dir);
  return dir;
}

test("the adapter starts the app, hands it each request, and hands back its answer", async () => {
  const dir = await packaged();
  assert.equal(entryPointOfFolder(dir), "server.js", "a start script that runs node with a file");
  process.env.SEALEYE_APP_PORT = String(await freePort());
  const { handler, stop } = await import(pathToFileURL(path.join(dir, "sealeye-handler.mjs")).href);
  try {
    const answer = await handler({
      version: "2.0",
      rawPath: "/things/1",
      rawQueryString: "a=1&b=two",
      cookies: ["c=3", "d=4"],
      headers: { host: "abc.execute-api.ca-central-1.amazonaws.com", "content-type": "application/json" },
      requestContext: { http: { method: "POST", path: "/things/1" } },
      body: Buffer.from('{"x":1}').toString("base64"),
      isBase64Encoded: true
    });
    assert.equal(answer.statusCode, 201);
    assert.equal(Buffer.from(answer.body, "base64").toString(), "hello");
    assert.equal(answer.isBase64Encoded, true);
    assert.deepEqual(answer.cookies, ["a=1", "b=2"]);
    assert.equal(answer.headers["set-cookie"], undefined);
    assert.deepEqual(JSON.parse(answer.headers["x-seen"]), {
      method: "POST", url: "/things/1?a=1&b=two", cookie: "c=3; d=4", body: '{"x":1}', host: "abc.execute-api.ca-central-1.amazonaws.com"
    });

    const binary = await handler({ rawPath: "/bin", requestContext: { http: { method: "GET" } }, headers: {} });
    assert.deepEqual([...Buffer.from(binary.body, "base64")], [0, 255, 1], "bytes come back as they were");
  } finally {
    delete process.env.SEALEYE_APP_PORT;
    stop();
  }
});

test("a folder that already has the adapter's file is refused, never overwritten", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-adapter-own-"));
  fs.writeFileSync(path.join(dir, "sealeye-handler.mjs"), "mine");
  assert.throws(() => addHandlerAdapter(dir), /rename yours/);
  assert.equal(fs.readFileSync(path.join(dir, "sealeye-handler.mjs"), "utf8"), "mine");
});

test("the app's entry point is read from its folder, and a folder with none says so", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-entry-"));
  assert.equal(entryPointOfFolder(dir), null);
  fs.writeFileSync(path.join(dir, "index.js"), "");
  assert.equal(entryPointOfFolder(dir), "index.js");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "main.js"), "");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ main: "./src/main" }));
  assert.equal(entryPointOfFolder(dir), "src/main.js", "main, with .js added as node does");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ main: "../outside.js", scripts: { start: "node --enable-source-maps src/main.js" } }));
  assert.equal(entryPointOfFolder(dir), "src/main.js", "never a file outside the folder; the start script instead");
});
