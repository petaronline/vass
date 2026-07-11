-- =====================================================================
-- Patch 4.38.5 — Daily deep reconcile for the tombstone pass.
--
-- The hourly sweep syncs a rolling 90-day window. The tombstone pass
-- (which removes synced_meta_posts rows for posts deleted on Meta) is
-- correctly bounded to the window it actually walked — so a post
-- deleted on Meta that is OLDER than 90 days never gets reconciled and
-- lingers on the Pipeline forever.
--
-- Fix: once per day, each account also runs a DEEP reconcile that
-- paginates back to its earliest stored post, so the tombstone pass
-- covers the full history and removes deletions at any age. Hourly
-- syncs stay fast; the deep pass runs at most once per 24h per account.
--
-- This column tracks when the last deep reconcile completed.
-- =====================================================================

ALTER TABLE meta_sync_state
    ADD COLUMN IF NOT EXISTS last_deep_reconcile_at TIMESTAMPTZ;

COMMENT ON COLUMN meta_sync_state.last_deep_reconcile_at IS
    'When the last full-history tombstone reconcile ran for this account. '
    'The hourly sweep triggers a deep pass when this is NULL or older than '
    '~24h. Distinct from last_synced_at (which every fast sync updates).';
