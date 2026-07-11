-- 038_insights_synced.sql
-- Analytics now pulls from BOTH organic_post_targets (Vass-published) and
-- synced_meta_posts (synced from the networks). The insights table from 037
-- required NOT NULL target_id/post_id and had no external_post_id, so it
-- couldn't store snapshots for sync-only posts.
--
-- This migration upgrades the table in place. It is a SEPARATE file (not an
-- edit to 037) because the migration runner tracks applied migrations BY
-- FILENAME — 037 is already recorded as applied on any box that ran 4.57.0,
-- so changing 037's contents would never re-run. 038 is new, so it runs.
--
-- Every statement here is idempotent / guarded so it's safe regardless of
-- whether the box previously ran 4.57.0's 037 or is brand new.

-- target_id / post_id become nullable (sync-only posts have neither).
ALTER TABLE organic_post_insights ALTER COLUMN target_id DROP NOT NULL;
ALTER TABLE organic_post_insights ALTER COLUMN post_id   DROP NOT NULL;

-- external_post_id is the stable key that works for both sources.
ALTER TABLE organic_post_insights ADD COLUMN IF NOT EXISTS external_post_id TEXT;

-- Backfill external_post_id for any rows 4.57.0 wrote (target-linked only).
UPDATE organic_post_insights i
   SET external_post_id = t.external_post_id
  FROM organic_post_targets t
 WHERE i.target_id = t.id
   AND i.external_post_id IS NULL;

-- Drop any rows that predate external_post_id and can't be backfilled
-- (shouldn't exist in practice; keeps the NOT NULL enforce below safe).
DELETE FROM organic_post_insights WHERE external_post_id IS NULL;

ALTER TABLE organic_post_insights ALTER COLUMN external_post_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_post_insights_acct_ext
    ON organic_post_insights (account_id, external_post_id, fetched_at DESC);
