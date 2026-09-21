// src/interview/render.js
// The two files `sealeye init` writes into the developer's folder, and nothing else
// writes there: DEPLOYMENT_PLAN.md (the plan in their language) and deployme.yaml
// (the plan exactly as the model submitted it).
//
// DEPLOYMENT_PLAN.md takes its sections, their order and their names from
// prompts/plan-template.md; every word of plain language about a module comes from
// prompts/module-catalog.yaml, so the interview prompt and this renderer cannot
// describe the same module two different ways. No em dash: the developer reads this.
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { repoRoot } from "../executor/env.js";

const PLAN_FILE = "DEPLOYMENT_PLAN.md";
const CONFIG_FILE = "deployme.yaml";

export function loadTemplate() {
  return fs.readFileSync(path.join(repoRoot, "prompts", "plan-template.md"), "utf8");
}

export function loadCatalog() {
  return YAML.parse(fs.readFileSync(path.join(repoRoot, "prompts", "module-catalog.yaml"), "utf8"));
}

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

const enabledModules = plan => (plan.modules || []).filter(m => m.enabled !== false);
const disabledModules = plan => (plan.modules || []).filter(m => m.enabled === false);
const moduleById = (plan, id) => (plan.modules || []).find(m => m.id === id);
const isEnabled = (plan, id) => enabledModules(plan).some(m => m.id === id);

function coreModule(plan) {
  return enabledModules(plan).find(
    m => m.id === "static_site_edge" || m.id === "http_api_serverless"
  );
}

/** "Static Website" or "Node.js API", from the plan rather than from a guess. */
function appTypeLabel(plan) {
  const core = coreModule(plan);
  if (!core) return plan.app?.type === "static-site" ? "Static Website" : "Application";
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
  return `# Deployment Plan\n\n${appTypeLabel(ctx.plan)} • Generated ${longDate(ctx.date)}`;
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
    `Backend: ${isStatic ? "none, it runs entirely in the browser" : "your own code, running on request"}`,
    `Build Step: ${isStatic ? "none required" : "none, your dependencies are installed for you"}`,
    `Profile: ${plan.profile || "poc"}`
  ]);
}

function selectedModules({ plan, catalog }) {
  const order = ["static_site_edge", "http_api_serverless", "observability_basic", "config_basic", "domain_public"];
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

  steps.push("You get the address back when it is live, and a report of what was created.");

  return steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
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
  const skipped = disabledModules(plan);
  if (!skipped.length) return "Every module in the catalog is in use for this app.";

  return bullets(
    skipped.map(module => {
      const entry = catalog.modules.find(m => m.id === module.id);
      return `${module.id}: ${entry?.skip_line?.trim() || "not needed for this app."}`;
    })
  );
}

function notes({ summary, assumptions }) {
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
  "Modules Not Required": modulesNotRequired,
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

    blocks.push(`## ${name}\n\n${render(ctx)}`);
  }

  return `${blocks.join("\n\n---\n\n")}\n`;
}

/** deployme.yaml: the plan as submitted, nothing added. */
export function renderPlanYaml(plan) {
  return YAML.stringify(plan);
}

/**
 * Write both files into the developer's folder. Called only after the interview has a
 * valid plan, and before the developer is asked whether to deploy.
 *
 * @returns {{planPath: string, configPath: string}}
 */
export function writeInterviewFiles(appPath, submission, options = {}) {
  const planPath = path.join(appPath, PLAN_FILE);
  const configPath = path.join(appPath, CONFIG_FILE);

  fs.writeFileSync(planPath, renderPlanMarkdown(submission, options));
  fs.writeFileSync(configPath, renderPlanYaml(submission.plan));

  return { planPath, configPath };
}
