// core/evidence-summary.js
// The change record in six lines: what `sealeye evidence` prints after writing
// DEPLOYMENT_EVIDENCE.md, and what seaLeye.online shows above the same file. One set of
// words for both surfaces (CLAUDE.md, principle 1). Each line is a label, its text, and
// whether it needs a person's attention; each surface colours it its own way.
//
// This file runs in a browser as well as in Node: it imports nothing.

const COUNT_WORDS = ["no", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
const countWord = n => COUNT_WORDS[n] || String(n);
const plural = (n, word) => `${countWord(n).toLowerCase()} ${word}${n === 1 ? "" : "s"}`;

/** The first six and last four characters; the file has the whole hash. */
export function shortHash(hash) {
  const h = String(hash || "");
  return /^[0-9a-f]{64}$/.test(h) ? `${h.slice(0, 6)}...${h.slice(-4)}` : h;
}

/** "Sep 27 2026 10:41", in the reader's local time. The file keeps the ISO string. */
export function localTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const month = d.toLocaleDateString("en-US", { month: "short" });
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${month} ${d.getDate()} ${d.getFullYear()} ${hh}:${mm}`;
}

/** "2 min 48 s", or "48 s". */
export function humanDuration(seconds) {
  if (typeof seconds !== "number") return String(seconds);
  const m = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return m ? `${m} min ${sec} s` : `${sec} s`;
}

const notRecorded = v => typeof v !== "string" || /not recorded/.test(v);

/**
 * @param {object} ev  the evidence object from GET /deployments/{id}/evidence
 * @param {{ name: string, command: string }} product  how this surface names seaLeye
 * @returns {{ title: string, rows: { label: string, text: string, alarm: boolean }[] }}
 */
export function evidenceSummary(ev, product = { name: "seaLeye", command: "sealeye" }) {
  const s = ev.subject;
  const r = ev.requested;
  const a = ev.approved;
  const b = ev.built;
  const n = ev.checkedNow;
  const rows = [];
  const row = (label, text, alarm = false) => rows.push({ label, text, alarm });

  const env = s.stackName ? `stack ${s.stackName}, profile ${s.profile}` : `no stack, profile ${s.profile}`;
  const title = `Change record for ${s.app?.name || s.deploymentId} (${env})`;

  // Requested
  const by = r.requestedBy;
  const person = typeof by === "string" ? by : (by.name ? `${by.name} (${by.user})` : by.user);
  const who = typeof by === "string" || !by.host ? person : `${person} on ${by.host}`;
  const when = notRecorded(r.startedAt) ? "" : `, ${localTime(r.startedAt)}`;
  let via = "origin not recorded before 2.16.0";
  if (typeof r.origin !== "string") {
    if (r.origin.planSource === "interview") {
      const count = (r.origin.answers || []).length;
      via = `via ${product.command} run, ${count ? plural(count, "question") + " answered" : "no questions asked"}`;
    } else if (r.origin.planSource === "reused") via = `via ${product.command} run, plan reused from ${r.origin.file}`;
    else if (r.origin.planSource === "file") via = `via ${product.command} deploy -f ${r.origin.file}`;
  }
  row("Requested by", `${who}${when}, ${via}`);

  // Approved
  const modules = Array.isArray(a.modules) ? plural(a.modules.length, "module") : `modules ${a.modules}`;
  const needs = a.needs.length ? plural(a.needs.length, "need") : "no needs";
  row("Approved plan", `sha256 ${shortHash(a.planSha256)}, ${modules}, ${needs}`);

  // Built
  if (b.none) {
    row("Built", `nothing. ${b.sentence.replace(/^Nothing was built\. /, "")}`);
  } else {
    // Which module's template this stack is built from. The file on disk may be the
    // dist copy with the plan's setting names written into it, so the name comes from
    // the kind rather than from the path.
    const tmpl =
      s.kind === "api" ? "http_api_serverless template"
      : s.kind === "static" ? "static_site_edge template"
      : `template ${b.templatePath}`;
    const art = /^none:/.test(String(b.artifactKey)) ? "no artifact" : `artifact ${b.artifactKey}`;
    const events = Array.isArray(b.events) ? plural(b.events.length, "CloudFormation event") : "events not checked";
    const took = typeof r.durationSeconds === "number" ? `, ${humanDuration(r.durationSeconds)}` : "";
    row("Built", `${tmpl}, ${art}, ${events}${took}`);
  }

  // Checked now
  if (n.none) {
    row("Checked now", "nothing to check");
  } else {
    const parts = [];
    let alarm = false;
    if (!n.stack.exists) { parts.push("the stack is gone"); alarm = true; }
    if (n.answered.error) { parts.push(`did not answer (${n.answered.error})`); alarm = true; }
    else parts.push(`answered ${n.answered.status} in ${(n.answered.ms / 1000).toFixed(1)} s`);
    if (n.template.result === "matches") parts.push("the stack runs the template that was approved");
    else if (n.template.result === "differs") { parts.push("the stack runs a different template from the one approved"); alarm = true; }
    else parts.push(`template not compared (${n.template.reason})`);
    if (typeof n.changesOutside === "string") parts.push(`changes outside ${product.name} ${n.changesOutside}`);
    else if (!n.changesOutside.length) parts.push(`no changes outside ${product.name}`);
    else { parts.push(`${plural(n.changesOutside.length, "change")} outside ${product.name}`); alarm = true; }
    row("Checked now", parts.join("; "), alarm);
  }

  // History
  const first = ev.history[0];
  const firstOn = !notRecorded(first?.startedAt) ? `, the first on ${localTime(first.startedAt).replace(/ \d\d:\d\d$/, "")}` : "";
  const what = s.stackName ? "to this environment" : "for this app";
  row("History", `${plural(ev.history.length, "deployment")} ${what}${firstOn}`);

  return { title, rows };
}
