// core/stages.js
// The path to production a catalog describes, and a plan resolved for a stage on it
// (PHASE5-PLAN Step 1; DESIGN.md, "A module per stage, in the catalog" and "Who applies
// each stage is in the catalog").
//
// A catalog's `stages` says, in order, the stages of its path, who applies each (seaLeye
// or the organization's own pipeline) and what gate each waits on; which stages are set
// aside (perf, built from staging for a load test, never promoted to); and what a stage
// adds beside what a plan names (`with`). Each module entry may say which stages it is
// for (`stages`) and what takes its place from a later stage (`instead`). Libraries
// change what is built at a later stage in those three ways: the same module told its
// stage (the most common, which needs nothing here but `stages`), a different module
// (`instead`), or a module added beside (`with`).
//
// A catalog with no `stages` has a path of one stage, dev, which seaLeye applies: every
// catalog before Phase 5, and the starter. Nothing about it changes.
//
// It runs in a browser too (the portal imports it), so it imports nothing.

/** Who applies a stage: seaLeye's own executor, or the organization's pipeline. */
export const APPLIERS = Object.freeze(["sealeye", "pipeline"]);

/** The first stage of every path, which a developer builds without asking. */
export const FIRST_STAGE = "dev";

const isText = v => typeof v === "string" && v.trim() !== "";
const isName = v => typeof v === "string" && /^[a-z][a-z0-9-]*$/.test(v);
const list = v => (Array.isArray(v) ? v : []);
const entryOf = (catalog, id) => list(catalog?.modules).find(m => m && m.id === id) || null;
const and = items => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

function stageOf(raw, aside = false) {
  const s = { name: raw.name, applies: raw.name === FIRST_STAGE ? "sealeye" : raw.applies, gate: list(raw.gate).filter(isText) };
  if (isText(raw.pipeline)) s.pipeline = raw.pipeline;
  if (aside) s.from = raw.from;
  return s;
}

/**
 * A catalog's path to production: { path, aside, with }. `path` is its stages in order,
 * each { name, applies, gate, pipeline? }; `aside` the stages built from one on the path
 * and never promoted to, each with `from`; `with` what a stage adds. A catalog that says
 * nothing has dev alone, which seaLeye applies.
 */
export function stagePath(catalog) {
  const st = catalog?.stages;
  if (!st || typeof st !== "object" || !Array.isArray(st.path) || !st.path.length) {
    return { path: [{ name: FIRST_STAGE, applies: "sealeye", gate: [] }], aside: [], with: [] };
  }
  return {
    path: st.path.filter(s => s && isName(s.name)).map(s => stageOf(s)),
    aside: list(st.aside).filter(s => s && isName(s.name)).map(s => stageOf(s, true)),
    with: list(st.with).filter(w => w && isText(w.module))
  };
}

/** Whether a catalog's path goes past dev: the only time anything below has a say. */
export function hasStagesPastDev(catalog) {
  return stagePath(catalog).path.length > 1;
}

/** Every stage a catalog knows, on the path and aside, in order. */
export function stageNames(catalog) {
  const { path, aside } = stagePath(catalog);
  return [...path.map(s => s.name), ...aside.map(s => s.name)];
}

/** A stage of the catalog's, on the path or aside, or null. */
export function stageNamed(catalog, name) {
  const { path, aside } = stagePath(catalog);
  return path.find(s => s.name === name) || aside.find(s => s.name === name) || null;
}

/**
 * Where a stage stands on the path: its place, or for a stage set aside the place of the
 * stage it is built from (perf stands with staging). -1 for a stage the catalog lacks.
 */
export function stageOrder(catalog, name) {
  const { path, aside } = stagePath(catalog);
  const at = path.findIndex(s => s.name === name);
  if (at >= 0) return at;
  const side = aside.find(s => s.name === name);
  return side ? path.findIndex(s => s.name === side.from) : -1;
}

/** The stage after this one on the path, or null: the end of the path, or a stage aside. */
export function nextStage(catalog, from) {
  const { path } = stagePath(catalog);
  const at = path.findIndex(s => s.name === from);
  return at >= 0 && at + 1 < path.length ? path[at + 1].name : null;
}

/** The stages a module is for: those its entry names, or every stage when it names none. */
export function stagesFor(entry, catalog) {
  return Array.isArray(entry?.stages) ? entry.stages : stageNames(catalog);
}

/**
 * The module that serves a planned module at a stage, following `instead` from stage to
 * stage: { id, entry, via } with `via` the ids it came through, or { why } when none does.
 */
