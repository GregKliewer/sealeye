// core/catalog-edits.js
// A platform engineer editing the words of a draft catalog's entry, before approving it
// (Greg, Oct 16, 2026, after a draft of Juniper Mutual's library could not be approved
// for one word in one line: "outside Terraform"). Words only: what a module is, when to
// use it, what its inputs are for, and the planner's guidance. Never its id, its inputs,
// its availability or what builds it, which are code's to read from the library.
//
// Runs in a browser: the portal imports it. No node: modules, no packages.

import { APPLIERS, FIRST_STAGE } from "./stages.js";

/** The fields of an entry whose words can be edited, as the command names them. */
export const EDITABLE_FIELDS = Object.freeze([
  { field: "line", key: "line", label: "What it gives an app" },
  { field: "short-line", key: "short_line", label: "In a few words" },
  { field: "when", key: "when", label: "When an app uses it" },
  { field: "skip-line", key: "skip_line", label: "Why an app would not" },
  { field: "guidance", key: "guidance", label: "Guidance for the planner" }
]);

/** The longest text an edit keeps. */
export const EDIT_LIMIT = 600;

const INPUT = /^input:([A-Za-z_][A-Za-z0-9_]*)$/;

/** What a field names, or null: { kind: "module", key } or { kind: "input", name }. */
export function fieldOf(field) {
  const f = EDITABLE_FIELDS.find(x => x.field === field || x.key === field);
  if (f) return { kind: "module", key: f.key, field: f.field, label: f.label };
  const m = INPUT.exec(String(field || ""));
  return m ? { kind: "input", name: m[1], field: `input:${m[1]}`, label: `Input ${m[1]}` } : null;
}

/** Every field of one entry that can be edited, with its words now. */
export function editableFieldsOf(entry) {
  const out = EDITABLE_FIELDS.map(f => ({ field: f.field, label: f.label, text: typeof entry?.[f.key] === "string" ? entry[f.key] : "" }));
  for (const [name, spec] of Object.entries(entry?.inputs || {})) {
    out.push({ field: `input:${name}`, label: `Input ${name}`, text: typeof spec?.line === "string" ? spec.line : "" });
  }
  return out;
}

/** Words a developer reads never hold an em or en dash (principle 8): as the draft does. */
const plain = t => String(t).replace(/\s*[–—]\s*/g, ", ").replace(/\s+/g, " ").trim();

const fail = message => Object.assign(new Error(message), { code: "BAD_EDIT" });

/**
 * The catalog with one entry's words changed, and the edit recorded on the entry
 * (`edited`: the field, who and when), so a late answer's rewrite keeps it and whoever
 * approves can see what a person wrote. Throws BAD_EDIT, in words, for anything else.
 */
export function applyEdit(document, { module, field, text, by, at }) {
  const where = fieldOf(field);
  if (!where) throw fail(`${field} is not something whose words can be changed: ${EDITABLE_FIELDS.map(f => f.field).join(", ")}, or input:<name>`);
  const words = plain(text ?? "");
  if (where.key === "line" && !words) throw fail("A module's line cannot be empty: it is what a developer reads of it");
  if (words.length > EDIT_LIMIT) throw fail(`At most ${EDIT_LIMIT} characters`);
  const modules = Array.isArray(document?.modules) ? document.modules : [];
  const i = modules.findIndex(m => m?.id === module);
  if (i === -1) throw fail(`The catalog has no module ${module}`);
  const entry = modules[i];
  let next;
  if (where.kind === "input") {
    if (!entry.inputs || !Object.hasOwn(entry.inputs, where.name)) throw fail(`${module} has no input ${where.name}`);
    const { line: _old, ...spec } = entry.inputs[where.name] || {};
    next = { ...entry, inputs: { ...entry.inputs, [where.name]: words ? { ...spec, line: words } : spec } };
  } else {
    const { [where.key]: _old, ...rest } = entry;
    next = words ? { ...rest, [where.key]: words } : rest;
  }
  next.edited = { ...(entry.edited || {}), [where.field]: { by: by || null, at: at || null } };
  return { ...document, modules: modules.map((m, j) => (j === i ? next : m)) };
}

