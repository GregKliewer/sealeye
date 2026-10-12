-- Who changed which of an app's settings, and from where (PHASE2-PLAN Step 8). The
-- values live in the organization's store and never here: a row is a name, an action
-- and a person.
CREATE TABLE setting_changes (
  id          bigserial PRIMARY KEY,
  org_id      text NOT NULL,
  team_id     text NOT NULL,
  app         text NOT NULL,
  name        text NOT NULL,
  action      text NOT NULL CHECK (action IN ('set', 'removed')),
  by_email    text,
  by_name     text,
  surface     text NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX setting_changes_app ON setting_changes (org_id, team_id, app, at DESC);
