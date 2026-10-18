// src/executor/evidence.js
// DEPLOYMENT_EVIDENCE.md: the change record for one environment, and the object it is
// rendered from. Every value is read from the deployment record, from a file
// seaLeye.run wrote, or from AWS at the moment of generation. Nothing is typed in, and
// a value that could not be read says so in words rather than being guessed. No
// setting's value appears anywhere in here: names only, "value redacted" where a value
// would be. No em dash: a bank reads this.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { repoRoot } from "../../core/config.js";
import { region, describe, stackEvents, stackTemplate, stackParameters } from "./cfn.js";
import { sha256Text } from "./package.js";
import { normalizeProfile } from "../../core/schema.js";
import { patternsFor } from "../../core/catalog.js";
import { catalogOfRecord } from "../catalogs.js";
import { listDeployments } from "../store.js";
import { sourceInWords } from "./settings.js";
import { checkTerraformNow } from "./terraform/index.js";
import { withPlatform } from "../platform.js";

const TEMPLATE_PATH = path.join(repoRoot, "prompts", "evidence.md");
const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

const NOT_RECORDED = "not recorded before 2.16.0";
const WINDOW_MS = 5 * 60 * 1000;   // five minutes either side of a deployment
const PROBE_MS = 10_000;

const get = (obj, dotted) => dotted.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);

function fillHeader(template, context) {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const value = get(context, key);
    return value === undefined || value === null ? "" : String(value);
  });
}

const ms = iso => (iso ? new Date(iso).getTime() : NaN);

function durationSeconds(startedAt, finishedAt) {
  const a = ms(startedAt);
  const b = ms(finishedAt);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.round((b - a) / 1000));
}

/** The developer's own URL, if the environment has one. */
function publicUrl(record) {
  return record?.outputs?.ApiUrl || record?.outputs?.WebsiteUrl || null;
}