/**
 * Carry a person's edits from an entry onto the one a rewrite wrote in its place: an
 * answer re-writes the words of the entries it touches, and never over what a person
 * wrote. Returns the new entry.
 */
export function keepEdits(previous, rewritten) {
  const edited = previous?.edited;
  if (!edited || !rewritten) return rewritten;
  let out = { ...rewritten, edited: { ...edited, ...(rewritten.edited || {}) } };
  for (const field of Object.keys(edited)) {
    const where = fieldOf(field);
    if (!where) continue;
    if (where.kind === "input") {
      // The input is gone, or renamed, in what the library now says: the edit has nothing
      // to keep, and the entry no longer says a person wrote it.
      if (!out.inputs?.[where.name]) {
        const { [field]: _stale, ...rest } = out.edited;
        out = { ...out, edited: rest };
        if (!Object.keys(rest).length) delete out.edited;
        continue;
      }
      const before = previous.inputs?.[where.name]?.line;
      const { line: _gone, ...spec } = out.inputs[where.name];
      out = { ...out, inputs: { ...out.inputs, [where.name]: before ? { ...spec, line: before } : spec } };
    } else if (typeof previous[where.key] === "string") {
      out = { ...out, [where.key]: previous[where.key] };
    } else {
      const { [where.key]: _gone, ...rest } = out;
      out = rest;
    }
  }
  return out;
}

/** The field an edit names for one of developer-words.js's places ("short line", "input x"), or null. */
export function fieldForPlace(place) {
  const p = String(place || "");
  if (p.startsWith("input ")) return `input:${p.slice(6)}`;
  return fieldOf(p.replace(/ /g, "-"))?.field || null;
}

// Who applies a stage, changed by hand (PHASE5-PLAN Step 2b; Greg, Nov 1, 2026): a
// platform team chooses where seaLeye builds, whatever its library's pipeline could. The
// stage keeps the edit with who and when, and what the library said of it then (`read`),
// so a later reading of the library keeps the edit while the library says the same, and
// takes what the library says once it changes, saying whose change it replaced.

/** The longest pipeline name an edit keeps. */
const PIPELINE_LIMIT = 200;

const stagesOf = document => [...(document?.stages?.path || []), ...(document?.stages?.aside || [])];
const whoOf = s => (s?.applies === "pipeline" ? { applies: "pipeline", pipeline: s.pipeline } : { applies: s?.applies || "sealeye" });
const sameWho = (a, b) => a.applies === b.applies && (a.applies !== "pipeline" || String(a.pipeline || "") === String(b.pipeline || ""));

/** Who applies a stage, as a line a platform engineer reads: "seaLeye", "the pipeline .github/workflows/app-promote.yml". */
export function whoAppliesWords(s) {
  if (s?.applies !== "pipeline") return "seaLeye";
  const name = String(s.pipeline || "").trim();
  // A name seaLeye put in itself, where the library named no file ("the library's pipeline").
  return !name ? "the pipeline the library names" : /^the /i.test(name) ? name : `the pipeline ${name}`;
}

/**
 * The catalog with who applies one stage changed, and the edit kept on the stage
 * (`edited`: who, when, and what the library said of it). Changing it back to what the
 * library said takes the edit away. Throws BAD_EDIT, in words, for anything else.
 */
