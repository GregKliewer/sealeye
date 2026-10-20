// What `deploy/server.sh park` counts as still standing, from the records
// (scripts/standing-environments.js). No AWS.
import { test } from "node:test";
import assert from "node:assert/strict";

import { standing } from "../scripts/standing-environments.js";

const at = n => `2026-10-${String(n).padStart(2, "0")}T12:00:00Z`;
const rec = (id, env, status, day, more = {}) => ({ deploymentId: id, stackName: env, status, startedAt: at(day), app: { name: env.replace(/^sealeye-/, "") }, ...more });

test("an environment stands while its newest record is live, under way, or failed with something left", () => {
  const rows = standing([
    rec("dep_a1", "sealeye-a", "succeeded", 1),
    rec("dep_a2", "sealeye-a", "destroyed", 2),                                     // torn down: not standing
    rec("dep_b1", "sealeye-b", "succeeded", 3, { orgId: "juniper", teamId: "payments", outputs: { ApiUrl: "https://b.example" } }),
    rec("dep_c1", "sealeye-c", "drafted", 4),                                       // nothing was built
    rec("dep_d1", "sealeye-d", "failed", 5),                                        // a first create that failed: deleted
    rec("dep_e1", "sealeye-e", "succeeded", 6),
    rec("dep_e2", "sealeye-e", "failed", 7),                                        // a failed update: the stack stays
    rec("dep_f1", "sealeye-f", "failed", 8, { backend: "terraform" }),              // may be part-built
    rec("dep_g1", "sealeye-g", "destroying", 9),                                    // under way
    { deploymentId: "dep_h1", environment: "sealeye-h", status: "queued", startedAt: at(10), app: { name: "h" } }
  ]);
  assert.deepEqual(rows.map(r => [r.environment, r.status, r.deploymentId]), [
    ["sealeye-e", "failed", "dep_e2"],
    ["sealeye-f", "failed", "dep_f1"],
    ["sealeye-g", "destroying", "dep_g1"],
    ["sealeye-h", "queued", "dep_h1"],
    ["sealeye-b", "succeeded", "dep_b1"]
  ]);
  assert.deepEqual(rows.find(r => r.app === "b"), { org: "juniper", team: "payments", app: "b", environment: "sealeye-b", status: "succeeded", deploymentId: "dep_b1", address: "https://b.example" });
  assert.deepEqual(standing([]), []);
});
