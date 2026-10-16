// api/catalogs.js
// Each organization's catalogs (PHASE4-PLAN Step 1, D4): what its platform can build,
// as a versioned document, so there can be more than the one in prompts/. An
// organization with no live catalog has the starter catalog (core/catalog.js), word for
// word, which is every organization today.
//
// A catalog is a draft when it is written, approved when a platform engineer says so,
// live when it is the one the API plans and refuses against, and retired when another
// replaced it. One live catalog per organization. Approving and making live each take a
// gate, which the API makes the self-test (api/self-test.js, PHASE4-PLAN Step 7): it is
// run on the catalog as it is when the change's turn comes, so a draft re-written by a
// late answer meanwhile is the one tested.
//
// Postgres when the API has a database, a file beside a laptop API otherwise, as for
// tokens. Read from memory, loaded once by openCatalogs() and written through, as the
// deployment store is: one API process.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { sealeyeHome } from "../core/config.js";
import { STARTER_VERSION, catalogProblems, starterCatalog } from "../core/catalog.js";
import { databaseUrl, db } from "./db.js";

export const STATUSES = ["draft", "approved", "live", "retired"];

const catalogsFile = () => path.join(sealeyeHome(), "catalogs.json");

/** Every catalog the API knows, by organization, oldest version first. */
let byOrg = new Map();

const rowOf = r => ({
  org: r.org_id ?? r.org,
  version: Number(r.version),
  status: r.status,
  document: r.document,
  createdBy: r.created_by ?? r.createdBy ?? null,
  createdAt: new Date(r.created_at ?? r.createdAt).toISOString(),
  approvedBy: r.approved_by ?? r.approvedBy ?? null,
  approvedAt: (r.approved_at ?? r.approvedAt) ? new Date(r.approved_at ?? r.approvedAt).toISOString() : null,
  madeLiveBy: r.made_live_by ?? r.madeLiveBy ?? null,
  madeLiveAt: (r.made_live_at ?? r.madeLiveAt) ? new Date(r.made_live_at ?? r.madeLiveAt).toISOString() : null
});

function index(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.org)) map.set(row.org, []);
    map.get(row.org).push(row);
  }
  for (const list of map.values()) list.sort((a, b) => a.version - b.version);
  return map;
}

function readFile() {
  try {
    const rows = JSON.parse(fs.readFileSync(catalogsFile(), "utf8"));
    return Array.isArray(rows) ? rows.map(rowOf) : [];
  } catch {
    return [];
  }
}

function writeFile(map) {
  const rows = [...map.values()].flat();
  fs.mkdirSync(path.dirname(catalogsFile()), { recursive: true });
  const tmp = `${catalogsFile()}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, catalogsFile());
}

/**
 * Load every organization's catalogs. Call once before serving, after the database's
 * migrations have run (openStore). Without a database, the file is read now.
 */
export async function openCatalogs() {
  if (databaseUrl()) {
    const { rows } = await db().query("SELECT * FROM catalogs");
    byOrg = index(rows.map(rowOf));
  } else {
    byOrg = index(readFile());
  }
  return { organizations: byOrg.size };
}

/** An organization's catalogs, oldest first, without their documents. */
export function catalogsOf(org) {
  return (byOrg.get(org) || []).map(({ document, ...rest }) => rest);
}

/**
 * The catalog the API plans and refuses against for an organization: its live one, or
 * the starter catalog when it has none.
 *
 * @returns {{ org: string, version: number | "starter", source: "organization" | "starter",
 *   document: object, approvedBy: string | null, approvedAt: string | null }}
 */
export function liveCatalog(org = "default") {
  const live = (byOrg.get(org) || []).find(c => c.status === "live");
  if (live) {
    return { org, version: live.version, source: "organization", document: live.document, approvedBy: live.approvedBy, approvedAt: live.approvedAt };
  }
  return { org, version: STARTER_VERSION, source: "starter", document: starterCatalog(), approvedBy: null, approvedAt: null };
}

/** The document of an organization's live catalog, for the functions in core/catalog.js. */
export function catalogFor(org = "default") {
  return liveCatalog(org).document;
}

/** The document of one of an organization's catalogs, live or not, or the starter's. */
export function catalogAt(org = "default", version = STARTER_VERSION) {
  if (version === STARTER_VERSION || version === undefined || version === null) return starterCatalog();
  return (byOrg.get(org) || []).find(c => c.version === Number(version))?.document || null;
}

/**
 * The catalog a record was planned against: the one it names, or, for a record from
 * before catalogs were kept (Oct 14, 2026), the starter, which was the only one. Null
 * when the record names one this API does not hold.
 */
export function catalogOfRecord(record) {
  return catalogAt(record?.orgId || "default", record?.catalog?.version ?? STARTER_VERSION);
}

/** What a record keeps of the catalog it was planned against: never the document. */
export function catalogRef(org = "default") {
  const { version, source } = liveCatalog(org);
  return { version, source };
}

// Changes run one at a time, each reading the catalogs as they are when its turn comes,
// so two changes made together both land, in memory as in the database.
let changes = Promise.resolve();

/**
 * Apply one change. `change(list)` gets the organization's catalogs as they are now and
 * returns { next, sql, result }; the database is written first, then memory, so memory
 * never runs ahead. Without a database the file is read again first, so a change made by
 * another process (a platform engineer's script beside a laptop API) is kept.
 */
function commit(org, change) {
  const turn = changes.then(async () => {
    if (!databaseUrl()) byOrg = index(readFile());
    const { next, sql, result } = change(byOrg.get(org) || []);
    if (databaseUrl()) {
      const conn = await db().connect();
      try {
        await conn.query("BEGIN");
        for (const [text, args] of sql) await conn.query(text, args);
        await conn.query("COMMIT");
      } catch (err) {
        await conn.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        conn.release();
      }
      byOrg.set(org, next);
    } else {
      const map = new Map(byOrg);
      map.set(org, next);
      writeFile(map);
      byOrg = map;
    }
    return result;
  });
  changes = turn.catch(() => {});
  return turn;
}

const fail = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });

/**
 * Keep a new catalog for an organization, as a draft, at the next version.
 * Throws with the problems when the document is not a catalog.
 */
export async function addCatalog({ org, document, by = null }) {
  const problems = catalogProblems(document);
  if (problems.length) throw fail(`not a catalog: ${problems.join("; ")}`, "CATALOG_INVALID", { problems });
  return commit(org, list => {
    const row = {
      org,
      version: (list.at(-1)?.version || 0) + 1,
      status: "draft",
      document: structuredClone(document),
      createdBy: by,
      createdAt: new Date().toISOString(),
      approvedBy: null,
      approvedAt: null
    };
    return {
      next: [...list, row],
      sql: [[
        `INSERT INTO catalogs (org_id, version, status, document, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [org, row.version, row.status, JSON.stringify(row.document), row.createdBy, row.createdAt]
      ]],
      result: { ...row, document: undefined }
    };
  });
}

