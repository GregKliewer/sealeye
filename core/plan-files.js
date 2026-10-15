// core/plan-files.js
// The two files an interview's plan is written down as: DEPLOYMENT_PLAN.md (the plan in
// the developer's language) and sealeye.yaml (the plan exactly as the model submitted
// it). `sealeye run` writes them into the developer's folder; the API sends the same
// text with the plan, so seaLeye.online offers the very files the command would write.
//
// DEPLOYMENT_PLAN.md takes its sections, their order and their names from
// prompts/plan-template.md; every word of plain language about a module comes from
// prompts/module-catalog.yaml, so the interview prompt and this renderer cannot
// describe the same module two different ways. No em dash: the developer reads this.
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { normalizeProfile, LEGACY_MODULE_IDS, MODULE_IDS, moduleIdSource } from "./schema.js";
import { buildableModules, catalogModuleIds, isBuildable, loadCatalog, unsupportedNeeds } from "./catalog.js";
import { repoRoot } from "./config.js";
import { CONFIG_FILE } from "./names.js";

export const PLAN_FILE = "DEPLOYMENT_PLAN.md";

export function loadTemplate() {
  return fs.readFileSync(path.join(repoRoot, "prompts", "plan-template.md"), "utf8");
}

export { loadCatalog };

/** Split the template on its horizontal rules: the preamble, then one block per section. */
function templateSections(template) {
  return template
    .split(/^---$/m)
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => {
      const heading = /^##\s+(.+)$/m.exec(block);
      return { heading: heading ? heading[1].trim() : null };
    });
}

/** "Notes (Optional)" is a note to whoever fills the template in, not a heading. */
function cleanHeading(heading) {
  return heading.replace(/\s*\(optional\)\s*$/i, "");
}

export const enabledModules = plan => (plan.modules || []).filter(m => m.enabled !== false);
const disabledModules = plan => (plan.modules || []).filter(m => m.enabled === false);
export const moduleById = (plan, id) => (plan.modules || []).find(m => m.id === id);
export const isEnabled = (plan, id) => enabledModules(plan).some(m => m.id === id);

const CORE_MODULES = ["static_site_edge", "http_api_serverless"];

export function coreModule(plan) {
  return enabledModules(plan).find(m => CORE_MODULES.includes(m.id));
}

/**
 * "Static Website" or "Node.js API", from the plan rather than from a guess.
 *
 * An app with neither core module is one that cannot start fresh for each request, so
 * it carries the continuous_service need instead. That is what it is called, and the
 * name comes from the need rather than from a module nobody can build.
 */
export function appTypeLabel(plan) {
  const core = coreModule(plan);

  if (!core) {
    if ((plan.needs || []).some(n => n.kind === "continuous_service")) {
      return "service that runs continuously";
    }
    return plan.app?.type === "static-site" ? "Static Website" : "service";
  }

  if (core.id === "static_site_edge") return "Static Website";

  const runtime = core.inputs?.runtime;
  return runtime === "python" ? "Python API" : "Node.js API";
}

