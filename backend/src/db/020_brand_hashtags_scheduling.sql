-- =====================================================================
-- Patch 4.29 — Brand hashtags + scheduling support.
--
-- 1. brand_hashtags: ordered list of hashtags per brand. The whole
--    list is the source of truth — UI sends the full set on save and
--    we replace-all. Keeps things simple (no diffing).
--
-- 2. organic_posts.scheduled_job_id: when a post is scheduled, the
--    BullMQ delayed-job id. Used to cancel/reschedule. NULL for
--    publish-now posts (worker doesn't touch them).
-- =====================================================================

CREATE TABLE brand_hashtags (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    brand_id    UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    -- Store WITHOUT the leading '#'. Lowercased. Composer adds the prefix
    -- when inserting; this keeps de-duplication and validation simple.
    tag         TEXT NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Tags are unique within a brand (case-insensitive via the
    -- lowercase storage convention).
    UNIQUE (brand_id, tag),

    -- Hashtag rules: letters, digits, underscore. 1–100 chars. No '#'.
    -- Empty rejected by check; oversize rejected too. Matches Meta /
    -- IG / FB acceptable tag character set.
    CONSTRAINT brand_hashtag_format CHECK (
        tag ~ '^[a-z0-9_]{1,100}$'
    )
);

CREATE INDEX idx_brand_hashtags_brand ON brand_hashtags(brand_id, sort_order);

COMMENT ON TABLE brand_hashtags IS
    'Per-brand preset hashtags surfaced in the composer toolbar.';


-- ---------------------------------------------------------------------
-- Scheduled-job tracking on organic_posts.
-- ---------------------------------------------------------------------
ALTER TABLE organic_posts
    ADD COLUMN scheduled_job_id TEXT;

CREATE INDEX idx_organic_posts_scheduled_job ON organic_posts(scheduled_job_id)
    WHERE scheduled_job_id IS NOT NULL;

COMMENT ON COLUMN organic_posts.scheduled_job_id IS
    'BullMQ delayed-job id for scheduled posts. NULL for publish-now.';

-- Add 'scheduled' to allowed status values via constraint replacement.
-- We can't just CHECK because the constraint exists; drop+recreate.
ALTER TABLE organic_posts DROP CONSTRAINT IF EXISTS post_status_check;
ALTER TABLE organic_posts
    ADD CONSTRAINT post_status_check
    CHECK (status IN ('draft','scheduled','publishing','published','partial','failed','cancelled'));

ALTER TABLE organic_post_targets DROP CONSTRAINT IF EXISTS target_status_check;
ALTER TABLE organic_post_targets
    ADD CONSTRAINT target_status_check
    CHECK (status IN ('pending','scheduled','publishing','published','failed','skipped'));
