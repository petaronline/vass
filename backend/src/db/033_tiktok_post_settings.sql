-- =====================================================================
-- Patch 4.43.0 — per-post TikTok settings.
--
-- TikTok requires privacy level + commercial-content disclosure to be
-- chosen per post. We store them on organic_posts so a scheduled post
-- carries the creator's choices to publish time. Null/false for posts
-- with no TikTok target.
--
-- Pre-audit, TikTok clamps visibility to SELF_ONLY regardless of what
-- we store here; once the app is audited the stored privacy applies.
-- =====================================================================

ALTER TABLE organic_posts
    ADD COLUMN IF NOT EXISTS tiktok_privacy TEXT;
ALTER TABLE organic_posts
    ADD COLUMN IF NOT EXISTS tiktok_commercial_content BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE organic_posts
    ADD COLUMN IF NOT EXISTS tiktok_your_brand BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE organic_posts
    ADD COLUMN IF NOT EXISTS tiktok_branded_content BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE organic_posts
    ADD COLUMN IF NOT EXISTS tiktok_disable_comment BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE organic_posts
    ADD COLUMN IF NOT EXISTS tiktok_disable_duet BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE organic_posts
    ADD COLUMN IF NOT EXISTS tiktok_disable_stitch BOOLEAN NOT NULL DEFAULT FALSE;

-- Allowed privacy values (null = not a TikTok post / use default).
ALTER TABLE organic_posts
    DROP CONSTRAINT IF EXISTS tiktok_privacy_check;
ALTER TABLE organic_posts
    ADD CONSTRAINT tiktok_privacy_check
    CHECK (tiktok_privacy IS NULL OR tiktok_privacy IN (
        'PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'
    ));

COMMENT ON COLUMN organic_posts.tiktok_privacy IS
    'Per-post TikTok privacy level. Clamped to SELF_ONLY by TikTok until the app is audited.';
