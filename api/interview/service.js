// api/interview/service.js
// Interviews held by the API: each one's graph, its saved state, its scratch folder and
// the events clients stream. One service per API process.
//
// An interview runs in stretches. It starts, works until it needs the developer (a
// question, or "Deploy this?"), and stops there with its state saved under its id. An
// answer, from whichever client sends it, resumes it. Every stretch is one stretch of
// the same LangFuse trace (core/tracing.js, traceRun's continueFrom).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Command, MemorySaver } from "@langchain/langgraph";

import { sealeyeHome, setting } from "../../core/config.js";
import { ModelNotPriced, priceFor, runCap } from "../../core/model-prices.js";
import { cleanFinding, isRedactedLine, linesByFile, looksBinary, markWhole, onePerLine, redactLines } from "../../core/scan.js";
import { unzipInto, UploadRefused } from "../../core/upload.js";
import { scanApp } from "../secret-scan.js";
import { promptVersion, traceRun, withoutTracing, flushScores } from "../../core/tracing.js";
import { buildInterviewGraph, MAX_TURNS } from "./graph.js";
import { planFiles } from "../../core/plan-files.js";
import { DEFAULT_MODEL, modelClient, modelCredential } from "./model.js";
import { claimsFor, signerFromSettings, withCallerToken } from "../gateway-token.js";

// Everything about an interview is gone a day after it starts, finished or not: its
// scratch folder (the developer's code) and its saved state (the conversation, file
// contents included). DESIGN.md, "The interview runs as a LangGraph graph".
export const INTERVIEW_TTL_MS = 24 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 15 * 60 * 1000;

/** An answer sent at the wrong moment: nothing is waiting for one. */
export class NotWaiting extends Error {}

export { ModelNotPriced, UploadRefused };

/**
 * @param {object}   [options]
 * @param {object}   [options.client]       an Anthropic client; tests pass a scripted one
 * @param {object}   [options.checkpointer] LangGraph saver; in memory until Step 10
 * @param {function} [options.now]          the clock, for tests
 * @param {string}   [options.scratchBase]  where uploaded apps are unpacked
 */
// LangChain sends every graph run to LangSmith when any of these is "true": each node's
// whole state, which holds the files the model read (D2), past the mask and past
// --no-trace. Anyone learning LangGraph is likely to have one set, so the interview
// turns them off for this process. Anything but "true" leaves LangChain's tracer off.
export const LANGCHAIN_TRACING_VARS = ["LANGSMITH_TRACING", "LANGSMITH_TRACING_V2", "LANGCHAIN_TRACING", "LANGCHAIN_TRACING_V2"];

function switchOffLangSmith() {
  for (const name of LANGCHAIN_TRACING_VARS) {
    if (process.env[name] !== undefined && process.env[name] !== "false" && setting("DEBUG")) {
      console.error(`  [debug] ${name} is set; LangSmith tracing is off for the interview, which never sends file contents out`);
    }
    process.env[name] = "false";
  }
}

// Passed to stretch() to pick up an interview that was running when the API stopped:
// LangGraph carries on from its last saved step.
const RESTART = Symbol("restart");

