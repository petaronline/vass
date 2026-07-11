-- =====================================================================
-- Patch 4.22 — Organic publishing: connected social accounts.
--
-- Stores per-user OAuth connections for organic publishing platforms:
-- Facebook Pages, Instagram, and Threads. Each Vass user can connect
-- multiple accounts/pages per platform independently.
--
-- Design:
--   • One row per (user, platform, external_id) — same user can have
--     multiple FB Pages connected.
--   • Access tokens encrypted with the same AES-256-GCM used elsewhere.
--   • `meta` JSONB stores platform-specific display data (page name,
--     picture URL, username, etc.) so the UI can render without extra
--     API calls on every load.
--   • `scopes` TEXT[] records what permissions were granted at OAuth
--     time — helps diagnose missing-permission errors later.
--   • Soft-delete via `disconnected_at` so we preserve history.
-- =====================================================================

CREATE TABLE organic_connected_accounts (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Which platform this connection is for.
    platform                TEXT NOT NULL,
    CONSTRAINT platform_check CHECK (platform IN ('facebook_page', 'instagram', 'threads')),

    -- The platform's own identifier for this entity (page ID, IG user ID, etc.).
    external_id             TEXT NOT NULL,

    -- Encrypted long-lived access token (AES-256-GCM, base64 IV+cipher+tag).
    access_token_encrypted  TEXT NOT NULL,
    token_expires_at        TIMESTAMPTZ,

    -- For FB Pages: the user token we used to derive the page token.
    -- Lets us refresh the page token without re-OAuth.
    parent_user_token_encrypted TEXT,

    -- Scopes granted at OAuth time, for diagnostics.
    scopes                  TEXT[] NOT NULL DEFAULT '{}',

    -- Display metadata — denormalized to avoid extra API calls.
    -- FB Page:   { name, picture_url, category, followers_count }
    -- Instagram: { username, name, picture_url, followers_count }
    -- Threads:   { username, name, picture_url }
    meta                    JSONB NOT NULL DEFAULT '{}',

    -- Soft-delete: null = active, set = user disconnected.
    disconnected_at         TIMESTAMPTZ,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A user can only have one active connection per (platform, external_id).
-- Allows re-connecting after disconnect by checking disconnected_at IS NULL.
CREATE UNIQUE INDEX organic_accounts_active_unique
    ON organic_connected_accounts (user_id, platform, external_id)
    WHERE disconnected_at IS NULL;

CREATE INDEX idx_organic_accounts_user     ON organic_connected_accounts(user_id);
CREATE INDEX idx_organic_accounts_platform ON organic_connected_accounts(platform);

CREATE TRIGGER organic_accounts_updated_at
    BEFORE UPDATE ON organic_connected_accounts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE organic_connected_accounts IS
    'Per-user OAuth connections for organic publishing (FB Pages, Instagram, Threads). '
    'One row per active account/page per user. Access tokens encrypted at rest.';

-- =====================================================================
-- oauth_states already exists (used by Meta Ads OAuth). We reuse it for
-- organic OAuth flows too — the state value is platform-agnostic. The
-- only addition: a `platform` column so the callback knows which flow
-- to complete. We add it conditionally.
-- =====================================================================
ALTER TABLE oauth_states
    ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'meta_ads';

COMMENT ON COLUMN oauth_states.platform IS
    'Which OAuth flow generated this state: meta_ads | facebook_page | instagram | threads';