/** A path under the repo, relative to it, so the file does not carry a home directory. */
function relativeToRepo(p) {
  if (!p) return null;
  const rel = path.relative(repoRoot, p);
  return rel.startsWith("..") ? p : rel;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function subjectOf(record, generatedAt) {
  return {
    deploymentId: record.deploymentId,
    app: record.app || null,
    kind: record.kind || (record.status === "drafted" ? "none built" : NOT_RECORDED),
    stackName: record.stackName || null,
    profile: normalizeProfile(record.plan?.profile) || NOT_RECORDED,
    region: region(),
    status: record.status,
    sealeyeVersion: pkg.version,
    generatedAt
  };
}

/** "Greg Kliewer (greg@...) on greg-mac", or as much of it as was recorded. */
export function personOnHost(by) {
  const person = by.name ? `${by.name} (${by.user})` : by.user;
  return by.host ? `${person} on ${by.host}` : person;
}

function requestedOf(record) {
  const origin = record.origin || null;
  return {
    requestedBy: record.requestedBy || NOT_RECORDED,
    requestedByNote: record.requestedBy?.verified === "token"
      ? "the person from their seaLeye token, checked by the platform; the machine as the command line reported it"
      : "reported by the command line on the developer's machine, not verified by the platform",
    startedAt: record.startedAt || NOT_RECORDED,
    finishedAt: record.finishedAt || (record.status === "drafted" ? record.startedAt : null) || NOT_RECORDED,
    durationSeconds: durationSeconds(record.startedAt, record.finishedAt) ?? NOT_RECORDED,
    origin: origin
      ? {
          // A deployment made in the portal has no command: null says so (Step 15).
          command: origin.command || (record.surface === "portal" ? null : NOT_RECORDED),
          planSource: origin.planSource || NOT_RECORDED,
          file: origin.file || null,
          answers: Array.isArray(origin.answers) ? origin.answers : null,
          // Deployed again (PHASE2-PLAN Step 14): whose code, and whether a plan came with it.
          ...(origin.planSource === "again" ? { command: origin.command || null, fromDeployment: origin.fromDeployment || NOT_RECORDED, packagedBy: origin.packagedBy || origin.fromDeployment || NOT_RECORDED, planGiven: origin.planGiven === true } : {})
        }
      : NOT_RECORDED
  };
}

/** The plan as approved. Setting values never come through here. */
function approvedOf(record) {
  const plan = record.plan || null;
  if (!plan) {
    return {
      planSha256: record.planSha256 || NOT_RECORDED,
      profile: NOT_RECORDED,
      modules: NOT_RECORDED,
      patterns: NOT_RECORDED,
      needs: []
    };
  }

  const modules = (plan.modules || [])
    .filter(m => m && m.enabled !== false)
    .map(m => {
      const inputs = { ...(m.inputs || {}) };
      if (m.id === "config_basic" && inputs.variables && typeof inputs.variables === "object") {
        inputs.variables = Object.fromEntries(Object.keys(inputs.variables).map(name => [name, "value redacted"]));
      }
      return { id: m.id, inputs };
    });

  let patterns;
  try {
    // The catalog the record was planned against, never whichever is live now.
    const catalog = catalogOfRecord(record);
    patterns = catalog ? patternsFor(plan, catalog) : `not read: the catalog this deployment was planned against (version ${record.catalog?.version}) is not held by the platform`;
  } catch (err) {
    patterns = `not read: ${err.message}`;
  }

  return {
    planSha256: record.planSha256 || NOT_RECORDED,
    profile: normalizeProfile(plan.profile) || NOT_RECORDED,
    modules,
    patterns,
    needs: (record.needs || plan.needs || []).map(n => ({
      line: n.line,
      evidence: n.evidence || [],
      profile_expects: n.profile_expects || null
    }))
  };
}

const DRAFT_SENTENCE = "Nothing was built. seaLeye.run declined the plan and saved the draft.";

async function builtOf(record, events) {
  if (record.status === "drafted") return { none: true, sentence: DRAFT_SENTENCE };

  const from = ms(record.startedAt) - WINDOW_MS;
  const to = (Number.isNaN(ms(record.finishedAt)) ? Date.now() : ms(record.finishedAt)) + WINDOW_MS;

  const inWindow = events.ok
    ? events.events.filter(e => {
        const t = ms(e.at);
        return !Number.isNaN(from) && t >= from && t <= to;
      })
    : null;

  return {
    none: false,
    stackName: record.stackName || NOT_RECORDED,
    templatePath: relativeToRepo(record.templatePath) || NOT_RECORDED,
    templateSha256: record.templateSha256 || (record.templateSha256Error ? `not recorded: ${record.templateSha256Error}` : NOT_RECORDED),
    artifactKey: record.artifactKey || (record.kind === "static" ? "none: a static site has no artifact" : NOT_RECORDED),
    artifactSha256:
      record.artifactSha256 ||
      (record.kind === "static"
        ? "none: a static site has no artifact"
        : record.artifactSha256Error
          ? `not recorded: ${record.artifactSha256Error}`
          : NOT_RECORDED),
    parameterNames: record.parameters ? Object.keys(record.parameters).sort() : NOT_RECORDED,
    settingNames: (record.settings || []).map(s => ({ name: s.name, source: s.source, value: "value redacted" })),
    secretScan: secretScanOf(record),
    outputs: record.outputs || {},
    events: inWindow === null
      ? `not checked: ${events.error}`
      : inWindow.map(e => ({ time: e.at, resource: e.logicalId, type: e.type, status: e.status, reason: e.reason }))
  };
}

/**
 * What was built for a Terraform environment (PHASE4-PLAN Step 9): the organization's
 * module, from which commit of its library, by which OpenTofu and provider, from which
 * root module, and what the apply did, read from the record.
 */
function builtOfTerraform(record) {
  if (record.status === "drafted") return { none: true, sentence: DRAFT_SENTENCE };
  const t = record.terraform || {};
  if (!t.module) return { none: true, sentence: "Nothing was built: the deployment stopped before the module was fetched." };
  return {
    none: false,
    terraform: true,
    environment: record.stackName || NOT_RECORDED,
    module: { id: t.module.id, source: t.module.source, repo: t.module.repo, commit: t.module.commit },
    tofuVersion: t.tofuVersion || NOT_RECORDED,
    providerVersion: t.providerVersion || NOT_RECORDED,
    rootSha256: t.rootSha256 || NOT_RECORDED,
    stateKey: t.stateKey || NOT_RECORDED,
    inputs: (t.inputs || []).map(i => ({ name: i.name, source: i.source, ...(i.from ? { from: i.from } : {}) })),
    ignoredInputs: t.ignoredInputs || [],
    artifactKey: record.artifactKey || (record.kind === "static" ? "none: a static site has no artifact" : NOT_RECORDED),
    artifactSha256: record.artifactSha256 || (record.kind === "static" ? "none: a static site has no artifact" : record.artifactSha256Error ? `not recorded: ${record.artifactSha256Error}` : NOT_RECORDED),
    entryPoint: record.entryPoint || null,
    planned: t.planned || "not recorded",
    applied: t.applied || "not recorded",
    resources: t.resources || [],
    secretScan: secretScanOf(record),
    outputs: record.moduleOutputs || {}
  };
}

/** Checked now, for a Terraform environment: the state, and anything changed outside seaLeye. */
async function checkedNowOfTerraform(record) {
  if (record.status === "drafted" || !record.terraform?.stateKey) {
    return { none: true, sentence: "Nothing to check. Nothing was built for this plan." };
  }
  const gone = record.status === "destroyed";
  const checked = gone ? { ok: false, error: "the environment was torn down" } : await checkTerraformNow(record, withPlatform(record.orgId || "default", catalogOfRecord(record)));
  const answered = !gone ? await probe(publicUrl(record)) : { url: publicUrl(record), error: "the environment was torn down" };
  return {
    none: false,
    terraform: true,
    state: checked.ok ? { resources: checked.resources } : { error: `not checked: ${checked.error}` },
    changesOutside: checked.ok ? checked.drift : `not checked: ${checked.error}`,
    changesOutsideNote: "as OpenTofu finds them by reading each part of the environment now, read-only, leaving out what the cloud sets itself (an empty value read back as an empty list, the deployment of a stage that deploys itself, and a policy the environment's own parts set, read back on its role or bucket)",
    answered
  };
}

/**
 * How the code was checked for secrets before it was packaged (PHASE3-PLAN Step 2), and
 * what the developer's .sealeye-allow let through: file, line and rule, never a value.
 */
function secretScanOf(record) {
  const scan = record.secretScan;
  if (!scan) return "not recorded: this deployment was made before seaLeye checked code for secrets";
  return {
    by: scan.gitleaks === "ran" ? "seaLeye's own rules and gitleaks" : "seaLeye's own rules only (gitleaks is not installed where this platform runs)",
    ...(scan.scannedBy ? { scannedBy: scan.scannedBy } : {}),
    allowed: (scan.allowed || []).map(a => `${a.file}:${a.line}:${a.rule}`)
  };
}

/** One GET of the environment's URL, ten seconds, one retry, and nothing else. */
async function probe(url) {
  if (!url) return { url: null, error: "no URL on the record" };

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_MS);
    const started = Date.now();
    try {
      const res = await fetch(url, { method: "GET", signal: controller.signal, redirect: "manual" });
      clearTimeout(timer);
      return { url, status: res.status, ms: Date.now() - started };
    } catch (err) {
      clearTimeout(timer);
      if (attempt === 1) return { url, error: err.name === "AbortError" ? `no answer within ${PROBE_MS / 1000} seconds` : err.message };
    }
  }
  return { url, error: "no answer" };
}

