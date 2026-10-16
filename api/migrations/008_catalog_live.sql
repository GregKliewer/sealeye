-- Who made a catalog live, and when (PHASE4-PLAN Step 7). Approving and making live are
-- two steps, and a retired catalog may go live again, so the last time it went live is
-- kept beside its approval.
ALTER TABLE catalogs ADD COLUMN made_live_by text;
ALTER TABLE catalogs ADD COLUMN made_live_at timestamptz;
