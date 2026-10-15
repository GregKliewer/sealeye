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
//   npm run eval:discovery -- --run --library <path> [--out <file>]
//                                                           run discovery for real on the
//                                                           clone and grade its draft
//
// Without --run the answer key is graded against itself (it must pass its own grading),
// and `--library` checks the key still matches the library, and that seaLeye's scanner
// stops the planted secret before any model could read it. With --run, discovery runs
// with the real model and no answers given: the draft and the questions it raised are
// graded, and what each worker spent is shown, to set the caps (PHASE4-PLAN D6).
// Recording a run in LangFuse, and a second run with scripted answers, are Step 7's.
//
// Without --run, needs no model and no keys. Deploys nothing either way.
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
export function gradeCatalog(candidate, key, { questions = null } = {}) {
  const keyModules = key.catalog.modules || [];
  const { pairs, extra } = matchModules(keyModules, candidate?.modules || []);

  const modules = pairs.map(({ key: k, found }) => {
    if (!found) return { source: k.source || k.id, found: false, ok: false, why: ["missing"] };
    const why = [];
    if (found.builds_with !== k.builds_with) why.push(`builds_with is ${found.builds_with ?? "missing"}, not ${k.builds_with}`);
    const offered = found.availability === "available";
    // A module the library leaves unclear is graded on its question, not on a guess.
    const unclear = key.hard_cases?.ambiguous?.module === k.source;
    if (!unclear && offered !== (k.availability === "available")) {
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

  // What the library leaves unclear must be asked, and the entry rest on the question.
  if (hc.ambiguous) {
    const m = bySource.get(hc.ambiguous.module);
    if (Array.isArray(questions)) {
      const asked = questions.find(q => (q.touches || []).includes(hc.ambiguous.module));
      const unanswered = asked && (asked.answer === null || asked.answer === undefined);
      const rests = Boolean(asked) && (!unanswered || (m?.open || []).includes(asked.id));
      hardCases.push({
        case: "unclear module asked",
        ok: Boolean(m) && Boolean(asked) && rests,
        why: !m ? "not in the catalog" : !asked ? `no question touches ${hc.ambiguous.module}` : !rests ? "asked, but its entry does not rest on the question" : `asked: ${asked.question}`
      });
    } else {
      pending.push({ case: "unclear module asked", waits: "a run's questions (--run)", what: hc.ambiguous.module });
    }
  }
  if (key.gaps?.length) pending.push({ case: "gaps", waits: "PHASE4-PLAN Step 10, the gap report", what: key.gaps.join(", ") });
  if (key.stages) pending.push({ case: "stages", waits: "Phase 5", what: (key.stages.path || []).join(", ") });

  const problems = catalogProblems(candidate);
  const correct = problems.length === 0 && modules.every(m => m.ok) && extra.length === 0 && hardCases.every(h => h.ok);
  return {
    modules,
    extra: extra.map(m => m?.source || m?.id || "a module with no id"),
    problems,
    hardCases,
    pending,
    correct
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
  return lines;
}

function argValue(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] || null;
}

/**
 * Run discovery for real on a clone of the library (PHASE4-PLAN Step 6): the real model,
 * through the gateway when this machine is set for one, with no answers given, so the
 * questions it raises and the guesses it makes are what is graded. Keeps nothing in this
 * machine's seaLeye folder: the run's draft is written to `out`.
 */
async function runDiscovery(libraryDir, key, out) {
  const os = await import("node:os");
  // The model key is found first, where this machine keeps it (the repo's .env or
  // ~/.sealeye/config), before seaLeye's folder moves to a scratch one for the run.
  const { modelCredential, resolveApiKey } = await import("../api/interview/model.js");
  resolveApiKey();
  if (!modelCredential()) throw new Error("--run needs a model key: ANTHROPIC_API_KEY in the environment, the repo's .env or ~/.sealeye/config");
  process.env.SEALEYE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-eval-discovery-"));
  delete process.env.DATABASE_URL;
  const { openCatalogs, catalogAt } = await import("../api/catalogs.js");
  const { createDiscoveryService } = await import("../api/discovery/service.js");
  const { readLibraryFolder } = await import("../api/discovery/library.js");
  await openCatalogs();
  const service = createDiscoveryService({ readLibrary: async () => readLibraryFolder(libraryDir, { repo: key.library }) });
  const [owner, repo] = key.library.split("/");
  const caller = { email: "eval@sealeye", org: "eval", team: "platform", scope: "org" };
  const started = Date.now();
  const { discoveryId } = await service.start({ caller, repos: [{ owner, repo }] });
  service.subscribe(discoveryId, 0, e => {
    if (!e) return;
    if (e.type === "read") console.log(`  read     ${e.source}`);
    if (e.type === "not_read") console.log(`  NOT READ ${e.source}: ${e.why}`);
    if (e.type === "question") console.log(`  asked    ${e.question.question} (guess: ${e.question.guess})`);
    if (e.type === "writing") console.log("  writing the catalog");
  });
  await service.settled(discoveryId);
  const run = service.record(discoveryId);
  const questions = service.questions(discoveryId);
  const spend = Object.entries(run.spend || {}).map(([w, v]) => [w, v?.cost || 0]).sort((a, b) => b[1] - a[1]);
  const total = spend.reduce((t, [, c]) => t + c, 0);
  console.log(`
The run: ${run.status}${run.reason ? ` (${run.reason})` : ""}, ${Math.round((Date.now() - started) / 1000)} s, US$${total.toFixed(4)} in all`);
  for (const [w, c] of spend) console.log(`  US$${c.toFixed(4)}  ${w}`);
  if (!run.catalogVersion) return { graded: null, run };
  const draft = catalogAt(run.org, run.catalogVersion);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, YAML.stringify({ ...draft, questions }));
  console.log(`
The draft, with its questions: ${out}`);
  return { graded: gradeCatalog(draft, key, { questions }), run };
}

async function main(args) {
  if (args.includes("--run")) {
    const library = argValue(args, "--library");
    if (!library) {
      console.error("--run reads a clone of the library: add --library <path>");
      process.exitCode = 1;
      return;
    }
    const key = loadAnswerKey();
    const out = path.resolve(argValue(args, "--out") || path.join("eval-results", `discovery-${new Date().toISOString().replace(/[:.]/g, "-")}.yaml`));
    console.log(`
Discovery on Juniper Mutual (${path.resolve(library)}), no answers given:\n`);
    const { graded } = await runDiscovery(path.resolve(library), key, out);
    if (!graded) {
      console.log("\nNo draft to grade.");
      process.exitCode = 1;
      return;
    }
    console.log("");
    for (const line of gradeLines(graded)) console.log(line);
    console.log(`\n${graded.correct ? "As expected." : "Not as expected."}`);
    process.exitCode = graded.correct ? 0 : 1;
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