/** Stack-level completions not within five minutes of any deployment to this stack. */
function changesOutside(events, siblings, stackName) {
  if (!events.ok) return `not checked: ${events.error}`;

  const finishes = siblings.map(s => ms(s.finishedAt)).filter(t => !Number.isNaN(t));

  return events.events
    .filter(e => e.logicalId === stackName && (e.status === "CREATE_COMPLETE" || e.status === "UPDATE_COMPLETE"))
    .filter(e => {
      const t = ms(e.at);
      return !finishes.some(f => Math.abs(t - f) <= WINDOW_MS);
    })
    .map(e => ({ time: e.at, status: e.status, reason: e.reason }));
}

async function checkedNowOf(record, events, siblings) {
  if (record.status === "drafted" || !record.stackName) {
    return { none: true, sentence: "Nothing to check. No stack was created for this plan." };
  }

  let stack;
  try {
    stack = await describe(record.stackName);
  } catch (err) {
    stack = { status: null, error: err.message };
  }

  const exists = stack.status !== null && stack.status !== undefined;

  let template;
  if (!exists) {
    template = { result: "not compared", reason: stack.error ? `describe-stacks failed: ${stack.error}` : "the stack is gone" };
  } else if (!record.templateSha256) {
    template = { result: "not compared", reason: "no template hash was recorded for this deployment" };
  } else {
    const t = await stackTemplate(record.stackName);
    if (!t.ok) template = { result: "not compared", reason: `get-template failed: ${t.error}` };
    else {
      const liveSha = sha256Text(t.template);
      template = { result: liveSha === record.templateSha256 ? "matches" : "differs", recorded: record.templateSha256, live: liveSha };
    }
  }

  let parameters;
  if (!exists) parameters = { result: "not compared", reason: "the stack is gone" };
  else if (!record.parameters) parameters = { result: "not compared", reason: "no parameters were recorded for this deployment" };
  else {
    const p = await stackParameters(record.stackName);
    if (!p.ok) parameters = { result: "not compared", reason: `describe-stacks failed: ${p.error}` };
    else {
      const recorded = Object.keys(record.parameters).sort();
      const same = recorded.length === p.keys.length && recorded.every((k, i) => k === p.keys[i]);
      parameters = same ? { result: "match", keys: recorded } : { result: "differ", recorded, live: p.keys };
    }
  }

  const answered = exists ? await probe(publicUrl(record)) : { url: publicUrl(record), error: "the stack is gone" };

  return {
    none: false,
    stack: {
      exists,
      status: exists ? stack.status : "gone",
      ...(stack.error ? { error: `not checked: describe-stacks failed: ${stack.error}` } : {})
    },
    template,
    parameters,
    answered,
    changesOutside: exists ? changesOutside(events, siblings, record.stackName) : "not checked: the stack is gone",
    changesOutsideNote: "as far as CloudFormation's events go; events are retained for ninety days"
  };
}

