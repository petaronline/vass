-- =====================================================================
-- Hotfix for Patch 4.35.
--
-- The original 025_meta_sync.sql was supposed to create two tables:
--   - synced_meta_posts  (created)
--   - meta_sync_state    (missed on at least one install — likely a
--                         partial transaction commit during the live
--                         install. Migration was recorded as applied
--                         but only the first table exists.)
--
-- This migration creates meta_sync_state if it doesn't exist. Safe to
-- run even on installs where the original 025 completed correctly —
-- the IF NOT EXISTS makes it a no-op.
-- =====================================================================

CREATE TABLE IF NOT EXISTS meta_sync_state (
    organic_account_id          UUID PRIMARY KEY
        REFERENCES organic_connected_accounts(id) ON DELETE CASCADE,
    last_synced_at              TIMESTAMPTZ,
    last_attempt_at             TIMESTAMPTZ,
    last_error                  TEXT,
    initial_sync_completed      BOOLEAN NOT NULL DEFAULT FALSE,
    earliest_post_at            TIMESTAMPTZ,
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE meta_sync_state IS
    'Per-account bookkeeping for the hourly Meta-sync cron.';
