-- =====================================================================
-- Patch 4.27 — Multi-media on organic posts.
--
-- Replaces the single `upload_id` column on organic_posts with a
-- join table that preserves order and tags each item as image/video.
-- This makes carousels (2-10 images) and Reels (single video) first
-- class without forking the data model.
--
-- The `upload_id` column on organic_posts stays for backwards-compat
-- and gets backfilled into the new table on migrate; existing single-
-- image posts work without code changes thanks to the publisher's
-- normalization layer.
-- =====================================================================

CREATE TABLE organic_post_media (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    post_id         UUID NOT NULL REFERENCES organic_posts(id) ON DELETE CASCADE,
    upload_id       UUID NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,

    -- Tagged at insert time. Determines the publish flow (image carousel
    -- vs single video / Reel). Constraint enforced application-side:
    -- a single post is all-image OR single-video (no mixing in 4.27).
    kind            TEXT NOT NULL,
    CONSTRAINT post_media_kind_check CHECK (kind IN ('image','video')),

    -- 0-indexed order within the post (carousel slide order).
    sort_order      INTEGER NOT NULL DEFAULT 0,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_organic_post_media_post  ON organic_post_media(post_id, sort_order);
CREATE INDEX idx_organic_post_media_upload ON organic_post_media(upload_id);

-- Backfill existing single-image posts into the new table so the
-- publisher can stop reading the old column.
INSERT INTO organic_post_media (post_id, upload_id, kind, sort_order)
SELECT id, upload_id, 'image', 0
  FROM organic_posts
 WHERE upload_id IS NOT NULL;

COMMENT ON TABLE organic_post_media IS
    'Per-post media items. Ordered, typed. All-image (carousel) OR single-video per post.';