function historyOf(record) {
  // The history is the record's own team's: whoever can read this evidence can see
  // those records, and no other team's (DESIGN.md, "Each team sees its own
  // environments"). Two teams' drafts of the same app name are two histories.
  const sameTeam = d => (d.orgId || "default") === (record.orgId || "default")
    && (d.teamId || "default") === (record.teamId || "default");
  const all = listDeployments().filter(sameTeam);
  const same = record.stackName
    ? all.filter(d => d.stackName === record.stackName)
    : all.filter(d => d.app?.name && d.app.name === record.app?.name);

  return same
    .sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || "")))
    .map(d => ({
      deploymentId: d.deploymentId,
      status: d.status,
      startedAt: d.startedAt || NOT_RECORDED,
      finishedAt: d.finishedAt || null,
      requestedBy: d.requestedBy ? personOnHost(d.requestedBy) : NOT_RECORDED,
      origin: d.origin?.command ? `${d.origin.command}${d.origin.planSource ? ` (${d.origin.planSource})` : ""}` : NOT_RECORDED
    }));
}

/**
 * The evidence object for one record, every field present, in the order the markdown
 * renders it.
 */
export async function assembleEvidence(record) {
  const generatedAt = new Date().toISOString();

  const terraform = record.backend === "terraform";
  const events = !terraform && record.stackName && record.status !== "drafted"
    ? await stackEvents(record.stackName)
    : { ok: false, events: [], error: "no stack" };

  const siblings = record.stackName ? listDeployments().filter(d => d.stackName === record.stackName) : [];

  const body = {
    subject: subjectOf(record, generatedAt),
    requested: requestedOf(record),
    approved: approvedOf(record),
    built: terraform ? builtOfTerraform(record) : await builtOf(record, events),
    checkedNow: terraform ? await checkedNowOfTerraform(record) : await checkedNowOf(record, events, siblings),
    history: historyOf(record)
  };

  const integrity = {
    sha256: crypto.createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex"),
    of: "sha256 of JSON.stringify of subject, requested, approved, built, checkedNow and history, in that order",
    json: `GET /deployments/${record.deploymentId}/evidence`,
    note: "This is a checksum, not a signature: it shows whether the file changed, not who wrote it."
  };

  return { ...body, integrity };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const code = s => `\`${s}\``;
const isStr = v => typeof v === "string";

function table(headers, rows) {
  const cell = v => String(v ?? "").replace(/\|/g, "\\|");
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map(r => `| ${r.map(cell).join(" | ")} |`)
  ].join("\n");
}