export function applyStageEdit(document, { stage, applies, pipeline, by, at }) {
  const all = stagesOf(document);
  if (!all.length) throw fail("This catalog has no path past dev, so no stage to change");
  const named = all.find(s => s?.name === stage);
  if (!named) throw fail(`The catalog has no stage ${stage}: ${all.map(s => s.name).join(", ")}`);
  if (stage === FIRST_STAGE) throw fail(`${FIRST_STAGE} is always built by seaLeye, when a developer asks`);
  if (!APPLIERS.includes(applies)) throw fail(`Who builds a stage is sealeye or pipeline, not ${applies}`);
  const name = String(pipeline ?? "").trim();
  if (applies === "pipeline" && !name) throw fail("Name the pipeline that builds it, as the library names it");
  if (name.length > PIPELINE_LIMIT) throw fail(`A pipeline's name is at most ${PIPELINE_LIMIT} characters`);
  // One printable line: the name is printed on the terminal and the self-test as it is.
  if (/[\u0000-\u001f\u007f]/.test(name)) throw fail("A pipeline's name is one line of plain characters, as the library names it");
  const wanted = applies === "pipeline" ? { applies, pipeline: name } : { applies };
  // What the library said is kept from the first edit, however many follow.
  const read = named.edited?.read || whoOf(named);
  const { pipeline: _p, edited: _e, ...rest } = named;
  const next = { ...rest, ...wanted, ...(sameWho(wanted, read) ? {} : { edited: { by: by || null, at: at || null, read } }) };
  const swap = list => (list || []).map(s => (s?.name === stage ? next : s));
  return { ...document, stages: { ...document.stages, path: swap(document.stages.path), ...(document.stages.aside ? { aside: swap(document.stages.aside) } : {}) } };
}

/**
 * Carry the stage edits of `previous` (the draft as it was, or the live catalog) onto
 * `rewritten`, whose path was read from the library again. An edit stays while the
 * library says of the stage what it said when the edit was made; once the library says
 * otherwise, its reading stands, and a note says whose change it replaced (Greg, Nov 1,
 * 2026). Returns { document, notes }.
 */
export function keepStageEdits(previous, rewritten) {
  const before = new Map(stagesOf(previous).filter(s => s?.edited).map(s => [s.name, s]));
  if (!before.size || !rewritten?.stages) return { document: rewritten, notes: [] };
  const notes = [];
  const carry = s => {
    const old = s && before.get(s.name);
    if (!old || s.name === FIRST_STAGE) return s;
    if (s.edited) return s;
    const now = whoOf(s);
    if (sameWho(now, old.edited.read)) {
      const { pipeline: _p, ...rest } = s;
      return { ...rest, ...whoOf(old), edited: old.edited };
    }
    notes.push(`The library now says ${whoAppliesWords(now)} builds ${s.name}, so it does; this replaces the change ${old.edited.by || "someone"} made${old.edited.at ? ` on ${when(old.edited.at)}` : ""}, which had ${whoAppliesWords(old)} build it.`);
    return s;
  };
  const st = rewritten.stages;
  // A stage the library no longer has takes its change with it, said as any other.
  const now = new Set(stagesOf(rewritten).map(s => s?.name));
  for (const [name, old] of before) {
    if (!now.has(name)) notes.push(`The library no longer has ${name}; the change ${old.edited.by || "someone"} made${old.edited.at ? ` on ${when(old.edited.at)}` : ""}, which had ${whoAppliesWords(old)} build it, goes with it.`);
  }
  return { document: { ...rewritten, stages: { ...st, path: (st.path || []).map(carry), ...(st.aside ? { aside: st.aside.map(carry) } : {}) } }, notes };
}

/** The self-test's notes for each stage a person changed: whose choice, and what the library says. */
export function stageEditNotes(document) {
  return stagesOf(document).filter(s => s?.edited).map(s =>
    `${s.name}: built by ${whoAppliesWords(s)}, as ${s.edited.by || "someone"} chose${s.edited.at ? ` on ${when(s.edited.at)}` : ""}; the library says ${whoAppliesWords(s.edited.read)} builds it.`);
}

/** A moment as a person reads it, in UTC: "Nov 1, 2026 at 21:40 UTC". */
function when(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return String(at);
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${month} ${d.getUTCDate()}, ${d.getUTCFullYear()} at ${hh}:${mm} UTC`;
}

/**
 * A document with notes of stage changes the library overrode added to
 * `discovery.stage_overrides`, which the stage map's own notes never replace, so a later
 * rewrite of the draft keeps them for whoever approves (the review of Step 2b).
 */
export function withOverrideNotes(document, notes) {
  if (!notes?.length) return document;
  const was = Array.isArray(document?.discovery?.stage_overrides) ? document.discovery.stage_overrides : [];
  return { ...document, discovery: { ...(document.discovery || {}), stage_overrides: [...new Set([...was, ...notes])] } };
}
