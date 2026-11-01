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
import { FIRST_STAGE, stageMapFindings, stageMapProblems } from "../../core/stages.js";

const unanswered = q => q.answer === undefined || q.answer === null;

/**
 * Every unanswered question that touches a module's folder: what its entry rests on. A
 * question about the stage map (`stageMap`) is not one: a module stays buildable in dev
 * while its later stages are asked about, and the self-test holds the catalog back until
 * the map holds (PHASE5-PLAN Step 2).
 */
export function openFor(source, questions) {
  return questions.filter(q => unanswered(q) && !q.stageMap && (q.touches || []).includes(source)).map(q => q.id);
}

/**
 * Unanswered questions that touch no one module (the path to production, a rule across
 * the library): the catalog as a whole rests on them, so the draft says so.
 */
export const openForCatalog = questions => questions.filter(q => unanswered(q) && !q.stageMap && !(q.touches || []).length).map(q => q.id);

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
    ...(rules.length ? { rules } : {}),
    // Which stages it is for, what takes its place later, and whether a stage adds it,
    // as the supervisor read the library (PHASE5-PLAN Step 2): checked by code in
    // withStageMap and provenStageMap before the draft is kept.
    ...stageWordsOf(written)
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
  const doc = {
    catalogVersion: `discovery-${run.id}`,
    discovery: {
      run: run.id,
      library: run.repos.map(r => ({ repo: r.repo, commit: r.commit })),
      ...(openForCatalog(questions).length ? { open: openForCatalog(questions) } : {})
    },
    modules: modules.map(m => entryFor(m, bySource.get(m.source), m.finding, questions, library)),
    need_kinds: starter.need_kinds,
    profiles: starter.profiles,
    ...(starter.legacy_profiles ? { legacy_profiles: starter.legacy_profiles } : {}),
    ...(starter.patterns ? { patterns: starter.patterns } : {}),
    ...(starter.defaults ? { defaults: starter.defaults } : {})
  };
  return provenStageMap(withStageMap(doc, library));
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
const CODE_READ = ["outputs", "delivers", "runs", "offers", "accepts", "version", "tag", "commit", "unreleased"];

export function keepEntries(document, base, sources, questions) {
  const before = new Map((base?.modules || []).map(m => [m.source, m]));
  // A kept entry carries its stage fields as approved, so the map is made again with it.
  return provenStageMap(withStageMap({
    ...document,
    modules: document.modules.map(m => {
      const was = before.get(m.source);
      if (!sources.has(m.source) || !was) return m;
      const { open: _old, ...kept } = was;
      // What code read this run, exactly: a field it no longer finds goes (a module given
      // its first release is no longer unreleased; a tag deleted takes its version with it).
      for (const k of CODE_READ) {
        if (k in m) kept[k] = m[k];
        else delete kept[k];
      }
      const open = openFor(m.source, questions);
      return { ...kept, id: m.id, ...(open.length ? { open } : {}) };
    })
  }));
}

/** The same draft with some entries written again (a late answer), the rest as they were. */
export function rewriteEntries(document, { modules, entries, questions, library = null }) {
  const bySource = new Map((entries || []).map(e => [e.source, e]));
  const moduleBySource = new Map(modules.map(m => [m.source, m]));
  const { open: _was, ...discovery } = document.discovery || {};
  const catalogOpen = openForCatalog(questions);
  return provenStageMap(withStageMap({
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
  }, library || undefined));
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

/** A stage's name as a catalog keeps it: lowercase, hyphens for spaces. */
const stageName = t => String(t || "").trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "");
const STAGE_FIELDS = ["stages", "instead", "added"];

