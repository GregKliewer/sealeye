// api/platform.js
// An organization's platform values (PHASE4-PLAN Step 9; DESIGN.md, "An organization's
// platform values"): what only its platform team can give a module, by stage. A value is
// named after the input it fills (`subnet_ids`), or after one module's input
// (`postgres.security_group_ids`), which wins over the plain name for that module.
//
// They are identifiers, never secrets, and a value that looks like one is refused. They
// are the organization's, not a catalog's: the catalog the API plans against is read
// with them beside it (`withPlatform`), never stored in it, so a module becomes buildable
// the moment its last value is set, without anyone approving the catalog again.
//
// Postgres when the API has a database, a file beside a laptop API otherwise, read from
// memory and written through, as catalogs are: one API process.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { sealeyeHome } from "../core/config.js";
import { scanText } from "../core/scan.js";
import { DEVELOPER_STAGE, PLATFORM_NAME, STAGES } from "../core/terraform-modules.js";
import { databaseUrl, db } from "./db.js";

const valuesFile = () => path.join(sealeyeHome(), "platform-values.json");

/** org -> stage -> name -> { value, setBy, setAt } */
let byOrg = new Map();

const MAX_WORD = 256;
const MAX_WORDS = 50;

const rowOf = r => ({
  org: r.org_id ?? r.org,
  stage: r.stage,
  name: r.name,
  value: r.value,
  setBy: r.set_by ?? r.setBy ?? null,
  setAt: new Date(r.set_at ?? r.setAt).toISOString()
});

function index(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.org)) map.set(row.org, new Map());
    const stages = map.get(row.org);
    if (!stages.has(row.stage)) stages.set(row.stage, new Map());
    stages.get(row.stage).set(row.name, { value: row.value, setBy: row.setBy, setAt: row.setAt });
  }
  return map;
}

const rowsOf = map => [...map].flatMap(([org, stages]) =>
  [...stages].flatMap(([stage, names]) => [...names].map(([name, v]) => ({ org, stage, name, ...v }))));

function readFile() {
  try {
    const rows = JSON.parse(fs.readFileSync(valuesFile(), "utf8"));
    return Array.isArray(rows) ? rows.map(rowOf) : [];
  } catch {
    return [];
  }
}

function writeFile(map) {
  fs.mkdirSync(path.dirname(valuesFile()), { recursive: true });
  const tmp = `${valuesFile()}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rowsOf(map), null, 2), { mode: 0o600 });
  fs.renameSync(tmp, valuesFile());
}

/** Load every organization's values. Call once before serving, after the migrations. */
export async function openPlatform() {
  if (databaseUrl()) {
    const { rows } = await db().query("SELECT * FROM platform_values");
    byOrg = index(rows.map(rowOf));
  } else {
    byOrg = index(readFile());
  }
  return { organizations: byOrg.size };
}

/** A refusal in words, with a code the API answers with. */
export class PlatformValueRefused extends Error {
  constructor(message, code = "INVALID_PLATFORM_VALUE") {
    super(message);
    this.name = "PlatformValueRefused";
    this.code = code;
  }
}

/** A stage, checked: dev when none is given. */
export function stageOf(raw) {
  const stage = raw === undefined || raw === null || raw === "" ? DEVELOPER_STAGE : String(raw);
  if (!STAGES.includes(stage)) throw new PlatformValueRefused(`A stage is one of ${STAGES.join(", ")}, not ${JSON.stringify(stage)}.`, "INVALID_STAGE");
  return stage;
}

/**
 * A value as kept: a word, or a list of words. A word is printable, with no spaces, and
 * not something that looks like a secret.
 */
export function cleanValue(name, value) {
  if (!PLATFORM_NAME.test(String(name || ""))) {
    throw new PlatformValueRefused("A platform value is named after the input it fills (subnet_ids), or a module's id, a dot and the input (postgres.security_group_ids).", "INVALID_PLATFORM_NAME");
  }
  const words = Array.isArray(value) ? value : [value];
  if (!words.length && !Array.isArray(value)) throw new PlatformValueRefused(`${name} needs a value.`);
  if (words.length > MAX_WORDS) throw new PlatformValueRefused(`${name} may hold at most ${MAX_WORDS} words.`);
  for (const w of words) {
    if (typeof w !== "string" || !w || w.length > MAX_WORD || !/^[\x21-\x7e]+$/.test(w)) {
      throw new PlatformValueRefused(`${name}'s value is a word with no spaces, such as an id or an address, or a list of them.`);
    }
  }
  // A value is named so a secret can never be one: the same rules the code is scanned
  // with, run on the line a module would read. The value is never in the refusal.
  const found = scanText("platform value", words.map(w => `${name} = "${w}"`).join("\n"));
  if (found.length) throw new PlatformValueRefused(`${name}'s value looks like a secret, so it was not kept. Platform values are ids and addresses; a secret goes in the organization's store.`, "LOOKS_LIKE_A_SECRET");
  return Array.isArray(value) ? [...words] : words[0];
}

