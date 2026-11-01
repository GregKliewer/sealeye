// Who applies a stage, changed by hand (PHASE5-PLAN Step 2b; Greg, Nov 1, 2026).
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyStageEdit, keepStageEdits, stageEditNotes } from "../core/catalog-edits.js";
import { provenStageMap, withStageMap } from "../api/discovery/draft.js";
import { selfTest } from "../api/self-test.js";

const pipeline = ".github/workflows/app-promote.yml";
const draft = () => ({
  modules: [{ id: "api", source: "modules/api", availability: "available", line: "Runs your app.", meets: [] }],
  need_kinds: [],
  profiles: [],
  stages: {
    path: [
      { name: "dev", applies: "sealeye", gate: [] },
      { name: "sit", applies: "pipeline", pipeline, gate: [] },
      { name: "prod", applies: "pipeline", pipeline, gate: ["an approved change ticket"] }
    ],
    aside: [{ name: "perf", from: "prod", applies: "sealeye", gate: [] }]
  }
});
const sitOf = d => d.stages.path.find(s => s.name === "sit");
const at = "2026-11-01T21:40:00.000Z";

test("a stage's applier is changed, with who, when and what the library said", () => {
  const d = applyStageEdit(draft(), { stage: "sit", applies: "sealeye", by: "greg@juniper.example", at });
  assert.deepEqual(sitOf(d), { name: "sit", applies: "sealeye", gate: [], edited: { by: "greg@juniper.example", at, read: { applies: "pipeline", pipeline } } });
  // A second edit keeps what the library said, not the first edit.
  const again = applyStageEdit(d, { stage: "sit", applies: "pipeline", pipeline: "other.yml", by: "pat@juniper.example", at });
  assert.deepEqual(sitOf(again).edited.read, { applies: "pipeline", pipeline });
  assert.equal(sitOf(again).pipeline, "other.yml");
  // Back to what the library said: no edit left.
  const back = applyStageEdit(again, { stage: "sit", applies: "pipeline", pipeline, by: "pat@juniper.example", at });
  assert.deepEqual(sitOf(back), { name: "sit", applies: "pipeline", pipeline, gate: [] });
  // A stage set aside can be changed too.
  assert.equal(applyStageEdit(draft(), { stage: "perf", applies: "pipeline", pipeline, by: "x", at }).stages.aside[0].applies, "pipeline");
});

test("dev, a stage the path does not have, and an unnamed pipeline are refused in words", () => {
  const refused = (edit, words) => assert.throws(() => applyStageEdit(draft(), edit), e => e.code === "BAD_EDIT" && words.test(e.message));
  refused({ stage: "dev", applies: "pipeline", pipeline }, /dev is always built by seaLeye/);
  refused({ stage: "qa", applies: "sealeye" }, /no stage qa: dev, sit, prod, perf/);
  refused({ stage: "sit", applies: "someone" }, /sealeye or pipeline/);
  refused({ stage: "sit", applies: "pipeline" }, /Name the pipeline/);
  assert.throws(() => applyStageEdit({ modules: [] }, { stage: "sit", applies: "sealeye" }), /no path past dev/);
});

test("read from the library again, an edit stays while the library says what it said; once it changes, the library's reading stands, in a note", () => {
  const edited = applyStageEdit(draft(), { stage: "sit", applies: "sealeye", by: "greg@juniper.example", at });
  const same = keepStageEdits(edited, draft());
  assert.equal(sitOf(same.document).applies, "sealeye");
  assert.equal(sitOf(same.document).pipeline, undefined);
  assert.deepEqual(same.notes, []);

  const changed = draft();
  sitOf(changed).pipeline = ".github/workflows/sit.yml";
  const now = keepStageEdits(edited, changed);
  assert.deepEqual(sitOf(now.document), { name: "sit", applies: "pipeline", pipeline: ".github/workflows/sit.yml", gate: [] });
  assert.deepEqual(now.notes, ["The library now says the pipeline .github/workflows/sit.yml builds sit, so it does; this replaces the change greg@juniper.example made on Nov 1, 2026 at 21:40 UTC, which had seaLeye build it."]);
});

test("discovery keeps an edit through a rewrite from the library, and the self-test says whose choice it is", () => {
  const library = { stages: [
    { name: "dev", built_by: "not_said", gate: [] },
    { name: "sit", built_by: "pipeline", pipeline, gate: [] },
    { name: "prod", built_by: "pipeline", pipeline, gate: ["an approved change ticket"] }
  ] };
  const edited = applyStageEdit(provenStageMap(withStageMap(draft(), library)), { stage: "sit", applies: "sealeye", by: "greg@juniper.example", at });
  const rewritten = provenStageMap(withStageMap(edited, library));
  assert.equal(sitOf(rewritten).applies, "sealeye");
  assert.equal(sitOf(rewritten).edited.by, "greg@juniper.example");
  assert.deepEqual(stageEditNotes(rewritten), ["sit: built by seaLeye, as greg@juniper.example chose on Nov 1, 2026 at 21:40 UTC; the library says the pipeline .github/workflows/app-promote.yml builds it."]);
  const tested = selfTest({ document: rewritten, version: 2 });
  assert.ok(tested.notes.some(n => n.startsWith("sit: built by seaLeye, as greg@juniper.example chose")));
  assert.equal(tested.checks.find(c => c.id === "stages").passed, true);
});