/** The stage fields the supervisor wrote for an entry, in the catalog's shape, or none. */
function stageWordsOf(written) {
  const out = {};
  if (Array.isArray(written?.stages)) {
    const names = [...new Set(written.stages.map(stageName).filter(Boolean))];
    if (names.length) out.stages = names;
  }
  const i = written?.instead;
  if (i && typeof i === "object") {
    // As the supervisor writes it ({ module: folder, stage }), or as the tool had it
    // first ({ source, from }). A folder
    // and a stage written the wrong way round are put right (Greg's run, Nov 1, 2026:
    // { from: "postgres-cluster", source: "staging" }).
    let place = i.module ?? i.source;
    let at = i.stage ?? i.from;
    const looksLikeFolder = t => /\//.test(String(t || ""));
    if (looksLikeFolder(at) && !looksLikeFolder(place)) [place, at] = [at, place];
    const folder = String(place || "").trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
    // By folder here; withStageMap makes it the module's id.
    if (folder && at) out.instead = { from: stageName(at), source: folder };
  }
  const a = written?.added;
  const addedAt = a?.stage ?? a?.from;
  if (a && typeof a === "object" && addedAt && a.beside) out.added = { from: stageName(addedAt), beside: String(a.beside) };
  return out;
}

/** The path the library reader found, as a catalog's `stages.path` and `aside`, or why not. */
function pathFrom(library) {
  const stages = Array.isArray(library?.stages) ? library.stages : [];
  // A run read before Phase 5 kept the path as words: there is no map to make of it.
  if (!stages.length || stages.some(s => !s || typeof s !== "object")) return { why: null };
  const stage = (s, first) => {
    const name = stageName(s.name);
    if (first) return { name };
    const byPipeline = s.built_by === "pipeline";
    return {
      name,
      // What the library's pipeline does not build, seaLeye does (DESIGN.md, "Who
      // applies each stage is in the catalog"); the platform team may change either.
      applies: byPipeline ? "pipeline" : "sealeye",
      ...(byPipeline ? { pipeline: String(s.pipeline || "").trim() || "the library's pipeline" } : {}),
      ...(Array.isArray(s.gate) && s.gate.filter(g => String(g).trim()).length ? { gate: s.gate.map(g => String(g).trim()).filter(Boolean) } : {})
    };
  };
  const path = stages.map((s, i) => stage(s, i === 0));
  if (path[0].name !== FIRST_STAGE) return { why: `The path to production was not read: the library's first stage is ${path[0].name || "unnamed"}, and seaLeye calls the stage a developer builds ${FIRST_STAGE}.` };
  const asideRead = (Array.isArray(library.aside) ? library.aside : []).filter(s => s && typeof s === "object");
  const aside = asideRead.map(s => ({ ...stage(s, false), from: stageName(s.from) }));
  // Who builds a stage, where the library does not say: seaLeye, by D3's rule, said
  // plainly so the platform team sees it before approving.
  const notes = [...stages.slice(1), ...asideRead].flatMap(s => {
    const n = stageName(s.name);
    if (s.built_by !== "pipeline") return [`The library does not say who builds ${n}, so seaLeye would.`];
    return String(s.pipeline || "").trim() ? [] : [`The library's pipeline builds ${n}, but no pipeline file was named.`];
  });
  return { path, ...(aside.length ? { aside } : {}), ...(notes.length ? { notes } : {}) };
}

/**
 * The draft's stage map, from the library reader's path (or the draft's own, when no
 * library is given) and each entry's stage fields: an `instead` named by folder becomes
 * the module's id, and every entry a stage adds (`added`) becomes a `with` (PHASE5-PLAN
 * Step 2). Safe to run again on a draft that has one.
 */
