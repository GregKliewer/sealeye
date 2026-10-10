-- Deployment records (PHASE1-PLAN Step 10, D5). The whole record is kept as JSON, as it
-- was in deployments.json, so nothing that reads a record changes; the columns beside
-- it are what the pilot needs to ask of it now and what sign-in will fill later.
CREATE TABLE deployments (
  deployment_id text PRIMARY KEY,
  org_id        text NOT NULL,
  team_id       text NOT NULL,
  created_by    text,
  surface       text NOT NULL,
  trace_id      text,
  app           text,
  status        text NOT NULL,
  started_at    timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  record        jsonb NOT NULL
);

CREATE INDEX deployments_org_team ON deployments (org_id, team_id);
CREATE INDEX deployments_status ON deployments (status);
