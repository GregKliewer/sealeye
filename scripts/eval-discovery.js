#!/usr/bin/env node
// scripts/eval-discovery.js
// Grade a catalog against the made-up organization's answer key (PHASE4-PLAN Step 4),
// as scripts/eval-interview.js grades plans:
//
//   npm run eval:discovery                                  grade the answer key itself
//   npm run eval:discovery -- --catalog <file.yaml|.json>   grade a catalog discovery wrote
//   npm run eval:discovery -- --library <path>              also check the key against
//                                                           a clone of the library
//   npm run eval:discovery -- --smoke                       seaLeye's own templates/,
//                                                           whose answer is the starter
//   npm run eval:discovery -- --run --library <path> [--answers none|scripted] [--out <dir>]
//                                                           run discovery for real on the
//                                                           clone and grade its draft
//
// Without --run the answer key is graded against itself (it must pass its own grading),
// and `--library` checks the key still matches the library, and that seaLeye's scanner
// stops the planted secret before any model could read it. With --run, discovery runs
// with the real model, twice (PHASE4-PLAN Step 7), so each result repeats: once with no
// answers given, graded on the questions it raised and the guesses it made, and once with
// the answers the key scripts (`answers:`), given at fixed points, graded on the catalog
// they settle. Each draft also gets the self-test a catalog passes before it is approved,
// and is graded on what it must refuse. What each worker spent is shown, to keep the caps
// honest (PHASE4-PLAN D6). With LangFuse keys, both are recorded as one dataset run
// (Datasets, then sealeye-discovery), with each run's trace, which holds its shape only.
// Run it before and after any change to discovery, its prompts above all.
//
// Without --run, needs no model and no keys. Deploys nothing either way.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import YAML from "yaml";

import { repoRoot } from "../core/config.js";
import { catalogProblems, starterCatalog } from "../core/catalog.js";
import { isRedactedLine } from "../core/scan.js";
import { secretFileReason } from "../core/secrets.js";

export const ANSWER_KEY = path.join(repoRoot, "test", "fixtures", "sample-platform", "answer-key.yaml");

/**
 * The answer key, with its catalog complete: need kinds and profiles are the starter's
 * unless the key gives its own.
 */
export function loadAnswerKey(file = ANSWER_KEY) {
  const key = YAML.parse(fs.readFileSync(file, "utf8"));
  const starter = starterCatalog();
  key.catalog = {
    need_kinds: starter.need_kinds,
    profiles: starter.profiles,
    ...key.catalog
  };
  return key;
}

/** A catalog file, YAML or JSON (JSON is YAML). */
export function loadCatalogFile(file) {
  return YAML.parse(fs.readFileSync(file, "utf8"));
}

const norm = text => String(text || "").toLowerCase();