export function withStageMap(doc, library) {
  const fromLibrary = library !== undefined ? pathFrom(library) : null;
  const ids = new Map((doc.modules || []).map(m => [m.source, m.id]));
  const modules = (doc.modules || []).map(m => {
    if (!m?.instead?.source) return m;
    // A module named in its own place says nothing (Greg's runs of Step 2, Nov 1, 2026).
    const own = m.instead.source === m.source || m.instead.source === m.id || m.instead.source === m.source.split("/").pop();
    if (own) return (({ instead: _i, ...r }) => r)(m);
    const byName = [...ids].filter(([src]) => src.split("/").pop() === m.instead.source);
    // A folder named by its last part counts only when one folder has that name.
    const id = ids.get(m.instead.source) || ids.get(`modules/${m.instead.source}`) || (byName.length === 1 ? byName[0][1] : undefined);
    return { ...m, instead: { from: m.instead.from, module: id || m.instead.source } };
  });
  const base = fromLibrary ? (fromLibrary.path ? { path: fromLibrary.path, ...(fromLibrary.aside ? { aside: fromLibrary.aside } : {}) } : null) : doc.stages ? { path: doc.stages.path, ...(doc.stages.aside ? { aside: doc.stages.aside } : {}) } : null;
  const discovery = { ...(doc.discovery || {}) };
  delete discovery.unproven;
  // What seaLeye read of the path but could not use, or filled in itself: said on the
  // self-test for whoever approves, never a reason to hold the catalog back, since a
  // catalog with no path builds dev alone (the review of Step 2, Nov 1, 2026).
  if (fromLibrary) {
    delete discovery.stage_notes;
    const notes = [...(fromLibrary.why ? [fromLibrary.why] : []), ...(fromLibrary.notes || [])];
    if (notes.length) discovery.stage_notes = notes;
  }
  const { stages: _was, ...rest } = doc;
  if (!base || base.path.length < 2) return { ...rest, discovery, modules: modules.map(withoutStageFields) };
  // A replacement from a stage that is not one past dev on the path is not a reading of
  // the map at all (a deprecated cache "replaced from dev"): left out, with a note.
  const later = new Set([...base.path.slice(1), ...(base.aside || [])].map(s => s.name));
  const notes = [...(discovery.stage_notes || [])];
  const placed = modules.map(m => {
    if (!m.instead || later.has(m.instead.from)) return m;
    notes.push(`${m.id} was said to give way to ${m.instead.module} from ${m.instead.from || "no stage"}, which is not a stage past ${FIRST_STAGE}; it is left out.`);
    return (({ instead: _i, ...r }) => r)(m);
  });
  // Written the wrong way round: the module said to give way is the one for the later
  // stages, and the one it names is for the earlier; the replacement is put on the
  // earlier one.
  const order = name => [...base.path, ...(base.aside || [])].findIndex(s => s.name === name);
  const firstAt = m => (Array.isArray(m?.stages) && m.stages.length ? Math.min(...m.stages.map(order).filter(n => n >= 0)) : null);
  const fixed = placed.map(m => ({ ...m }));
  for (const m of fixed) {
    const other = m.instead && fixed.find(o => o.id === m.instead.module);
    if (!other || other.instead) continue;
    const mine = firstAt(m);
    const theirs = firstAt(other);
    if (mine !== null && theirs !== null && mine >= order(m.instead.from) && theirs < order(m.instead.from)) {
      other.instead = { from: m.instead.from, module: m.id };
      delete m.instead;
    }
  }
  if (notes.length) discovery.stage_notes = [...new Set(notes)];
  const adds = fixed.filter(m => m.added).map(m => ({ from: m.added.from, module: m.id, beside: m.added.beside }));
  return { ...rest, discovery, modules: fixed, stages: { ...base, ...(adds.length ? { with: adds } : {}) } };
}

function withoutStageFields(m) {
  const out = { ...m };
  for (const f of STAGE_FIELDS) delete out[f];
  return out;
}

/**
 * A draft whose stage map holds only what code can prove (PHASE5-PLAN D2): what the
 * shape check refuses, or the self-test's proof does not hold, is taken out and listed in
 * `discovery.unproven` ({ kind, module?, other?, words }), for the run to ask about with
 * its guess. A guess never goes live. A module with nothing at a later stage is listed
 * too, though nothing is taken out: the self-test holds the catalog back until it is
 * answered.
 */
