-- ============================================================
-- Vass — Patch 2.1: Ad Account Page Photos
-- ============================================================
-- Adds page metadata to ad_accounts so the UI can show the
-- linked Page's profile picture next to each account name.
--
-- Both columns are nullable because:
--   - Existing accounts haven't been re-synced yet
--   - Some ad accounts (rare) genuinely have no promotable Pages
--
-- When the columns are null, the UI falls back to initials.
-- ============================================================

ALTER TABLE ad_accounts
    ADD COLUMN IF NOT EXISTS page_id      TEXT,
    ADD COLUMN IF NOT EXISTS picture_url  TEXT;