/** Which discovery prompts a run used: a short hash of the three, as the interview's prompt is named. */
function promptsVersion() {
  const text = ["discovery-worker.md", "discovery-library.md", "discovery-supervisor.md"]
    .map(f => { try { return fs.readFileSync(path.join(repoRoot, "prompts", f), "utf8"); } catch { return ""; } }).join("\n");
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/**
 * Match each of the key's modules to the candidate's: by `source` (its folder in the
 * library), so discovery may name a module as it likes; by id when the candidate gives
 * no source. Each candidate entry is matched once at most.
 */
function matchModules(keyModules, candidateModules) {
  const left = [...candidateModules];
  const take = test => {
    const i = left.findIndex(test);
    return i === -1 ? null : left.splice(i, 1)[0];
  };
  const pairs = keyModules.map(k => ({
    key: k,
    found: take(c => c?.source && c.source === k.source) || take(c => !c?.source && c?.id === k.id)
  }));
  return { pairs, extra: left };
}

/**
 * Grade one catalog against the key. Every check that can be made today is made; the
 * ones that wait on a later step or an open question are listed with what they wait on,
 * never counted as passed.
 *
 * @returns {{ modules: object[], extra: string[], problems: string[], hardCases: object[],
 *   pending: object[], correct: boolean }}
 */
export function gradeCatalog(candidate, key, { questions = null, selfTest = null, scripted = false } = {}) {
  const keyModules = key.catalog.modules || [];
  const { pairs, extra } = matchModules(keyModules, candidate?.modules || []);
  const isAnswered = q => Boolean(q) && q.answer !== null && q.answer !== undefined;
  // The question about what the library leaves unclear: one touching the module and the
  // one it is unclear beside.
  const amb = key.hard_cases?.ambiguous;
  const aboutUnclear = amb ? [amb.module, ...(amb.with ? [amb.with] : [])] : [];
  // About the caches only: a question touching both and nothing else (a question about a
  // rule across every module touches both too, and is not about this; Greg's run, Oct 16).
  const unclearQuestion = Array.isArray(questions) && amb
    ? questions.find(q => aboutUnclear.every(s => (q.touches || []).includes(s)) && (q.touches || []).every(t => aboutUnclear.includes(t)))
    : null;

  const modules = pairs.map(({ key: k, found }) => {
    if (!found) return { source: k.source || k.id, found: false, ok: false, why: ["missing"] };
    const why = [];
    if (found.builds_with !== k.builds_with) why.push(`builds_with is ${found.builds_with ?? "missing"}, not ${k.builds_with}`);
    const offered = found.availability === "available";
    // A module the library leaves unclear is graded on its question, not on a guess,
    // until the question is answered; then on what the answer settles.
    const unclear = amb?.module === k.source && !isAnswered(unclearQuestion);
    const wanted = amb?.module === k.source && isAnswered(unclearQuestion) ? (key.answers?.ambiguous?.then?.availability || k.availability) : k.availability;
    if (!unclear && offered !== (wanted === "available")) {
      why.push(offered ? "offered, and it must not be" : `not offered (${found.availability ?? "no availability"})`);
    }
    const keyInputs = Object.keys(k.inputs || {});
    const theirs = new Set(Object.keys(found.inputs || {}));
    const missingInputs = keyInputs.filter(n => !theirs.has(n));
    const extraInputs = [...theirs].filter(n => !keyInputs.includes(n));
    if (missingInputs.length) why.push(`inputs missing: ${missingInputs.join(", ")}`);
    if (extraInputs.length) why.push(`inputs it does not have: ${extraInputs.join(", ")}`);
    const required = keyInputs.filter(n => k.inputs[n]?.required);
    const notRequired = required.filter(n => theirs.has(n) && !found.inputs[n]?.required);
    if (notRequired.length) why.push(`not marked required: ${notRequired.join(", ")}`);
    if (!String(found.line || "").trim()) why.push("no line");
    return { source: k.source || k.id, id: found.id, found: true, ok: why.length === 0, why };
  });

  const hc = key.hard_cases || {};
  const bySource = new Map(pairs.filter(p => p.found).map(p => [p.key.source, p.found]));
  const hardCases = [];

  // The deprecated module: never offered.
  if (hc.deprecated) {
    const m = bySource.get(hc.deprecated.module);
    hardCases.push({
      case: "deprecated",
      ok: Boolean(m) && m.availability !== "available",
      why: !m ? "not in the catalog" : m.availability === "available" ? "offered" : `kept as ${m.availability}`
    });
  }

  // The rule written only in a README: in the module's guidance, in its own terms.
  if (hc.readme_rule) {
    const m = bySource.get(hc.readme_rule.module);
    const missing = (hc.readme_rule.must_mention || []).filter(w => !norm(m?.guidance).includes(norm(w)));
    hardCases.push({
      case: "readme_rule",
      ok: Boolean(m) && missing.length === 0,
      why: !m ? "not in the catalog" : missing.length ? `guidance does not say ${missing.join(", ")}` : "in its guidance"
    });
  }

  // The overlap. One the library settles (Juniper's databases, by stage) is not a
  // question (Greg, Oct 15, 2026): it is caught when each entry says which stages it is
  // for and names the other, so a planner sees the pair. One it leaves unclear is caught
  // by a question touching every module in it. How a plan names a module per stage is
  // Q20's either way.
  const pending = [];
  const text = m => norm([m?.guidance, m?.when, m?.line].filter(Boolean).join(" "));
  // A module's name as a word of its own: "postgres" in "postgres-cluster" is not it.
  const names = m => [m.id, m.source, m.source.split("/").pop(), m.id.replace(/_/g, "-")].filter(Boolean);
  const named = (m, other) => names(other).some(n => new RegExp(`(^|[^a-z0-9_-])${n.toLowerCase().replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}($|[^a-z0-9_-])`).test(text(m)));
  if (hc.overlap) {
    const both = (hc.overlap.modules || []).map(s => bySource.get(s));
    const saysStage = m => /\bstaging\b/.test(norm(m?.guidance));
    hardCases.push({
      case: "overlap (part)",
      ok: both.every(m => m && saysStage(m)),
      why: both.some(m => !m) ? "not both in the catalog" : both.every(saysStage) ? "both there, each saying its stages" : "a database's guidance does not say which stages it is for"
    });
    if (hc.overlap.settled_by_library) {
      const [a, b] = both;
      const ok = Boolean(a && b) && named(a, b) && named(b, a);
      hardCases.push({ case: "overlap: each names the other", ok, why: !a || !b ? "not both in the catalog" : ok ? "each says which to use instead" : `${named(a, b) ? b.id : a.id}'s entry does not name ${named(a, b) ? a.id : b.id}` });
    } else if (Array.isArray(questions)) {
      const asked = questions.find(q => (hc.overlap.modules || []).every(s => (q.touches || []).includes(s)));
      hardCases.push({ case: "overlap asked", ok: Boolean(asked), why: asked ? `asked: ${asked.question}` : "no question touches both" });
    }
    pending.push({ case: "overlap", waits: "Q20 (a module per stage in a plan)", what: hc.overlap.rule });
  }

  // A module the stage adds beside the app's (PHASE5-PLAN D1, pattern 3): caught when its
  // entry says from which stage, and beside what. Its `with` waits on Phase 5 Step 2.
  if (hc.addition) {
    const m = bySource.get(hc.addition.module);
    const missing = (hc.addition.must_mention || []).filter(w => !text(m).includes(norm(w)));
    hardCases.push({
      case: "addition (part)",
      ok: Boolean(m) && missing.length === 0,
      why: !m ? "not in the catalog" : missing.length ? `its entry does not say ${missing.join(", ")}` : "it says from which stage, and beside what"
    });
    pending.push({ case: "addition", waits: "Phase 5 Step 2 (a stage's additions, `with`)", what: hc.addition.rule });
  }

  // What the library leaves unclear must be asked, and the entry rest on the question.
  if (hc.ambiguous) {
    const m = bySource.get(hc.ambiguous.module);
    if (Array.isArray(questions)) {
      // About what is unclear: touching the module, and the one it is unclear beside.
      const about = aboutUnclear;
      const asked = unclearQuestion;
      const unanswered = asked && !isAnswered(asked);
      const rests = Boolean(asked) && (!unanswered || (m?.open || []).includes(asked.id));
      hardCases.push({
        case: "unclear module asked",
        ok: Boolean(m) && Boolean(asked) && rests,
        why: !m ? "not in the catalog" : !asked ? `no question touches ${about.join(" and ")}, and only them` : !rests ? "asked, but its entry does not rest on the question" : `asked: ${asked.question}`
      });
    } else {
      pending.push({ case: "unclear module asked", waits: "a run's questions (--run)", what: hc.ambiguous.module });
    }
  }
  // With the key's answers given (the second pass): every answer is written into the
  // draft, and nothing it holds rests on a question any more.
  if (scripted && Array.isArray(questions)) {
    const notIn = questions.filter(q => isAnswered(q) && !q.usedAt);
    const stillOpen = questions.filter(q => !isAnswered(q));
    const resting = (candidate?.modules || []).filter(m => (m?.open || []).length).map(m => m.id);
    const ok = !notIn.length && !stillOpen.length && !resting.length && !(candidate?.discovery?.open || []).length;
    hardCases.push({
      case: "answers written in",
      ok,
      why: ok ? `${questions.length} answered, every one in the draft` : [
        notIn.length ? `${notIn.length} answered but not in the draft` : "",
        stillOpen.length ? `${stillOpen.length} never answered` : "",
        resting.length ? `still resting on a question: ${resting.join(", ")}` : ""
      ].filter(Boolean).join("; ") || "the catalog still rests on a question"
    });
  }

  // The self-test a catalog passes before it is approved (api/self-test.js): it passes,
  // and refuses what the key says must be refused.
  if (selfTest) {
    // With no answers given, a question about the whole catalog rightly holds up its
    // approval (DESIGN.md, Step 7): that check waits on the answer, and every other must
    // pass (Greg's run, Oct 16, 2026). With the key's answers, all of them must.
    const failing = selfTest.checks.filter(c => !c.passed);
    const waiting = !scripted ? failing.filter(c => c.id === "questions") : [];
    const blocking = failing.filter(c => !waiting.includes(c));
    hardCases.push({
      case: "self-test",
      ok: blocking.length === 0,
      why: !failing.length ? "passes: it could be approved" : blocking.length ? blocking.flatMap(c => c.problems).join("; ") : "passes, but for the questions about the whole catalog"
    });
    for (const c of waiting) pending.push({ case: "approval", waits: `the answers to ${c.problems.length} ${c.problems.length === 1 ? "question" : "questions"} about the whole catalog`, what: c.problems.map(p => p.replace(/^A question about the whole catalog is not answered yet: /, "")).join("; ") });
    const refusal = source => {
      const m = bySource.get(source);
      return m ? selfTest.refused.find(r => r.id === m.id) : null;
    };
    if (hc.deprecated) {
      const r = refusal(hc.deprecated.module);
      hardCases.push({ case: "must refuse: deprecated", ok: Boolean(r), why: r ? `refused: ${r.why}` : "a plan using it would be accepted" });
    }
    if (amb && unclearQuestion && !isAnswered(unclearQuestion)) {
      const r = refusal(amb.module);
      const ok = Boolean(r) && /question/.test(r.why);
      hardCases.push({ case: "must refuse: resting on a question", ok, why: ok ? `refused: ${r.why}` : r ? `refused, but for another reason: ${r.why}` : "a plan using it would be accepted" });
    }
  }

  if (key.stages) pending.push({ case: "stages", waits: "Phase 5", what: (key.stages.path || []).join(", ") });

  const problems = catalogProblems(candidate);
  const correct = problems.length === 0 && modules.every(m => m.ok) && extra.length === 0 && hardCases.every(h => h.ok);
  return {
    modules,
    extra: extra.map(m => m?.source || m?.id || "a module with no id"),
    problems,
    hardCases,
    pending,
    // Graded apart from `correct`, so a run before discovery mapped needs grades the
    // same as it did (DESIGN.md, "Discovery records which needs each module meets").
    needs: gradeNeeds(pairs, key),
    correct
  };
}

/**
 * Which needs each module meets, against the key, and the gaps that leaves: the need
 * kinds no offered module meets must be exactly the key's `gaps`. A draft with no
 * `meets` at all was made before discovery mapped needs, and says so.
 */
export function gradeNeeds(pairs, key) {
  const found = pairs.filter(p => p.found);
  if (!found.some(p => Array.isArray(p.found.meets))) return { mapped: false, ok: false, why: "no module says which needs it meets", modules: [], gaps: null };
  const set = a => [...new Set(a || [])].sort();
  const modules = found.filter(p => Array.isArray(p.key.meets)).map(p => {
    const wanted = set(p.key.meets);
    const got = set(p.found.meets);
    const ok = wanted.join() === got.join();
    return { source: p.key.source, ok, why: ok ? "" : `meets ${got.join(", ") || "nothing"}, not ${wanted.join(", ") || "nothing"}` };
  });
  const kinds = (key.catalog?.need_kinds || []).length ? key.catalog.need_kinds.map(n => n.key) : null;
  const offered = found.filter(p => p.found.availability === "available").flatMap(p => p.found.meets || []);
  const all = kinds || [...new Set([...(key.gaps || []), ...found.flatMap(p => p.key.meets || [])])];
  const unmet = set(all.filter(k => !offered.includes(k)));
  const gapsOk = unmet.join() === set(key.gaps).join();
  return {
    mapped: true,
    ok: modules.every(m => m.ok) && gapsOk,
    modules,
    gaps: { ok: gapsOk, unmet, wanted: set(key.gaps) }
  };
}

/** Each `variable "x" { ... }` in a module's .tf files, and whether it has a default. */
export function moduleVariables(dir) {
  const vars = {};
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith(".tf"))) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of text.matchAll(/^variable\s+"([A-Za-z0-9_]+)"\s*\{([\s\S]*?)^\}/gm)) {
      vars[m[1]] = { required: !/^\s*default\s*=/m.test(m[2]) };
    }
  }
  return vars;
}

