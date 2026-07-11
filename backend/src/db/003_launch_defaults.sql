-- ============================================================
-- Vass — Phase 2: Launch Defaults
-- ============================================================
-- Adds:
--   - account_launch_defaults: per-ad-account overrides for launch behavior
--                              (currently just creative enhancement settings,
--                               but the JSONB column is intentionally open-ended
--                               so future Phase 2.X features can extend it
--                               without schema changes)
--   - app_settings keys for global defaults
--
-- Resolution order at launch time:
--   account_launch_defaults.config (if exists) → global default → built-in
-- ============================================================

-- ------------------------------------------------------------
-- Per-account launch defaults
-- One row per ad account that has custom overrides.
-- If a row doesn't exist for an account, the global default is used.
-- ------------------------------------------------------------
CREATE TABLE account_launch_defaults (
    ad_account_id       UUID PRIMARY KEY REFERENCES ad_accounts(id) ON DELETE CASCADE,
    config              JSONB NOT NULL DEFAULT '{}',
    updated_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------
-- Seed the global default key so the UI always has something to read.
-- We store the JSON as a string in app_settings.value (it's a JSON blob).
-- ------------------------------------------------------------
-- The default config: disable_enhancements = true means we pass a fully-off
-- degrees_of_freedom_spec to every ad. The granular_overrides field lets
-- advanced admins flip individual enhancements back on.
INSERT INTO app_settings (key, value) VALUES
    ('launch_defaults.global', '{"disable_enhancements": true, "granular_overrides": {}}')
ON CONFLICT (key) DO NOTHING;

-- updated_at trigger
CREATE TRIGGER account_launch_defaults_updated_at BEFORE UPDATE ON account_launch_defaults
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
