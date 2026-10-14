-- Each organization's catalogs (PHASE4-PLAN Step 1, D4): what its platform can build,
-- as a versioned document in the shape of prompts/module-catalog.yaml. An organization
-- with no live catalog has the starter one, which is not a row here. Names, lines and
-- signals only: a catalog holds no secret and no value from anyone's code.
CREATE TABLE catalogs (
  org_id       text NOT NULL,
  version      integer NOT NULL CHECK (version > 0),
  status       text NOT NULL CHECK (status IN ('draft', 'approved', 'live', 'retired')),
  document     jsonb NOT NULL,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  approved_by  text,
  approved_at  timestamptz,
  PRIMARY KEY (org_id, version),
  CHECK (status = 'draft' OR approved_by IS NOT NULL)
);

-- One live catalog per organization.
CREATE UNIQUE INDEX catalogs_one_live ON catalogs (org_id) WHERE status = 'live';
