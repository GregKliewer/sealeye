// src/executor/report.js
// DEPLOYMENT_REPORT.md: what the developer got, in words they can act on.
// The header comes from prompts/report.md; everything below is built from the
// deployment record (real values, read back from CloudFormation) and the plan.
import fs from "node:fs";
import path from "node:path";

import { repoRoot } from "../../core/config.js";
import { normalizeProfile } from "../../core/schema.js";
import { region } from "./cfn.js";
import { sourceInWords } from "./settings.js";
import { commandLine } from "../../core/operations.js";

const TEMPLATE_PATH = path.join(repoRoot, "prompts", "report.md");

const get = (obj, dotted) => dotted.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);

/** Fill {{app.name}}-style placeholders in the header. Unknown keys become empty. */
function fillHeader(template, context) {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const value = get(context, key);
    return value === undefined || value === null ? "" : String(value);
  });
}

function fence(command) {
  return ["```", command, "```"].join("\n");
}

/**
 * What the developer now has, for an environment built from the organization's own
 * module (PHASE4-PLAN Step 9): in their words, with the module's folder named, and no
 * product name (principle 8).
 */
function whatWasCreatedFromModule(record) {
  const t = record.terraform || {};
  const o = record.outputs || {};
  const lines = ["## What was created", ""];
  if (record.kind === "static") {
    lines.push(
      "- A public website, served over HTTPS from your organization's content network. Anyone with the link can open it.",
      `- The storage holding your files${o.BucketName ? ` (bucket \`${o.BucketName}\`)` : ""}, which only the website can read.`
    );
  } else {
    lines.push(
      "- A public HTTPS address for your app. There is no server for you to run, patch or scale.",
      `- Your app running unchanged on Node.js 20, started from \`${record.entryPoint || "index.js"}\`. The platform's adapter starts it and hands it each request.`
    );
  }
  // Each module the app uses, built beside it, and where the app finds it.
  const finds = Object.entries(t.settings || {});
  for (const p of t.parts || []) {
    const what = String(p.line || `The module ${p.id}`).trim().replace(/[.!?]+$/, "");
    const names = finds.filter(([, from]) => String(from).startsWith(`${p.id}.`)).map(([setting]) => `\`${setting}\``);
    lines.push(`- ${what}${names.length ? `, which your app finds through ${names.join(" and ")}` : ""}. Your app is given what it needs to use it, and nothing more.`);
  }
  lines.push(
    "",
    ...versionChangeLines(t.module?.versionChange),
    `All of it was built from your organization's own module, \`${t.module?.source || "its module"}\` in ${t.module?.repo || "its platform library"}${t.module?.version ? `, version ${t.module.version}` : ""}${t.module?.commit ? ` at ${t.module.commit.slice(0, 12)}` : ""}, as one environment, \`${record.stackName}\`, in ${region()}. Tearing it down removes everything above and nothing else.`
  );
  return lines.join("\n");
}

/**
 * A newer release of the module than the environment had (api/executor/terraform/
 * versions.js): which, and what its changelog says changed, in the library's words.
 */
function versionChangeLines(change) {
  if (!change?.from || !change?.to) return [];
  return [
    `This deploy moved your environment from version ${change.from} of your organization's module to ${change.to}.${change.changes?.length ? " Its changelog says:" : " Its changelog says nothing about the change."}`,
    ...(change.changes || []).map(c => `- ${c}`),
    ""
  ];
}

/** What the developer now has, named in their terms with the AWS name in brackets. */
function whatWasCreated(record) {
  if (record.backend === "terraform") return whatWasCreatedFromModule(record);
  const o = record.outputs || {};
  const lines = ["## What was created", ""];

  if (record.kind === "static") {
    lines.push(
      "- A public website, served straight from storage. Anyone with the link can open it.",
      `- The storage holding your files (bucket \`${o.BucketName || "—"}\`).`
    );
  } else {
    const retention = record.parameters?.RetentionDays;
    lines.push(
      "- A public HTTPS address for your app. There is no server for you to run, patch or scale.",
      `- Your app running unchanged on Node.js 20 (function \`${o.FunctionName || record.app?.name}\`). The platform starts it with \`node index.js\` and hands it real HTTP requests.`,
      `- Somewhere to read what your app printed (log group \`${o.LogGroup || "—"}\`${retention ? `, kept for ${retention} days` : ""}).`
    );
  }

  lines.push(
    "",
    `All of it is one CloudFormation stack, \`${record.stackName}\`, in ${region()}. Deleting that stack deletes everything above and nothing else.`
  );
  return lines.join("\n");
}

function yourUrl(record) {
  const url = record.outputs?.ApiUrl || record.outputs?.WebsiteUrl;
  const lines = ["## Your URL", "", url ? url : "_No URL was returned by this deployment._"];

  // Say it where the address is, not three sections away: the http:// is the first
  // thing anyone notices.
  if (url && record.kind === "static" && record.backend !== "terraform") {
    lines.push(
      "",
      "That address is `http://`, not `https://`. This profile serves your files straight out of storage with no CDN in front of them, and a storage-hosted site is plain HTTP. The CDN is what adds `https://` and your own domain name — it is a deliberate omission here, not something that went wrong."
    );
  }

  return lines.join("\n");
}

