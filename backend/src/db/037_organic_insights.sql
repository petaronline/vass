-- 037_organic_insights.sql
-- Organic analytics: per-target insight snapshots over time.
--
-- NOTE: 4.57.1 adds 038_insights_synced.sql which makes target_id/post_id
-- nullable and adds external_post_id so sync-only posts can be stored. This
-- 037 file is the ORIGINAL 4.57.0 shape and must stay as-is, because the
-- migration runner tracks by filename — boxes that ran 4.57.0 already recorded
-- 037 as applied and will only pick up the changes via the new 038 file.

CREATE TABLE IF NOT EXISTS organic_post_insights (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    target_id       UUID NOT NULL REFERENCES organic_post_targets(id) ON DELETE CASCADE,
    post_id         UUID NOT NULL REFERENCES organic_posts(id) ON DELETE CASCADE,
    account_id      UUID NOT NULL REFERENCES organic_connected_accounts(id) ON DELETE CASCADE,
    platform        TEXT NOT NULL,

    impressions     BIGINT,
    reach           BIGINT,
    likes           BIGINT,
    comments        BIGINT,
    shares          BIGINT,
    clicks          BIGINT,
    saves           BIGINT,
    video_views     BIGINT,
    engagement      BIGINT,

    extra           JSONB NOT NULL DEFAULT '{}'::jsonb,
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_post_insights_target   ON organic_post_insights (target_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_post_insights_account  ON organic_post_insights (account_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_post_insights_post     ON organic_post_insights (post_id);
