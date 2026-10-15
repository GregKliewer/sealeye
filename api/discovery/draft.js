// api/discovery/draft.js
// A discovery run's draft catalog, put together by plain code from what the readers and
// the supervisor wrote (PHASE4-PLAN Step 6). Code decides each entry's id, folder, inputs
// (read from the module's variables, api/discovery/terraform.js) and what builds it; the
// supervisor's words fill in the rest; and code, not the model, decides which entries
// rest on a question not yet answered, so an entry that does is always marked.
//
// The catalog keeps the starter's need kinds, profiles and patterns: what an app may
// need and what each profile expects are seaLeye's, not the library's. It takes nothing
// else of the starter's, since its modules and rules are seaLeye's own four.
import { starterCatalog } from "../../core/catalog.js";

const unanswered = q => q.answer === undefined || q.answer === null;

/** Every unanswered question that touches a module's folder: what its entry rests on. */
export function openFor(source, questions) {
  return questions.filter(q => unanswered(q) && (q.touches || []).includes(source)).map(q => q.id);
}

/**
 * Unanswered questions that touch no one module (the path to production, a rule across
 * the library): the catalog as a whole rests on them, so the draft says so.
 */
export const openForCatalog = questions => questions.filter(q => unanswered(q) && !(q.touches || []).length).map(q => q.id);

// Words a developer reads never hold an em or en dash (principle 8); the prompt asks,
// and code makes sure.
const plain = t => (typeof t === "string" ? t.replace(/\s*[\u2013\u2014]\s*/g, ", ") : t);

/**
 * Whether a module is offered: never when it was not read; never when the reader or the
 * supervisor says the library has deprecated it; otherwise available.
 */
function availabilityOf(module, written, finding) {
  if (module.failed) return "not_read";
  if (written?.availability === "deprecated" || finding?.availability === "deprecated") return "deprecated";
  return "available";
}

/** An entry from what code read and what the model wrote of it. */
function entryFor(module, written, finding, questions) {
  const words = written || finding || {};
  const inputLines = { ...(finding?.input_lines || {}), ...(written?.input_lines || {}) };
  const inputs = Object.fromEntries(Object.entries(module.inputs).map(([name, v]) => {
    const line = plain(inputLines[name] || v.line);
    return [name, { required: v.required, ...("default" in v ? { default: v.default } : {}), ...(line ? { line } : {}) }];
  }));
  const guidance = written?.guidance
    || [finding?.stages && finding.stages !== "all" ? `For ${finding.stages}.` : "", ...(finding?.rules || []).map(r => r.rule)].filter(Boolean).join(" ")
    || undefined;
  const entry = {
    id: module.id,
    source: module.source,
    availability: availabilityOf(module, written, finding),
    builds_with: "terraform",
    role: words.role || "optional",
    line: plain(words.line) || `The module in ${module.source}.`,
    ...(words.when ? { when: plain(words.when) } : {}),
    ...(Array.isArray(words.signals) && words.signals.length ? { signals: words.signals.map(plain) } : {}),
    inputs,
    ...(guidance ? { guidance } : {})
  };
  const open = openFor(module.source, questions);
  if (open.length) entry.open = open;
  if (module.failed) entry.not_read = module.failed;
  return entry;
}

/**
 * The draft's document.
 *
 * @param {object} p
 * @param {{ id: string, repos: object[] }} p.run
 * @param {object[]} p.modules     { source, id, inputs, finding?, failed? }
 * @param {object} [p.library]     the library reader's finding
 * @param {object[]} p.entries     the supervisor's entries, by source
 * @param {object[]} p.questions   every question the run raised, with any answers
 */
export function draftCatalog({ run, modules, library, entries, questions }) {
  const starter = starterCatalog();
  const bySource = new Map((entries || []).map(e => [e.source, e]));
  return {
    catalogVersion: `discovery-${run.id}`,
    discovery: {
      run: run.id,
      library: run.repos.map(r => ({ repo: r.repo, commit: r.commit })),
      ...(library ? { path_to_production: { stages: library.stages || [], aside: library.aside || [], gates: library.gates || [] } } : {}),
      ...(openForCatalog(questions).length ? { open: openForCatalog(questions) } : {})
    },
    modules: modules.map(m => entryFor(m, bySource.get(m.source), m.finding, questions)),
    need_kinds: starter.need_kinds,
    profiles: starter.profiles,
    ...(starter.legacy_profiles ? { legacy_profiles: starter.legacy_profiles } : {}),
    ...(starter.patterns ? { patterns: starter.patterns } : {}),
    ...(starter.defaults ? { defaults: starter.defaults } : {})
  };
}

/** The same draft with some entries written again (a late answer), the rest as they were. */
export function rewriteEntries(document, { modules, entries, questions }) {
  const bySource = new Map((entries || []).map(e => [e.source, e]));
  const moduleBySource = new Map(modules.map(m => [m.source, m]));
  const { open: _was, ...discovery } = document.discovery || {};
  const catalogOpen = openForCatalog(questions);
  return {
    ...document,
    discovery: { ...discovery, ...(catalogOpen.length ? { open: catalogOpen } : {}) },
    modules: document.modules.map(old => {
      const m = moduleBySource.get(old.source);
      if (!m) return old;
      if (bySource.has(old.source)) return entryFor(m, bySource.get(old.source), m.finding, questions);
      // Untouched words, but which questions it rests on can still change.
      const open = openFor(old.source, questions);
      const { open: _gone, ...rest } = old;
      return open.length ? { ...rest, open } : rest;
    })
  };
}
