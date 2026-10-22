// api/discovery/service.js
// A discovery run (PHASE4-PLAN Step 6; DESIGN.md, "A discovery run never pauses" and
// "The discovery run"): read an organization's platform library, have a worker read each
// module and a reader read the library as a whole, in parallel, then have the supervisor
// write a draft catalog. It never waits on a person. What it cannot settle it asks, with
// a guess; an answer is used if it is there before its entry is written, and one that
// comes later re-writes only the entries it touches.
//
//   read -> (worker per module, library reader, in parallel) -> supervise -> end
//
// The run is a LangGraph graph with no checkpointer: a run cut off by a restart is
// marked stopped, and running it again is cheap (Greg, Oct 15, 2026). One per API
// process, like the interview service.
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import { Annotation, END, Send, START, StateGraph } from "@langchain/langgraph";

import { setting } from "../../core/config.js";
import { traceDiscovery, traceEvent } from "../../core/tracing.js";
import { addCatalog, catalogAt, catalogsOf, changeDraft, liveCatalog } from "../catalogs.js";
import { claimsFor, signerFromSettings, withCallerToken } from "../gateway-token.js";
import { modelClient, modelCredential } from "../interview/model.js";
import { switchOffLangSmith } from "../interview/service.js";
import { draftCatalog, keepEntries, rewriteEntries, withoutUnplainInputLines } from "./draft.js";
import { developerTexts, developerWordProblems } from "../../core/developer-words.js";
import { fieldForPlace } from "../../core/catalog-edits.js";
import { libraryRepos, repoName } from "./github.js";
import { readLibrary as readFromGitHub } from "./library.js";
import { ANSWER_LIMIT } from "../../core/discovery-words.js";
import { createBudget, readLibraryLevel, readModule, SpendingLimit, superviseEntries } from "./readers.js";
import * as store from "./store.js";
import { connectsOf, deliversOf, idFor, libraryHash, listModules, moduleHash, moduleInputs, moduleOutputs, moduleRuns } from "./terraform.js";
import { keepEdits } from "../../core/catalog-edits.js";
import fs from "node:fs";

/**
 * How this seaLeye reads a library: its discovery prompts, and a number raised when the
 * code that reads a module changes what it records. A run compares with the live
 * catalog's only when it was read the same way: after a release that reads better, every
 * module is read again (the review of Step 6c, Oct 22, 2026).
 */
const READER_CODE = 1;
export function readerVersion() {
  const dir = path.join(import.meta.dirname, "..", "..", "prompts");
  const hash = crypto.createHash("sha256").update(`code ${READER_CODE}\0`);
  for (const f of fs.readdirSync(dir).filter(f => /^discovery-.*\.md$/.test(f)).sort()) hash.update(`${f}\0`).update(fs.readFileSync(path.join(dir, f))).update("\0");
  return hash.digest("hex").slice(0, 16);
}

// Set from the first measured run on the made-up organization, Oct 15, 2026 (PHASE4-PLAN
// D6): its most expensive worker spent half a cent and the whole run eighteen cents;
// Greg chose ten cents a worker and three dollars a run.
export const DEFAULT_WORKER_CAP = 0.1;
export const DEFAULT_RUN_CAP = 3;
const MAX_PARALLEL = 4;
const QUESTION_KINDS = ["overlap", "deprecated", "contradiction", "other"];

/** A list as the tool asks for it, from a list, one value, or nothing. */
const asList = v => (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v]);

/** What kind of failure an error is, for a trace: its class and any status, never its message. */
const errorKind = err => [err?.name || typeof err, Number.isInteger(err?.status) ? String(err.status) : null].filter(Boolean).join(" ");

// Words that say nothing about what a question asks, left out when two are compared.
const QUESTION_FILLER = new Set(["which", "what", "when", "where", "with", "from", "this", "that", "these", "those", "should", "would", "does", "there", "their", "they", "them", "have", "been", "being", "into", "about", "each", "every", "some", "other", "still"]);

const capSetting = (name, fallback) => {
  const v = setting(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`SEALEYE_${name} must be a number of dollars above zero`);
  return n;
};

/** Who may start a run and answer its questions: an organization-wide token (Greg, Oct 15, 2026). */
export const mayDiscover = caller => !caller || caller.scope === "org";

export class DiscoveryNotFound extends Error {}
/** A run is already going for this organization: one at a time. */
export class RunGoing extends Error {}
export class QuestionNotFound extends Error {}

const replace = fallback => Annotation({ reducer: (_, next) => next, default: fallback });
const merge = Annotation({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) });

const State = Annotation.Root({
  modules: replace(() => []),
  library: replace(() => null),
  found: merge,             // source -> { finding } or { failed }
  // Folders not read again: their findings are in `found` from the start, and the
  // library's finding is kept too (DESIGN.md, "Discovery reads again only what changed").
  kept: replace(() => []),
  done: replace(() => false)
});

/**
 * @param {object} [options]
 * @param {object} [options.client]       an Anthropic client; tests pass a scripted one
 * @param {Function} [options.readLibrary] reads a repository into a snapshot (tests pass one)
 * @param {() => number} [options.now]
 * @param {string} [options.scratchBase]
 */
