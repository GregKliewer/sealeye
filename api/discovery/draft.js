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
import { forbiddenWord } from "../../core/developer-words.js";
import { keepEdits } from "../../core/catalog-edits.js";

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

const loose = t => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Every rule a reader found for a module: its own worker's, and the library reader's
 * that apply to it (by folder, id, or "all"). Each keeps where it was found.
 */
export function rulesFor(module, finding, library) {
  const names = new Set([module.source, module.id, module.source.split("/").pop()]);
  const applies = r => (r.applies_to || []).some(a => a === "all" || names.has(String(a).trim().replace(/^\.\/+/, "").replace(/\/+$/, "")));
  return [...(finding?.rules || []), ...(library?.rules || []).filter(applies)]
    .filter(r => r && typeof r.rule === "string" && r.rule.trim())
    .map(r => ({
      rule: r.rule.trim(),
      ...(r.stages && r.stages !== "all" ? { stages: String(r.stages) } : {}),
      ...(r.evidence?.file ? { evidence: { file: String(r.evidence.file), ...(Number.isInteger(r.evidence.line) ? { line: r.evidence.line } : {}) } } : {})
    }));
}

/**
 * The planner's guidance: the supervisor's, then every rule a reader found that it does
 * not already say, in the reader's words. Whether a rule the library states reaches the
 * catalog never rests on how the supervisor chose to word an entry (Greg, Oct 15, 2026,
 * after the first measured run lost Juniper's on-call rule that way).
 */
function guidanceFor(written, finding, rules) {
  const own = written?.guidance || (finding?.stages && finding.stages !== "all" ? `For ${finding.stages}.` : "");
  const missing = rules.filter(r => !loose(own).includes(loose(r.rule)));
  const added = missing.map(r => `${r.rule.replace(/[.\s]+$/, "")}${r.stages ? ` (${r.stages})` : ""}.`);
  return [own.trim(), ...added].filter(Boolean).join(" ") || undefined;
}

/** An entry from what code read and what the model wrote of it. */
function meetsOf(keys) {
  const wanted = new Set(keys);
  return starterCatalog().need_kinds.map(n => n.key).filter(k => wanted.has(k));
}

function entryFor(module, written, finding, questions, library) {
  const words = written || finding || {};
  const inputLines = { ...(finding?.input_lines || {}), ...(written?.input_lines || {}) };
  const inputs = Object.fromEntries(Object.entries(module.inputs).map(([name, v]) => {
    const line = plain(inputLines[name] || v.line);
    return [name, { required: v.required, ...("default" in v ? { default: v.default } : {}), ...(line ? { line } : {}), ...(v.sensitive ? { sensitive: true } : {}), ...(v.type ? { type: v.type } : {}) }];
  }));
  const rules = rulesFor(module, finding, library);
  const guidance = guidanceFor(written, finding, rules);
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
    // Read by code, never written by a model: its outputs, how it takes an app, and what
    // it would run on the platform's server (empty when nothing). A run before these were
    // read has none of them, and its Terraform modules are not built (Step 9).
    ...(module.outputs ? { outputs: module.outputs } : {}),
    ...(module.outputs ? { delivers: module.delivers || null } : {}),
    ...(Array.isArray(module.runs) ? { runs: module.runs } : {}),
    // How it connects to another module, by code (terraform.js, connectsOf): what it
    // offers an app that uses it, and what an app module takes of that.
    ...(module.offers ? { offers: module.offers } : {}),
    ...(module.accepts ? { accepts: module.accepts } : {}),
    // Which release of it was read and is built, by code from the library's tags: its
    // version, its tag and the commit the tag points to. In a library that releases its
    // modules, one with no release is not built (core/terraform-modules.js).
    ...(module.release ? { version: module.release.version, tag: module.release.tag, commit: module.release.commit } : {}),
    ...(module.unreleased ? { unreleased: true } : {}),
    ...(guidance ? { guidance } : {}),
    // Which needs an app may have it meets, as the supervisor judged: what the gap report
    // reads (DESIGN.md, "Discovery records which needs each module meets"). Known keys
    // only, in the list's own order; a module the supervisor did not write has none.
    ...(Array.isArray(written?.meets) ? { meets: meetsOf(written.meets) } : {}),
    // Each rule as found, with where, for whoever approves the catalog (Step 7).
    ...(rules.length ? { rules } : {})
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
    modules: modules.map(m => entryFor(m, bySource.get(m.source), m.finding, questions, library)),
    need_kinds: starter.need_kinds,
    profiles: starter.profiles,
    ...(starter.legacy_profiles ? { legacy_profiles: starter.legacy_profiles } : {}),
    ...(starter.patterns ? { patterns: starter.patterns } : {}),
    ...(starter.defaults ? { defaults: starter.defaults } : {})
  };
}