function find(list, org, version) {
  const row = list.find(c => c.version === Number(version));
  if (!row) throw fail(`${org} has no catalog version ${version}`, "CATALOG_NOT_FOUND");
  return row;
}

/**
 * A platform engineer approves a draft. `gate(row)` runs on the catalog as it is when
 * this change's turn comes, and throws to refuse it.
 */
export async function approveCatalog({ org, version, by, gate = () => {} }) {
  if (!by) throw fail("an approval names who approved", "CATALOG_APPROVER");
  return commit(org, list => {
    const row = find(list, org, version);
    if (row.status !== "draft") throw fail(`catalog ${version} is ${row.status}, not a draft`, "CATALOG_STATUS");
    gate(row);
    const approved = { ...row, status: "approved", approvedBy: by, approvedAt: new Date().toISOString() };
    return {
      next: list.map(c => (c.version === row.version ? approved : c)),
      sql: [[
        `UPDATE catalogs SET status = 'approved', approved_by = $3, approved_at = $4 WHERE org_id = $1 AND version = $2`,
        [org, row.version, approved.approvedBy, approved.approvedAt]
      ]],
      result: { ...approved, document: undefined }
    };
  });
}

/**
 * An approved catalog, or a retired one going back, becomes the organization's live one,
 * and the one it replaces is retired, together. `gate(row, list)` runs first, on the
 * catalogs as they are when this change's turn comes, and throws to refuse it: the API
 * makes it the self-test and the guard for environments in use (PHASE4-PLAN Step 7).
 */
export async function makeLive({ org, version, by = null, gate = () => {} }) {
  return commit(org, list => {
    const row = find(list, org, version);
    if (row.status !== "approved" && row.status !== "retired") {
      throw fail(`catalog ${version} is ${row.status}; only an approved or retired catalog goes live`, "CATALOG_STATUS");
    }
    gate(row, list);
    const at = new Date().toISOString();
    return {
      next: list.map(c =>
        c.version === row.version ? { ...c, status: "live", madeLiveBy: by, madeLiveAt: at } : c.status === "live" ? { ...c, status: "retired" } : c
      ),
      sql: [
        [`UPDATE catalogs SET status = 'retired' WHERE org_id = $1 AND status = 'live'`, [org]],
        [`UPDATE catalogs SET status = 'live', made_live_by = $3, made_live_at = $4 WHERE org_id = $1 AND version = $2`, [org, row.version, by, at]]
      ],
      result: { org, version: row.version, status: "live", madeLiveBy: by, madeLiveAt: at }
    };
  });
}

/**
 * Change a draft's document in place, as a discovery run does when a late answer
 * re-writes the entries it touches (DESIGN.md, "A discovery run never pauses"). Only a
 * draft: an approved or live catalog is never changed, so a run whose draft was
 * approved meanwhile keeps a new draft instead (addCatalog).
 */
export async function updateDraft({ org, version, document }) {
  const problems = catalogProblems(document);
  if (problems.length) throw fail(`not a catalog: ${problems.join("; ")}`, "CATALOG_INVALID", { problems });
  return commit(org, list => {
    const row = find(list, org, version);
    if (row.status !== "draft") throw fail(`catalog ${version} is ${row.status}, not a draft`, "CATALOG_STATUS");
    const changed = { ...row, document: structuredClone(document) };
    return {
      next: list.map(c => (c.version === row.version ? changed : c)),
      sql: [[`UPDATE catalogs SET document = $3 WHERE org_id = $1 AND version = $2 AND status = 'draft'`, [org, row.version, JSON.stringify(document)]]],
      result: { ...changed, document: undefined }
    };
  });
}