export function moduleAtStage(catalog, id, stage) {
  const order = stageOrder(catalog, stage);
  const via = [];
  let current = entryOf(catalog, id);
  if (!current) return { why: `${id} is not in the catalog` };
  for (let hops = 0; hops < 8; hops++) {
    const instead = current.instead;
    if (instead && isText(instead.module) && stageOrder(catalog, instead.from) >= 0 && order >= stageOrder(catalog, instead.from)) {
      const next = entryOf(catalog, instead.module);
      if (!next) return { why: `${current.id} is replaced from ${instead.from} by ${instead.module}, which is not in the catalog` };
      via.push(current.id);
      current = next;
      continue;
    }
    if (!stagesFor(current, catalog).includes(stage)) return { why: `${current.id} is not for ${stage}, and nothing takes its place there` };
    return { id: current.id, entry: current, via };
  }
  return { why: `${id} is replaced too many times on the way to ${stage}` };
}

/**
 * A plan as it would be built at a stage: each module it uses served at that stage (an
 * `instead` taken), each module the stage adds beside what the plan uses (`with`), the
 * plan's own words for each module (`connect`, inputs) kept. Nothing else of the plan
 * changes: what was approved in dev is what is built.
 *
 * @returns {{ stage, plan, changes: object[], problems: string[] }}
 *   `changes`: { kind: "instead", from, to } and { kind: "with", module, beside } for
 *   each; `problems`: why the plan cannot be built there, in words, empty when it can.
 */
export function resolveForStage(plan, catalog, stage) {
  const problems = [];
  const changes = [];
  if (stageOrder(catalog, stage) < 0) {
    return { stage, plan: null, changes, problems: [`${stage} is not a stage on this catalog's path`] };
  }
  const modules = [];
  for (const m of list(plan?.modules)) {
    if (!m || m.enabled === false) { modules.push(m); continue; }
    const at = moduleAtStage(catalog, m.id, stage);
    if (at.why) { problems.push(at.why); modules.push(m); continue; }
    if (at.id !== m.id) changes.push({ kind: "instead", from: m.id, to: at.id });
    modules.push(at.id === m.id ? m : { ...m, id: at.id });
  }
  const order = stageOrder(catalog, stage);
  const used = modules.filter(m => m && m.enabled !== false);
  for (const w of stagePath(catalog).with) {
    if (stageOrder(catalog, w.from) < 0 || order < stageOrder(catalog, w.from)) continue;
    const beside = used.find(m => list(entryOf(catalog, m.id)?.meets).includes(w.beside));
    if (!beside || modules.some(m => m && m.id === w.module)) continue;
    if (!entryOf(catalog, w.module)) { problems.push(`${stage} adds ${w.module}, which is not in the catalog`); continue; }
    modules.push({ id: w.module, enabled: true });
    changes.push({ kind: "with", module: w.module, beside: beside.id });
  }
  return { stage, plan: { ...plan, modules }, changes, problems };
}

/**
 * What is wrong with a catalog's path and its modules' stages, as a document: names,
 * order, who applies each stage, and that every module and stage named exists. Empty
 * when nothing is, and for a catalog that says nothing of stages. Whether the map holds
 * together (each `instead` and `with` proven) is the self-test's: stageMapGaps.
 */
