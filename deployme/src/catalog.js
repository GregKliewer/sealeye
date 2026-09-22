// src/catalog.js
// prompts/module-catalog.yaml, read fresh each time. It is the one place that says what
// this version of the platform can build and what it can only write down, so the API
// refuses against it, the card marks against it, and the interview's language comes
// from it. Not cached: the file is small, the calls are rare, and an edit during a
// working day should take effect without restarting anything.
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { repoRoot, loadUserConfig } from "./executor/env.js";
import { normalizeProfile } from "./schema.js";

/**
 * The organization the developer belongs to, for the messages that name one. From
 * ~/.deployme/config, because whose platform library this is belongs to the person
 * running the command and never to a line of code.
 */
export function orgName() {
  loadUserConfig();
  return process.env.ORG || "your organization";
}

/** The fixed closing paragraph of the refusal, so the words can change without code. */
export function refusalClosing(org = orgName()) {
  const file = path.join(repoRoot, "prompts", "refusal.md");
  return fs.readFileSync(file, "utf8").trim().split("{{org}}").join(org);
}

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
      // The refusal reads as a list, so it takes the short form; the long sentence is
      // what the card and the plan file use.
      return { id: m.id, line: entry?.short_line || firstSentence(entry?.line) };
    });

  // A profile's first sentence is who it is for; the patterns are what follows. The
  // refusal lists what is missing, so it takes the patterns and leaves the framing, in
  // the same voice as the module lines beside it.
  const asked = normalizeProfile(plan?.profile);
  const entry = profileEntry(asked, catalog);
  const whole = String(entry?.line || "").replace(/\s+/g, " ").trim();
  const patterns = whole.replace(/^[^.]*\.\s*/, "") || whole;
  const profile =
    entry && entry.availability !== "real"
      ? { id: asked, line: patterns.charAt(0).toLowerCase() + patterns.slice(1) }
      : null;

  return { modules, profile };
}

/** The module's line in one sentence, for places that list many of them at once. */
const oneLine = text => firstSentence(String(text || "").replace(/\s+/g, " ").trim());

/**
 * The catalog as the interview reads it: every module with what it is, when it applies
 * and what in a folder points at it, then the profiles and their patterns.
 *
 * Generated rather than written out in the prompt, because a module that exists in two
 * places eventually says two different things, and the one the developer hears would be
 * the copy nobody updated.
 */
export function catalogForPrompt(catalog = loadCatalog()) {
  const lines = ["### Modules", ""];

  for (const m of catalog.modules || []) {
    const inputs = Object.entries(m.inputs || {})
      .map(([name, spec]) => `${name} (${JSON.stringify(spec?.default ?? null)})`)
      .join(", ");

    lines.push(`- **${m.id}**  ${m.availability}  ${m.role}`);
    lines.push(`  ${oneLine(m.line)}`);
    if (m.when) lines.push(`  When: ${String(m.when).replace(/\s+/g, " ").trim()}`);
    if (m.signals?.length) lines.push(`  In the folder: ${m.signals.join("; ")}.`);
    if (inputs) lines.push(`  Inputs and defaults: ${inputs}.`);
    lines.push("");
  }

  lines.push("### Profiles", "");
  for (const p of catalog.profiles || []) {
    lines.push(`- **${p.id}**  ${p.availability}  ${String(p.line).replace(/\s+/g, " ").trim()}`);
  }

  lines.push("", "### Patterns each profile applies", "");
  for (const [id, block] of Object.entries(catalog.patterns || {})) {
    lines.push(`**${id}**: ${String(block.line).replace(/\s+/g, " ").trim()}`);
    for (const [moduleId, text] of Object.entries(block.modules || {})) {
      lines.push(`- ${moduleId}: ${String(text).replace(/\s+/g, " ").trim()}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

/** The patterns a profile applies to the modules a plan enables, for the card. */
export function patternsFor(plan, catalog = loadCatalog()) {
  const profile = normalizeProfile(plan?.profile);
  const block = (catalog.patterns || {})[profile];
  if (!block) return [];

  const enabled = new Set((plan?.modules || []).filter(m => m && m.enabled !== false).map(m => m.id));

  return Object.entries(block.modules || {})
    .filter(([id]) => enabled.has(id))
    .map(([id, text]) => ({ id, line: String(text).replace(/\s+/g, " ").trim() }));
}
