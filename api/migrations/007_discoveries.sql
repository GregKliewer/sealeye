-- Discovery runs and the questions they raise (PHASE4-PLAN Step 6; DESIGN.md, "A
-- discovery run never pauses" and "The discovery run"). A run reads an organization's
-- platform library and writes a draft catalog; what it cannot settle alone it asks, with
-- a guess, and an answer is taken whenever it comes.
--
-- A run's record holds who started it, which commits it read, what each worker found and
-- what it spent: names, lines and evidence pointers (a file and what it shows), never a
-- file's contents and never a value the scanner found.
CREATE TABLE discoveries (
  id           text PRIMARY KEY,
  org_id       text NOT NULL,
  status       text NOT NULL CHECK (status IN ('running', 'finished', 'stopped', 'failed')),
  record       jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX discoveries_org ON discoveries (org_id, created_at DESC);

-- One row per question. `touches` is the module folders whose entries the answer
-- changes; the answer, who gave it and when stay on the row for the catalog's history.
CREATE TABLE discovery_questions (
  id            text PRIMARY KEY,
  discovery_id  text NOT NULL REFERENCES discoveries (id) ON DELETE CASCADE,
  org_id        text NOT NULL,
  question      jsonb NOT NULL,
  answered_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX discovery_questions_run ON discovery_questions (discovery_id, created_at);
