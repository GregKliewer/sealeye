-- Interviews in progress (DESIGN.md, "The interview runs as a LangGraph graph"). The
-- conversation itself is in LangGraph's own checkpoint tables; these hold what the API
-- needs to pick an interview up again after a restart, and the events a client replays.
-- Both are deleted with the interview, and left out of the nightly backup, because an
-- interview's questions can quote the developer's code.
CREATE TABLE interviews (
  interview_id text PRIMARY KEY,
  record       jsonb NOT NULL,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE interview_events (
  interview_id text NOT NULL REFERENCES interviews (interview_id) ON DELETE CASCADE,
  seq          integer NOT NULL,
  event        jsonb NOT NULL,
  PRIMARY KEY (interview_id, seq)
);