function longDate(date) {
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function bullets(lines) {
  return lines.map(l => `- ${l}`).join("\n");
}

function inputLines(module) {
  const inputs = module.inputs || {};
  const keys = Object.keys(inputs);
  if (!keys.length) return "";

  const value = v => {
    if (Array.isArray(v)) return v.length ? v.join(", ") : "none";
    if (v && typeof v === "object") {
      const names = Object.keys(v);
      return names.length ? names.join(", ") : "none";
    }
    return v === null || v === undefined || v === "" ? "none" : String(v);
  };

  return ["", "", "Inputs:", ...keys.map(k => `- ${k}: ${value(inputs[k])}`)].join("\n");
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function preamble(ctx) {
  const drafted = unsupportedNeeds(ctx.plan).length > 0;
  const title = drafted ? "# Deployment Plan (draft)" : "# Deployment Plan";
  const meta = `${appTypeLabel(ctx.plan)} • Generated ${longDate(ctx.date)}`;

  // A draft says so before anything else. A developer who reads one line of this file
  // should not come away thinking something was built.
  const status = drafted
    ? "\n\nDrafted: seaLeye.run can build part of this today. The sections below say what it cannot build yet, and why."
    : "";

  return `${title}\n\n${meta}${status}`;
}

/**
 * What the app needs that no module supports, with the code that shows it.
 *
 * The line is the developer's sentence, the evidence is what was read in their folder,
 * and profile_expects is what their profile will ask of it once something supports it.
 * Nothing here is a module id, because nobody has seen the module yet.
 */
function whatItNeeds({ plan }) {
  const needs = unsupportedNeeds(plan);
  if (!needs.length) return null;

  return needs
    .map(need => {
      const lines = [`### ${need.line}`, "", "Found in your code:"];
      for (const e of need.evidence) lines.push(`- ${e.shows} (${e.file})`);
      if (need.profile_expects) {
        lines.push("", `What your ${normalizeProfile(plan.profile)} profile will expect of it: ${need.profile_expects}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

/** What a developer does with a draft, which is the only question a draft raises. */
function whatHappensNext({ plan }) {
  if (!unsupportedNeeds(plan).length) return null;

  return (
    "When your Platform Library has modules that support the needs above, run " +
    "`sealeye run` in this folder. seaLeye.run will read this draft, match the needs " +
    "to modules, and finish the plan. Until then nothing is deployed."
  );
}

/** What runs the app, which is not "on request" when nothing runs it on request. */
function backendLine(plan, isStatic, core) {
  if (isStatic) return "none, it runs entirely in the browser";
  if (core) return "your own code, running on request";
  return "your own code, running continuously";
}

function applicationSummary({ plan }) {
  const core = coreModule(plan);
  const isStatic = core?.id === "static_site_edge";
  const inputs = core?.inputs || {};

  const structure = isStatic
    ? [inputs.entry_point, ...(inputs.additional_pages || [])].filter(Boolean).join(", ") ||
      "the files in your folder"
    : inputs.entry_point || "your entry point";

  return bullets([
    `Type: ${appTypeLabel(plan)}`,
    `Name: ${plan.app?.name || "your app"}`,
    `Structure: ${structure}`,
    `Runtime: ${isStatic ? "browser" : inputs.runtime === "python" ? "python" : "node"}`,
    `Backend: ${backendLine(plan, isStatic, core)}`,
    `Build Step: ${isStatic ? "none required" : "none, your dependencies are installed for you"}`,
    `Profile: ${normalizeProfile(plan.profile) || "poc"}`
  ]);
}

function selectedModules({ plan, catalog }) {
  const order = ["static_site_edge", "http_api_serverless", "observability_basic", "config_basic"];
  const modules = enabledModules(plan).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

  return modules
    .map(module => {
      const entry = catalog.modules.find(m => m.id === module.id);
      const role = entry?.role === "core" ? "Core" : entry?.role === "shared" ? "Observability" : "Optional";
      const line = entry?.line?.trim() || "";
      return `### ${module.id} - ${role}\n${line}${inputLines(module)}`;
    })
    .join("\n\n");
}

function whatWillBeCreated({ plan }) {
  const core = coreModule(plan);
  const steps = [];

  if (core?.id === "static_site_edge") {
    steps.push("Your files are uploaded exactly as they are, with nothing added to your folder.");
    steps.push("A public address is created for them, with HTTPS already on.");
  } else if (core?.id === "http_api_serverless") {
    steps.push(
      "Your app is packaged with its dependencies installed for you. Your own folder is not touched."
    );
    steps.push("A secure HTTPS address is created, and your app answers requests at it.");
    steps.push("Your app starts when a request arrives and costs nothing while nothing is calling it.");
  }

  if (isEnabled(plan, "observability_basic")) {
    const days = moduleById(plan, "observability_basic")?.inputs?.retention_days || 30;
    steps.push(
      `Everything your app prints, and every request, error and response time, is collected and kept for ${days} days.`
    );
  }

  if (isEnabled(plan, "config_basic")) {
    const names = Object.keys(moduleById(plan, "config_basic")?.inputs?.variables || {});
    steps.push(
      names.length
        ? `The settings your app reads from its environment are passed to it when it runs: ${names.join(", ")}.`
        : "The settings your app reads from its environment are passed to it when it runs."
    );
  }

  // A plan with no public URL in its outputs has no address to hand back, so it is not
  // promised one.
  steps.push(
    (plan.outputs || []).includes("public_url")
      ? "You get the address back when it is live, and a report of what was created."
      : "You get a report of what was created."
  );

  const numbered = steps.map((s, i) => `${i + 1}. ${s}`).join("\n");

  // A draft describes what would be built, not what will be. Saying otherwise is the
  // whole failure this file exists to avoid.
  if (unsupportedNeeds(plan).length) {
    return (
      "This plan is a draft, so nothing is created while it stays one. " +
      "What seaLeye.run would build today, once the needs above are met:\n\n" +
      numbered
    );
  }

  return numbered;
}

function expectedOutput({ plan }) {
  const outputs = plan.outputs || [];
  const lines = [];

  if (outputs.includes("public_url")) {
    lines.push("Public URL: generated when the deployment finishes, HTTPS included. Shareable immediately.");
  }
  if (outputs.includes("logs") || outputs.includes("log_stream")) {
    lines.push("Logs: everything your app prints, from the first request, with no setup.");
  }
  if (outputs.includes("metrics") || outputs.includes("metrics_dashboard")) {
    lines.push("Metrics: requests, errors and response times, tracked automatically.");
  }

  return bullets(lines.length ? lines : ["Public URL: generated when the deployment finishes."]);
}

function modulesNotRequired({ plan, catalog }) {
  // Only modules seaLeye.run builds are ever named here. What the app needs beyond
  // them has its own section and is not a module that was "not required".
  const skipped = disabledModules(plan).filter(m => isBuildable(m.id, catalog));
  if (!skipped.length) return "Every module seaLeye.run builds is in use for this app.";

  return bullets(
    skipped.map(module => {
      const entry = catalog.modules.find(m => m.id === module.id);
      return `${module.id}: ${entry?.skip_line?.trim() || "not needed for this app."}`;
    })
  );
}

function notes({ summary, assumptions, notesKept }) {
  // A plan written down after the fact, for a deployment whose interview's summary and
  // assumptions the platform did not keep (a plan from a file, one changed with
  // Configure, or a deployment from before they were kept). It never claims that no
  // assumptions were needed: it says it does not know.
  if (notesKept === false) {
    return "This copy was written from the plan this deployment used. The interview's summary and assumptions are not part of this deployment's record, so they are not shown here.";
  }

  const lines = [];
  if (summary) lines.push(summary.trim(), "");

  if (assumptions?.length) {
    lines.push("Assumptions seaLeye.run made, and you can correct any of them:");
    lines.push(bullets(assumptions.map(a => a.trim())));
  } else {
    lines.push("No assumptions were needed: everything in this plan came from your folder or your answers.");
  }

  return lines.join("\n");
}

const SECTIONS = {
  "Application Summary": applicationSummary,
  "Selected Modules": selectedModules,
  "What Will Be Created": whatWillBeCreated,
  "Expected Output": expectedOutput,
  "What Your App Needs That No Module Supports Yet": whatItNeeds,
  "Modules Not Required": modulesNotRequired,
  "What Happens Next": whatHappensNext,
  Notes: notes
};

/**
 * DEPLOYMENT_PLAN.md, in the developer's language.
 *
 * @param {{plan: object, summary: string, assumptions: string[]}} submission
 */
export function renderPlanMarkdown(submission, { template = loadTemplate(), catalog = loadCatalog(), date = new Date() } = {}) {
  const ctx = { ...submission, catalog, date };
  const blocks = [];

  const seen = new Set();

  for (const [index, { heading }] of templateSections(template).entries()) {
    // The template rules off its own sub-blocks too (one per example module), so only
    // the first headingless block is the preamble; the rest are skeleton, not sections.
    if (heading === null) {
      if (index === 0) blocks.push(preamble(ctx));
      continue;
    }

    const name = cleanHeading(heading);
    if (seen.has(name)) continue;
    seen.add(name);

    const render = SECTIONS[name];
    if (!render) continue;   // a section the template names and the plan has nothing to say about

    const body = render(ctx);
    if (body === null) continue;   // a section only a draft has, on a plan that is not one

    blocks.push(`## ${name}\n\n${body}`);
  }

  const markdown = `${blocks.join("\n\n---\n\n")}\n`;

  // The one rule this file exists to keep. A module id in here that seaLeye.run cannot
  // build is a promise to a developer that nobody can keep, so it fails here, loudly,
  // rather than reaching their folder. Any id the catalog names, the four, and the ids
  // of plans before 0.4 are looked for; only what this catalog builds may appear.
  const stray = strayModule(markdown, catalog);
  if (stray) {
    throw new Error(
      `DEPLOYMENT_PLAN.md names ${stray}, which seaLeye.run does not build. ` +
        "Only " + buildableModules(catalog).map(m => m.id).join(", ") + " may appear in a plan file."
    );
  }

  return markdown;
}


/** The first module id in `text` that this catalog does not build, or null. */
function strayModule(text, catalog) {
  const ids = [...new Set([...MODULE_IDS, ...LEGACY_MODULE_IDS, ...catalogModuleIds(catalog)])];
  const pattern = new RegExp(`(?:${ids.map(moduleIdSource).join("|")})`, "g");
  for (const [match] of String(text).matchAll(pattern)) {
    const id = match.replace(/`/g, "");
    if (!isBuildable(id, catalog)) return id;
  }
  return null;
}

/** sealeye.yaml: the plan as submitted, nothing added. */
export function renderPlanYaml(plan) {
  return YAML.stringify(plan);
}


/** Both files, by name, as the command writes them and the portal offers them. */
export function planFiles(submission, options = {}) {
  return {
    [PLAN_FILE]: renderPlanMarkdown(submission, options),
    [CONFIG_FILE]: renderPlanYaml(submission.plan)
  };
}