/**
 * Check the key against a clone of the library: every module folder has an entry and
 * every entry a folder; each entry's inputs are its variables, required where the
 * variable has no default; and, read as discovery reads it, the planted secret's line is
 * replaced, the variables file is held back as its name, and the pipeline is read.
 *
 * @returns {Promise<{ problems: string[], checked: string[] }>}
 */
export async function checkLibrary(libraryDir, key, { readFolder } = {}) {
  const problems = [];
  const checked = [];
  const folders = fs.readdirSync(path.join(libraryDir, "modules"), { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => `modules/${d.name}`).sort();
  const entries = new Map((key.catalog.modules || []).map(m => [m.source, m]));

  for (const folder of folders) if (!entries.has(folder)) problems.push(`${folder} is in the library and not in the key`);
  for (const source of entries.keys()) if (!folders.includes(source)) problems.push(`${source} is in the key and not in the library`);
  checked.push(`${folders.length} module folders, ${entries.size} entries`);

  for (const folder of folders.filter(f => entries.has(f))) {
    const vars = moduleVariables(path.join(libraryDir, folder));
    const inputs = entries.get(folder).inputs || {};
    for (const [name, v] of Object.entries(vars)) {
      if (!inputs[name]) problems.push(`${folder}: variable ${name} is not an input in the key`);
      else if (Boolean(inputs[name].required) !== v.required) problems.push(`${folder}: ${name} is ${v.required ? "" : "not "}required in the library`);
    }
    for (const name of Object.keys(inputs)) if (!vars[name]) problems.push(`${folder}: input ${name} is not a variable in the library`);
  }
  checked.push("every entry's inputs against its variables");

  // Read as discovery reads it (api/discovery/library.js, PHASE4-PLAN Step 5): the same
  // walk, the shared rules and gitleaks, and each flagged line replaced before any
  // worker could read the file.
  const hc = key.hard_cases || {};
  const read = readFolder || (await import("../api/discovery/library.js")).readLibraryFolder;
  const snapshot = await read(libraryDir);
  try {
    const inSnapshot = file => path.join(snapshot.dir, ...file.split("/"));
    const missing = folders.filter(f => !fs.existsSync(inSnapshot(f)));
    if (missing.length) problems.push(`discovery's reading left out ${missing.join(", ")}`);
    const pipeline = path.join(snapshot.dir, ".github", "workflows");
    if (!fs.existsSync(pipeline) || !fs.readdirSync(pipeline).length) problems.push("discovery's reading left out the library's pipeline");
    checked.push("discovery reads every module folder and the pipeline");

    if (hc.planted_secret) {
      const { file, line, rule } = hc.planted_secret;
      const hit = snapshot.findings.find(f => f.file === file && f.line === line);
      if (!hit) problems.push(`the scanner did not stop ${file}:${line}`);
      else if (hit.rule !== rule) problems.push(`the scanner stopped ${file}:${line} as ${hit.rule}, not ${rule}`);
      const others = snapshot.findings.filter(f => f !== hit);
      if (others.length) problems.push(`the scanner found what the key does not plant: ${others.map(f => `${f.file}:${f.line}`).join(", ")}`);
      // The line is replaced, and the rest of the file is still there to read.
      const original = fs.readFileSync(path.join(libraryDir, file), "utf8").split("\n");
      const seen = fs.existsSync(inSnapshot(file)) ? fs.readFileSync(inSnapshot(file), "utf8").split("\n") : [];
      const others_ = lines => lines.filter((_, i) => i !== line - 1).join("\n");
      if (!isRedactedLine(seen[line - 1] || "")) problems.push(`${file}:${line} would reach a model as it is`);
      else if (seen.length !== original.length || others_(seen) !== others_(original)) {
        problems.push(`${file} reaches a model with more than its flagged line taken out`);
      }
      checked.push("the planted secret is stopped, its line replaced and the rest of its file read, and nothing else is found");
    }
    if (hc.secret_file) {
      const file = hc.secret_file.file;
      if (!fs.existsSync(path.join(libraryDir, file))) problems.push(`${file} is not in the library`);
      else if (!secretFileReason(path.basename(file))) problems.push(`${file} is not a file seaLeye refuses to read`);
      else if (!snapshot.secretFiles.includes(file) || fs.statSync(inSnapshot(file)).size !== 0) problems.push(`${file} is read, not held back as its name`);
      checked.push("the variables file is held back as its name only");
    }
  } finally {
    snapshot.remove();
  }
  return { problems, checked };
}

/** The grading, for the terminal. */
export function gradeLines(graded) {
  const lines = [];
  for (const m of graded.modules) {
    lines.push(`  ${m.ok ? "ok" : "NO"}  ${m.source}${m.id && m.found ? ` (${m.id})` : ""}${m.ok ? "" : `: ${m.why.join("; ")}`}`);
  }
  for (const e of graded.extra) lines.push(`  NO  ${e}: not in the library`);
  for (const p of graded.problems) lines.push(`  NO  the catalog: ${p}`);
  lines.push("");
  for (const h of graded.hardCases) lines.push(`  ${h.ok ? "ok" : "NO"}  ${h.case}: ${h.why}`);
  for (const p of graded.pending) lines.push(`  ..  ${p.case}: waits on ${p.waits} (${p.what})`);
  const n = graded.needs;
  if (n) {
    lines.push("");
    if (!n.mapped) lines.push(`  NO  needs met: ${n.why}`);
    else {
      for (const m of n.modules.filter(m => !m.ok)) lines.push(`  NO  ${m.source}: ${m.why}`);
      lines.push(`  ${n.modules.every(m => m.ok) ? "ok" : "NO"}  needs met: ${n.modules.filter(m => m.ok).length} of ${n.modules.length} modules as the key says`);
      lines.push(`  ${n.gaps.ok ? "ok" : "NO"}  gaps: nothing offered meets ${n.gaps.unmet.join(", ") || "nothing"}${n.gaps.ok ? "" : `; the key says ${n.gaps.wanted.join(", ")}`}`);
    }
  }
  return lines;
}

function argValue(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] || null;
}