function whatThisIs(ev) {
  const env = ev.subject.stackName || "none built";
  return [
    "## What this is",
    "",
    `The change record for ${ev.subject.app?.name || "this app"} (environment ${env}), written by seaLeye.run ${ev.subject.sealeyeVersion} at ${ev.subject.generatedAt}. Every value below was read from seaLeye.run's own records and ${ev.built?.terraform ? "from OpenTofu's record of the environment and from AWS" : "from CloudFormation"} at the time of generation. Nothing was typed in. Where something could not be read, it says so.`
  ].join("\n");
}

function whoAsked(ev) {
  const r = ev.requested;
  const who = isStr(r.requestedBy) ? r.requestedBy : `${personOnHost(r.requestedBy)} (${r.requestedByNote})`;
  const lines = [
    "## Who asked and when",
    "",
    `- Requested by: ${who}`,
    `- Started: ${r.startedAt}`,
    `- Finished: ${r.finishedAt}`,
    `- Duration: ${isStr(r.durationSeconds) ? r.durationSeconds : `${r.durationSeconds} seconds`}`
  ];
  if (isStr(r.origin)) lines.push(`- Origin: ${r.origin}`);
  else if (r.origin.planSource === "again") {
    lines.push(`- Command: ${r.origin.command ? code(`sealeye ${r.origin.command}`) : "Deploy again, in the portal"}`);
    lines.push(`- Code: the artifact ${code(r.origin.packagedBy)} packaged, deployed again without a new upload${r.origin.fromDeployment !== r.origin.packagedBy ? `, as ${code(r.origin.fromDeployment)} had` : ""}`);
    lines.push(`- Plan came from: ${r.origin.planGiven ? (r.origin.file ? code(r.origin.file) : "a plan given with the request") : `the plan ${code(r.origin.fromDeployment)} was deployed with`}`);
  } else {
    lines.push(`- Command: ${r.origin.command ? code(`sealeye ${r.origin.command}`) : "New environment, in the portal"}`);
    lines.push(`- Plan came from: ${r.origin.planSource}${r.origin.file ? ` (${code(r.origin.file)})` : ""}`);
  }
  return lines.join("\n");
}

