// api/interview/pgstore.js
// Interviews kept in Postgres, so one paused at a question survives the API restarting
// (PHASE1-PLAN Step 10, D8). Two parts, both in the interview_state schema, which the
// nightly backup leaves out:
//
// - LangGraph's own checkpoint tables, through its Postgres saver: the conversation.
// - interview_state.interviews and interview_events: what the service needs to pick an
//   interview up again, and the events a reconnecting client replays.
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

import { db } from "../db.js";

export const INTERVIEW_SCHEMA = "interview_state";

// What of a record is worth keeping: everything but the live parts.
const KEPT = ["id", "app", "appDir", "ownsDir", "scratchRoot", "user", "trace", "mode", "model",
  "status", "waitingFor", "result", "approved", "failure", "traceId", "createdAt", "endedAt"];

/**
 * The interview schema and its tables, made at every start rather than by a migration:
 * the nightly backup leaves the schema out, so a database restored from it has to get
 * them back without anyone remembering to.
 */
export async function ensureInterviewSchema() {
  await db().query(`
    CREATE SCHEMA IF NOT EXISTS ${INTERVIEW_SCHEMA};
    CREATE TABLE IF NOT EXISTS ${INTERVIEW_SCHEMA}.interviews (
      interview_id text PRIMARY KEY,
      record       jsonb NOT NULL,
      created_at   timestamptz NOT NULL,
      updated_at   timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS ${INTERVIEW_SCHEMA}.interview_events (
      interview_id text NOT NULL REFERENCES ${INTERVIEW_SCHEMA}.interviews (interview_id) ON DELETE CASCADE,
      seq          integer NOT NULL,
      event        jsonb NOT NULL,
      PRIMARY KEY (interview_id, seq)
    );`);
}

/** LangGraph's saver, on the shared pool, in the interview schema. */
export async function postgresCheckpointer() {
  await ensureInterviewSchema();
  const saver = new PostgresSaver(db(), undefined, { schema: INTERVIEW_SCHEMA });
  await saver.setup();
  return saver;
}

/**
 * The service's persistence: write-through, in order, never blocking the interview.
 * A failed write is logged; the interview carries on.
 */
export function postgresInterviewStore() {
  let writes = Promise.resolve();
  const queue = (what, fn) => {
    writes = writes.then(fn).catch(err => console.error(`could not save ${what}: ${err.message}`));
    return writes;
  };

  return {
    save(record) {
      const kept = Object.fromEntries(KEPT.map(k => [k, record[k] ?? null]));
      return queue(`interview ${record.id}`, () =>
        db().query(
          `INSERT INTO ${INTERVIEW_SCHEMA}.interviews (interview_id, record, created_at, updated_at)
           VALUES ($1, $2, to_timestamp($3 / 1000.0), now())
           ON CONFLICT (interview_id) DO UPDATE SET record = EXCLUDED.record, updated_at = now()`,
          [record.id, kept, record.createdAt]
        )
      );
    },

    addEvent(id, event) {
      return queue(`an event of interview ${id}`, () =>
        db().query(
          `INSERT INTO ${INTERVIEW_SCHEMA}.interview_events (interview_id, seq, event) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [id, event.seq, event]
        )
      );
    },

    remove(id) {
      return queue(`the removal of interview ${id}`, () =>
        db().query(`DELETE FROM ${INTERVIEW_SCHEMA}.interviews WHERE interview_id = $1`, [id])
      );
    },

    /** Every kept interview with its events, oldest first. */
    async loadAll() {
      await writes;
      const { rows } = await db().query(`SELECT record FROM ${INTERVIEW_SCHEMA}.interviews ORDER BY created_at`);
      const events = await db().query(`SELECT interview_id, event FROM ${INTERVIEW_SCHEMA}.interview_events ORDER BY interview_id, seq`);
      const byId = new Map();
      for (const { interview_id, event } of events.rows) {
        if (!byId.has(interview_id)) byId.set(interview_id, []);
        byId.get(interview_id).push(event);
      }
      return rows.map(({ record }) => ({ record, events: byId.get(record.id) || [] }));
    },

    flush() {
      return writes;
    }
  };
}
