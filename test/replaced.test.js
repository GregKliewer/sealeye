// A replaced deploy says so (DESIGN.md): only the newest successful deploy of an
// environment is what it runs, so each older successful one is marked as replaced by the
// next successful one after it. Its own result is untouched; a failed deploy replaces
// nothing, because the stack rolled back to what was there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { replacements } from "../api/replaced.js";

const r = (id, status, stackName, hour) => ({ deploymentId: id, status, stackName, startedAt: `2026-10-12T${String(hour).padStart(2, "0")}:00:00Z` });

test("each older success is replaced by the next success on the same stack", () => {
  const map = replacements([
    r("d5", "running", "s1", 5),
    r("d4", "failed", "s1", 4),
    r("d3", "succeeded", "s1", 3),
    r("d2", "succeeded", "s1", 2),
    r("d1", "succeeded", "s1", 1),
    r("e1", "succeeded", "s2", 6),
    r("x1", "drafted", null, 7)
  ]);
  assert.equal(map.get("d1"), "d2");
  assert.equal(map.get("d2"), "d3");
  assert.equal(map.has("d3"), false, "a failed and a running deploy after it replace nothing yet");
  assert.equal(map.has("e1"), false, "another environment's");
  assert.equal(map.size, 2);
});

test("the order records come in does not matter", () => {
  const map = replacements([r("a", "succeeded", "s", 1), r("b", "succeeded", "s", 2)]);
  assert.equal(map.get("a"), "b");
});

test("the list says so on both surfaces' source, and the command shows it", async () => {
  const path = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { startApi, token } = await import("./helpers/api-with-aws.js");
  const ANA = token("a");
  const base = { backend: "cloudformation", orgId: "default", teamId: "default", surface: "cli", kind: "api", stackName: "sealeye-default-orders-api-aaaaaa" };
  const api = await startApi({
    tokens: [{ token: ANA, id: "ana", team: "default" }],
    records: [
      { ...base, deploymentId: "dep_orders00002", app: { name: "orders-api" }, status: "succeeded", paused: true, outputs: { ApiUrl: "https://new.example/" }, startedAt: "2026-10-12T02:00:00Z" },
      { ...base, deploymentId: "dep_orders00001", app: { name: "orders-api" }, status: "succeeded", paused: true, outputs: { ApiUrl: "https://new.example/" }, startedAt: "2026-10-12T01:00:00Z" }
    ],
    aws: ""
  });
  try {
    const { deployments } = (await api.call("/deployments", { token: ANA })).body;
    const [newer, older] = deployments;
    assert.equal(newer.replaced, false);
    assert.equal(newer.paused, true);
    assert.equal(older.status, "succeeded", "its own result stays");
    assert.equal(older.replaced, true);
    assert.equal(older.replacedBy, "dep_orders00002");
    assert.equal(older.paused, false, "paused is the current deploy's to say");

    const root = path.resolve(import.meta.dirname, "..");
    const { stdout } = await promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), "list", "--deployments", "--api", api.api], {
      cwd: api.home, env: { ...process.env, HOME: api.home, SEALEYE_HOME: api.home, SEALEYE_TOKEN: ANA, NO_COLOR: "1" }
    });
    assert.match(stdout, /dep_orders00002\s+orders-api\s+succeeded \(paused\)\s+https:\/\/new\.example\//);
    assert.match(stdout, /dep_orders00001\s+orders-api\s+succeeded \(replaced by dep_orders00002\)\s+-/);
  } finally {
    api.stop();
  }
});