export function stageMapProblems(doc) {
  const problems = [];
  const st = doc?.stages;
  const ids = new Set(list(doc?.modules).map(m => m?.id).filter(isText));
  if (st !== undefined) {
    if (!st || typeof st !== "object" || Array.isArray(st)) return ["stages is a path, what is set aside, and what a stage adds"];
    if (!Array.isArray(st.path) || !st.path.length) problems.push("stages.path is a list of stages, dev first");
    else {
      if (st.path[0]?.name !== FIRST_STAGE) problems.push(`stages.path starts with ${FIRST_STAGE}, which a developer builds`);
      if (st.path[0]?.gate !== undefined && list(st.path[0].gate).length) problems.push(`${FIRST_STAGE} has no gate: a developer builds it without asking`);
      if (st.path[0]?.applies !== undefined && st.path[0].applies !== "sealeye") problems.push(`${FIRST_STAGE} is applied by seaLeye`);
    }
    const seen = new Set();
    const checkStage = (s, where, aside) => {
      if (!s || !isName(s.name)) return problems.push(`${where}: a stage has a name of lowercase letters, digits and hyphens`);
      if (seen.has(s.name)) problems.push(`stage ${s.name} is named twice`);
      seen.add(s.name);
      if (s.name !== FIRST_STAGE) {
        if (!APPLIERS.includes(s.applies)) problems.push(`stage ${s.name}: applies is sealeye or pipeline, who builds it`);
        if (s.applies === "pipeline" && !isText(s.pipeline)) problems.push(`stage ${s.name}: a stage the pipeline applies names the pipeline`);
      }
      if (s.gate !== undefined && (!Array.isArray(s.gate) || !s.gate.every(isText))) problems.push(`stage ${s.name}: gate is a list of what it waits on, in words`);
      if (aside && !list(st.path).some(p => p?.name === s.from)) problems.push(`stage ${s.name} is built from ${s.from ?? "a stage"}, which is not on the path`);
    };
    list(st.path).forEach((s, i) => checkStage(s, `stages.path ${i + 1}`, false));
    if (st.aside !== undefined && !Array.isArray(st.aside)) problems.push("stages.aside is a list of stages");
    list(st.aside).forEach((s, i) => checkStage(s, `stages.aside ${i + 1}`, true));
    if (st.with !== undefined && !Array.isArray(st.with)) problems.push("stages.with is a list of what a stage adds");
    const kinds = new Set(list(doc?.need_kinds).map(n => n?.key).filter(Boolean));
    list(st.with).forEach((w, i) => {
      if (!w || !isText(w.module)) return problems.push(`stages.with ${i + 1} names no module`);
      if (!ids.has(w.module)) problems.push(`stages.with adds ${w.module}, which is not in the catalog`);
      if (!list(st.path).some(p => p?.name === w.from) || w.from === FIRST_STAGE) problems.push(`stages.with adds ${w.module} from ${w.from ?? "no stage"}, which is not a stage past ${FIRST_STAGE} on the path`);
      // Need kinds missing altogether are catalogProblems' to say.
      if (Array.isArray(doc?.need_kinds) && !kinds.has(w.beside)) problems.push(`stages.with adds ${w.module} beside ${w.beside ?? "nothing"}, which is not one of the catalog's need kinds`);
    });
  }
  const known = new Set(st && typeof st === "object" ? [...list(st.path), ...list(st.aside)].map(s => s?.name).filter(Boolean) : [FIRST_STAGE]);
  for (const m of list(doc?.modules)) {
    if (!m || !isText(m.id)) continue;
    if (m.stages !== undefined) {
      if (!Array.isArray(m.stages) || !m.stages.length) problems.push(`module ${m.id}: stages is a list of the stages it is for`);
      else for (const s of m.stages) if (!known.has(s)) problems.push(`module ${m.id}: stages names ${s}, which is not on the catalog's path`);
    }
    if (m.instead !== undefined) {
      const i = m.instead;
      if (!i || typeof i !== "object" || !isText(i.module)) { problems.push(`module ${m.id}: instead names the module that takes its place, and from which stage`); continue; }
      if (!ids.has(i.module)) problems.push(`module ${m.id}: instead names ${i.module}, which is not in the catalog`);
      if (i.module === m.id) problems.push(`module ${m.id}: instead names itself`);
      if (!known.has(i.from) || i.from === FIRST_STAGE) problems.push(`module ${m.id}: instead is from ${i.from ?? "no stage"}, which is not a stage past ${FIRST_STAGE} on the path`);
    }
  }
  return problems;
}

const requiredInputs = entry => Object.entries(entry?.inputs || {}).filter(([, v]) => v?.required).map(([k]) => k).sort();
const offered = entry => [...(entry?.offers?.access ? ["access"] : []), ...list(entry?.offers?.values)];

/**
 * Whether a catalog's stage map holds together (PHASE5-PLAN D2), in words: what the
 * self-test refuses. Each `instead` proven: the module that takes over takes the same
 * required inputs, offers everything the one it replaces offers (so a plan's `connect`
 * still holds), and meets the same needs. Every module available from some stage has one
 * at every later stage, itself or through `instead`. Every `with` adds a module no app
 * asks for, beside a need some module meets. Empty for a catalog with dev alone.
 */
