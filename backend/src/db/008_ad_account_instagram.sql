-- ============================================================
-- Vass — Patch 2.5: Instagram account auto-attach
-- ============================================================
--
-- Adds instagram_user_id to ad_accounts. Behaves like page_id:
-- populated from /{ad-account-id}/instagram_accounts during sync where
-- accessible, settable manually via CLI for agency-shared accounts.
--
-- Used in createAdCreative's object_story_spec.
-- ============================================================

ALTER TABLE ad_accounts
    ADD COLUMN IF NOT EXISTS instagram_user_id TEXT;

COMMENT ON COLUMN ad_accounts.instagram_user_id IS
    'Meta Instagram User ID (formerly instagram_actor_id). Used in object_story_spec to identify the IG account that runs the ad. NULL means no Instagram identity attached — ad runs on Facebook only.';
