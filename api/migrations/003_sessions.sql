-- Portal sign-in (PHASE1-PLAN Step 14): a person pastes their token once, and the
-- portal gets a session cookie in its place. Only the session's hash is kept, as for
-- tokens. A session ends when it expires, when its person signs out, or when the token
-- it came from is revoked.
CREATE TABLE sessions (
  session_hash  text PRIMARY KEY,
  token_id      text NOT NULL REFERENCES tokens (token_id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);

CREATE INDEX sessions_expires ON sessions (expires_at);