function whatWasAsked(ev) {
  const o = ev.requested.origin;
  const lines = ["## What was asked and answered", ""];
  if (isStr(o)) lines.push(`The questions and answers were ${o}.`);
  else if (o.planSource === "reused") lines.push(`No questions were asked. The plan already in ${code(o.file || "sealeye.yaml")} was reused.`);
  else if (o.planSource === "file") lines.push(`No questions were asked. The plan was deployed from ${code(o.file || "a file")}.`);
  else if (o.planSource === "again") lines.push(`No questions were asked. The code ${code(o.packagedBy || o.fromDeployment)} packaged was deployed again.`);
  else if (!o.answers || !o.answers.length) lines.push("The interview asked no questions: the folder answered everything.");
  else lines.push(table(["Question", "Answer"], o.answers.map(a => [a.question, `${a.answer}${a.scripted ? " (from an answers file)" : ""}`])));
  return lines.join("\n");
}

function whatWasApproved(ev) {
  const a = ev.approved;
  const lines = ["## What was approved", "", `- Plan sha256: ${code(a.planSha256)}`, `- Profile: ${a.profile}`];

  if (isStr(a.modules)) lines.push(`- Modules: ${a.modules}`);
  else {
    lines.push("- Modules:");
    for (const m of a.modules) {
      const inputs = Object.entries(m.inputs)
        .map(([k, v]) => `${k}: ${typeof v === "object" && v !== null ? (Array.isArray(v) ? v.join(", ") : Object.entries(v).map(([n, x]) => `${n} (${x})`).join(", ")) : v}`)
        .join("; ");
      lines.push(`  - ${code(m.id)}${inputs ? `: ${inputs}` : ""}`);
    }
  }

  if (isStr(a.patterns)) lines.push(`- Patterns: ${a.patterns}`);
  else if (a.patterns.length) {
    lines.push(`- Patterns the ${a.profile} profile applies:`);
    for (const p of a.patterns) lines.push(`  - ${code(p.id)}: ${p.line}`);
  } else lines.push("- Patterns: none for this profile beyond what the modules build");

  if (a.needs.length) {
    lines.push("- What the app needs that no module supports yet:");
    for (const n of a.needs) {
      lines.push(`  - ${n.line}`);
      for (const e of n.evidence) lines.push(`    - ${e.shows} (${e.file})`);
      if (n.profile_expects) lines.push(`    - what the profile will expect: ${n.profile_expects}`);
    }
  }
  return lines.join("\n");
}

