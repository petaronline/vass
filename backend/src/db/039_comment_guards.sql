-- 039_comment_guards.sql
-- Comment Guard: rule-matched auto-hide moderation for ad comments.
--
-- Meta's Marketing API has NO per-ad "disable comments" toggle (that control
-- lives only in the Ads Manager UI). The API only permits hiding individual
-- comments. So "turn comments off" is implemented as: monitor each ad's
-- underlying Page post and hide comments matching the guard's rules.
--
-- Hiding a comment requires the owning Page's page-scoped token, which we
-- already store per connected Page in organic_connected_accounts (the organic
-- OAuth flow requests pages_manage_engagement). A target whose Page is not
-- connected there cannot be moderated (page_connected = FALSE).
--
--   comment_guards          — one row per scope (campaign + ad sets + rules)
--   comment_guard_targets   — the resolved posts we monitor (one per ad)
--   comment_guard_actions   — log of every hidden comment (for review + unhide)

CREATE TABLE IF NOT EXISTS comment_guards (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ad_account_id           UUID NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
    meta_campaign_id        TEXT NOT NULL,
    meta_campaign_name      TEXT,
    target_ad_set_ids       TEXT[] NOT NULL DEFAULT '{}',
    target_page_ids         TEXT[] NOT NULL DEFAULT '{}',
    active_only             BOOLEAN NOT NULL DEFAULT TRUE,
    -- Rule config, e.g. { "links": true, "phone": true, "profanity": true, "keywords": ["..."] }
    rules                   JSONB NOT NULL DEFAULT '{}'::jsonb,
    sweep_interval_minutes  INTEGER NOT NULL DEFAULT 5,
    -- pending | scanning | active | paused | failed
    status                  TEXT NOT NULL DEFAULT 'pending',
    error_message           TEXT,
    ads_total               INTEGER NOT NULL DEFAULT 0,
    targets_total           INTEGER NOT NULL DEFAULT 0,
    comments_hidden         INTEGER NOT NULL DEFAULT 0,
    last_scanned_at         TIMESTAMPTZ,
    last_swept_at           TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comment_guards_user   ON comment_guards (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comment_guards_active ON comment_guards (status) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS comment_guard_targets (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    guard_id            UUID NOT NULL REFERENCES comment_guards(id) ON DELETE CASCADE,
    meta_ad_id          TEXT NOT NULL,
    meta_ad_name        TEXT,
    meta_ad_status      TEXT,
    meta_ad_set_id      TEXT,
    meta_creative_id    TEXT,
    page_id             TEXT,
    -- effective_object_story_id, format "{pageid}_{postid}" — the node we read comments from
    post_id             TEXT,
    page_connected      BOOLEAN NOT NULL DEFAULT FALSE,
    comments_hidden     INTEGER NOT NULL DEFAULT 0,
    last_checked_at     TIMESTAMPTZ,
    last_error          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (guard_id, meta_ad_id)
);

CREATE INDEX IF NOT EXISTS idx_cg_targets_guard ON comment_guard_targets (guard_id);

CREATE TABLE IF NOT EXISTS comment_guard_actions (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    guard_id            UUID NOT NULL REFERENCES comment_guards(id) ON DELETE CASCADE,
    target_id           UUID NOT NULL REFERENCES comment_guard_targets(id) ON DELETE CASCADE,
    comment_id          TEXT NOT NULL,
    -- 'links' | 'phone' | 'profanity' | 'keyword'
    matched_rule        TEXT NOT NULL,
    matched_detail      TEXT,
    comment_message     TEXT,
    author_name         TEXT,
    permalink_url       TEXT,
    hidden_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    unhidden_at         TIMESTAMPTZ,
    UNIQUE (guard_id, comment_id)
);

CREATE INDEX IF NOT EXISTS idx_cg_actions_guard ON comment_guard_actions (guard_id, hidden_at DESC);