/** The answer a script gives a question, or null to leave it (the key's `answers:`). */
export function scriptedAnswer(q, key, when) {
  const amb = key.hard_cases?.ambiguous;
  const about = amb ? [amb.module, ...(amb.with ? [amb.with] : [])] : [];
  const isUnclear = amb && about.every(s => (q.touches || []).includes(s)) && (q.touches || []).every(t => about.includes(t));
  const a = key.answers || {};
  if (isUnclear && a.ambiguous?.when === when) return a.ambiguous.answer;
  if (!isUnclear && a.others?.when === when) return a.others.answer === "guess" ? q.guess : a.others.answer;
  return null;
}

/**
 * Get ready to run discovery for real (PHASE4-PLAN Step 6): find the model key and the
 * LangFuse keys where this machine keeps them (the repo's .env or ~/.sealeye/config),
 * then move seaLeye's folder to a scratch one, so nothing a run keeps lands in this
 * machine's own. Returns what the passes need.
 */
async function prepareRuns() {
  const os = await import("node:os");
  const { modelCredential, resolveApiKey } = await import("../api/interview/model.js");
  resolveApiKey();
  if (!modelCredential()) throw new Error("--run needs a model key: ANTHROPIC_API_KEY in the environment, the repo's .env or ~/.sealeye/config");
  const tracing = await import("../core/tracing.js");
  const record = tracing.tracingConfigured() && !tracing.tracingSwitchedOff() && tracing.startTracing();
  process.env.SEALEYE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-eval-discovery-"));
  delete process.env.DATABASE_URL;
  const { openCatalogs } = await import("../api/catalogs.js");
  await openCatalogs();
  return { record, tracing };
}