function whatWasBuiltTerraform(b) {
  const counts = c => (isStr(c) ? c : `${c.add} to create, ${c.change} to change, ${c.remove} to remove`);
  const lines = [
    "## What was built",
    "",
    `- Environment: ${code(b.environment)}`,
    `- Module: ${code(b.module.id)}, the folder ${code(b.module.source)} of ${code(b.module.repo)} at commit ${code(b.module.commit)}`,
    `- Built by: OpenTofu ${b.tofuVersion}, with the AWS provider ${b.providerVersion}`,
    `- Root module sha256: ${code(b.rootSha256)}`,
    `- State: ${code(b.stateKey)}`,
    `- Artifact: ${code(b.artifactKey)}`,
    `- Artifact sha256: ${code(b.artifactSha256)}`
  ];
  if (b.entryPoint) lines.push(`- Started from: ${code(b.entryPoint)}, through the platform's adapter`);
  if (b.inputs.length) {
    lines.push("- Inputs, names and where each came from:");
    for (const i of b.inputs) lines.push(`  - ${code(i.name)}: ${i.source}${i.from ? ` (${code(i.from)})` : ""}`);
  }
  if (b.ignoredInputs.length) lines.push(`- Inputs the plan named that seaLeye or the platform gives instead: ${b.ignoredInputs.map(code).join(", ")}`);
  if (isStr(b.secretScan)) lines.push(`- Checked for secrets: ${b.secretScan}`);
  else if (b.secretScan) {
    lines.push(`- Checked for secrets by ${b.secretScan.by}${b.secretScan.scannedBy ? `, when ${code(b.secretScan.scannedBy)} packaged this code` : ""}.`);
    if (b.secretScan.allowed.length) {
      lines.push(`- Let through on the developer's word, in ${code(".sealeye-allow")} (file, line, rule; values are never recorded):`);
      for (const a of b.secretScan.allowed) lines.push(`  - ${code(a)}`);
    } else lines.push("- Nothing was let through by .sealeye-allow.");
  }
  lines.push(`- Planned: ${counts(b.planned)}`, `- Applied: ${counts(b.applied)}`);
  const outs = Object.entries(b.outputs);
  if (outs.length) {
    lines.push("- Outputs:");
    for (const [k, v] of outs) lines.push(`  - ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
  }
  lines.push("", "What the apply did, part by part:", "");
  if (!b.resources.length) lines.push("Nothing was recorded.");
  else lines.push(table(["Part", "Done"], b.resources.map(r => [r.address, r.action || ""])));
  return lines.join("\n");
}

function checkedNowTerraform(c) {
  const lines = ["## Checked now", ""];
  if (c.state.error) lines.push(`- State: ${c.state.error}.`);
  else lines.push(`- State: ${c.state.resources.length ? `holds ${c.state.resources.map(code).join(", ")}` : "holds nothing"}.`);
  if (c.answered.error) lines.push(`- Answered: no. ${c.answered.url ? code(c.answered.url) + " " : ""}${c.answered.error}.`);
  else lines.push(`- Answered: ${c.answered.status} in ${(c.answered.ms / 1000).toFixed(1)} s from ${code(c.answered.url)}. One request was made and nothing else.`);
  if (isStr(c.changesOutside)) lines.push(`- Changes outside seaLeye.run: ${c.changesOutside}.`);
  else if (!c.changesOutside.length) lines.push(`- Changes outside seaLeye.run: none, ${c.changesOutsideNote}.`);
  else {
    lines.push(`- Changes outside seaLeye.run: ${c.changesOutside.length}, ${c.changesOutsideNote}:`);
    for (const x of c.changesOutside) {
      const what = x.attributes?.length ? `, ${x.attributes.length === 1 ? "its" : "these"} ${x.attributes.map(code).join(", ")}` : "";
      lines.push(`  - ${code(x.address)}${x.action ? `: ${x.action}` : ""}${what}`);
    }
  }
  return lines.join("\n");
}

function whatWasBuilt(ev) {
  const b = ev.built;
  if (b.none) return ["## What was built", "", b.sentence].join("\n");
  if (b.terraform) return whatWasBuiltTerraform(b);

  const lines = [
    "## What was built",
    "",
    `- Stack: ${code(b.stackName)}`,
    `- Template: ${code(b.templatePath)}`,
    `- Template sha256: ${code(b.templateSha256)}`,
    `- Artifact: ${code(b.artifactKey)}`,
    `- Artifact sha256: ${code(b.artifactSha256)}`,
    `- Parameter names: ${isStr(b.parameterNames) ? b.parameterNames : b.parameterNames.map(code).join(", ")}`
  ];
  if (b.settingNames.length) {
    lines.push("- Settings passed to the app, names only:");
    for (const s of b.settingNames) lines.push(`  - ${code(s.name)}: ${s.value}, taken from ${sourceInWords(s.source)}`);
  }
  if (b.secretScan !== undefined) {
    if (isStr(b.secretScan)) {
      lines.push(`- Checked for secrets: ${b.secretScan}`);
    } else {
      lines.push(`- Checked for secrets by ${b.secretScan.by}${b.secretScan.scannedBy ? `, when ${code(b.secretScan.scannedBy)} packaged this code` : ""}.`);
      if (b.secretScan.allowed.length) {
        lines.push(`- Let through on the developer's word, in ${code(".sealeye-allow")} (file, line, rule; values are never recorded):`);
        for (const a of b.secretScan.allowed) lines.push(`  - ${code(a)}`);
      } else {
        lines.push("- Nothing was let through by .sealeye-allow.");
      }
    }
  }
  const outs = Object.entries(b.outputs);
  if (outs.length) {
    lines.push("- Outputs:");
    for (const [k, v] of outs) lines.push(`  - ${k}: ${v}`);
  }
  lines.push("", "CloudFormation events in the window of this deployment, five minutes either side:", "");
  if (isStr(b.events)) lines.push(b.events);
  else if (!b.events.length) lines.push("No events fell in the window.");
  else lines.push(table(["Time", "Resource", "Status", "Reason"], b.events.map(e => [e.time, e.resource, e.status, e.reason || ""])));
  return lines.join("\n");
}

