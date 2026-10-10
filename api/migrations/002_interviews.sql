-- Interviews in progress (DESIGN.md, "The interview runs as a LangGraph graph"). Their
-- own schema, interview_state, which also holds LangGraph's checkpoint tables (the
-- conversation, file contents included). Everything in it lives a day at most, and the
-- nightly backup leaves the whole schema out.
CREATE SCHEMA IF NOT EXISTS interview_state;

-- What the API needs to pick an interview up again after a restart.
CREATE TABLE interview_state.interviews (
  interview_id text PRIMARY KEY,
  record       jsonb NOT NULL,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- The events a client replays when it reconnects.
CREATE TABLE interview_state.interview_events (
  interview_id text NOT NULL REFERENCES interview_state.interviews (interview_id) ON DELETE CASCADE,
  seq          integer NOT NULL,
  event        jsonb NOT NULL,
  PRIMARY KEY (interview_id, seq)
);
