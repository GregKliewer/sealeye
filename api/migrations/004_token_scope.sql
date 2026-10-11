-- Each team sees its own environments (PHASE2-PLAN Step 1, D1). A token is either for
-- one team, which is what every token issued so far is, or organization-wide, which sees
-- every team's environments in its organization. Set when the token is issued.
ALTER TABLE tokens ADD COLUMN scope text NOT NULL DEFAULT 'team'
  CHECK (scope IN ('team', 'org'));
