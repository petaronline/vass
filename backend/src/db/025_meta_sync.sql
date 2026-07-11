-- =====================================================================
-- Patch 4.35 — Meta Graph-driven unified calendar.
--
-- Adds:
--   1. synced_meta_posts — posts pulled from Meta/Threads APIs that
--      Vass didn't originate. Vass-originated posts are still tracked
--      in organic_posts + organic_post_targets; the calendar view
--      merges both, deduplicated by (account_id, external_post_id).
--
--   2. meta_sync_state — per-account sync bookkeeping so the hourly
--      cron knows when each account was last successfully synced and
--      can resume on transient failures.
-- =====================================================================

-- ---------------------------------------------------------------------
-- synced_meta_posts: one row per (organic_account_id, external_post_id).
--
-- We keep the raw API response in `raw` JSONB so future features
-- (insights, comments, custom fields) can read whatever was already
-- fetched without an extra round-trip.
-- ---------------------------------------------------------------------
CREATE TABLE synced_meta_posts (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organic_account_id      UUID NOT NULL
        REFERENCES organic_connected_accounts(id) ON DELETE CASCADE,
    platform                TEXT NOT NULL,
    -- Same constraint as organic_connected_accounts so the platform
    -- values stay in sync between the two tables.
    CONSTRAINT synced_platform_check
        CHECK (platform IN ('facebook_page', 'instagram', 'threads')),

    -- The platform's own post id. Stable across re-fetches; used for
    -- dedup against organic_post_targets.external_post_id.
    external_post_id        TEXT NOT NULL,
    external_post_url       TEXT, -- permalink. Sometimes absent for IG.

    -- Display data, denormalized so the calendar query doesn't need
    -- to touch JSONB.
    body                    TEXT,
    -- Single representative media URL for thumbnails. For carousels we
    -- store the first child; full structure is in `raw` if needed.
    media_url               TEXT,
    media_type              TEXT, -- 'IMAGE' | 'VIDEO' | 'CAROUSEL' | 'TEXT' | etc.
    posted_at               TIMESTAMPTZ NOT NULL,

    -- Bookkeeping
    fetched_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    raw                     JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT unique_account_external_post
        UNIQUE (organic_account_id, external_post_id)
);

CREATE INDEX synced_meta_posts_by_account_time
    ON synced_meta_posts (organic_account_id, posted_at DESC);

CREATE INDEX synced_meta_posts_by_time
    ON synced_meta_posts (posted_at DESC);

COMMENT ON TABLE synced_meta_posts IS
    'Posts pulled from Meta/Threads APIs for the unified calendar. '
    'Vass-originated posts live in organic_posts; the calendar merges both.';

-- ---------------------------------------------------------------------
-- meta_sync_state: per-account bookkeeping for the hourly sync cron.
--
-- One row per account, created lazily by the cron on first attempt.
-- The cron updates last_synced_at on success, last_error_at + error
-- on failure. initial_sync_completed flag distinguishes a fresh
-- connection (needs 365-day pull) from a steady-state account (90-day).
-- ---------------------------------------------------------------------
CREATE TABLE meta_sync_state (
    organic_account_id          UUID PRIMARY KEY
        REFERENCES organic_connected_accounts(id) ON DELETE CASCADE,
    last_synced_at              TIMESTAMPTZ,
    last_attempt_at             TIMESTAMPTZ,
    last_error                  TEXT,
    -- Whether the initial 365-day backfill has been done. Set to true
    -- after the first successful sync. New connections start FALSE.
    initial_sync_completed      BOOLEAN NOT NULL DEFAULT FALSE,
    -- Earliest post we have. Helps the "Load older" feature know
    -- how far back we already pulled, so it can request the next chunk.
    earliest_post_at            TIMESTAMPTZ,
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE meta_sync_state IS
    'Per-account bookkeeping for the hourly Meta-sync cron.';
