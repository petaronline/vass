-- ============================================================
-- Vass — Patch 2.4: Strip deprecated standard_enhancements key
-- ============================================================
--
-- Meta deprecated the `standard_enhancements` key inside creative_features_spec
-- (error subcode 3858504). To disable Standard Enhancements, advertisers
-- now opt out of each individual feature.
--
-- This migration removes the key from any granular_overrides JSON that
-- still has it, so future launches don't try to send it.
--
-- Note: app_settings.value is TEXT (storing JSON as a string), while
-- account_launch_defaults.config is JSONB. Casting accordingly.
-- ============================================================

UPDATE app_settings
SET value = (
      jsonb_set(
        value::jsonb,
        '{granular_overrides}',
        ((value::jsonb)->'granular_overrides') - 'standard_enhancements'
      )
    )::text,
    updated_at = NOW()
WHERE key = 'launch_defaults.global'
  AND value IS NOT NULL
  AND value::jsonb ? 'granular_overrides'
  AND (value::jsonb)->'granular_overrides' ? 'standard_enhancements';

UPDATE account_launch_defaults
SET config = jsonb_set(
      config,
      '{granular_overrides}',
      (config->'granular_overrides') - 'standard_enhancements'
    ),
    updated_at = NOW()
WHERE config->'granular_overrides' ? 'standard_enhancements';