export function stageMapGaps(doc) {
  if (!hasStagesPastDev(doc)) return [];
  const gaps = [];
  const names = stageNames(doc);
  for (const m of list(doc?.modules)) {
    if (!m || !isText(m.id) || m.availability !== "available") continue;
    const i = m.instead;
    if (i && isText(i.module)) {
      const later = entryOf(doc, i.module);
      if (later) {
        const [a, b] = [requiredInputs(m), requiredInputs(later)];
        if (a.join() !== b.join()) gaps.push(`${i.module} takes ${m.id}'s place from ${i.from}, but needs ${and(b) || "nothing"} where ${m.id} needs ${and(a) || "nothing"}`);
        const lost = offered(m).filter(o => !offered(later).includes(o));
        if (lost.length) gaps.push(`${i.module} takes ${m.id}'s place from ${i.from}, but does not offer ${and(lost)}, which a plan may connect`);
        const unmet = list(m.meets).filter(k => !list(later.meets).includes(k));
        if (unmet.length) gaps.push(`${i.module} takes ${m.id}'s place from ${i.from}, but does not meet ${and(unmet)}`);
      }
    }
    // From the first stage a module is for, every later one has a module for it.
    const first = Math.min(...stagesFor(m, doc).map(s => stageOrder(doc, s)).filter(n => n >= 0));
    if (!Number.isFinite(first)) continue;
    const missing = names.filter(s => stageOrder(doc, s) >= first && moduleAtStage(doc, m.id, s).why);
    if (missing.length) gaps.push(`${m.id} has no module at ${and(missing)}: say what takes its place (instead), or that it is for ${missing.length === 1 ? "that stage" : "those stages"} too`);
  }
  for (const w of stagePath(doc).with) {
    const added = entryOf(doc, w.module);
    if (added && list(added.meets).length) gaps.push(`${w.from} adds ${w.module}, which meets what an app asks for (${and(added.meets)}); a module a stage adds is one no app asks for`);
    if (!list(doc?.modules).some(m => m?.availability === "available" && list(m.meets).includes(w.beside))) gaps.push(`${w.from} adds ${w.module} beside ${w.beside}, which no module the catalog offers meets`);
  }
  return gaps;
}

/**
 * A catalog's stage map as a client reads it (GET /catalog's document, PHASE5-PLAN Step
 * 1): the path, each stage's gate and who applies it, what is set aside, and what a stage
 * adds, said by the added module's line and the need it stands beside, never by an id,
 * since a module a stage adds may be one the platform does not build yet (principle 2).
 * Which pipeline applies a stage is the platform's to know. Null for dev alone.
 */
export function stageMapView(catalog) {
  if (!hasStagesPastDev(catalog)) return null;
  const { path, aside, with: adds } = stagePath(catalog);
  const need = key => list(catalog?.need_kinds).find(n => n?.key === key)?.line || key;
  const shown = s => ({ name: s.name, applies: s.applies, gate: s.gate, ...(s.from ? { from: s.from } : {}) });
  return {
    path: path.map(shown),
    aside: aside.map(shown),
    with: adds.map(w => ({ from: w.from, beside: need(w.beside), line: entryOf(catalog, w.module)?.line || "" })).filter(w => w.line)
  };
}

/**
 * A module's stages as a client reads them: the stages it is for, and what takes its
 * place from a later stage, by that module's line, never its id. Empty for dev alone.
 */
export function moduleStageView(entry, catalog) {
  if (!hasStagesPastDev(catalog)) return {};
  const out = {};
  if (Array.isArray(entry?.stages)) out.stages = entry.stages;
  const i = entry?.instead;
  const other = i && isText(i.module) ? entryOf(catalog, i.module) : null;
  if (other?.line) out.instead = { from: i.from, line: other.line };
  return out;
}

const sentence = text => {
  const t = String(text || "").trim().replace(/[.\s]+$/, "");
  return t ? `${t.charAt(0).toLowerCase()}${t.slice(1)}` : "";
};

/**
 * What a module's stages say, in a line both surfaces print under it: "For dev, sit and
 * uat. From staging, the platform uses another in its place: a relational database ...". Empty
 * when the module is for every stage and nothing takes its place.
 */
export function moduleStageWords(m) {
  const parts = [];
  if (Array.isArray(m?.stages) && m.stages.length) parts.push(`For ${and(m.stages)}.`);
  if (m?.instead?.line) parts.push(`From ${m.instead.from}, the platform uses another in its place: ${sentence(m.instead.line)}.`);
  return parts.join(" ");
}

/** Who builds a stage, and what it waits on, in words. */
function stageLine(s) {
  if (s.name === FIRST_STAGE) return "you build it yourself, whenever you like";
  const who = s.applies === "pipeline" ? "built by your platform team's pipeline" : "built by seaLeye";
  const waits = s.gate?.length ? `, after ${and(s.gate)}` : ", when your team asks";
  return `${who}${waits}`;
}

/**
 * The path to production, one line a stage, then what each stage adds: the lines both
 * surfaces print under "The path to production". Empty for dev alone, so nothing is
 * printed for a catalog that has no path past it.
 */
export function stageMapWords(view) {
  if (!view) return [];
  return [
    ...view.path.map(s => `${s.name}: ${stageLine(s)}.`),
    ...view.aside.map(s => `${s.name}: built from ${s.from} for a load test, and nothing is promoted from it.`),
    ...view.with.map(w => `From ${w.from}, beside ${w.beside}, the platform adds: ${sentence(w.line)}.`)
  ];
}
