-- =====================================================================
-- Patch 4.18.1 — Revert App ID/Secret to workspace-wide.
--
-- Patch 4.18 made the Meta App credentials per-user, but that was wrong:
-- the entire point of the workspace model is that test users authenticate
-- against a single Meta App registered by the workspace admin. Each user
-- still gets their own access token (different Facebook account, different
-- pages, different ad accounts) — but they all OAuth against ONE shared
-- Meta App.
--
-- So:
--   • app_id and app_secret move BACK to app_settings (workspace-wide).
--   • user_meta_connections keeps only the per-user access token + the
--     snapshot of the connected Facebook user.
-- =====================================================================

-- Step 1. Copy the first admin's App ID/Secret back into app_settings,
-- if app_settings doesn't already have them.
DO $$
DECLARE
    first_admin    UUID;
    v_app_id       TEXT;
    v_app_secret   TEXT;
BEGIN
    SELECT id INTO first_admin
      FROM users
     WHERE role = 'admin' AND deleted_at IS NULL
     ORDER BY created_at ASC
     LIMIT 1;

    IF first_admin IS NULL THEN
        RETURN;
    END IF;

    SELECT app_id, app_secret_encrypted
      INTO v_app_id, v_app_secret
      FROM user_meta_connections
     WHERE user_id = first_admin
     LIMIT 1;

    IF v_app_id IS NOT NULL THEN
        INSERT INTO app_settings (key, value, updated_by, updated_at)
        VALUES ('meta.app_id', v_app_id, first_admin, NOW())
        ON CONFLICT (key) DO UPDATE SET
            value = EXCLUDED.value,
            updated_at = NOW();
    END IF;

    IF v_app_secret IS NOT NULL THEN
        INSERT INTO app_settings (key, encrypted_value, updated_by, updated_at)
        VALUES ('meta.app_secret', v_app_secret, first_admin, NOW())
        ON CONFLICT (key) DO UPDATE SET
            encrypted_value = EXCLUDED.encrypted_value,
            updated_at = NOW();
    END IF;
END $$;

-- Step 2. Drop the per-user App columns.
ALTER TABLE user_meta_connections
  DROP COLUMN IF EXISTS app_id,
  DROP COLUMN IF EXISTS app_secret_encrypted;

COMMENT ON TABLE user_meta_connections IS
  'Per-user Meta connection: stores each Vass user''s long-lived access token (from OAuth against the workspace-wide Meta App in app_settings). Pages and ad accounts surfaced are whatever that token can see — i.e. the user''s own Facebook business assets.';
