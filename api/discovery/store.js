// api/discovery/store.js
// Discovery runs and their questions, kept as catalogs are (api/catalogs.js): Postgres
// when the API has a database, a file beside a laptop API otherwise; read from memory,
// loaded once by openDiscoveries() and written through. One API process.
//
// A run is a record (who started it, the commits it read, each module's finding, the
// draft catalog it wrote, what it spent). A question is a row of its own, so an answer
// can arrive while the run is going or a week after it ended.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { sealeyeHome } from "../../core/config.js";
import { databaseUrl, db } from "../db.js";

const file = () => path.join(sealeyeHome(), "discoveries.json");

let runs = new Map();        // id -> run
let questions = new Map();   // id -> question

function readFile() {
  try {
    const data = JSON.parse(fs.readFileSync(file(), "utf8"));
    return { runs: data.runs || [], questions: data.questions || [] };
  } catch {
    return { runs: [], questions: [] };
  }
}

function writeFile() {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ runs: [...runs.values()], questions: [...questions.values()] }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file());
}

/** Load every run and question. Call once, after the migrations ran (openStore). */
export async function openDiscoveries() {
  if (databaseUrl()) {
    const r = await db().query("SELECT record FROM discoveries");
    const q = await db().query("SELECT question FROM discovery_questions");
    runs = new Map(r.rows.map(x => [x.record.id, x.record]));
    questions = new Map(q.rows.map(x => [x.question.id, x.question]));
  } else {
    const data = readFile();
    runs = new Map(data.runs.map(x => [x.id, x]));
    questions = new Map(data.questions.map(x => [x.id, x]));
  }
  return { runs: runs.size };
}

// Changes are written one at a time, database first, then memory.
let changes = Promise.resolve();
function commit(sql, apply) {
  const turn = changes.then(async () => {
    if (databaseUrl()) {
      for (const [text, args] of sql) await db().query(text, args);
    }
    const result = apply();
    if (!databaseUrl()) writeFile();
    return result;
  });
  changes = turn.catch(() => {});
  return turn;
}

const copy = x => (x ? structuredClone(x) : null);

/** Keep a run as it is now (insert or replace). */
export function saveRun(run) {
  const kept = structuredClone(run);
  return commit(
    [[
      `INSERT INTO discoveries (id, org_id, status, record, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, record = EXCLUDED.record, updated_at = now()`,
      [kept.id, kept.org, kept.status, JSON.stringify(kept), kept.createdAt]
    ]],
    () => {
      runs.set(kept.id, kept);
      return copy(kept);
    }
  );
}

export const getRun = id => copy(runs.get(id));

/** An organization's runs, newest first. */
export const runsOf = org => [...runs.values()].filter(r => r.org === org).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map(copy);

/** Keep a question (insert or replace). */
export function saveQuestion(question) {
  const kept = structuredClone(question);
  return commit(
    [[
      `INSERT INTO discovery_questions (id, discovery_id, org_id, question, answered_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET question = EXCLUDED.question, answered_at = EXCLUDED.answered_at`,
      [kept.id, kept.discovery, kept.org, JSON.stringify(kept), kept.answeredAt || null, kept.createdAt]
    ]],
    () => {
      questions.set(kept.id, kept);
      return copy(kept);
    }
  );
}

export const getQuestion = id => copy(questions.get(id));

/** A run's questions, in the order they were raised. */
export const questionsOf = runId =>
  [...questions.values()].filter(q => q.discovery === runId).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.seq - b.seq)).map(copy);

/** Every run, any organization: for the API's start, which stops any left running. */
export const allRuns = () => [...runs.values()].map(copy);