function logs(record) {
  const logGroup = record.outputs?.LogGroup;
  const lines = ["## Logs", ""];
  if (record.backend === "terraform") {
    lines.push(record.kind === "static"
      ? "A static site has no application logs: nothing of yours is running."
      : "What your app prints is kept by your organization's platform. Reading it through seaLeye is not available for an environment built from your organization's modules yet; ask your platform team.");
    return lines.join("\n");
  }

  if (logGroup) {
    lines.push(
      "Everything your app prints goes here. Follow it live with:",
      "",
      fence(`aws logs tail ${logGroup} --follow`)
    );
  } else {
    lines.push(
      "A static site has no application logs — nothing of yours is running. Requests are served directly from storage."
    );
  }
  return lines.join("\n");
}

/**
 * What the app was given, by name only. A report is a file the developer keeps and
 * hands to whoever asks what this environment is, so it says which settings reached the
 * app and says nothing at all about what they contain.
 */
function settings(record) {
  const passed = record.settings || [];
  if (!passed.length) return null;

  const lines = [
    "## Settings",
    "",
    "Your app was started with these settings in its environment. Their values are not in this report, not in your plan file, and not in anything seaLeye.run stores:",
    ""
  ];

  for (const setting of passed) {
    lines.push(
      `- \`${setting.name}\`: value redacted, taken from ${sourceInWords(setting.source, { forDeveloper: true })}`
    );
  }

  lines.push(
    "",
    "`PORT` is not one of them. The platform chooses the port and tells your app what it is."
  );

  return lines.join("\n");
}

function redeploy(record) {
  const what = record.kind === "static" ? "your files" : "your code";
  return [
    "## Redeploy",
    "",
    `Change ${what}, then run \`sealeye deploy\` again in this folder. The URL stays the same — it belongs to the environment, not to any one deployment.`
  ].join("\n");
}

function tearDown(record) {
  return [
    "## Tear down",
    "",
    "When you are finished with this environment:",
    "",
    fence(commandLine("teardown", record.deploymentId)),
    "",
    record.backend === "terraform" ? "That removes the environment and everything in it." : "That deletes the stack and everything in it."
  ].join("\n");
}

/**
 * Where the fuller record lives. Two sentences: the report is what the developer got,
 * the evidence is what a change board asks for, and the evidence never carries a value.
 */
function changeRecord(record) {
  return [
    "## Change record",
    "",
    `When someone asks what was built and why, \`sealeye evidence ${record.app?.name}\` writes DEPLOYMENT_EVIDENCE.md in this folder from seaLeye.run's records and ${record.backend === "terraform" ? "from the platform's record of the environment" : "from CloudFormation"}: who asked, what they answered, what was approved, what was built, and what AWS says about it now. It never contains a setting's value.`
  ].join("\n");
}

function assumptions(record, plan) {
  const lines = [
    "## Assumptions carried from the plan",
    "",
    "These came from your answers, not from anything seaLeye.run guessed for you:",
    ""
  ];

  if (plan?.profile) lines.push(`- Profile: \`${normalizeProfile(plan.profile)}\``);

  const modules = (plan?.modules || []).filter(m => m.enabled !== false);
  if (modules.length) {
    lines.push("- What you asked for:");
    for (const m of modules) {
      const inputs = Object.entries(m.inputs || {})
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      lines.push(`  - \`${m.id}\`${inputs ? ` — ${inputs}` : ""}`);
    }
  }

  if (plan?.outputs?.length) lines.push(`- Outputs you asked for: ${plan.outputs.join(", ")}`);

  lines.push(`- Region: ${region()} — fixed for this environment.`);
  if (record.paused) {
    lines.push("- Your app is paused: it was paused before this deploy and still takes no requests. Resume it to put it back (sealeye resume, or Pause in the portal).");
  }
  if (record.source === "again") {
    lines.push(`- Deployed again: the code \`${record.packagedBy || record.fromDeployment}\` packaged (artifact \`${record.artifactKey}\`), with nothing uploaded and no .env read: settings came from the organization's store.`);
  } else if (record.appPath) {
    lines.push(
      `- Deployed from \`${record.appPath}\`${record.artifactKey ? ` (artifact \`${record.artifactKey}\`)` : ""}.`
    );
  }
  lines.push(
    record.kind === "static"
      ? "- Your files were not modified. seaLeye.run uploaded a copy of them. This report is the only file it writes into your folder."
      : `- Your app was not modified. The start script${record.backend === "terraform" ? " and the adapter" : ""} the platform needs ${record.backend === "terraform" ? "were" : "was"} added to the uploaded copy, not to your source. This report is the only file seaLeye.run writes into your folder.`
  );
  lines.push(
    "- Secret files (.env, .env.production, keys and credentials) were left out of what was packaged. Settings reach your app from the organization's store or with the deploy, never inside the code."
  );

  return lines.join("\n");
}

/**
 * Render the full report for a succeeded deployment.
 * @returns {string} markdown
 */
export function renderReport(record, plan) {
  const header = fillHeader(fs.readFileSync(TEMPLATE_PATH, "utf8"), {
    app: record.app,
    profile: normalizeProfile(plan?.profile) || "",
    region: region(),
    date: (record.finishedAt || new Date().toISOString()).slice(0, 10)
  });

  const sections = [
    whatWasCreated(record),
    yourUrl(record),
    logs(record),
    settings(record),
    redeploy(record),
    tearDown(record),
    changeRecord(record),
    assumptions(record, plan)
  ].filter(Boolean);   // a deployment with no settings has no Settings section

  return `${header.replace(/\s+$/, "")}\n\n${sections.join("\n\n")}\n`;
}