function checkedNow(ev) {
  const c = ev.checkedNow;
  if (c.none) return ["## Checked now", "", c.sentence].join("\n");
  if (c.terraform) return checkedNowTerraform(c);

  const lines = ["## Checked now", "", `- Stack status: ${c.stack.status}${c.stack.error ? ` (${c.stack.error})` : ""}`];

  if (c.template.result === "matches") lines.push("- Template: matches. The stack runs the template that was approved.");
  else if (c.template.result === "differs") lines.push(`- Template: differs. Recorded ${code(c.template.recorded)}, the stack has ${code(c.template.live)}.`);
  else lines.push(`- Template: not compared (${c.template.reason}).`);

  if (c.parameters.result === "match") lines.push(`- Parameters: match (${c.parameters.keys.map(code).join(", ")}).`);
  else if (c.parameters.result === "differ") lines.push(`- Parameters: differ. Recorded ${c.parameters.recorded.map(code).join(", ")}; the stack has ${c.parameters.live.map(code).join(", ")}.`);
  else lines.push(`- Parameters: not compared (${c.parameters.reason}).`);

  if (c.answered.error) lines.push(`- Answered: no. ${c.answered.url ? code(c.answered.url) + " " : ""}${c.answered.error}.`);
  else lines.push(`- Answered: ${c.answered.status} in ${(c.answered.ms / 1000).toFixed(1)} s from ${code(c.answered.url)}. One request was made and nothing else.`);

  if (isStr(c.changesOutside)) lines.push(`- Changes outside seaLeye.run: ${c.changesOutside}.`);
  else if (!c.changesOutside.length) lines.push(`- Changes outside seaLeye.run: none. No changes were made to this environment outside seaLeye.run, ${c.changesOutsideNote}.`);
  else {
    lines.push(`- Changes outside seaLeye.run: ${c.changesOutside.length}, ${c.changesOutsideNote}:`);
    for (const x of c.changesOutside) lines.push(`  - ${x.time}: ${x.status}${x.reason ? ` (${x.reason})` : ""}`);
  }
  return lines.join("\n");
}

function history(ev) {
  return [
    "## History of this environment",
    "",
    table(
      ["Deployment", "Status", "Started", "Finished", "Requested by", "Origin"],
      ev.history.map(h => [h.deploymentId, h.status, h.startedAt, h.finishedAt || "", h.requestedBy, h.origin])
    )
  ].join("\n");
}

function integrity(ev) {
  const i = ev.integrity;
  return ["## Integrity", "", `- sha256: ${code(i.sha256)}`, `- Of: ${i.of}`, `- The JSON this was rendered from: ${code(i.json)}`, "", i.note].join("\n");
}

export function renderEvidence(ev) {
  const header = fillHeader(fs.readFileSync(TEMPLATE_PATH, "utf8"), {
    app: ev.subject.app || {},
    stackName: ev.subject.stackName || "none built",
    profile: ev.subject.profile,
    region: ev.subject.region,
    generatedAt: ev.subject.generatedAt
  });

  const sections = [whatThisIs(ev), whoAsked(ev), whatWasAsked(ev), whatWasApproved(ev), whatWasBuilt(ev), checkedNow(ev), history(ev), integrity(ev)];
  return `${header.replace(/\s+$/, "")}\n\n${sections.join("\n\n")}\n`;
}
