-- =====================================================================
-- Patch 4.31 — First comment + location tagging.
--
-- 1. Post-level fields:
--    - first_comment: the comment text to post immediately after publish.
--      We chose post-level (not target-level) because the same first
--      comment typically applies to every target; per-target overrides
--      can be added later if users ask.
--    - location_id + location_name: a Facebook Page ID for the place
--      (FB and IG both use a Page ID to tag location). Name stored
--      denormalized so list views don't need extra API calls.
--
-- 2. Target-level tracking:
--    - first_comment_external_id: the Meta-side comment id (so we can
--      delete or moderate later if needed). NULL = no comment posted.
--    - first_comment_posted_at: timestamp of the second-step success.
--      Distinguishes "main post published, comment still pending or
--      failed" from "everything done."
--
-- Designed forward-compat for TikTok / Threads: first_comment is a
-- generic string, location_id is platform-agnostic (we just store the
-- ID — the publisher decides how to send it per network). Per-target
-- tracking columns sit on organic_post_targets which already abstracts
-- across platforms.
-- =====================================================================

ALTER TABLE organic_posts
    ADD COLUMN first_comment   TEXT,
    ADD COLUMN location_id     TEXT,
    ADD COLUMN location_name   TEXT;

COMMENT ON COLUMN organic_posts.first_comment IS
    'Optional comment posted automatically after the main post publishes.';
COMMENT ON COLUMN organic_posts.location_id IS
    'Facebook Page ID for the tagged place (FB uses `place`, IG uses `location_id`).';
COMMENT ON COLUMN organic_posts.location_name IS
    'Cached display name of the location at the time of save.';

ALTER TABLE organic_post_targets
    ADD COLUMN first_comment_external_id TEXT,
    ADD COLUMN first_comment_posted_at   TIMESTAMPTZ;

COMMENT ON COLUMN organic_post_targets.first_comment_external_id IS
    'Meta-side comment id (returned by /{post-id}/comments). NULL if no comment was attempted or it failed.';
COMMENT ON COLUMN organic_post_targets.first_comment_posted_at IS
    'When the first comment was successfully posted to this target. NULL = not done yet (or main post itself failed).';
