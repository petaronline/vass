-- =====================================================================
-- Patch 4.25 — Organic publishing: posts + per-target results.
--
-- An "organic post" is one Studio publish operation. The user wrote
-- some text, optionally attached one image, and picked one or more
-- connected social profiles to publish to. The post gets a row here,
-- and each target (profile) gets a row in organic_post_targets.
--
-- This patch ships immediate publishing only — `scheduled_for` is on
-- the schema but always NULL for now. Patch 4.26 (Pipeline) will set
-- it for scheduled posts and add a worker to drain them.
-- =====================================================================

CREATE TABLE organic_posts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    brand_id        UUID REFERENCES brands(id) ON DELETE SET NULL,

    -- Base content. Per-target override lives on the targets row.
    body            TEXT NOT NULL DEFAULT '',

    -- Optional single image (patch 4.25 scope). Video + carousel later.
    upload_id       UUID REFERENCES uploads(id) ON DELETE SET NULL,

    -- Future-proofing for patch 4.26 (Pipeline / scheduling).
    -- NULL = publish-now (this patch's only flow).
    scheduled_for   TIMESTAMPTZ,

    -- Aggregate status — derived from the targets but cached for list views.
    -- 'draft' (saved, not sent), 'publishing' (in flight),
    -- 'published' (all targets succeeded), 'partial' (some failed),
    -- 'failed' (all failed).
    status          TEXT NOT NULL DEFAULT 'draft',
    CONSTRAINT post_status_check CHECK (status IN ('draft','publishing','published','partial','failed')),

    published_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_organic_posts_user        ON organic_posts(user_id);
CREATE INDEX idx_organic_posts_brand       ON organic_posts(brand_id);
CREATE INDEX idx_organic_posts_status      ON organic_posts(status);
CREATE INDEX idx_organic_posts_scheduled   ON organic_posts(scheduled_for) WHERE scheduled_for IS NOT NULL;
CREATE INDEX idx_organic_posts_created     ON organic_posts(created_at DESC);

CREATE TRIGGER organic_posts_updated_at
    BEFORE UPDATE ON organic_posts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE organic_posts IS
    'One row per Studio publish operation. Body + optional image + N target profiles. '
    'Per-target results in organic_post_targets.';


-- ---------------------------------------------------------------------
-- Per-target results.
-- ---------------------------------------------------------------------
CREATE TABLE organic_post_targets (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    post_id             UUID NOT NULL REFERENCES organic_posts(id) ON DELETE CASCADE,

    -- The connected profile we publish to.
    account_id          UUID NOT NULL REFERENCES organic_connected_accounts(id) ON DELETE CASCADE,

    -- Snapshot the platform at write time so we don't have to JOIN to
    -- know what we were targeting (the account might be disconnected later).
    platform            TEXT NOT NULL,

    -- Per-target body override. NULL means "use the parent post's body".
    body_override       TEXT,

    -- Result fields, filled in by the publisher after Meta responds.
    status              TEXT NOT NULL DEFAULT 'pending',
    CONSTRAINT target_status_check CHECK (status IN ('pending','publishing','published','failed','skipped')),

    -- The native post ID on the platform (e.g. "{page_id}_{post_id}" for FB,
    -- the IG media ID for IG). Used to link out / fetch insights later.
    external_post_id    TEXT,
    -- Public-facing URL of the published post, when we can derive one.
    external_post_url   TEXT,

    error_message       TEXT,
    error_code          TEXT,

    published_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_organic_post_targets_post     ON organic_post_targets(post_id);
CREATE INDEX idx_organic_post_targets_account  ON organic_post_targets(account_id);
CREATE INDEX idx_organic_post_targets_status   ON organic_post_targets(status);

CREATE TRIGGER organic_post_targets_updated_at
    BEFORE UPDATE ON organic_post_targets
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE organic_post_targets IS
    'One row per (post, target profile). Stores per-target body override and publish result.';