export function createInterviewService({
  client,
  checkpointer = new MemorySaver(),
  persistence = null,
  now = Date.now,
  scratchBase = path.join(sealeyeHome(), "interviews")
} = {}) {
  switchOffLangSmith();
  const interviews = new Map();
  // Kept in Postgres when the API has one (pgstore.js), so an interview outlives a
  // restart. In memory otherwise.
  const keep = record => persistence?.save(record);
  let modelClientCache = client || null;
  // Every model call carries a token naming who is calling, when the API has a signing
  // key (api/gateway-token.js). A key that cannot be read is said once, by name only,
  // and the API carries on: the gateway then refuses the calls, and the developer is
  // told to tell whoever runs the API, rather than every deploy and page going down too.
  // Only a call to the platform's own gateway carries one: a call straight to Anthropic,
  // with the model key, never sends a second credential beside it.
  let signer = null;
  try {
    if (modelCredential()?.gatewayKey) signer = signerFromSettings();
  } catch (err) {
    console.error(`seaLeye API: SEALEYE_GATEWAY_SIGNING_KEY could not be read (${err.message}), so model calls carry no token`);
  }

  const graph = buildInterviewGraph({
    checkpointer,
    runtimeFor: id => {
      const record = interviews.get(id);
      if (!record) throw new Error(`no interview ${id}`);
      // An interview picked up after a restart reaches here without POST /interviews
      // having made the client first.
      if (!ready()) throw new Error("the seaLeye API has no model key set, so it cannot run an interview");
      return { client: withCallerToken(modelClientCache, signer, () => claimsFor(record)), emit: event => emit(record, event) };
    }
  });

  /** The API can run interviews: it has a model key or a gateway key, or a client was given. */
  function ready() {
    if (modelClientCache) return true;
    const credential = modelCredential();
    if (!credential) return false;
    modelClientCache = modelClient(credential);
    return true;
  }

  function emit(record, event) {
    const numbered = { seq: (record.events.at(-1)?.seq || 0) + 1, at: new Date(now()).toISOString(), ...event };
    record.events.push(numbered);
    persistence?.addEvent(record.id, numbered);
    for (const listener of record.listeners) {
      try {
        listener(numbered);
      } catch {}
    }
  }

  /**
   * Start an interview over a folder already on this machine.
   *
   * @param {object}  options
   * @param {string}  options.appDir    the app, read only; its name is the app's name
   * @param {boolean} [options.ownsDir] delete appDir's scratch root when the interview goes
   * @param {string}  [options.scratchRoot] the folder to delete (defaults to appDir)
   * @param {object}  [options.deployed] the plan the live environment was built from
   * @param {string}  [options.user]    who asked, for the trace
   * @param {string}  [options.owner]   the caller's email when the API checks tokens: only
   *                                     they may answer, follow or end it
   * @param {object}  [options.caller]  the token's holder ({ email, org, team }) when the
   *                                     API checks tokens, for the model gateway's log
   * @param {string}  [options.surface] "cli" or "portal", the surface that started it
   * @param {string}  [options.model]
   * @param {boolean} [options.trace]   false turns tracing off for this interview only
   * @param {object[]} [options.withheld] files sent empty because they look like they hold
   *                                     a secret (core/scan.js): read_file refuses them
   */
  function start({ appDir, ownsDir = false, scratchRoot, deployed = null, user, owner = null, caller = null, surface = "cli", model, trace = true, withheld = [] }) {
    // A run is capped by what it spends, so it never starts on a model seaLeye cannot
    // price: without a price there would be no cap at all (DESIGN.md, "A run's cap is
    // close, not exact"). Throws ModelNotPriced, or a sentence about SEALEYE_RUN_CAP.
    const resolvedModel = model || setting("MODEL") || DEFAULT_MODEL;
    if (!priceFor(resolvedModel)) throw new ModelNotPriced(resolvedModel);
    const cap = runCap();
    const id = `int_${crypto.randomBytes(8).toString("hex")}`;
    const record = {
      id,
      app: path.basename(appDir),
      appDir,
      ownsDir,
      scratchRoot: scratchRoot || appDir,
      user,
      owner,
      caller: caller ? { email: caller.email, org: caller.org, team: caller.team } : null,
      surface: surface === "portal" ? "portal" : "cli",
      trace,
      mode: deployed ? "re-run" : "first run",
      model: resolvedModel,
      status: "running",
      waitingFor: null,
      result: null,
      approved: null,
      traceId: null,
      createdAt: now(),
      events: [],
      listeners: new Set()
    };
    interviews.set(id, record);
    keep(record);

    emit(record, { type: "started", interviewId: id, app: record.app });
    stretch(record, null, {
      appDir,
      deployed,
      model: record.model,
      withheld,
      cap
    });
    return { ...summary(record), findings: withheld };
  }

  /**
   * Start an interview over an uploaded zip of the app folder. The zip is unpacked into
   * a scratch folder of this interview's own, named after the app, which goes when the
   * interview does. Throws UploadRefused with a sentence when the upload breaks a rule.
   *
   * Before the graph starts, what arrived is scanned again (api/secret-scan.js): the
   * shared rules and gitleaks. A file with a finding is emptied in the scratch copy, so
   * no model call can carry it, and joins the files the client sent empty for the same
   * reason (`findings`, file, line and rule, as the client's scan found them). Throws
   * ScanFailed, and keeps nothing, when gitleaks is installed and could not finish.
   */
  async function startFromUpload({ zip, app, findings = [], ...rest }) {
    // Before anything is unpacked: a model with no price cannot start a run.
    const model = rest.model || setting("MODEL") || DEFAULT_MODEL;
    if (!priceFor(model)) throw new ModelNotPriced(model);
    // Any folder name a developer might have, as one path segment and nothing more.
    if (typeof app !== "string" || !app || app.length > 200 || /[\/\\\0-\x1f]/.test(app) || /^\.+$/.test(app)) {
      throw new UploadRefused("app must be the app folder's name");
    }
    fs.mkdirSync(scratchBase, { recursive: true, mode: 0o700 });
    const scratchRoot = fs.mkdtempSync(path.join(scratchBase, "int-"));
    const appDir = path.join(scratchRoot, app);
    let withheld;
    try {
      unzipInto(zip, appDir);
      const scanned = await scanApp(appDir);
      const inside = file => {
        const target = path.join(appDir, ...file.split("/"));
        return target.startsWith(appDir + path.sep) ? target : null;
      };
      const binaryFiles = [...new Set(scanned.found.map(f => f.file))].filter(file => {
        try {
          return looksBinary(fs.readFileSync(inside(file)));
        } catch {
          return false;
        }
      });
      const found = markWhole(scanned.found, { wholeFiles: scanned.wholeFiles, binaryFiles });
      // Each flagged line becomes one that says why; a file with a value over many
      // lines, or that is not text, is emptied. Either way before the graph starts.
      for (const file of new Set(found.filter(f => f.whole).map(f => f.file))) {
        const target = inside(file);
        if (target) fs.writeFileSync(target, "");
      }
      for (const [file, kinds] of linesByFile(found)) {
        const target = inside(file);
        if (target) fs.writeFileSync(target, redactLines(new Uint8Array(fs.readFileSync(target)), kinds));
      }
      // What the client says it held back counts only where the file arrived with that
      // line already replaced, or empty: it explains what is missing, and can never
      // hide anything that arrived with contents.
      const claimed = (Array.isArray(findings) ? findings : []).slice(0, 1000).map(cleanFinding).filter(Boolean).flatMap(f => {
        try {
          const text = fs.readFileSync(inside(f.file), "utf8");
          if (text.length === 0) return [{ ...f, whole: true }];
          return isRedactedLine(text.split("\n")[f.line - 1] || "") ? [f] : [];
        } catch {
          return [];
        }
      });
      withheld = onePerLine([...claimed, ...found]).map(f => ({ ...f, whole: [...claimed, ...found].some(g => g.file === f.file && g.whole) }));
    } catch (err) {
      fs.rmSync(scratchRoot, { recursive: true, force: true });
      throw err;
    }
    return start({ appDir, ownsDir: true, scratchRoot, withheld, ...rest });
  }

  /**
   * The developer's answer to whatever the interview is waiting on: the text of an
   * answer, or y/n to "Deploy this?". Throws NotWaiting when nothing is.
   */
  function answer(id, value) {
    const record = interviews.get(id);
    if (!record) return null;
    if (record.status !== "waiting") throw new NotWaiting(`interview ${id} is not waiting for an answer`);

    record.status = "running";
    const waited = record.waitingFor;
    record.waitingFor = null;
    keep(record);
    emit(record, { type: "answered", for: waited });
    stretch(record, new Command({ resume: typeof value === "string" || typeof value === "boolean" ? value : "" }));
    return summary(record);
  }

  /** Run the graph until it pauses or ends, inside this interview's trace. */
  function stretch(record, resume, input) {
    // LangGraph stops a run after 25 steps by default, and a reading turn is two steps
    // (the model, then its tools). The interview's own limit is MAX_TURNS, so the graph's
    // has to sit above it, or a long read ends in LangGraph's error instead.
    const config = { configurable: { thread_id: record.id }, recursionLimit: 2 * MAX_TURNS + 10 };

    const work = async () => {
      const saved = resume ? await graph.getState(config) : null;
      if (resume === RESTART && !saved?.next?.length) {
        throw new Error("the platform restarted before this interview had saved its place");
      }
      const continueFrom = saved?.values?.trace || null;

      return traceRun(
        { app: record.app, mode: record.mode, model: record.model, promptSha: promptVersion(), user: record.user, continueFrom },
        async run => {
          const begin = resume === RESTART
            ? null
            : resume || { ...input, trace: run.traceId ? { traceId: run.traceId, spanId: run.spanId } : null };
          if (run.traceId && !record.traceId) record.traceId = run.traceId;

          const out = await graph.invoke(begin, config);
          const paused = out.__interrupt__?.[0]?.value;
          // What this stretch ended on: a question asked, a plan waiting for "Deploy
          // this?", or how the interview ended.
          const status = paused
            ? (paused.type === "confirm" ? "submitted" : "asked a question")
            : out.approved === true ? "approved" : out.approved === false ? "declined" : out.result?.status || "stopped";
          run.set({ status, questions: out.questions ?? 0 });
          return out;
        }
      );
    };

    const traced = record.trace ? work : () => withoutTracing(work);

    record.running = traced()
      .then(out => {
        const paused = out.__interrupt__?.[0]?.value;

        if (paused) {
          record.status = "waiting";
          record.waitingFor = paused.type;
          if (paused.type === "confirm") record.result = { ...strip(paused), traceId: record.traceId || undefined };
          keep(record);
          emit(record, paused.type === "confirm"
            ? { type: "plan", ...record.result, ...filesFor(record.result) }
            : { type: "question", number: paused.number, question: paused.question, lead: paused.lead || [] });
          return;
        }

        record.status = "finished";
        record.approved = out.approved ?? null;
        record.result = { ...(record.result || out.result || { status: "stopped" }), ...(record.traceId ? { traceId: record.traceId } : {}) };
        keep(record);
        // Cleaned up first, so a client that sees "finished" knows the app's copy is gone.
        return end(record)
          .catch(cleanupFailed(record))
          .then(() => emit(record, { type: "finished", ...record.result, approved: record.approved }));
      })
      .catch(err => {
        record.status = "failed";
        const message = err?.userFacing ? err.message : `seaLeye.run could not finish the interview: ${err?.message || err}`;
        if (setting("DEBUG") && !err?.userFacing) console.error(err);
        record.failure = message;
        keep(record);
        return end(record)
          .catch(cleanupFailed(record))
          .then(() => emit(record, { type: "failed", message }));
      })
      .catch(err => {
        // Cleaning up must never take the API down with it.
        if (setting("DEBUG")) console.error(`  [debug] could not clean up interview ${record.id}: ${err?.message || err}`);
      })
      .finally(() => flushScores().catch(() => {}));
  }

  const cleanupFailed = record => err => {
    if (setting("DEBUG")) console.error(`  [debug] could not clean up interview ${record.id}: ${err?.message || err}`);
  };

  /** The interview's own data goes as soon as it is over: the code and the saved state. */
  async function end(record) {
    record.endedAt = now();
    keep(record);
    await forget(record, { keepRecord: true });
  }

  async function forget(record, { keepRecord = false } = {}) {
    try {
      await checkpointer.deleteThread?.(record.id);
    } catch {}
    if (record.ownsDir && record.scratchRoot) {
      fs.rmSync(record.scratchRoot, { recursive: true, force: true });
    }
    if (!keepRecord) {
      persistence?.remove(record.id);
      for (const listener of record.listeners) {
        try { listener(null); } catch {}
      }
      interviews.delete(record.id);
    }
  }

  /**
   * Follow an interview's events from `after` (the last seq the client saw). Every
   * event so far is replayed first, so a client that reconnects misses nothing.
   * `listener(event)` gets null when the interview is gone.
   */
  function subscribe(id, after, listener) {
    const record = interviews.get(id);
    if (!record) return null;
    for (const event of record.events) if (event.seq > after) listener(event);
    // Already over: everything there is to know has just been sent.
    // (Judged by the last event, not the status: the status changes a moment before the
    // final event is sent, while the app's copy is being removed.)
    const last = record.events[record.events.length - 1]?.type;
    if (last === "finished" || last === "failed") return () => {};
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  function get(id) {
    const record = interviews.get(id);
    return record ? summary(record) : null;
  }

  /** Whose interview this is: the caller's email when it was started with a token. */
  function ownerOf(id) {
    return interviews.get(id)?.owner ?? null;
  }

  /**
   * The developer left (Ctrl+C, or quit at a question): drop the interview now rather
   * than keep their code for a day. A stretch still running finishes first.
   */
  async function remove(id) {
    const record = interviews.get(id);
    if (!record) return false;
    await record.running?.catch?.(() => {});
    if (record.status === "running" || record.status === "waiting") {
      record.status = "failed";
      emit(record, { type: "failed", message: "The interview was stopped." });
    }
    await forget(record);
    return true;
  }

  /**
   * Pick up the interviews kept from before the API restarted: one waiting on the
   * developer waits again, one that was mid-step carries on from its last saved step,
   * and an ended one stays for a client to replay. Anything older than a day goes.
   *
   * @returns {Promise<{ interviewId: string, as: string }[]>}
   */
  async function restore() {
    if (!persistence) return [];
    const cutoff = now() - INTERVIEW_TTL_MS;
    const picked = [];
    for (const { record: kept, events } of await persistence.loadAll()) {
      if (interviews.has(kept.id)) continue;
      const record = { ...kept, events, listeners: new Set() };
      interviews.set(record.id, record);
      if (record.createdAt < cutoff) {
        await forget(record);
        continue;
      }
      if (record.status === "running") {
        stretch(record, RESTART);
        picked.push({ interviewId: record.id, as: "carrying on from its last step" });
      } else if (record.status === "waiting") {
        picked.push({ interviewId: record.id, as: `waiting for ${record.waitingFor === "confirm" ? "Deploy this?" : "an answer"}` });
      } else if (record.status === "finished" || record.status === "failed") {
        // Saved as ended, but the API stopped before its last event was written: say it
        // now, so a client following it is not left waiting for an end that never comes.
        const last = record.events.at(-1)?.type;
        if (last !== "finished" && last !== "failed") {
          await end(record).catch(cleanupFailed(record));
          if (record.status === "finished") emit(record, { type: "finished", ...record.result, approved: record.approved });
          else emit(record, { type: "failed", message: record.failure || "seaLeye.run could not finish the interview." });
        }
      }
    }
    return picked;
  }

  /** Waits for the current stretch, for tests and for shutting down. */
  async function settled(id) {
    const record = interviews.get(id);
    await record?.running;
  }

  /**
   * Remove everything older than a day, finished or not, including scratch folders no
   * interview here owns: one the API was stopped in the middle of is otherwise left on
   * disk for good.
   */
  async function sweep() {
    const cutoff = now() - INTERVIEW_TTL_MS;
    for (const record of [...interviews.values()]) {
      if (record.createdAt < cutoff) await forget(record);
    }

    const owned = new Set([...interviews.values()].map(r => r.scratchRoot));
    let leftovers = [];
    try {
      leftovers = fs.readdirSync(scratchBase).filter(name => name.startsWith("int-"));
    } catch {}
    for (const name of leftovers) {
      const dir = path.join(scratchBase, name);
      try {
        if (!owned.has(dir) && fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }

  sweep().catch(() => {});
  const timer = setInterval(() => sweep().catch(() => {}), SWEEP_EVERY_MS);
  timer.unref();

  /**
   * The interviews one person has open: still running or waiting on them, newest first.
   * With no owner (a laptop API without tokens), every open one.
   */
  function openFor(owner) {
    return [...interviews.values()]
      .filter(r => (r.status === "running" || r.status === "waiting") && (owner === null || r.owner === owner))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map(r => ({ interviewId: r.id, app: r.app, status: r.status, waitingFor: r.waitingFor, startedAt: r.createdAt, mode: r.mode }));
  }

  return { start, startFromUpload, answer, remove, restore, subscribe, get, ownerOf, openFor, settled, sweep, ready, close: () => clearInterval(timer) };
}

function summary(record) {
  return {
    interviewId: record.id,
    app: record.app,
    status: record.status,
    waitingFor: record.waitingFor,
    ...(record.traceId ? { traceId: record.traceId } : {}),
    ...(record.result ? { result: record.result } : {}),
    ...(record.approved !== null ? { approved: record.approved } : {})
  };
}

/** What the confirm interrupt carries, minus its own type field. */
function strip({ type, ...rest }) {
  return rest;
}

/**
 * Run one interview in this process, start to plan, with the developer's side as
 * callbacks. For the regression set and for tests; the CLI goes through the API.
 * Resolves when the interview stops, fails, or reaches "Deploy this?", which it never
 * answers.
 *
 * @returns {Promise<{status, plan?, summary?, assumptions?, questions?, validationRetries?, message?, errors?, traceId?}>}
 */
export async function runInterview({ appPath, deployed = null, ask, onStep = () => {}, model, user, client, trace = true }) {
  const service = createInterviewService({ client });
  try {
    if (!service.ready()) {
      const err = new Error("ANTHROPIC_API_KEY is not set (nor SEALEYE_GATEWAY_KEY with SEALEYE_MODEL_URL), so the interview cannot run.");
      err.userFacing = true;
      throw err;
    }

    const { interviewId } = service.start({ appDir: path.resolve(appPath), deployed, user, model, trace });

    return await new Promise((resolve, reject) => {
      service.subscribe(interviewId, 0, async event => {
        if (!event) return;
        try {
          if (event.type === "step") onStep(event.line);
          else if (event.type === "question") service.answer(interviewId, await ask(event.question, event.lead));
          else if (event.type === "plan") resolve(strip(event));
          else if (event.type === "finished") resolve(strip(event));
          else if (event.type === "failed") {
            const err = new Error(event.message);
            err.userFacing = true;
            reject(err);
          }
        } catch (err) {
          reject(err);
        }
      });
    }).then(({ seq, at, approved, ...result }) => result);
  } finally {
    service.close();
  }
}

/**
 * The two files the plan is written down as (core/plan-files.js), with the plan, so
 * seaLeye.online can offer exactly what `sealeye run` writes into the folder. A plan
 * the files cannot be written for still reaches "Deploy this?"; the event says why.
 */
function filesFor(result) {
  if (!result?.plan) return {};
  try {
    return { files: planFiles({ plan: result.plan, summary: result.summary, assumptions: result.assumptions }) };
  } catch (err) {
    return { filesError: err.message };
  }
}