export function createDiscoveryService({ client, readLibrary = readFromGitHub, now = Date.now, scratchBase } = {}) {
  // LangChain's own tracer would send each node's whole state out; discovery's state
  // holds what workers found in the library. Off, as for the interview.
  switchOffLangSmith();
  // id -> { run (the one copy this process changes), listeners, events, snapshots,
  // budget, writing (answers being used, one pass at a time), qseq }
  const live = new Map();
  let base = client || null;
  let signer = null;

  function clientFor(run) {
    if (!base) {
      const credential = modelCredential();
      if (!credential) throw new Error("the seaLeye API has no model key set, so it cannot run discovery");
      base = modelClient(credential);
    }
    if (!signer && modelCredential()?.gatewayKey) signer = signerFromSettings();
    return worker => withCallerToken(base, signer, () => claimsFor({ ...run, owner: run.startedBy }, { worker }));
  }
  const viaGateway = () => !client && Boolean(modelCredential()?.gatewayKey);

  function state(id) {
    if (!live.has(id)) live.set(id, { run: null, listeners: new Set(), events: [], writing: Promise.resolve(), rewrites: 0, qseq: 0 });
    return live.get(id);
  }

  /**
   * The run this process changes: one object per run, so the run going and an answer
   * being used never save each other's stale copy. Loaded from the store the first time
   * an answer comes for a run an earlier process did.
   */
  function runOf(id) {
    const s = state(id);
    if (!s.run) s.run = store.getRun(id);
    return s.run;
  }
  /** Keep the run as it is now; saves are written in the order they are made. */
  const save = id => store.saveRun(runOf(id));

  function emit(id, event) {
    const s = state(id);
    const numbered = { seq: (s.events.at(-1)?.seq || 0) + 1, at: new Date(now()).toISOString(), ...event };
    s.events.push(numbered);
    for (const listener of s.listeners) {
      try {
        listener(numbered);
      } catch {}
    }
  }

  const summary = run => run && {
    discoveryId: run.id,
    org: run.org,
    status: run.status,
    ...(run.reason ? { reason: run.reason, message: run.message } : {}),
    startedBy: run.startedBy,
    surface: run.surface,
    repos: run.repos,
    modules: (run.modules || []).map(m => ({ source: m.source, id: m.id, status: m.status })),
    catalog: run.catalogVersion ? { version: run.catalogVersion } : null,
    // What it was compared with, and what it kept and wrote again; or that nothing had
    // changed, so it wrote no draft (DESIGN.md, "Discovery reads again only what changed").
    full: Boolean(run.full),
    ...(run.baseline ? { comparedWith: { catalog: run.baseline.catalog, kept: run.baseline.kept.length, written: (run.baseline.written || []).length, gone: run.baseline.gone || [] } } : {}),
    // A run that found nothing changed has no questions or draft of its own: the run
    // behind the live catalog holds them, and both surfaces go there for them.
    ...(run.unchangedSince ? { unchangedSince: run.unchangedSince, questionsIn: run.questionsIn || null } : {}),
    // An answer being written into the draft now, and why the last one could not be,
    // for a surface to show after the run's own stream has ended (Greg, Oct 15, 2026).
    rewriting: (live.get(run.id)?.rewrites || 0) > 0,
    ...(run.answerProblem ? { answerProblem: run.answerProblem } : {}),
    spent: Number(Object.values(run.spend || {}).reduce((s, w) => s + (w?.cost || 0), 0).toFixed(4)),
    createdAt: run.createdAt,
    finishedAt: run.finishedAt || null
  };

  /** The module a model's word for one names: its folder, written a little loosely, or its id. */
  function sourceFor(run, word) {
    const w = String(word || "").trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
    const m = (run.modules || []).find(m => m.source === w || m.id === w || m.source.split("/").pop() === w);
    return m ? m.source : null;
  }

  async function raise(run, raised, touchesDefault) {
    const out = [];
    for (const q of Array.isArray(raised) ? raised : []) {
      // One question the model wrote in the wrong shape is left out, never the module it
      // came from (Greg's run, Oct 16, 2026: custom-domain was read, then lost).
      try {
        const kept = await raiseOne(run, q, touchesDefault);
        if (kept) out.push(kept);
      } catch (err) {
        traceEvent("question left out", { raisedBy: touchesDefault ? "worker" : "supervisor", error: errorKind(err) });
      }
    }
    return out;
  }

  /** One question raised, as `raise` does for each; the question kept, or null. */
  async function raiseOne(run, q, touchesDefault) {
    const s = state(run.id);
    if (!q || typeof q !== "object" || typeof q.question !== "string" || !q.question.trim()) return null;
    const touches = [...new Set([...(touchesDefault ? [touchesDefault] : []), ...asList(q.touches)].map(t => sourceFor(run, t)).filter(Boolean))];
    // The supervisor sees the readers' questions and may ask one again in its own
    // words; the prompt says not to, and code makes sure (Greg, Oct 15, 2026).
    const same = touchesDefault ? null : repeats({ kind: QUESTION_KINDS.includes(q.kind) ? q.kind : "other", question: String(q.question || ""), touches }, store.questionsOf(run.id));
    if (same) {
      // The supervisor sees across modules where a reader saw one: asked again naming a
      // module the first left out, the first is widened to touch it too, rather than
      // the wider one dropped (Greg's run, Oct 16, 2026: a reader asked about
      // cache-valkey alone, and the supervisor's question naming cache-redis as well
      // was dropped as a repeat).
      const wider = touches.filter(t => !(same.touches || []).includes(t));
      if (wider.length && same.answer == null && !same.mergedInto && (same.touches || []).length) {
        const widened = { ...same, touches: [...same.touches, ...wider] };
        await store.saveQuestion(widened);
        emit(run.id, { type: "widened", question: publicQuestion(widened) });
      }
      return null;
    }
    // The tool asks for lists; a model may still send one as a single value.
    const options = asList(q.options).map(String).filter(o => o.trim()).slice(0, 4);
    if (!options.length && typeof q.guess === "string" && q.guess.trim()) options.push(q.guess);
    const question = {
      id: `q_${crypto.randomBytes(6).toString("hex")}`,
      seq: ++s.qseq,
      discovery: run.id,
      org: run.org,
      // One of the schema's kinds, whatever the model wrote: the kind reaches the trace.
      kind: QUESTION_KINDS.includes(q.kind) ? q.kind : "other",
      question: String(q.question || "").slice(0, 600),
      options,
      guess: options.includes(q.guess) ? q.guess : options[0],
      touches,
      evidence: asList(q.evidence).slice(0, 6).map(e => (e && typeof e === "object"
        ? { file: String(e.file || ""), ...(Number.isInteger(e.line) ? { line: e.line } : {}), shows: String(e.shows || "") }
        : { file: "", shows: String(e) })),
      raisedBy: touchesDefault ? `worker:${touchesDefault}` : "supervisor",
      answer: null,
      createdAt: new Date(now()).toISOString()
    };
    await store.saveQuestion(question);
    // Its kind and who raised it, never its words (DESIGN.md, Step 7's traces).
    traceEvent("question", { kind: question.kind, raisedBy: question.raisedBy, touches: touches.length });
    emit(run.id, { type: "question", question: publicQuestion(question) });
    return question;
  }

  /**
   * The question one asks again, if it does, or undefined: one asks again what another
   * does when it touches nothing the
   * other does not (both touching no module counts), and it is the same kind (other than
   * "other") or mostly the same words; or it shares a module with the other and is in
   * nearly the same words, even if it names one more (the third measured run). Answered
   * questions count too: the answer settles it, and asking again after someone answered
   * put the same question in front of them twice (Greg's run, Oct 15, 2026).
   *
   * Asked about the same module, the shorter question's words are what count: the
   * supervisor asks again what a reader asked, in more words, and against every word of
   * both the share fell below the line (the postgres stages question, asked twice in
   * both passes of Greg's run, Oct 16, 2026). At least two words in common, so two
   * short questions on one module are not the same for one word.
   */
  function repeats(q, existing) {
    const words = t => new Set(String(t).toLowerCase().match(/[a-z0-9]+/g)?.filter(w => w.length > 3 && !QUESTION_FILLER.has(w)) || []);
    const mine = words(q.question);
    return existing.find(e => {
      const theirs = words(e.question);
      const shared = [...mine].filter(w => theirs.has(w)).length;
      const overlap = shared / Math.max(1, new Set([...mine, ...theirs]).size);
      const withinShorter = shared / Math.max(1, Math.min(mine.size, theirs.size));
      const covered = q.touches.length ? q.touches.every(t => (e.touches || []).includes(t)) : !(e.touches || []).length;
      // Asked about the same module in mostly the same words, even naming one more.
      const sharesOne = q.touches.some(t => (e.touches || []).includes(t));
      if (sharesOne && shared >= 2 && withinShorter >= 0.6) return true;
      if (!covered) return false;
      // "other" is a catch-all, so only the words can say two of those are the same.
      return (e.kind === q.kind && q.kind !== "other") || overlap >= 0.4;
    });
  }

  const publicQuestion = q => ({
    id: q.id, kind: q.kind, question: q.question, options: q.options, guess: q.guess, touches: q.touches,
    evidence: q.evidence, answer: q.answer ?? null, answeredBy: q.answeredBy || null, answeredAt: q.answeredAt || null,
    usedAt: q.usedAt || null,
    // Asked in the run behind the live catalog, about a module kept as it was, and carried
    // into this one with its answer (DESIGN.md, "Discovery reads again only what changed").
    ...(q.carriedFrom ? { carried: true } : {}),
    // The questions merged into this one, each as it was asked and by whom.
    ...(q.merged?.length ? { merged: q.merged.map(m => ({ question: m.question, raisedBy: m.raisedBy })) } : {})
  });

  /**
   * A run's questions, less those merged into another: one issue is one question, kept
   * once, wherever it was asked. A merged question keeps its own record, saying which it
   * was merged into.
   */
  const asked = id => store.questionsOf(id).filter(q => !q.mergedInto);

  /**
   * Merge the questions the supervisor says ask the same thing (Greg, Oct 16, 2026: three
   * about the caches in one run). Code checks and applies each: both must be this run's
   * and not merged already, and two different answers are never merged. The one kept
   * touches every module either did, takes an answer only the other had, and keeps who
   * asked each.
   */
  async function applyMerges(run, merges) {
    const all = new Map(store.questionsOf(run.id).map(q => [q.id, q]));
    const done = [];
    for (const m of Array.isArray(merges) ? merges : []) {
      let keep = all.get(String(m?.keep || ""));
      if (!keep || keep.mergedInto) continue;
      for (const id of new Set((Array.isArray(m.merged) ? m.merged : []).map(String))) {
        const other = all.get(id);
        if (!other || other.id === keep.id || other.mergedInto) continue;
        // Never closes a question nobody answered: one with no answer goes only into
        // another with none, and two answers that differ are never merged.
        if (other.answer == null && keep.answer != null) continue;
        if (other.answer != null && keep.answer != null && other.answer !== keep.answer) continue;
        // A question about the whole catalog holds up its approval; one about modules
        // holds back only those. Merging across the two would move a guess out of sight.
        if (!(other.touches || []).length !== !(keep.touches || []).length) continue;
        if (other.answer != null && keep.answer == null) {
          keep = { ...keep, answer: other.answer, answeredBy: other.answeredBy || null, answeredAt: other.answeredAt || null, usedAt: null, usedIn: null };
        }
        keep = {
          ...keep,
          touches: [...new Set([...(keep.touches || []), ...(other.touches || [])])],
          merged: [...(keep.merged || []), { id: other.id, question: other.question, raisedBy: other.raisedBy, kind: other.kind }, ...(other.merged || [])]
        };
        const gone = { ...other, mergedInto: keep.id };
        await store.saveQuestion(gone);
        all.set(gone.id, gone);
        done.push(gone.id);
      }
      await store.saveQuestion(keep);
      all.set(keep.id, keep);
    }
    if (done.length) {
      traceEvent("questions merged", { merged: done.length });
      emit(run.id, { type: "merged", questions: done, into: [...new Set(done.map(id => all.get(id).mergedInto))] });
    }
    return done;
  }

  function graphFor(run) {
    const s = state(run.id);
    const common = () => ({ clientFor: clientFor(run), credentialIsGateway: viaGateway(), budget: s.budget, org: run.orgName });
    const snapshotOf = m => s.snapshots[m.repo];

    const graph = new StateGraph(State)
      .addNode("worker", async ({ module }) => {
        emit(run.id, { type: "reading", source: module.source });
        try {
          const finding = await readModule({ ...common(), module, snapshot: snapshotOf(module) });
          await raise(run, finding.questions, module.source);
          emit(run.id, { type: "read", source: module.source });
          return { found: { [module.source]: { finding } } };
        } catch (err) {
          const failed = err instanceof SpendingLimit ? (err.scope === "run" ? "the run reached its spending limit" : "this module reached its spending limit") : "seaLeye could not finish reading it";
          // What kind of failure, never its words, so the next one says why.
          traceEvent("not read", { source: module.source, error: errorKind(err) });
          emit(run.id, { type: "not_read", source: module.source, why: failed, error: errorKind(err) });
          return { found: { [module.source]: { failed } } };
        }
      })
      .addNode("library_reader", async ({ modules }) => {
        try {
          const finding = await readLibraryLevel({ ...common(), modules, snapshot: s.snapshots[0] });
          await raise(run, finding.questions, null);
          emit(run.id, { type: "read", source: "." });
          return { library: finding };
        } catch (err) {
          traceEvent("not read", { source: ".", error: errorKind(err) });
          emit(run.id, { type: "not_read", source: ".", why: "seaLeye could not finish reading the library's README and pipeline", error: errorKind(err) });
          return { library: null };
        }
      })
      .addNode("supervise", async st => {
        const modules = st.modules.map(m => ({ ...m, ...(st.found[m.source] || {}) }));
        const keptSet = new Set(st.kept || []);
        // What code read of each module goes with it into the draft: its inputs and
        // outputs, how it takes an app, what it would run (PHASE4-PLAN Step 9). Leaving
        // them out leaves the Terraform executor nothing to build (found Oct 17, 2026).
        run.modules = modules.map(m => ({ source: m.source, id: m.id, repo: m.repo, hash: m.hash, inputs: m.inputs, outputs: m.outputs, delivers: m.delivers ?? null, runs: m.runs, offers: m.offers ?? null, accepts: m.accepts ?? null, release: m.release ?? null, unreleased: Boolean(m.unreleased), status: m.failed ? "not_read" : keptSet.has(m.source) ? "kept" : "read", finding: m.finding || null, failed: m.failed || null }));
        run.library = st.library;
        await save(run.id);
        await writeAll(run);
        return { done: true };
      })
      .addConditionalEdges(START, st => {
        // Only the modules that changed are read again; the library's README and
        // pipeline only when no module is kept, since they are kept only when unchanged.
        const kept = new Set(st.kept || []);
        const sends = [
          ...st.modules.filter(m => !kept.has(m.source)).map(module => new Send("worker", { module })),
          ...(kept.size && st.library ? [] : [new Send("library_reader", { modules: st.modules })])
        ];
        // Nothing to read, only a module gone: straight to the writing.
        return sends.length ? sends : ["supervise"];
      }, ["worker", "library_reader", "supervise"])
      .addEdge("worker", "supervise")
      .addEdge("library_reader", "supervise")
      .addEdge("supervise", END);
    return graph.compile();
  }

  /**
   * Once, before a draft is kept: the entries among `sources` whose words a developer
   * must never read (the self-test's word check, core/developer-words.js) go back to the
   * supervisor to be written again in plain words, and the new ones replace them. A
   * library's own descriptions, a variable's above all, are written in the cloud's terms,
   * and a draft holding them cannot be approved (Greg, Oct 16, 2026). If the call cannot
   * be made, the entries stay as they were and the self-test says what to fix.
   *
   * @param {(entries: object[]) => object} build  the draft as it would be with these entries
   * @returns {Promise<object[]>} the entries, some written again
   */
  async function inPlainWords(run, entries, sources, build, { inputs = true } = {}) {
    const doc = build(entries);
    const sourceOf = new Map((doc.modules || []).map(m => [m.id, m.source]));
    const offered = { ...doc, modules: (doc.modules || []).filter(m => m.availability === "available" && sources.includes(m.source)) };
    // A rewrite after an answer keeps the input lines already written plainly, and leaves
    // any still unplain out (withoutUnplainInputLines), so it asks again only about a
    // module's own words: each late answer would otherwise pay for the inputs again
    // (Greg's run, Oct 16: four fix-ups in one pass).
    // A field a person wrote is theirs: never sent back to the model (keepEdits would set
    // the model's words aside anyway), and the self-test tells them what is left.
    const editedBy = new Map((doc.modules || []).map(m => [m.id, m.edited || {}]));
    const problems = developerWordProblems(offered).filter(p => p.module && sourceOf.has(p.module) && (inputs || !/: input /.test(p.where))
      && !editedBy.get(p.module)?.[fieldForPlace(p.where.slice(p.where.indexOf(": ") + 2))]);
    if (!problems.length) return entries;
    const again = [...new Set(problems.map(p => sourceOf.get(p.module)))];
    // Each place with what it says now, so the model sees the words to replace: an
    // input's line is often the library's own variable description, which it never wrote.
    const textAt = new Map(developerTexts(offered).map(t => [t.where, t.text]));
    const lines = problems.map(p => {
      const place = p.where.slice(p.where.indexOf(": ") + 2);
      const input = place.startsWith("input ") ? place.slice(6) : null;
      return `${sourceOf.get(p.module)}: ${place} uses ${p.instead ? `"${p.found}"; write "${p.instead}" in its place` : p.term}${textAt.has(p.where) ? ` (now: "${String(textAt.get(p.where)).replace(/\s+/g, " ").slice(0, 200)}")` : ""}${input ? `; write input_lines.${input}` : ""}`;
    });
    emit(run.id, { type: "plain_words", sources: again });
    const s = state(run.id);
    try {
      const written = await superviseEntries({
        clientFor: clientFor(run), credentialIsGateway: viaGateway(), budget: s.budget, org: run.orgName,
        modules: run.modules, library: run.library, questions: asked(run.id), sources: again, plainWords: { lines, terms: [...new Set(problems.filter(p => !p.instead).map(p => p.term))] }
      });
      const fresh = new Map((written.entries || []).filter(e => again.includes(e.source)).map(e => [e.source, e]));
      traceEvent("plain words", { entries: fresh.size, words: problems.length });
      return entries.map(e => fresh.get(e.source) || e).concat([...fresh.values()].filter(e => !entries.some(x => x.source === e.source)));
    } catch (err) {
      emit(run.id, { type: "plain_words_not_done", sources: again, why: err instanceof SpendingLimit ? "the run reached its spending limit" : "seaLeye could not write them again" });
      return entries;
    }
  }

  /**
   * The run behind the live catalog, for the same library, when this run may be compared
   * with it: the folders it read, each module's hash and finding, and the hash of the
   * library's README and pipeline. Null when there is no such run, it read another
   * library, or the README or pipeline changed since: then every module is read.
   */
  function baselineFor(run, libHash) {
    const live = liveCatalog(run.org);
    if (live.source !== "organization") return null;
    const id = live.document?.discovery?.run;
    const was = id ? store.getRun(id) : null;
    if (!was || !Array.isArray(was.modules) || !was.libraryHash) return null;
    if (was.repos?.[0]?.repo !== run.repos[0]?.repo) return null;
    if (was.libraryHash !== libHash) return null;
    if (was.readerVersion !== readerVersion()) return null;
    return { run: was, catalog: live.version, document: live.document };
  }

  /**
   * The folders whose entries are written again: those that changed, and unchanged ones
   * a changed module touches, so what spans modules stays whole. An unchanged module is
   * written again when a changed module's finding or earlier entry names it, when it
   * meets a need a changed module met before, or when its earlier entry names a module
   * the library no longer has.
   */
  function toWrite(run, base) {
    const kept = new Set(run.modules.filter(m => m.status === "kept").map(m => m.source));
    const changed = run.modules.filter(m => !kept.has(m.source)).map(m => m.source);
    const entryOf = new Map((base.modules || []).map(m => [m.source, m]));
    const namesOf = m => [m.source, m.source.split("/").pop(), m.id].filter(Boolean);
    const mentions = (text, m) => namesOf(m).some(n => new RegExp(`(^|[^A-Za-z0-9_-])${n.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}($|[^A-Za-z0-9_-])`).test(text));
    const changedText = changed.map(src => JSON.stringify([run.modules.find(m => m.source === src)?.finding || null, entryOf.get(src) || null])).join("\n");
    const changedNeeds = new Set(changed.flatMap(src => entryOf.get(src)?.meets || []));
    const gone = (base.modules || []).filter(m => !run.modules.some(x => x.source === m.source));
    // A module added or gone may overlap any other, and nothing yet says which needs a
    // new one meets: every entry is written again (the findings are still kept).
    const added = run.modules.some(m => !entryOf.has(m.source));
    if (added || gone.length) return run.modules.map(m => m.source);
    const changedModules = run.modules.filter(m => changed.includes(m.source));
    const touched = run.modules.filter(m => kept.has(m.source)).filter(m => {
      const was = entryOf.get(m.source);
      return mentions(changedText, m) ||
        // And the other way: a kept entry that names a changed module.
        changedModules.some(c => mentions(JSON.stringify(was || {}), c)) ||
        (was?.meets || []).some(k => changedNeeds.has(k));
    }).map(m => m.source);
    return [...changed, ...touched];
  }

  /**
   * The live catalog's run's questions about modules kept as they were, carried into this
   * run with their answers, so nobody is asked again what they already answered and an
   * entry kept from the live catalog still rests on what it rested on. A question about
   * the whole catalog is carried too: the README and pipeline it came from are unchanged.
   */
  async function carryQuestions(run, was, kept, baseCatalog) {
    const s = state(run.id);
    const here = new Set(run.modules.map(m => m.source));
    let carried = 0;
    for (const q of store.questionsOf(was.id)) {
      if (q.mergedInto) continue;
      const touches = q.touches || [];
      const allKept = touches.every(t => kept.has(t));
      // An answered question that also touches a module read again is carried too, so
      // its answer reaches that module's entry and nobody is asked it again; an open one
      // is left to the module's reader, which asks again what it needs to.
      if (!allKept && !(q.answer != null && touches.some(t => kept.has(t)))) continue;
      // In the draft only if it is in the catalog the run keeps entries from: an answer
      // written into a later draft that never went live is written in again.
      const inBase = q.answer != null && q.usedAt && Number(q.usedIn) <= Number(baseCatalog);
      await store.saveQuestion({
        ...q, id: `q_${crypto.randomBytes(6).toString("hex")}`, seq: ++s.qseq, discovery: run.id, carriedFrom: q.id, merged: [],
        touches: touches.filter(t => here.has(t)),
        usedAt: inBase ? q.usedAt : null, usedIn: inBase ? q.usedIn : null
      });
      carried += 1;
    }
    return carried;
  }

  /**
   * The supervisor writes the entries that need writing, using every answer there is
   * now, then the draft is kept. Every entry, unless the run was compared with the live
   * catalog's: then only those of modules that changed, and of unchanged ones they touch
   * (`toWrite`); the rest are the live catalog's (`keepEntries`).
   */
  async function writeAll(run) {
    const s = state(run.id);
    emit(run.id, { type: "writing" });
    const before = asked(run.id);
    const base = run.baseline ? catalogAt(run.org, run.baseline.catalog) : null;
    // An answer not yet written into an entry is written in now: its modules are written
    // again even when kept (an answer given during the run, or carried from a draft that
    // never went live).
    const pending = before.filter(q => q.answer != null && !q.usedAt).flatMap(q => q.touches || []);
    const sources = base
      ? [...new Set([...toWrite(run, base), ...pending])].filter(src => run.modules.some(m => m.source === src))
      : run.modules.map(m => m.source);
    const keep = new Set(base ? run.modules.map(m => m.source).filter(src => !sources.includes(src)) : []);
    const liveEntry = new Map((base?.modules || []).map(m => [m.source, m]));
    const build = (list, questions) => {
      const doc = draftCatalog({ run, modules: run.modules, library: run.library, entries: list, questions });
      if (!base) return doc;
      const kept = keepEntries(doc, base, keep, questions);
      // What a person wrote of an entry written again is theirs, as a late answer keeps it.
      return { ...kept, modules: kept.modules.map(m => (keep.has(m.source) || !liveEntry.get(m.source)?.edited ? m : keepEdits(liveEntry.get(m.source), m))) };
    };
    const written = sources.length ? await superviseEntries({
      clientFor: clientFor(run),
      credentialIsGateway: viaGateway(),
      budget: s.budget,
      org: run.orgName,
      modules: run.modules,
      library: run.library,
      questions: before,
      sources
    }) : { entries: [], questions: [] };
    if (base) run.baseline.written = sources;
    await raise(run, written.questions, null);
    await applyMerges(run, written.merges);
    const entries = await inPlainWords(run, written.entries || [], sources, list => build(list, asked(run.id)));
    const questions = asked(run.id);
    const document = withoutUnplainInputLines(build(entries, questions));
    const kept = await addCatalog({ org: run.org, document, by: run.startedBy });
    run.catalogVersion = kept.version;
    run.spend = s.budget.spend();
    // Only answers whose modules were written: one about a kept module is in it already.
    await markUsed(before.filter(q => q.answer != null && !q.usedAt && (q.touches || []).every(t => sources.includes(t))), kept.version);
    await save(run.id);
    emit(run.id, { type: "draft", catalog: { version: kept.version }, open: questions.filter(q => q.answer == null).length });
  }

  /**
   * Mark answers as in the draft, each only if it is still the answer the pass read: an
   * answer changed meanwhile stays pending for the next pass.
   */
  async function markUsed(used, version) {
    const at = new Date(now()).toISOString();
    for (const q of used) {
      const current = store.getQuestion(q.id);
      if (current && current.answer === q.answer && current.answeredAt === q.answeredAt && !current.usedAt) {
        await store.saveQuestion({ ...current, usedAt: at, usedIn: version });
      }
    }
  }

  /**
   * Re-write the entries answers touched that are not in yet, one pass at a time per run.
   * The same path takes an answer that came while the entries were first being written:
   * to this run it is simply a late answer.
   */
  function useAnswers(id) {
    const s = state(id);
    s.rewrites += 1;
    s.writing = s.writing.then(async () => {
      const run = runOf(id);
      if (!run?.catalogVersion) return;
      let pending = asked(id).filter(q => q.answer != null && !q.usedAt);
      if (!pending.length) return;
      const sources = [...new Set(pending.flatMap(q => q.touches))];
      let entries = [];
      if (sources.length) {
        s.budget = s.budget || createBudget({ workerCap: capSetting("DISCOVERY_WORKER_CAP", DEFAULT_WORKER_CAP), runCap: capSetting("DISCOVERY_RUN_CAP", DEFAULT_RUN_CAP), spend: run.spend });
        try {
          const written = await traceDiscovery({ runId: id, org: run.org, repo: run.repos?.[0]?.repo, commit: run.repos?.[0]?.commit, user: run.startedBy, kind: "answers" }, async trace => {
            const out = await superviseEntries({
              clientFor: clientFor(run), credentialIsGateway: viaGateway(), budget: s.budget, org: run.orgName,
              modules: run.modules, library: run.library, questions: asked(id), sources
            });
            trace.set({ answers: pending.length, entries: sources.length });
            return out;
          });
          // Questions it raises now go out too, and entries resting on them say so.
          await raise(run, written.questions, null);
          await applyMerges(run, written.merges);
          entries = written.entries.filter(e => sources.includes(e.source));
          {
            const base = catalogAt(run.org, run.catalogVersion);
            entries = await inPlainWords(run, entries, sources,
              list => rewriteEntries(structuredClone(base), { modules: run.modules, entries: list, questions: asked(id), library: run.library }), { inputs: false });
          }
          // An answer a merge carried onto modules this pass did not write waits for the
          // next one, so no module is marked done without being written (the review).
          const now = new Map(asked(id).map(q => [q.id, q]));
          pending = pending.map(q => now.get(q.id)).filter(q => q && q.answer != null && (q.touches || []).every(t => sources.includes(t)));
        } catch (err) {
          run.spend = s.budget.spend();
          run.answerProblem = err instanceof SpendingLimit ? "the run reached its spending limit" : "seaLeye could not write the entries again";
          await save(id);
          emit(id, { type: "answer_not_used", questions: pending.map(q => q.id), why: run.answerProblem });
          return;
        }
      }
      let version = run.catalogVersion;
      const current = catalogAt(run.org, version);
      const document = withoutUnplainInputLines(rewriteEntries(structuredClone(current), { modules: run.modules, entries, questions: asked(id), library: run.library }));
      const status = catalogsOf(run.org).find(c => c.version === version)?.status;
      // Approved meanwhile (between reading its status and writing it): a new draft, as
      // for one approved earlier, so the answer is not left stuck (the review).
      const asNew = async () => (await addCatalog({ org: run.org, document, by: run.startedBy })).version;
      if (status === "draft") {
        try {
          // Re-written on the draft as it is when this write's turn comes, so an edit a
          // person made to its words meanwhile is kept, not written over (keepEdits).
          await changeDraft({ org: run.org, version, change: latest => withoutUnplainInputLines(rewriteEntries(latest, { modules: run.modules, entries, questions: asked(id), library: run.library })) });
        } catch (err) {
          if (err.code !== "CATALOG_STATUS") throw err;
          version = await asNew();
        }
      } else version = await asNew();
      await markUsed(pending, version);
      run.catalogVersion = version;
      run.spend = s.budget ? s.budget.spend() : run.spend;
      delete run.answerProblem;
      await save(id);
      emit(id, { type: "answers_used", questions: pending.map(q => q.id), sources, catalog: { version } });
      // An answer that changed while this pass ran is still pending: one more pass.
      if (asked(id).some(q => q.answer != null && !q.usedAt)) useAnswers(id);
    }).catch(err => {
      // Kept, never lost: the answers stay pending and the next pass uses them. Said on
      // the run's events and in the API's log, which holds no content of the library.
      console.error(`discovery ${id}: answers could not be written into the draft: ${err?.message || err}`);
      const why = err instanceof SpendingLimit ? "the run reached its spending limit" : "seaLeye could not write the entries again";
      const run = runOf(id);
      if (run) {
        run.answerProblem = why;
        save(id).catch(() => {});
      }
      emit(id, { type: "answer_not_used", why });
    }).finally(() => {
      s.rewrites -= 1;
    });
    return s.writing;
  }

  /**
   * Start a run. Reads each repository first, then runs the graph in the background.
   * Resolves with the run as it stands once it has begun.
   */
  async function start({ caller = null, surface = "cli", repos, full = false } = {}) {
    const targets = repos?.length ? repos : libraryRepos();
    if (!targets.length) throw Object.assign(new Error("no library is named: set SEALEYE_LIBRARY_REPOS to owner/repo"), { code: "NO_LIBRARY" });
    // One repository a run, for now: two libraries' folders can share a name, and a
    // finding, a question and an entry are keyed by folder.
    if (targets.length > 1) throw Object.assign(new Error("discovery reads one library repository a run for now: name one in SEALEYE_LIBRARY_REPOS"), { code: "ONE_LIBRARY" });
    const org = caller?.org || "default";
    if (store.runsOf(org).some(r => r.status === "running")) throw new RunGoing(org);
    if (!client && !modelCredential()) throw Object.assign(new Error("the seaLeye API has no model key set, so it cannot run discovery"), { code: "NO_MODEL_KEY" });
    const workerCap = capSetting("DISCOVERY_WORKER_CAP", DEFAULT_WORKER_CAP);
    const runCap = capSetting("DISCOVERY_RUN_CAP", DEFAULT_RUN_CAP);
    const run = {
      id: `dsc_${crypto.randomBytes(8).toString("hex")}`,
      org: caller?.org || "default",
      orgName: setting("ORG") || process.env.ORG || "your organization",
      status: "running",
      startedBy: caller?.email || null,
      caller: caller ? { email: caller.email, org: caller.org, team: caller.team } : null,
      surface: surface === "portal" ? "portal" : "cli",
      repos: targets.map(t => ({ repo: repoName(t), ref: t.ref || null, commit: null })),
      modules: [],
      // Every module read, whatever changed, when the person asked (`sealeye discover
      // --all`, "Read every module again"); otherwise only what changed since the live
      // catalog's run (DESIGN.md, "Discovery reads again only what changed").
      full: Boolean(full),
      cap: { worker: workerCap, run: runCap },
      spend: {},
      catalogVersion: null,
      createdAt: new Date(now()).toISOString()
    };
    const s = state(run.id);
    s.run = run;
    await save(run.id);
    s.budget = createBudget({ workerCap, runCap });
    emit(run.id, { type: "started", discoveryId: run.id, repos: run.repos.map(r => r.repo) });
    s.done = go(run, targets).catch(() => {});
    return summary(run);
  }

  async function go(run, targets) {
    const s = state(run.id);
    try {
      s.snapshots = [];
      for (const [i, target] of targets.entries()) {
        const snap = await readLibrary(target, { scratchBase: scratchBase || path.join(os.tmpdir(), "sealeye-discovery") });
        s.snapshots.push(snap);
        run.repos[i] = { repo: target.owner && target.repo ? repoName(target) : snap.repo, ref: target.ref || null, commit: snap.commit, via: snap.via, tagged: Boolean(snap.tagged), files: snap.files, secretFiles: snap.secretFiles.length, findings: snap.findings.length };
        emit(run.id, { type: "library", repo: snap.repo, commit: snap.commit, files: snap.files, held: snap.secretFiles.length + (snap.unreadFiles || []).length, replaced: snap.findings.length });
      }
      // What every reader may read beyond its own module, hashed, how this seaLeye reads,
      // and the run it can be compared with (DESIGN.md, "Discovery reads again only what
      // changed").
      run.libraryHash = libraryHash(s.snapshots[0].dir);
      run.readerVersion = readerVersion();
      const baseline = run.full ? null : baselineFor(run, run.libraryHash);
      const before = new Map((baseline?.run.modules || []).map(m => [m.source, m]));
      const modules = [];
      // A module the base run read keeps its id, so a plan or an environment that names
      // it still names it when a new module would sort ahead of it.
      const ids = new Set([...before.values()].filter(m => s.snapshots.some(snap => listModules(snap.dir).includes(m.source))).map(m => m.id));
      s.snapshots.forEach((snap, repo) => {
        for (const source of listModules(snap.dir)) {
          let id = before.get(source)?.id;
          if (!id) {
            id = idFor(source);
            while (ids.has(id)) id = `${id}_${repo + 2}`;
            ids.add(id);
          }
          // What code reads of it, exactly: its inputs and outputs, how it takes an app,
          // and anything it would run on the platform's server (core/terraform-modules.js).
          const inputs = moduleInputs(path.join(snap.dir, source));
          const outputs = moduleOutputs(path.join(snap.dir, source));
          // Which release of it was read (core/module-versions.js), or, in a library that
          // releases its modules, that it has none.
          const release = snap.releases?.[source] || null;
          modules.push({ source, id, repo, hash: moduleHash(snap.dir, source), inputs, outputs, delivers: deliversOf(inputs, outputs), runs: moduleRuns(snap.dir, source), ...connectsOf(inputs, outputs), release, unreleased: Boolean(snap.tagged && !release) });
        }
      });
      // Modules whose code is unchanged since then keep what was found. A module holding
      // another counts as changed when the one inside it did: its reader may read it.
      const entries = new Set((baseline?.document.modules || []).map(m => m.source));
      const same = m => { const was = before.get(m.source); return was && was.hash === m.hash; };
      const kept = modules.filter(m => {
        const was = before.get(m.source);
        const inside = modules.filter(n => n.source.startsWith(`${m.source}/`));
        return was && same(m) && inside.every(same) && was.status !== "not_read" && was.finding && entries.has(m.source);
      }).map(m => m.source);
      const keptSet = new Set(kept);
      run.modules = modules.map(m => ({ ...m, status: keptSet.has(m.source) ? "kept" : "reading" }));
      await save(run.id);
      emit(run.id, { type: "modules", modules: modules.map(m => m.source) });

      if (baseline) {
        const gone = [...before.keys()].filter(src => !modules.some(m => m.source === src));
        // Nothing changed: no draft, since it would be the live catalog again. What code
        // reads of each module (its release above all) must be as the live catalog has it
        // too; a release moved with no change to the code still makes a draft, written
        // with no model call.
        const entryOf = new Map(baseline.document.modules.map(m => [m.source, m]));
        const codeSame = m => {
          const e = entryOf.get(m.source) || {};
          return (e.version || null) === (m.release?.version || null) && Boolean(e.unreleased) === Boolean(m.unreleased) &&
            ["outputs", "delivers", "runs", "offers", "accepts"].every(k => JSON.stringify(e[k] ?? null) === JSON.stringify(m[k] ?? null));
        };
        if (kept.length === modules.length && !gone.length && modules.every(codeSame)) {
          run.unchangedSince = baseline.catalog;
          run.questionsIn = baseline.run.id;
          run.status = "finished";
          run.finishedAt = new Date(now()).toISOString();
          run.spend = s.budget.spend();
          await save(run.id);
          emit(run.id, { type: "unchanged", catalog: { version: baseline.catalog } });
          emit(run.id, { type: "finished", catalog: null, unchangedSince: baseline.catalog, open: 0 });
          return;
        }
        run.baseline = { run: baseline.run.id, catalog: baseline.catalog, kept, gone };
        // Questions are carried only beside kept modules: with none kept, the library's
        // README and pipeline are read again too, and ask again what they need to.
        const carried = kept.length ? await carryQuestions(run, baseline.run, keptSet, baseline.catalog) : 0;
        await save(run.id);
        if (kept.length) emit(run.id, { type: "kept", sources: kept, catalog: { version: baseline.catalog }, carried });
      }

      // Traced as its shape only: workers, files by path and size, tokens and cost, and
      // questions by kind; never a file, a prompt or a reply (core/tracing.js).
      await traceDiscovery({ runId: run.id, org: run.org, repo: run.repos[0]?.repo, commit: run.repos[0]?.commit, user: run.startedBy }, async trace => {
        try {
          const was = new Map((run.baseline ? store.getRun(run.baseline.run)?.modules || [] : []).map(m => [m.source, m]));
          const found = Object.fromEntries(kept.map(src => [src, { finding: was.get(src)?.finding }]));
          await graphFor(run).invoke(
            { modules, kept, found, library: kept.length ? store.getRun(run.baseline.run)?.library || null : null },
            { maxConcurrency: MAX_PARALLEL, recursionLimit: 50 }
          );
        } finally {
          trace.set(runOutcome(run, s));
        }
      });
      run.status = "finished";
      run.finishedAt = new Date(now()).toISOString();
      run.spend = s.budget.spend();
      await save(run.id);
      emit(run.id, { type: "finished", catalog: { version: run.catalogVersion }, open: asked(run.id).filter(q => q.answer == null).length });
      // Any answer that came while the entries were being written.
      await useAnswers(run.id);
    } catch (err) {
      run.status = err instanceof SpendingLimit ? "stopped" : "failed";
      run.reason = err instanceof SpendingLimit ? "spending_limit" : "error";
      run.message = err instanceof SpendingLimit
        ? "This run reached its spending limit before it could write the catalog, so it stopped there. Nothing was written."
        : String(err?.message || "seaLeye could not finish the run").slice(0, 300);
      run.finishedAt = new Date(now()).toISOString();
      run.spend = s.budget?.spend() || run.spend;
      await save(run.id);
      emit(run.id, { type: run.status, reason: run.reason, message: run.message });
    } finally {
      for (const snap of s.snapshots || []) snap.remove();
      s.snapshots = [];
      // A run's events are for following it; an hour after it ends, with nobody
      // following, they go. The run and its questions stay in the store.
      setTimeout(() => {
        if (!s.listeners.size) s.events = [];
      }, 60 * 60 * 1000).unref();
    }
  }

  /** What a run's trace says of it at the end: counts and money, never words. */
  function runOutcome(run, s) {
    const questions = asked(run.id);
    const byKind = {};
    for (const q of questions) byKind[`questions_${String(q.kind).replace(/[^a-z_]/g, "")}`] = (byKind[`questions_${String(q.kind).replace(/[^a-z_]/g, "")}`] || 0) + 1;
    return {
      modules: (run.modules || []).length,
      notRead: (run.modules || []).filter(m => m.status === "not_read").length,
      questions: questions.length,
      open: questions.filter(q => q.answer == null).length,
      ...byKind,
      catalog: run.catalogVersion || 0,
      spent: Number(Object.values(s.budget?.spend() || {}).reduce((t, w) => t + (w?.cost || 0), 0).toFixed(4))
    };
  }

  /** Answer a question, during the run or after it. */
  async function answer({ id, questionId, answer: text, by = null }) {
    const run = store.getRun(id);
    if (!run) throw new DiscoveryNotFound(id);
    let q = store.getQuestion(questionId);
    if (!q || q.discovery !== id) throw new QuestionNotFound(questionId);
    // A question merged into another (one still on someone's screen): the answer is the
    // one it was merged into's.
    for (let hops = 0; q?.mergedInto && hops < 10; hops++) q = store.getQuestion(q.mergedInto);
    if (!q) throw new QuestionNotFound(questionId);
    const value = String(text ?? "").trim();
    if (!value || value.length > ANSWER_LIMIT) throw Object.assign(new Error("an answer is one of the options, or a sentence of your own"), { code: "BAD_ANSWER" });
    const saved = await store.saveQuestion({ ...q, answer: value, answeredBy: by, answeredAt: new Date(now()).toISOString(), usedAt: null, usedIn: null });
    emit(id, { type: "answered", question: publicQuestion(saved) });
    // Used now if its entries are already written; otherwise the supervisor reads it
    // just before it writes them.
    useAnswers(id);
    return publicQuestion(saved);
  }

  /**
   * Follow a run's events from `after`. Every event so far is replayed first. A run that
   * is over ends the stream once replayed (`listener(null)`); what an answer changes
   * later is read from the run and its questions.
   */
  function subscribe(id, after, listener) {
    const run = store.getRun(id);
    if (!run) return null;
    const s = state(id);
    for (const event of s.events) if (event.seq > after) listener(event);
    if (run.status !== "running") {
      listener(null);
      return () => {};
    }
    s.listeners.add(listener);
    return () => s.listeners.delete(listener);
  }

  return {
    /** On start: a run the API was doing when it stopped is over. Running it again is cheap. */
    open: async () => {
      const opened = await store.openDiscoveries();
      for (const run of store.allRuns().filter(r => r.status === "running")) {
        await store.saveRun({ ...run, status: "stopped", reason: "restarted", message: "The platform restarted while this run was going. Run it again.", finishedAt: new Date(now()).toISOString() });
      }
      return opened;
    },
    start,
    answer,
    subscribe,
    get: id => summary(store.getRun(id)),
    list: org => store.runsOf(org).map(summary),
    questions: id => asked(id).map(publicQuestion),
    record: id => store.getRun(id),
    /** For tests: resolves when the run, and any answers it is using, are done. */
    settled: async id => {
      await state(id).done;
      await state(id).writing;
    },
    useAnswers
  };
}
