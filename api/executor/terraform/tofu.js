// api/executor/terraform/tofu.js
// Every OpenTofu call the executor makes (PHASE4-PLAN Step 9; DESIGN.md, "A Terraform
// executor builds an organization's own modules"). The only file that spawns `tofu`, as
// cfn.js is the only one that spawns `aws`.
//
// `tofu` runs code from the organization's library, so it runs as `npm install` does:
// with an environment holding only what it needs (`tofuEnv`). No API setting, no
// database address, no model or gateway key, no GitHub credential. It acts through the
// Terraform deploy role (AWS_PROFILE, written at start by deploy/settings.mjs), installs
// providers only from the image's own folder (TF_CLI_CONFIG_FILE), and never asks a
// question (TF_INPUT=0).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { region, setting } from "../../../core/config.js";

/** The versions the image carries (Dockerfile; test/tofu-versions.test.js keeps them equal). */
export const TOFU_VERSION = "1.12.6";
export const AWS_PROVIDER_VERSION = "5.100.0";

/** Where the image keeps OpenTofu's configuration: providers from its own folder only. */
export const IMAGE_CLI_CONFIG = "/etc/sealeye/tofu.tfrc";
/** The lock file for the one provider, written when the image was built. */
export const IMAGE_LOCK_FILE = "/usr/share/sealeye/tofu/.terraform.lock.hcl";

/** The profile the Terraform deploy role is reached through (deploy/settings.mjs). */
export const TERRAFORM_PROFILE = "sealeye-deploy-terraform";

/**
 * The AWS profile a Terraform environment acts through: the Terraform deploy role's, on
 * the server; whatever the API itself has on a laptop.
 */
export function terraformProfile(env = process.env) {
  return env.SEALEYE_TERRAFORM_PROFILE || env.AWS_PROFILE || null;
}

/**
 * Why the platform cannot build from an organization's modules here, or null when it
 * can. On the server (an API with a database) the Terraform deploy role must be set up:
 * falling back to the CloudFormation role would fail part-way through a build, for a
 * reason no developer can act on (the review, Oct 17, 2026).
 */
export function terraformNotReady(env = process.env) {
  if (env.DATABASE_URL && !env.SEALEYE_TERRAFORM_PROFILE) {
    return "This platform is not set up to build from your organization's own modules yet, so nothing was built. Your platform team sets it up (SEALEYE_TERRAFORM_ROLE_ARN, deploy/README.md).";
  }
  return null;
}

const KEEP = [
  "PATH", "TMPDIR", "LANG", "LC_ALL",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "AWS_CA_BUNDLE",
  // On a laptop the API may hold credentials of its own; on the server it has none, and
  // the role is reached through the profile below.
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_EC2_METADATA_DISABLED"
];

/**
 * What `tofu` sees of the environment. `home` is a folder of its own, so nothing it
 * writes lands in the API's home.
 */
export function tofuEnv({ home, env = process.env } = {}) {
  const out = {};
  for (const name of KEEP) if (env[name] !== undefined) out[name] = env[name];
  const profile = terraformProfile(env);
  if (profile) out.AWS_PROFILE = profile;
  out.AWS_REGION = region();
  out.AWS_SDK_LOAD_CONFIG = "1";
  out.TF_INPUT = "0";
  out.TF_IN_AUTOMATION = "1";
  out.CHECKPOINT_DISABLE = "1";
  if (home) out.HOME = home;
  const config = env.SEALEYE_TOFU_CONFIG || IMAGE_CLI_CONFIG;
  if (fs.existsSync(config)) out.TF_CLI_CONFIG_FILE = config;
  return out;
}

/** The binary: `tofu` on the path, or SEALEYE_TOFU naming another (tests use a stand-in). */
export const tofuBinary = () => setting("TOFU") || "tofu";

/**
 * Run `tofu <args>` in `cwd` and resolve when it exits. Never rejects on a non-zero exit.
 * With `json`, each line of stdout that is OpenTofu's machine-readable output is handed
 * to `onMessage` as it arrives, so the record can say what is happening.
 *
 * @returns {Promise<{ ok: boolean, code: number, stdout: string, stderr: string, messages: object[] }>}
 */