export function provenStageMap(doc) {
  if (!doc.stages) return doc;
  const unproven = [...(doc.discovery?.unproven || [])];
  const notes = [...(doc.discovery?.stage_notes || [])];
  let d = structuredClone(doc);
  // The path itself: refused, there is no map at all.
  const bare = { ...d, modules: d.modules.map(withoutStageFields), stages: { ...d.stages, with: [] } };
  const pathProblems = stageMapProblems(bare);
  if (pathProblems.length) {
    const { stages: _gone, ...rest } = d;
    return { ...rest, modules: d.modules.map(withoutStageFields), discovery: { ...d.discovery, stage_notes: [...(d.discovery?.stage_notes || []), `The path to production was not used: ${pathProblems.join("; ")}.`] } };
  }
  // An entry's own stage fields that do not fit the path.
  const problems = stageMapProblems(d);
  // Only the field that is wrong goes, never the module's other stage fields: a module
  // with no `stages` is for every stage, which is a claim of its own (the review).
  const known = new Set([...(d.stages.path || []), ...(d.stages.aside || [])].map(s => s.name));
  d.modules = d.modules.map(m => {
    const own = problems.filter(p => p.startsWith(`module ${m.id}:`));
    if (!own.length) return m;
    const out = { ...m };
    const words = own.map(p => p.replace(`module ${m.id}: `, ""));
    if (own.some(p => / stages /.test(p) || p.includes(": stages "))) {
      const kept = (m.stages || []).filter(s => known.has(s));
      const unknown = (m.stages || []).filter(s => !known.has(s));
      // A stage the path does not have is the library reader's to find, not a guess to
      // settle here: it is left out, said in the notes, and the rest kept (Greg's run of
      // Step 2, Nov 1, 2026: a reader left perf out of the path, and the cluster's perf was
      // asked about with a guess no answer could make true).
      if (kept.length && unknown.length && Array.isArray(m.stages)) {
        out.stages = kept;
        notes.push(`${m.id} names ${unknown.join(" and ")}, which the path to production as read does not have, so it is left out.`);
      } else {
        if (kept.length) out.stages = kept;
        else delete out.stages;
        unproven.push({ kind: "stages", module: m.id, words: words.filter(w => w.startsWith("stages")).join("; ") || words.join("; ") });
      }
    }
    if (own.some(p => p.includes(": instead "))) {
      delete out.instead;
      unproven.push({ kind: "instead", module: m.id, other: m.instead?.module, from: m.instead?.from, words: words.filter(w => w.startsWith("instead")).join("; ") || words.join("; ") });
    }
    return out;
  });
  const dropWith = (module, words) => {
    const w = (d.stages.with || []).find(x => x.module === module);
    unproven.push({ kind: "with", module, ...(w ? { from: w.from, beside: w.beside } : {}), words });
    d.stages = { ...d.stages, with: (d.stages.with || []).filter(w => w.module !== module) };
    d.modules = d.modules.map(m => (m.id === module ? (({ added: _a, ...r }) => r)(m) : m));
  };
  for (const p of stageMapProblems(d).filter(p => p.startsWith("stages.with"))) {
    const w = (d.stages.with || []).find(w => p.includes(` ${w.module} `) || p.includes(` ${w.module},`));
    if (w) dropWith(w.module, p);
  }
  // What the self-test proves: an instead or a with that does not hold is taken out.
  for (const f of stageMapFindings(d)) {
    if (f.kind === "instead" && d.modules.find(m => m.id === f.module)?.instead) {
      unproven.push({ kind: "instead", module: f.module, other: f.other, from: f.from, words: f.words });
      d.modules = d.modules.map(m => (m.id === f.module ? (({ instead: _i, ...r }) => r)(m) : m));
    } else if (f.kind === "with" && (d.stages.with || []).some(w => w.module === f.module)) dropWith(f.module, f.words);
  }
  for (const f of stageMapFindings(d)) if (f.kind === "coverage") unproven.push({ kind: "coverage", module: f.module, stages: f.stages, words: f.words });
  if (!(d.stages.with || []).length) {
    const { with: _w, ...s } = d.stages;
    d.stages = s;
  }
  d.discovery = { ...d.discovery, ...(unproven.length ? { unproven } : {}), ...(notes.length ? { stage_notes: [...new Set(notes)] } : {}) };
  if (!unproven.length) delete d.discovery.unproven;
  return d;
}