/**
 * One run of discovery on the clone, graded. With `scripted`, the key's answers are
 * given at its fixed points: as a question goes out, or once the draft is written.
 * The draft and its questions are written to `out`.
 */
export async function runDiscovery(libraryDir, key, out, { scripted = false, client } = {}) {
  const { catalogAt } = await import("../api/catalogs.js");
  const { createDiscoveryService } = await import("../api/discovery/service.js");
  const { readLibraryFolder } = await import("../api/discovery/library.js");
  const { selfTest } = await import("../api/self-test.js");
  const service = createDiscoveryService({ ...(client ? { client } : {}), readLibrary: async () => readLibraryFolder(libraryDir, { repo: key.library }) });
  const [owner, repo] = key.library.split("/");
  const caller = { email: "eval@sealeye", org: `eval-${scripted ? "scripted" : "none"}`, team: "platform", scope: "org" };
  const started = Date.now();
  const { discoveryId } = await service.start({ caller, repos: [{ owner, repo }] });
  const given = [];
  const answeredIds = new Set();
  service.subscribe(discoveryId, 0, e => {
    if (!e) return;
    if (e.type === "read") console.log(`  read     ${e.source}`);
    if (e.type === "not_read") console.log(`  NOT READ ${e.source}: ${e.why}${e.error ? ` (${e.error})` : ""}`);
    if (e.type === "question" || e.type === "widened") {
      console.log(e.type === "question" ? `  asked    ${e.question.question} (guess: ${e.question.guess})` : `  widened  to touch ${e.question.touches.join(", ")}: ${e.question.question}`);
      const answer = scripted && !answeredIds.has(e.question.id) ? scriptedAnswer(e.question, key, "as_asked") : null;
      if (answer) answeredIds.add(e.question.id);
      if (answer) {
        given.push(service.answer({ id: discoveryId, questionId: e.question.id, answer, by: "eval@sealeye" }).catch(() => {}));
        console.log(`  answered ${answer}`);
      }
    }
    if (e.type === "merged") console.log(`  merged   ${e.questions.length} into one`);
    if (e.type === "plain_words") console.log(`  plain    writing again in plain words: ${e.sources.join(", ")}`);
    if (e.type === "plain_words_not_done") console.log(`  NOT PLAIN ${e.sources.join(", ")}: ${e.why}`);
    if (e.type === "writing") console.log("  writing the catalog");
  });
  await service.settled(discoveryId);
  await Promise.all(given);
  if (scripted) {
    // The rest, once the draft is written: late answers, each written into the draft.
    for (const q of service.questions(discoveryId).filter(q => q.answer === null)) {
      const answer = scriptedAnswer(q, key, "after_draft");
      if (!answer) continue;
      console.log(`  answered ${answer} (after the draft: ${q.question})`);
      await service.answer({ id: discoveryId, questionId: q.id, answer, by: "eval@sealeye" });
    }
    await service.settled(discoveryId);
  }
  const run = service.record(discoveryId);
  const questions = service.questions(discoveryId);
  const spend = Object.entries(run.spend || {}).map(([w, v]) => [w, v?.cost || 0]).sort((a, b) => b[1] - a[1]);
  const total = spend.reduce((t, [, c]) => t + c, 0);
  console.log(`
The run: ${run.status}${run.reason ? ` (${run.reason})` : ""}, ${Math.round((Date.now() - started) / 1000)} s, US$${total.toFixed(4)} in all`);
  // Why a run that failed or stopped did, as the run says it (Oct 22, 2026: a run that
  // failed in no time printed nothing more than "failed (error)").
  if (run.message) console.log(`  ${run.message}`);
  for (const [w, c] of spend) console.log(`  US$${c.toFixed(4)}  ${w}`);
  if (!run.catalogVersion) return { graded: null, run, questions, total };
  const draft = catalogAt(run.org, run.catalogVersion);
  const tested = selfTest({ document: draft, version: run.catalogVersion, questionText: id => questions.find(q => q.id === id)?.question || null });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, YAML.stringify({ ...draft, questions, selfTest: tested }));
  console.log(`
The draft, with its questions and its self-test: ${out}`);
  return { graded: gradeCatalog(draft, key, { questions, selfTest: tested, scripted }), run, questions, total };
}

