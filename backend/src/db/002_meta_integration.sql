-- ============================================================
-- Vass — Phase 1: Meta integration
-- ============================================================
-- Adds:
--   - app_settings: single-row store for global config (Meta credentials, token)
--   - oauth_states: short-lived CSRF tokens for OAuth callbacks
--   - ad_accounts.is_enabled: admin can toggle which accounts users can launch into
-- ============================================================

-- ------------------------------------------------------------
-- App Settings (single-row design)
-- We keep this as a key/value table so we can add settings later
-- without schema migrations. The encrypted_value column holds
-- secrets that have been AES-256-GCM encrypted at rest.
-- ------------------------------------------------------------
CREATE TABLE app_settings (
    key                 TEXT PRIMARY KEY,
    value               TEXT,                              -- plain value
    encrypted_value     TEXT,                              -- AES-256-GCM encrypted (base64)
    updated_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the keys we know about (NULL values until set)
INSERT INTO app_settings (key) VALUES
    ('meta.app_id'),
    ('meta.app_secret'),                                    -- encrypted_value
    ('meta.access_token'),                                  -- encrypted_value
    ('meta.token_expires_at'),
    ('meta.connected_user_id'),
    ('meta.connected_user_name'),
    ('meta.connected_at'),
    ('meta.business_id')
ON CONFLICT (key) DO NOTHING;

-- ------------------------------------------------------------
-- OAuth states — short-lived CSRF tokens for the OAuth callback.
-- We generate one per oauth-url request, store it, and verify on callback.
-- Auto-cleaned after 10 minutes.
-- ------------------------------------------------------------
CREATE TABLE oauth_states (
    state           TEXT PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes')
);

CREATE INDEX idx_oauth_states_expires ON oauth_states(expires_at);

-- ------------------------------------------------------------
-- Add is_enabled to ad_accounts
-- Default true so admin's synced accounts are immediately usable
-- ------------------------------------------------------------
ALTER TABLE ad_accounts
    ADD COLUMN is_enabled BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX idx_ad_accounts_enabled ON ad_accounts(is_enabled) WHERE is_enabled = TRUE;

-- updated_at trigger for app_settings
CREATE TRIGGER app_settings_updated_at BEFORE UPDATE ON app_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
