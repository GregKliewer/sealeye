// src/catalog.js
// prompts/module-catalog.yaml, read fresh each time. It is the one place that says what
// this version of the platform can build and what it can only write down, so the API
// refuses against it, the card marks against it, and the interview's language comes
// from it. Not cached: the file is small, the calls are rare, and an edit during a
// working day should take effect without restarting anything.
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { repoRoot, loadUserConfig } from "./config.js";
import { normalizeProfile } from "./schema.js";

/**
 * The organization the developer belongs to, for the messages that name one. From
 * ~/.sealeye/config, because whose platform library this is belongs to the person
 * running the command and never to a line of code.
 */
export function orgName() {
  loadUserConfig();
  return process.env.ORG || "your organization";
}

/**
 * The fixed closing paragraph of the refusal, so the words can change without code.
 * It says what would make the plan buildable and never when, because seaLeye.run does
 * not know when and will not guess in front of a developer.
 */
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
 * What the app needs that no module supports yet.
 *
 * A plan can be entirely valid and still carry these. That is the point: the plan is
 * the honest record of what the app needs, and the platform says which parts of it it
 * can build rather than deploying something smaller and reporting success.
 *
 * A profile is never in here. Whatever a plan is designed for, this run builds a dev
 * environment, and the patterns a dev or prod profile asks for are what the pipeline
 * applies to the environments it builds later.
 */
export function unsupportedNeeds(plan) {
  return (plan?.needs || []).map(need => ({
    kind: need.kind,
    line: need.line,
    evidence: need.evidence || [],
    profile_expects: need.profile_expects || null
  }));
}

/** The evidence for a need, as one phrase, for places that show it beside the line. */
export function evidencePhrase(need) {
  return (need?.evidence || [])
    .map(e => (e.file ? `${e.shows} (${e.file})` : e.shows))
    .join("; ");
}

/** The fixed need kinds, as the interview and the renderer read them. */
export function needKinds(catalog = loadCatalog()) {
  return catalog.need_kinds || [];
}

/** What a profile will expect of a need, in the catalog's own words. */
export function profileExpectsFor(kind, profile, catalog = loadCatalog()) {
  const entry = needKinds(catalog).find(n => n.key === kind);
  return entry?.profile_expects?.[normalizeProfile(profile)] || null;
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
  const lines = ["### Modules seaLeye.run builds", ""];

  for (const m of catalog.modules || []) {
    const inputs = Object.entries(m.inputs || {})
      .map(([name, spec]) => `${name} (${JSON.stringify(spec?.default ?? null)})`)
      .join(", ");

    lines.push(`- **${m.id}**  ${m.role}`);
    lines.push(`  ${oneLine(m.line)}`);
    if (m.when) lines.push(`  When: ${String(m.when).replace(/\s+/g, " ").trim()}`);
    if (m.signals?.length) lines.push(`  In the folder: ${m.signals.join("; ")}.`);
    if (inputs) lines.push(`  Inputs and defaults: ${inputs}.`);
    lines.push("");
  }

  // The need kinds are a fixed list so the same need reads the same way every run.
  // The key is yours; the line is the developer's.
  lines.push("### Need kinds, for what no module above supports", "");
  for (const n of catalog.need_kinds || []) {
    lines.push(`- **${n.key}**  "${String(n.line).trim()}"`);
    if (n.signals?.length) lines.push(`  In the folder: ${n.signals.join("; ")}.`);
    for (const [profile, text] of Object.entries(n.profile_expects || {})) {
      lines.push(`  ${profile} expects: ${String(text).replace(/\s+/g, " ").trim()}`);
    }
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