/**
 * A draft whose modules the run did not read again take their entries from the live
 * catalog the run was compared with (DESIGN.md, "Discovery reads again only what
 * changed"): its words, its guidance, which needs it meets, and what a person wrote of
 * it, as approved; what code read of the module this time (its outputs, how it takes an
 * app, what it would run, how it connects, which release), since that is read fresh
 * every run; and which of this run's questions it rests on.
 *
 * @param {object} document     the draft, every entry written from this run
 * @param {object} base         the live catalog's document
 * @param {Set<string>} sources the folders whose entries are kept from `base`
 * @param {object[]} questions  this run's questions, those carried over among them
 */
export function keepEntries(document, base, sources, questions) {
  const before = new Map((base?.modules || []).map(m => [m.source, m]));
  return {
    ...document,
    modules: document.modules.map(m => {
      const was = before.get(m.source);
      if (!sources.has(m.source) || !was) return m;
      const { open: _old, ...kept } = was;
      const fresh = Object.fromEntries(["outputs", "delivers", "runs", "offers", "accepts", "version", "tag", "commit", "unreleased"].filter(k => k in m).map(k => [k, m[k]]));
      const open = openFor(m.source, questions);
      return { ...kept, id: m.id, ...fresh, ...(open.length ? { open } : {}) };
    })
  };
}

/** The same draft with some entries written again (a late answer), the rest as they were. */
export function rewriteEntries(document, { modules, entries, questions, library = null }) {
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
      if (bySource.has(old.source)) {
        // An input line written plainly before (by the fix-up) is kept where the new words
        // give none, rather than going back to the library's own description.
        const written = bySource.get(old.source);
        const kept = Object.fromEntries(Object.entries(old.inputs || {}).filter(([name, spec]) => spec?.line && spec.line !== m.inputs?.[name]?.line).map(([name, spec]) => [name, spec.line]));
        // And what a person wrote of it (sealeye catalog edit) is never written over.
        return keepEdits(old, entryFor(m, { ...written, input_lines: { ...kept, ...(written.input_lines || {}) } }, m.finding, questions, library));
      }
      // Untouched words, but which questions it rests on can still change.
      const open = openFor(old.source, questions);
      const { open: _gone, ...rest } = old;
      return open.length ? { ...rest, open } : rest;
    })
  };
}

/**
 * The last resort for an input's line, after the supervisor has had its one chance to
 * write it plainly: a line that still holds a word a developer never reads is left out,
 * and the input is shown by its name alone. An input's line is most often the library's
 * own variable description ("The DB subnet group"), which no one at seaLeye wrote, and a
 * missing line costs a developer less than a catalog that cannot be approved (Greg's run,
 * Oct 16, 2026). A module's own words are never left out: the self-test names them.
 */
export function withoutUnplainInputLines(document) {
  return {
    ...document,
    modules: (document.modules || []).map(m => {
      if (!m || m.availability !== "available" || !m.inputs) return m;
      let changed = false;
      const inputs = Object.fromEntries(Object.entries(m.inputs).map(([name, spec]) => {
        // A line a person wrote stays as they wrote it: the self-test tells them.
        if (spec && typeof spec.line === "string" && forbiddenWord(spec.line) && !m.edited?.[`input:${name}`]) {
          changed = true;
          const { line: _gone, ...rest } = spec;
          return [name, rest];
        }
        return [name, spec];
      }));
      return changed ? { ...m, inputs } : m;
    })
  };
}
