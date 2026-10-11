-- Who may call the API (PHASE1-PLAN Step 13, D7): one row per token issued to a person,
-- until sign-in replaces tokens. Only a hash of each token is kept; the token itself is
-- shown once, to the person who issues it, and never stored.
CREATE TABLE tokens (
  token_id      text PRIMARY KEY,
  token_hash    text NOT NULL UNIQUE,
  email         text NOT NULL,
  name          text NOT NULL,
  org_id        text NOT NULL,
  team_id       text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  last_used_at  timestamptz
);

CREATE INDEX tokens_email ON tokens (email);
