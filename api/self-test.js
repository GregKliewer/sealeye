// api/self-test.js
// The self-test a catalog passes before it is approved, and again before it goes live
// (PHASE4-PLAN Step 7; DESIGN.md, "A catalog goes live through a self-test, approved and
// made live apart"). Plain code: no model, nothing spent, seconds.
//
// It asks what a developer would meet if this catalog were live: whether each module
// that must be refused is refused by the same check POST /plans/validate makes, whether
// a plan for each module it builds is accepted, and whether any word a developer reads
// is one they must never read. A catalog's shape, and any question about the whole
// catalog still open, are checked first.
import { PLAN_VERSION } from "../core/schema.js";
import { catalogProblems, isBuildable } from "../core/catalog.js";
import { developerWordProblems } from "../core/developer-words.js";
import { SELF_TEST_CHECKS } from "../core/discovery-words.js";
import { checkAgainst } from "./validate.js";

/** Why the platform will not build a module from this catalog, in words, or null when it will. */
export function whyRefused(m, document) {
  if (isBuildable(m.id, document)) return null;
  if (m.availability === "not_read" || m.not_read) return "it could not be read";
  if (m.availability === "deprecated") return "the library has deprecated it";
  if (m.availability !== "available") return `it is ${m.availability || "not marked available"}`;
  if (Array.isArray(m.open) && m.open.length) return "it rests on a question not yet answered";
  return "nothing the platform has builds it yet";
}

/** The smallest plan that names one module, against this catalog's version. */
export function planNaming(id, version, appType = "api") {
  return {
    planVersion: PLAN_VERSION,
    catalog: version,
    app: { name: "self-test", type: appType },
    profile: "dev",
    modules: [{ id, enabled: true }],
    outputs: []
  };
}

const check = (id, problems) => ({ id, title: SELF_TEST_CHECKS[id], passed: problems.length === 0, problems });

/**
 * Run the self-test on a catalog document.
 *
 * @param {object} p
 * @param {object} p.document         the catalog
 * @param {number} p.version          its version, which the plans name
 * @param {(id: string) => string | null} [p.questionText]  a question's words, by id
 * @returns {{ version, passed: boolean, checks: object[], refused: object[], built: string[], notes: string[] }}
 */
export function selfTest({ document, version, questionText = () => null }) {
  const shape = catalogProblems(document);
  if (shape.length) {
    return { version, passed: false, checks: [check("shape", shape)], refused: [], built: [], notes: [] };
  }

  // A question that touches no one module has no entry to hold back, so its guess
  // would go live with the catalog: the catalog waits for its answer.
  const open = Array.isArray(document.discovery?.open) ? document.discovery.open : [];
  const questions = open.map(id => {
    const words = questionText(id);
    return words ? `A question about the whole catalog is not answered yet: ${words}` : `A question about the whole catalog is not answered yet (${id})`;
  });

  const modules = (document.modules || []).filter(m => m && typeof m.id === "string");
  const refused = [];
  const built = [];
  const refusedProblems = [];
  const acceptedProblems = [];
  for (const m of modules) {
    const why = whyRefused(m, document);
    const result = checkAgainst(planNaming(m.id, version), document);
    if (why) {
      refused.push({ id: m.id, why });
      if (result.valid) refusedProblems.push(`A plan using ${m.id} was accepted, but ${why}, so it must be refused`);
    } else {
      built.push(m.id);
      if (!result.valid) acceptedProblems.push(`A plan using ${m.id} was refused: ${result.errors.map(e => e.message).join("; ")}`);
    }
  }

  // Every module the catalog offers, built yet or not: one waiting only for an executor
  // is built the day the platform has one, with no self-test in between.
  const offered = { ...document, modules: modules.filter(m => m.availability === "available") };
  // One problem a place, naming every word in it, so one fix finds them all.
  const byPlace = new Map();
  for (const p of developerWordProblems(offered)) {
    if (!byPlace.has(p.where)) byPlace.set(p.where, { cloud: [], size: [] });
    byPlace.get(p.where)[p.kind].push(p.term);
  }
  const and = list => (list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`);
  const words = [...byPlace].flatMap(([where, { cloud, size }]) => [
    ...(cloud.length ? [`${where} says ${and(cloud)}, ${cloud.length === 1 ? "a word" : "words"} a developer never reads; say what it does for their app`] : []),
    ...(size.length ? [`${where} gives ${and(size)}; a developer reads "set by a load test" instead`] : [])
  ]);

  const notes = [];
  if (!built.length) notes.push("It builds nothing yet: the platform has nothing that builds these modules, so every plan written against it will be refused until it does.");

  const checks = [
    check("shape", []),
    check("questions", questions),
    check("refused", refusedProblems),
    check("accepted", acceptedProblems),
    check("words", words)
  ];
  return { version, passed: checks.every(c => c.passed), checks, refused, built, notes };
}