/** An organization's values at a stage: name -> { value, setBy, setAt }, in name order. */
export function platformValues(org = "default", stage = DEVELOPER_STAGE) {
  const names = byOrg.get(org)?.get(stage) || new Map();
  return Object.fromEntries([...names].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, v]) => [name, { ...v }]));
}

/** The values alone, name -> value, as a module is given them. */
export function valuesAt(org = "default", stage = DEVELOPER_STAGE) {
  return Object.fromEntries(Object.entries(platformValues(org, stage)).map(([name, v]) => [name, v.value]));
}

/**
 * A catalog document as the platform builds from it: the same document, with the names
 * of the organization's values at the developer's stage beside it (`platform`), which
 * core/terraform-modules.js reads. A new object every time; the stored one is never
 * changed, and nothing writes this one back.
 */
export function withPlatform(org = "default", document) {
  if (!document || typeof document !== "object") return document;
  return { ...document, platform: { stage: DEVELOPER_STAGE, names: Object.keys(platformValues(org, DEVELOPER_STAGE)) } };
}

// Changes run one at a time, each reading the values as they are when its turn comes.
let changes = Promise.resolve();

function commit(change) {
  const turn = changes.then(async () => {
    if (!databaseUrl()) byOrg = index(readFile());
    const { next, sql, result } = change(byOrg);
    if (databaseUrl()) {
      for (const [text, args] of sql) await db().query(text, args);
    } else {
      writeFile(next);
    }
    byOrg = next;
    return result;
  });
  changes = turn.catch(() => {});
  return turn;
}

const copyOf = map => new Map([...map].map(([org, stages]) => [org, new Map([...stages].map(([s, n]) => [s, new Map(n)]))]));

/** Set one value, replacing any earlier one. */
export async function setPlatformValue({ org = "default", stage = DEVELOPER_STAGE, name, value, by = null }) {
  const kept = cleanValue(name, value);
  const at = new Date().toISOString();
  return commit(map => {
    const next = copyOf(map);
    if (!next.has(org)) next.set(org, new Map());
    if (!next.get(org).has(stage)) next.get(org).set(stage, new Map());
    next.get(org).get(stage).set(name, { value: kept, setBy: by, setAt: at });
    return {
      next,
      sql: [[
        `INSERT INTO platform_values (org_id, stage, name, value, set_by, set_at) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (org_id, stage, name) DO UPDATE SET value = EXCLUDED.value, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at`,
        [org, stage, name, JSON.stringify(kept), by, at]
      ]],
      result: { stage, name, value: kept, setBy: by, setAt: at }
    };
  });
}

/** Remove one value. One that is not there is not an error. */
export async function removePlatformValue({ org = "default", stage = DEVELOPER_STAGE, name }) {
  if (!PLATFORM_NAME.test(String(name || ""))) throw new PlatformValueRefused("That is not a platform value's name.", "INVALID_PLATFORM_NAME");
  return commit(map => {
    const next = copyOf(map);
    const existed = Boolean(next.get(org)?.get(stage)?.delete(name));
    return {
      next,
      sql: [[`DELETE FROM platform_values WHERE org_id = $1 AND stage = $2 AND name = $3`, [org, stage, name]]],
      result: { stage, name, removed: existed }
    };
  });
}
