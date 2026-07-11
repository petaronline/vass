-- =====================================================================
-- Per-user isolation (Patch 4.18 phase 1).
--
-- Goal: each Vass user has their own Meta connection (App ID/Secret +
-- access token) and their own enabled ad-account list. Test users
-- authenticate with THEIR Facebook account and see only THEIR pages and
-- ad accounts. Existing data (the admin's connection + ad accounts)
-- migrates onto the first admin user so nothing breaks.
--
-- Teams come later; for now we just need clean isolation.
-- =====================================================================

-- --------------------------------------------------------------------
-- New per-user Meta connection table.
--
-- Replaces the workspace-wide `app_settings` rows under the 'meta.*'
-- keys. One row per user; nullable fields cover the "credentials
-- saved but not yet connected" intermediate state.
-- --------------------------------------------------------------------
CREATE TABLE user_meta_connections (
    user_id                 UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- App ID is plaintext; App Secret is AES-256-GCM encrypted (same crypto
    -- the existing settings table uses, base64 over IV+ciphertext+tag).
    app_id                  TEXT,
    app_secret_encrypted    TEXT,
    -- User access token (long-lived, ~60d) — encrypted with the same key.
    access_token_encrypted  TEXT,
    token_expires_at        TIMESTAMPTZ,
    -- Snapshot of the Facebook user that did the OAuth, for display only.
    connected_user_meta_id  TEXT,
    connected_user_name     TEXT,
    connected_at            TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE user_meta_connections IS
  'Per-user Meta Marketing API connection (App ID/Secret + user access token). One row per Vass user.';


-- --------------------------------------------------------------------
-- ad_accounts: add user_id, drop the global UNIQUE on meta_account_id,
-- add a composite UNIQUE so the same Meta ad account can be enabled by
-- multiple Vass users without colliding.
-- --------------------------------------------------------------------

-- New column. Nullable temporarily so we can backfill before enforcing.
ALTER TABLE ad_accounts
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;

-- Backfill: every existing ad_accounts row belongs to the first admin user
-- (i.e. whoever installed Vass and connected Meta). If there is no admin
-- user (fresh install), nothing to backfill.
DO $$
DECLARE
    first_admin UUID;
BEGIN
    SELECT id INTO first_admin
      FROM users
     WHERE role = 'admin' AND deleted_at IS NULL
     ORDER BY created_at ASC
     LIMIT 1;

    IF first_admin IS NOT NULL THEN
        UPDATE ad_accounts SET user_id = first_admin WHERE user_id IS NULL;
    ELSE
        -- No admin to attribute these to. Wipe pre-existing ad_accounts;
        -- they would be unreachable per-user anyway.
        DELETE FROM ad_accounts WHERE user_id IS NULL;
    END IF;
END $$;

-- Now enforce NOT NULL.
ALTER TABLE ad_accounts
  ALTER COLUMN user_id SET NOT NULL;

-- Drop the workspace-wide unique on meta_account_id. Same Meta ad account
-- can now appear in multiple users' rows (each row is "this user enabled
-- this Meta account in Vass").
ALTER TABLE ad_accounts
  DROP CONSTRAINT IF EXISTS ad_accounts_meta_account_id_key;

-- Per-user unique: a user can't enable the same Meta account twice.
ALTER TABLE ad_accounts
  ADD CONSTRAINT ad_accounts_user_meta_account_id_key
    UNIQUE (user_id, meta_account_id);

CREATE INDEX IF NOT EXISTS idx_ad_accounts_user ON ad_accounts(user_id);


-- --------------------------------------------------------------------
-- Migrate the workspace-wide Meta connection (app_settings rows) to the
-- first admin's user_meta_connections row. This preserves the existing
-- Vass install's behaviour — the admin doesn't have to reconnect.
-- --------------------------------------------------------------------
DO $$
DECLARE
    first_admin UUID;
    v_app_id          TEXT;
    v_app_secret_enc  TEXT;
    v_access_enc      TEXT;
    v_expires         TEXT;
    v_conn_user_id    TEXT;
    v_conn_user_name  TEXT;
    v_conn_at         TEXT;
BEGIN
    SELECT id INTO first_admin
      FROM users
     WHERE role = 'admin' AND deleted_at IS NULL
     ORDER BY created_at ASC
     LIMIT 1;

    IF first_admin IS NULL THEN
        RETURN; -- nothing to migrate
    END IF;

    -- Pull every Meta-related setting value (plaintext OR encrypted)
    SELECT value             INTO v_app_id          FROM app_settings WHERE key = 'meta.app_id';
    SELECT encrypted_value   INTO v_app_secret_enc  FROM app_settings WHERE key = 'meta.app_secret';
    SELECT encrypted_value   INTO v_access_enc      FROM app_settings WHERE key = 'meta.access_token';
    SELECT value             INTO v_expires         FROM app_settings WHERE key = 'meta.token_expires_at';
    SELECT value             INTO v_conn_user_id    FROM app_settings WHERE key = 'meta.connected_user_id';
    SELECT value             INTO v_conn_user_name  FROM app_settings WHERE key = 'meta.connected_user_name';
    SELECT value             INTO v_conn_at         FROM app_settings WHERE key = 'meta.connected_at';

    -- Only insert when we have at least the App ID — otherwise we'd be
    -- carrying over a half-deleted state for no reason.
    IF v_app_id IS NOT NULL THEN
        INSERT INTO user_meta_connections (
            user_id, app_id, app_secret_encrypted,
            access_token_encrypted, token_expires_at,
            connected_user_meta_id, connected_user_name, connected_at
        ) VALUES (
            first_admin,
            v_app_id,
            v_app_secret_enc,
            v_access_enc,
            CASE WHEN v_expires IS NOT NULL THEN v_expires::TIMESTAMPTZ ELSE NULL END,
            v_conn_user_id,
            v_conn_user_name,
            CASE WHEN v_conn_at IS NOT NULL THEN v_conn_at::TIMESTAMPTZ ELSE NULL END
        )
        ON CONFLICT (user_id) DO UPDATE SET
            app_id                 = EXCLUDED.app_id,
            app_secret_encrypted   = EXCLUDED.app_secret_encrypted,
            access_token_encrypted = EXCLUDED.access_token_encrypted,
            token_expires_at       = EXCLUDED.token_expires_at,
            connected_user_meta_id = EXCLUDED.connected_user_meta_id,
            connected_user_name    = EXCLUDED.connected_user_name,
            connected_at           = EXCLUDED.connected_at,
            updated_at             = NOW();
    END IF;
END $$;

-- Clean up: drop the now-orphaned app_settings rows. We intentionally
-- keep `branding.logo_data_url` (workspace-wide setting) and anything
-- else not under the 'meta.*' namespace.
DELETE FROM app_settings WHERE key IN (
    'meta.app_id',
    'meta.app_secret',
    'meta.access_token',
    'meta.token_expires_at',
    'meta.connected_user_id',
    'meta.connected_user_name',
    'meta.connected_at'
);
