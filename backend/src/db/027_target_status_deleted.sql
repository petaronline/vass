-- =====================================================================
-- Patch 4.36.4 — Tombstone deleted platform posts.
--
-- When a post that Vass published gets deleted directly on the platform
-- (e.g. user removes their FB post via Facebook's UI), the hourly Meta
-- sync now detects the absence and marks our target row as 'deleted'.
-- The calendar query hides posts whose every target is non-live.
--
-- This migration just extends the target status check constraint to
-- allow the new value. The actual detection logic lives in meta-sync.ts.
-- =====================================================================

ALTER TABLE organic_post_targets
    DROP CONSTRAINT IF EXISTS target_status_check;

ALTER TABLE organic_post_targets
    ADD CONSTRAINT target_status_check
    CHECK (status IN ('pending','publishing','published','failed','skipped','deleted'));

-- Speed up the tombstone pass: lookups by (account_id, external_post_id)
-- within a time window need to be quick.
CREATE INDEX IF NOT EXISTS idx_organic_post_targets_account_external
    ON organic_post_targets(account_id, external_post_id);
