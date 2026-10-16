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
import { addCatalog, catalogAt, catalogsOf, updateDraft } from "../catalogs.js";
import { claimsFor, signerFromSettings, withCallerToken } from "../gateway-token.js";
import { modelClient, modelCredential } from "../interview/model.js";
import { switchOffLangSmith } from "../interview/service.js";
import { draftCatalog, rewriteEntries } from "./draft.js";
import { libraryRepos, repoName } from "./github.js";
import { readLibrary as readFromGitHub } from "./library.js";
import { ANSWER_LIMIT } from "../../core/discovery-words.js";
import { createBudget, readLibraryLevel, readModule, SpendingLimit, superviseEntries } from "./readers.js";
import * as store from "./store.js";
import { idFor, listModules, moduleHash, moduleInputs } from "./terraform.js";

// Set from the first measured run on the made-up organization, Oct 15, 2026 (PHASE4-PLAN
// D6): its most expensive worker spent half a cent and the whole run eighteen cents;
// Greg chose ten cents a worker and three dollars a run.
export const DEFAULT_WORKER_CAP = 0.1;
export const DEFAULT_RUN_CAP = 3;
const MAX_PARALLEL = 4;

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
    const s = state(run.id);
    for (const q of raised || []) {
      const touches = [...new Set([...(touchesDefault ? [touchesDefault] : []), ...(Array.isArray(q.touches) ? q.touches : [])].map(t => sourceFor(run, t)).filter(Boolean))];
      // The supervisor sees the readers' questions and may ask one again in its own
      // words; the prompt says not to, and code makes sure (Greg, Oct 15, 2026).
      if (!touchesDefault && repeats({ kind: q.kind || "other", question: String(q.question || ""), touches }, store.questionsOf(run.id))) continue;
      const options = (q.options || []).map(String).slice(0, 4);
      const question = {
        id: `q_${crypto.randomBytes(6).toString("hex")}`,
        seq: ++s.qseq,
        discovery: run.id,
        org: run.org,
        kind: q.kind || "other",
        question: String(q.question || "").slice(0, 600),
        options,
        guess: options.includes(q.guess) ? q.guess : options[0],
        touches,
        evidence: (q.evidence || []).slice(0, 6).map(e => ({ file: String(e.file || ""), ...(Number.isInteger(e.line) ? { line: e.line } : {}), shows: String(e.shows || "") })),
        raisedBy: touchesDefault ? `worker:${touchesDefault}` : "supervisor",
        answer: null,
        createdAt: new Date(now()).toISOString()
      };
      await store.saveQuestion(question);
      // Its kind and who raised it, never its words (DESIGN.md, Step 7's traces).
      traceEvent("question", { kind: question.kind, raisedBy: question.raisedBy, touches: touches.length });
      emit(run.id, { type: "question", question: publicQuestion(question) });
      out.push(question);
    }
    return out;
  }

  /**
   * Whether a question asks again what one already asked does: it touches nothing the
   * other does not (both touching no module counts), and it is the same kind (other than
   * "other") or mostly the same words; or it shares a module with the other and is in
   * nearly the same words, even if it names one more (the third measured run). Answered
   * questions count too: the answer settles it, and asking again after someone answered
   * put the same question in front of them twice (Greg's run, Oct 15, 2026).
   */
  function repeats(q, existing) {
    const words = t => new Set(String(t).toLowerCase().match(/[a-z0-9]+/g)?.filter(w => w.length > 3) || []);
    const mine = words(q.question);
    return existing.some(e => {
      const theirs = words(e.question);
      const shared = [...mine].filter(w => theirs.has(w)).length;
      const overlap = shared / Math.max(1, new Set([...mine, ...theirs]).size);
      const covered = q.touches.length ? q.touches.every(t => (e.touches || []).includes(t)) : !(e.touches || []).length;
      // Asked about the same module in mostly the same words, even naming one more.
      const sharesOne = q.touches.some(t => (e.touches || []).includes(t));
      if (sharesOne && overlap >= 0.6) return true;
      if (!covered) return false;
      // "other" is a catch-all, so only the words can say two of those are the same.
      return (e.kind === q.kind && q.kind !== "other") || overlap >= 0.4;
    });
  }

  const publicQuestion = q => ({
    id: q.id, kind: q.kind, question: q.question, options: q.options, guess: q.guess, touches: q.touches,
    evidence: q.evidence, answer: q.answer ?? null, answeredBy: q.answeredBy || null, answeredAt: q.answeredAt || null,
    usedAt: q.usedAt || null
  });

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
          emit(run.id, { type: "not_read", source: module.source, why: failed });
          return { found: { [module.source]: { failed } } };
        }
      })
      .addNode("library_reader", async ({ modules }) => {
        try {
          const finding = await readLibraryLevel({ ...common(), modules, snapshot: s.snapshots[0] });
          await raise(run, finding.questions, null);
          emit(run.id, { type: "read", source: "." });
          return { library: finding };
        } catch {
          emit(run.id, { type: "not_read", source: ".", why: "seaLeye could not finish reading the library's README and pipeline" });
          return { library: null };
        }
      })
      .addNode("supervise", async st => {
        const modules = st.modules.map(m => ({ ...m, ...(st.found[m.source] || {}) }));
        run.modules = modules.map(m => ({ source: m.source, id: m.id, repo: m.repo, hash: m.hash, inputs: m.inputs, status: m.failed ? "not_read" : "read", finding: m.finding || null, failed: m.failed || null }));
        run.library = st.library;
        await save(run.id);
        await writeAll(run);
        return { done: true };
      })
      .addConditionalEdges(START, st => [
        ...st.modules.map(module => new Send("worker", { module })),
        new Send("library_reader", { modules: st.modules })
      ], ["worker", "library_reader"])
      .addEdge("worker", "supervise")
      .addEdge("library_reader", "supervise")
      .addEdge("supervise", END);
    return graph.compile();
  }

  /** The supervisor writes every entry, using every answer there is now, then the draft is kept. */
  async function writeAll(run) {
    const s = state(run.id);
    emit(run.id, { type: "writing" });
    const before = store.questionsOf(run.id);
    const written = await superviseEntries({
      clientFor: clientFor(run),
      credentialIsGateway: viaGateway(),
      budget: s.budget,
      org: run.orgName,
      modules: run.modules,
      library: run.library,
      questions: before,
      sources: run.modules.map(m => m.source)
    });
    await raise(run, written.questions, null);
    const questions = store.questionsOf(run.id);
    const document = draftCatalog({ run, modules: run.modules, library: run.library, entries: written.entries, questions });
    const kept = await addCatalog({ org: run.org, document, by: run.startedBy });
    run.catalogVersion = kept.version;
    run.spend = s.budget.spend();
    await markUsed(before.filter(q => q.answer != null && !q.usedAt), kept.version);
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
      const pending = store.questionsOf(id).filter(q => q.answer != null && !q.usedAt);
      if (!pending.length) return;
      const sources = [...new Set(pending.flatMap(q => q.touches))];
      let entries = [];
      if (sources.length) {
        s.budget = s.budget || createBudget({ workerCap: capSetting("DISCOVERY_WORKER_CAP", DEFAULT_WORKER_CAP), runCap: capSetting("DISCOVERY_RUN_CAP", DEFAULT_RUN_CAP), spend: run.spend });
        try {
          const written = await traceDiscovery({ runId: id, org: run.org, repo: run.repos?.[0]?.repo, commit: run.repos?.[0]?.commit, user: run.startedBy, kind: "answers" }, async trace => {
            const out = await superviseEntries({
              clientFor: clientFor(run), credentialIsGateway: viaGateway(), budget: s.budget, org: run.orgName,
              modules: run.modules, library: run.library, questions: store.questionsOf(id), sources
            });
            trace.set({ answers: pending.length, entries: sources.length });
            return out;
          });
          // Questions it raises now go out too, and entries resting on them say so.
          await raise(run, written.questions, null);
          entries = written.entries.filter(e => sources.includes(e.source));
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
      const document = rewriteEntries(structuredClone(current), { modules: run.modules, entries, questions: store.questionsOf(id), library: run.library });
      const status = catalogsOf(run.org).find(c => c.version === version)?.status;
      if (status === "draft") await updateDraft({ org: run.org, version, document });
      else version = (await addCatalog({ org: run.org, document, by: run.startedBy })).version;
      await markUsed(pending, version);
      run.catalogVersion = version;
      run.spend = s.budget ? s.budget.spend() : run.spend;
      delete run.answerProblem;
      await save(id);
      emit(id, { type: "answers_used", questions: pending.map(q => q.id), sources, catalog: { version } });
      // An answer that changed while this pass ran is still pending: one more pass.
      if (store.questionsOf(id).some(q => q.answer != null && !q.usedAt)) useAnswers(id);
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
  async function start({ caller = null, surface = "cli", repos } = {}) {
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
        run.repos[i] = { repo: target.owner && target.repo ? repoName(target) : snap.repo, ref: target.ref || null, commit: snap.commit, via: snap.via, files: snap.files, secretFiles: snap.secretFiles.length, findings: snap.findings.length };
        emit(run.id, { type: "library", repo: snap.repo, commit: snap.commit, files: snap.files, held: snap.secretFiles.length + (snap.unreadFiles || []).length, replaced: snap.findings.length });
      }
      const modules = [];
      const ids = new Set();
      s.snapshots.forEach((snap, repo) => {
        for (const source of listModules(snap.dir)) {
          let id = idFor(source);
          while (ids.has(id)) id = `${id}_${repo + 2}`;
          ids.add(id);
          modules.push({ source, id, repo, hash: moduleHash(snap.dir, source), inputs: moduleInputs(path.join(snap.dir, source)) });
        }
      });
      run.modules = modules.map(m => ({ ...m, status: "reading" }));
      await save(run.id);
      emit(run.id, { type: "modules", modules: modules.map(m => m.source) });

      // Traced as its shape only: workers, files by path and size, tokens and cost, and
      // questions by kind; never a file, a prompt or a reply (core/tracing.js).
      await traceDiscovery({ runId: run.id, org: run.org, repo: run.repos[0]?.repo, commit: run.repos[0]?.commit, user: run.startedBy }, async trace => {
        try {
          await graphFor(run).invoke({ modules }, { maxConcurrency: MAX_PARALLEL, recursionLimit: 50 });
        } finally {
          trace.set(runOutcome(run, s));
        }
      });
      run.status = "finished";
      run.finishedAt = new Date(now()).toISOString();
      run.spend = s.budget.spend();
      await save(run.id);
      emit(run.id, { type: "finished", catalog: { version: run.catalogVersion }, open: store.questionsOf(run.id).filter(q => q.answer == null).length });
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
    const questions = store.questionsOf(run.id);
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
    const q = store.getQuestion(questionId);
    if (!q || q.discovery !== id) throw new QuestionNotFound(questionId);
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
    questions: id => store.questionsOf(id).map(publicQuestion),
    record: id => store.getRun(id),
    /** For tests: resolves when the run, and any answers it is using, are done. */
    settled: async id => {
      await state(id).done;
      await state(id).writing;
    },
    useAnswers
  };
}