export function runTofu(args, { cwd, home, onMessage = () => {}, env } = {}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(tofuBinary(), args, { cwd, env: env || tofuEnv({ home }), stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      return resolve({ ok: false, code: -1, stdout: "", stderr: `the platform could not start OpenTofu (${err.message})`, messages: [] });
    }
    let stdout = "";
    let stderr = "";
    let partial = "";
    const messages = [];
    child.stdout.on("data", d => {
      stdout += d;
      partial += d;
      let i;
      while ((i = partial.indexOf("\n")) !== -1) {
        const line = partial.slice(0, i).trim();
        partial = partial.slice(i + 1);
        if (!line.startsWith("{")) continue;
        try {
          const m = JSON.parse(line);
          messages.push(m);
          try { onMessage(m); } catch {}
        } catch {}
      }
    });
    child.stderr.on("data", d => (stderr += d));
    child.on("error", e => resolve({ ok: false, code: -1, stdout, stderr: `the platform could not run OpenTofu (${e.message}; is it installed?)`, messages }));
    child.on("close", code => resolve({ ok: code === 0, code, stdout, stderr, messages }));
  });
}

/**
 * The first error OpenTofu reported, in its own words: its summary, then its detail. From
 * its machine-readable diagnostics when there are any, else from what it printed.
 */
export function firstError(result) {
  const diag = (result?.messages || []).find(m => m?.type === "diagnostic" && m.diagnostic?.severity === "error")?.diagnostic;
  const clean = t => String(t || "").replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim();
  if (diag) {
    const where = diag.address ? ` (${diag.address})` : "";
    return `${clean(diag.summary)}${where}${diag.detail ? `: ${clean(diag.detail)}` : ""}`.slice(0, 2000);
  }
  const text = clean(result?.stderr) || clean(result?.stdout);
  const error = text.match(/Error: (.*)$/)?.[1];
  return (error || text || `OpenTofu exited ${result?.code}`).slice(0, 2000);
}

/**
 * What a plan or an apply changed, from OpenTofu's own count of it (`change_summary`):
 * { add, change, remove }, or null when it gave none.
 */
export function changeSummary(messages = []) {
  const c = [...messages].reverse().find(m => m?.type === "change_summary")?.changes;
  return c ? { add: Number(c.add) || 0, change: Number(c.change) || 0, remove: Number(c.remove) || 0 } : null;
}

/** Each resource an apply finished with, by address and what was done, in order. */
export function appliedResources(messages = []) {
  return messages
    .filter(m => m?.type === "apply_complete" && m.hook?.resource?.addr)
    .map(m => ({ address: m.hook.resource.addr, action: m.hook.action || null }));
}

/** Each resource that changed outside OpenTofu, from a refresh-only plan. */
export function driftedResources(messages = []) {
  return messages
    .filter(m => m?.type === "resource_drift" && m.change?.resource?.addr)
    .map(m => ({ address: m.change.resource.addr, action: m.change.action || null }));
}

/**
 * What changed outside OpenTofu, part by part, with the attributes that differ, from the
 * saved refresh-only plan as `tofu show -json` gives it (`resource_drift`). The streamed
 * messages name only the part; a reader needs to see what changed.
 *
 * Two kinds of difference are the cloud's own and are left out (the first builds, Oct 17,
 * 2026, where a fresh environment showed five "changes" nobody made):
 * - an empty value read back as another empty one: nothing, an empty list, an empty map
 *   or an empty word are the same (the provider writes `null` and reads back `{}` or `[]`);
 * - the deployment of an API stage that deploys itself (`auto_deploy`): API Gateway sets
 *   `deployment_id` each time it deploys.
 * - the policies a role reads back that the environment's own attachments put on it: a
 *   module that attaches a policy as a part of its own (`aws_iam_role_policy_attachment`)
 *   sees it again in the role's `managed_policy_arns`. A policy nothing in the
 *   environment attached is still a change.
 * - a bucket's `policy` read back from the environment's own bucket policy part
 *   (`aws_s3_bucket_policy`). A policy changed by hand still shows, as a change to that
 *   part.
 * - a policy's `attachment_count`, when it counts the environment's own attachments of
 *   that policy (the first connected build, Oct 20, 2026: a table's access policy, made
 *   and then attached to the app's role by the same environment, read back as attached
 *   once). An attachment nothing in the environment made still shows.
 * A part with nothing left is not a change.
 */