const DATASET = "sealeye-discovery";

/** The dataset's id, creating it the first time. */
async function ensureDataset(langfuseRequest) {
  try {
    const created = await langfuseRequest("POST", "/api/public/v2/datasets", {
      name: DATASET,
      description: "Juniper Mutual's library, graded against its answer key with no answers and with scripted ones. Written by scripts/eval-discovery.js."
    }, 10_000);
    if (created?.id) return created.id;
  } catch {}
  return (await langfuseRequest("GET", `/api/public/v2/datasets/${encodeURIComponent(DATASET)}`, undefined, 10_000))?.id;
}

/** What a pass is expected to come to, for the dataset item: counts and names, never the library's words. */
const expectedFor = (key, scripted) => ({
  modules: (key.catalog.modules || []).length,
  refused: [key.hard_cases?.deprecated?.module].filter(Boolean),
  hardCases: Object.keys(key.hard_cases || {}),
  answers: scripted ? "the key's, at fixed points" : "none"
});

async function main(args) {
  if (args.includes("--run")) {
    const library = argValue(args, "--library");
    if (!library) {
      console.error("--run reads a clone of the library: add --library <path>");
      process.exitCode = 1;
      return;
    }
    const which = argValue(args, "--answers");
    if (which && !["none", "scripted"].includes(which)) {
      console.error("--answers is none or scripted; left out, both run");
      process.exitCode = 1;
      return;
    }
    const passes = which ? [which === "scripted"] : [false, true];
    const key = loadAnswerKey();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outDir = path.resolve(argValue(args, "--out") || "eval-results");
    const { record, tracing } = await prepareRuns();
    const runName = `${stamp} discovery`;
    const datasetId = record ? await ensureDataset(tracing.langfuseRequest).catch(() => null) : null;
    const experimentId = tracing.newExperimentId();
    if (!record) console.log("\nLangFuse keys are not set here, or tracing is off: graded, and not recorded.");
    else if (!datasetId) console.log("\nThe dataset could not be reached in LangFuse: graded, and not recorded.");

    let allOk = true;
    for (const scripted of passes) {
      const name = scripted ? "scripted-answers" : "no-answers";
      console.log(`\nDiscovery on Juniper Mutual (${path.resolve(library)}), ${scripted ? "with the key's answers, at fixed points" : "no answers given"}:\n`);
      const out = path.join(outDir, `discovery-${stamp}-${name}.yaml`);
      const pass = async () => runDiscovery(path.resolve(library), key, out, { scripted });
      let result = null;
      if (datasetId) {
        const itemId = `${DATASET}-juniper-${name}`;
        await tracing.langfuseRequest("POST", "/api/public/dataset-items", { datasetName: DATASET, id: itemId, input: { library: key.library, answers: name }, expectedOutput: expectedFor(key, scripted) }, 10_000).catch(() => {});
        await tracing.traceExperimentItem(
          { experimentId, runName, description: `Discovery prompts ${promptsVersion()}`, datasetId, itemId, input: { library: key.library, answers: name }, expectedOutput: expectedFor(key, scripted) },
          async ({ traceId }) => {
            // The item's output in LangFuse is counts and yes-or-no, never a question's
            // words, an answer or the run's record: the library is read by clone, and
            // the clone named could be anyone's (the review, Oct 16, 2026).
            result = await pass();
            result.traceId = traceId;
            const g = result.graded;
            return {
              correct: Boolean(g?.correct),
              modulesRight: g ? g.modules.filter(m => m.ok).length : 0,
              hardCasesCaught: g ? g.hardCases.filter(h => h.ok).length : 0,
              hardCases: g ? g.hardCases.length : 0,
              questions: result.questions.length,
              spent: Number(result.total.toFixed(4))
            };
          }
        );
      } else {
        result = await pass();
      }
      const { graded } = result;
      if (!graded) {
        console.log("\nNo draft to grade.");
        allOk = false;
        continue;
      }
      console.log("");
      for (const line of gradeLines(graded)) console.log(line);
      console.log(`\n${graded.correct ? "As expected." : "Not as expected."}`);
      allOk = allOk && graded.correct;
      if (datasetId && result.traceId) {
        await tracing.flushTracing();
        tracing.scoreTrace(result.traceId, "catalog_correct", graded.correct);
        tracing.scoreTrace(result.traceId, "hard_cases_caught", graded.hardCases.filter(h => h.ok).length);
        const selfTestCase = graded.hardCases.find(h => h.case === "self-test");
        if (selfTestCase) tracing.scoreTrace(result.traceId, "self_test_passed", selfTestCase.ok);
        const refusals = graded.hardCases.filter(h => h.case.startsWith("must refuse"));
        if (refusals.length) tracing.scoreTrace(result.traceId, "must_refuse_refused", refusals.every(h => h.ok));
        tracing.scoreTrace(result.traceId, "questions_asked", result.questions.length);
        if (graded.needs) tracing.scoreTrace(result.traceId, "needs_mapped", graded.needs.ok);
      }
    }
    if (datasetId) {
      await tracing.flushTracing();
      await tracing.flushScores(10_000);
      console.log(`\nIn LangFuse: Datasets, ${DATASET}, Experiments, then ${runName}.`);
    }
    process.exitCode = allOk ? 0 : 1;
    return;
  }

  if (args.includes("--smoke")) {
    // seaLeye's own templates/: the starter catalog is their answer. Discovery's own
    // reading of them is Step 6; until then the starter is graded against itself.
    const starter = starterCatalog();
    const problems = catalogProblems(starter);
    console.log(`\nThe smoke test, seaLeye's own templates/: the starter catalog, ${starter.modules.length} modules`);
    console.log(problems.length ? problems.map(p => `  NO  ${p}`).join("\n") : "  ok  a catalog by its own rules");
    process.exitCode = problems.length ? 1 : 0;
    return;
  }

  const key = loadAnswerKey();
  const catalogFile = argValue(args, "--catalog");
  const candidate = catalogFile ? loadCatalogFile(catalogFile) : key.catalog;
  const graded = gradeCatalog(candidate, key);

  console.log(`\nJuniper Mutual (${key.library}): ${catalogFile ? path.basename(catalogFile) : "the answer key itself"}`);
  console.log("");
  for (const line of gradeLines(graded)) console.log(line);
  let ok = graded.correct;

  const library = argValue(args, "--library");
  if (library) {
    const { problems, checked } = await checkLibrary(path.resolve(library), key);
    console.log("\nThe key against the library:");
    for (const c of checked) console.log(`  ..  ${c}`);
    for (const p of problems) console.log(`  NO  ${p}`);
    if (!problems.length) console.log("  ok  the key matches the library");
    ok = ok && problems.length === 0;
  }

  console.log(`\n${ok ? "As expected." : "Not as expected."}`);
  process.exitCode = ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main(process.argv.slice(2)).catch(err => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
