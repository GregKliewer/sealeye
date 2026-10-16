// core/catalog-edits.js
// A platform engineer editing the words of a draft catalog's entry, before approving it
// (Greg, Oct 16, 2026, after a draft of Juniper Mutual's library could not be approved
// for one word in one line: "outside Terraform"). Words only: what a module is, when to
// use it, what its inputs are for, and the planner's guidance. Never its id, its inputs,
// its availability or what builds it, which are code's to read from the library.
//
// Runs in a browser: the portal imports it. No node: modules, no packages.

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
