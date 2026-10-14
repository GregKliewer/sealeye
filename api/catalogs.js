// api/catalogs.js
// Each organization's catalogs (PHASE4-PLAN Step 1, D4): what its platform can build,
// as a versioned document, so there can be more than the one in prompts/. An
// organization with no live catalog has the starter catalog (core/catalog.js), word for
// word, which is every organization today.
//
// A catalog is a draft when it is written, approved when a platform engineer says so,
// live when it is the one the API plans and refuses against, and retired when another
// replaced it. One live catalog per organization. Nothing makes a catalog live from a
// request yet: discovery writes drafts, and the self-test that must pass before one goes
// live (Step 7) comes before any endpoint or command that does.
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
  approvedAt: (r.approved_at ?? r.approvedAt) ? new Date(r.approved_at ?? r.approvedAt).toISOString() : null
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

/** Apply one change: to the database first, then to memory, so memory never runs ahead. */
async function commit(org, next, sql) {
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
}

/**
 * Keep a new catalog for an organization, as a draft, at the next version.
 * Throws with the problems when the document is not a catalog.
 */
export async function addCatalog({ org, document, by = null }) {
  const problems = catalogProblems(document);
  if (problems.length) {
    const err = new Error(`not a catalog: ${problems.join("; ")}`);
    err.code = "CATALOG_INVALID";
    err.problems = problems;
    throw err;
  }
  const list = byOrg.get(org) || [];
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
  await commit(org, [...list, row], [[
    `INSERT INTO catalogs (org_id, version, status, document, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [org, row.version, row.status, JSON.stringify(row.document), row.createdBy, row.createdAt]
  ]]);
  return { ...row, document: undefined };
}

function find(org, version) {
  const row = (byOrg.get(org) || []).find(c => c.version === Number(version));
  if (!row) {
    const err = new Error(`${org} has no catalog version ${version}`);
    err.code = "CATALOG_NOT_FOUND";
    throw err;
  }
  return row;
}

/** A platform engineer approves a draft. */
export async function approveCatalog({ org, version, by }) {
  const row = find(org, version);
  if (row.status !== "draft") throw Object.assign(new Error(`catalog ${version} is ${row.status}, not a draft`), { code: "CATALOG_STATUS" });
  if (!by) throw Object.assign(new Error("an approval names who approved"), { code: "CATALOG_APPROVER" });
  const approved = { ...row, status: "approved", approvedBy: by, approvedAt: new Date().toISOString() };
  const next = byOrg.get(org).map(c => (c === row ? approved : c));
  await commit(org, next, [[
    `UPDATE catalogs SET status = 'approved', approved_by = $3, approved_at = $4 WHERE org_id = $1 AND version = $2`,
    [org, row.version, approved.approvedBy, approved.approvedAt]
  ]]);
  return { ...approved, document: undefined };
}

/**
 * An approved catalog becomes the organization's live one, and the one it replaces is
 * retired, together. Not reachable from any request: Step 7 puts the self-test in front.
 */
export async function makeLive({ org, version }) {
  const row = find(org, version);
  if (row.status !== "approved") throw Object.assign(new Error(`catalog ${version} is ${row.status}; only an approved catalog goes live`), { code: "CATALOG_STATUS" });
  const next = byOrg.get(org).map(c =>
    c === row ? { ...c, status: "live" } : c.status === "live" ? { ...c, status: "retired" } : c
  );
  await commit(org, next, [
    [`UPDATE catalogs SET status = 'retired' WHERE org_id = $1 AND status = 'live'`, [org]],
    [`UPDATE catalogs SET status = 'live' WHERE org_id = $1 AND version = $2`, [org, row.version]]
  ]);
  return { org, version: row.version, status: "live" };
}
