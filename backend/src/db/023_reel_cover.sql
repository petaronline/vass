-- =====================================================================
-- Patch 4.33 — Reel cover thumbnails.
--
-- Optional custom cover image for video posts (Reels on both FB and IG).
-- Stored as a pointer to an upload — same uploads table as everything
-- else. NULL = use the video's first frame (Meta's default).
--
-- IG uses cover_url on the REELS container (works instantly via API).
-- FB does it post-publish via POST /{video-id}/thumbnails; needs the
-- pages_read_user_content scope and is best-effort.
-- =====================================================================

ALTER TABLE organic_posts
    ADD COLUMN cover_upload_id UUID REFERENCES uploads(id) ON DELETE SET NULL;

COMMENT ON COLUMN organic_posts.cover_upload_id IS
    'Optional custom cover image for video posts (Reels). NULL = use first frame.';