export function driftDetail(plan) {
  const empty = v => v == null || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);
  const same = (x, y) => (empty(x) && empty(y)) || JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
  const attached = attachedPolicies(plan);
  const attachments = attachmentsOf(attached);
  const bucketPolicies = ownParts(plan, "aws_s3_bucket_policy", v => [v.bucket, v.policy]);
  const sameJson = (x, y) => {
    if (empty(x) || empty(y)) return false;
    const norm = v => { try { return JSON.stringify(sortKeys(JSON.parse(v))); } catch { return String(v); } };
    return norm(x) === norm(y);
  };
  const ownPolicies = (b, a) => {
    const mine = attached.get(a?.name || b?.name) || new Set();
    const rest = v => (Array.isArray(v) ? v : []).filter(arn => !mine.has(arn)).sort();
    return same(rest(b?.managed_policy_arns), rest(a?.managed_policy_arns));
  };
  const ownAttachments = a => Number(a?.attachment_count) === (attachments.get(a?.arn) || 0);
  const cloudSets = (type, before, after, key) =>
    (type === "aws_apigatewayv2_stage" && key === "deployment_id" && after?.auto_deploy === true) ||
    (type === "aws_iam_policy" && key === "attachment_count" && ownAttachments(after)) ||
    (type === "aws_iam_role" && key === "managed_policy_arns" && ownPolicies(before, after)) ||
    (type === "aws_s3_bucket" && key === "policy" && empty(before?.policy) && sameJson(after?.policy, bucketPolicies.get(after?.bucket || after?.id)));
  const changed = (type, before, after) => {
    const b = before && typeof before === "object" ? before : {};
    const a = after && typeof after === "object" ? after : {};
    return [...new Set([...Object.keys(b), ...Object.keys(a)])]
      .filter(k => !same(b[k], a[k]) && !cloudSets(type, b, a, k))
      .sort();
  };
  return (plan?.resource_drift || [])
    .filter(d => d?.address && d?.mode !== "data")
    .map(d => ({ address: d.address, action: d.change?.actions?.join(", ") || null, attributes: changed(d.type || d.address.split(".").at(-2), d.change?.before, d.change?.after) }))
    .filter(d => d.attributes.length);
}

const sortKeys = v => Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v;

/** One kind of the environment's own parts, from a plan's state, as a map of `pick`'s [key, value]. */
function ownParts(plan, type, pick) {
  const out = new Map();
  const walk = mod => {
    for (const r of mod?.resources || []) {
      if (r?.type !== type || r.mode === "data" || !r.values) continue;
      const [k, v] = pick(r.values);
      if (k && v != null && !out.has(k)) out.set(k, v);
    }
    for (const c of mod?.child_modules || []) walk(c);
  };
  walk(plan?.prior_state?.values?.root_module);
  walk(plan?.planned_values?.root_module);
  return out;
}

/** How many times the environment attached each policy, by its address, from the roles' attachments. */
function attachmentsOf(attached) {
  const out = new Map();
  for (const arns of attached.values()) for (const arn of arns) out.set(arn, (out.get(arn) || 0) + 1);
  return out;
}

/** Each role's policies the environment attached itself, by role name, from a plan's state. */
function attachedPolicies(plan) {
  const out = new Map();
  const walk = mod => {
    for (const r of mod?.resources || []) {
      if (r?.type !== "aws_iam_role_policy_attachment" || r.mode === "data") continue;
      const { role, policy_arn: arn } = r.values || {};
      if (!role || !arn) continue;
      if (!out.has(role)) out.set(role, new Set());
      out.get(role).add(arn);
    }
    for (const c of mod?.child_modules || []) walk(c);
  };
  walk(plan?.prior_state?.values?.root_module);
  walk(plan?.planned_values?.root_module);
  return out;
}

/** A `state list`'s lines: what was built, without the data OpenTofu only reads. */
export function builtParts(stdout) {
  return String(stdout || "").split("\n").map(l => l.trim()).filter(l => l && !/(^|\.)data\./.test(l));
}

/** The lock OpenTofu says holds the state, from its error, or null. */
export function lockHeld(result) {
  const text = `${result?.stderr || ""}\n${(result?.messages || []).map(m => m?.diagnostic ? `${m.diagnostic.summary} ${m.diagnostic.detail || ""}` : "").join("\n")}`;
  if (!/state lock|acquiring the state lock|Error acquiring/i.test(text)) return null;
  return text.match(/ID:\s*([0-9a-f-]{8,})/i)?.[1] || "unknown";
}

/** A working folder's own home for `tofu`, made on first use. */
export function homeFor(dir) {
  const home = path.join(dir, ".home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}
