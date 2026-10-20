-- An organization's platform values (PHASE4-PLAN Step 9; DESIGN.md, "An organization's
-- platform values"): the inputs only its platform team can give a module, such as the
-- subnets and security groups an environment goes in, by stage. Identifiers, never
-- secrets: the API refuses a value that looks like one. A value is a word or a list of
-- words, kept as JSON.
CREATE TABLE platform_values (
  org_id     text NOT NULL,
  stage      text NOT NULL,
  name       text NOT NULL,
  value      jsonb NOT NULL,
  set_by     text,
  set_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, stage, name)
);
