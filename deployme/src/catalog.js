// src/catalog.js
// prompts/module-catalog.yaml, read fresh each time. It is the one place that says what
// this version of the platform can build and what it can only write down, so the API
// refuses against it, the card marks against it, and the interview's language comes
// from it. Not cached: the file is small, the calls are rare, and an edit during a
// working day should take effect without restarting anything.
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { repoRoot } from "./executor/env.js";
import { normalizeProfile } from "./schema.js";

export function loadCatalog() {
  return YAML.parse(fs.readFileSync(path.join(repoRoot, "prompts", "module-catalog.yaml"), "utf8"));
}

export function moduleEntry(id, catalog = loadCatalog()) {
  return (catalog.modules || []).find(m => m.id === id) || null;
}

export function profileEntry(id, catalog = loadCatalog()) {
  return (catalog.profiles || []).find(p => p.id === id) || null;
}

/** A catalog line, on one line: the card and the refusal both want the first sentence. */
export function firstSentence(text) {
  const whole = String(text || "").replace(/\s+/g, " ").trim();
  return (whole.match(/^.*?\.(?=\s|$)/) || [whole])[0].trim();
}

/**
 * What a plan asks for that this version does not build: the planned modules it
 * enables, and a profile whose patterns the platform does not apply.
 *
 * A plan can be entirely valid and still ask for these. That is the point of a
 * library: the plan is the honest record of what the app needs, and the platform says
 * which parts of it exist today rather than deploying something smaller and reporting
 * success.
 */
export function notDeployable(plan, catalog = loadCatalog()) {
  const buildable = new Set(
    (catalog.modules || []).filter(m => m.availability === "real").map(m => m.id)
  );

  const modules = (plan?.modules || [])
    .filter(m => m && m.enabled !== false && !buildable.has(m.id))
    .map(m => {
      const entry = moduleEntry(m.id, catalog);
      return { id: m.id, line: firstSentence(entry?.line) };
    });

  // A module's first sentence is its description. A profile's first sentence is only
  // its framing, and the patterns are the sentence after it, so a profile keeps both.
  const asked = normalizeProfile(plan?.profile);
  const entry = profileEntry(asked, catalog);
  const profile =
    entry && entry.availability !== "real"
      ? { id: asked, line: String(entry.line || "").replace(/\s+/g, " ").trim() }
      : null;

  return { modules, profile };
}
