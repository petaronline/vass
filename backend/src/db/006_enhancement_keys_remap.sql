-- ============================================================
-- Vass — Patch 2.2: Remap enhancement keys to Meta's actual API
-- ============================================================
--
-- Phase 2 stored creative-enhancement keys based on a guessed/partial
-- list (image_text_translation, 3d_animation, etc). Several of those
-- keys are not real Meta API keys, so launches that pass them to
-- creative_features_spec get rejected with #100.
--
-- This migration replaces the stored config (in app_settings.launch_defaults.global
-- and in account_launch_defaults.config) with the new, Meta-correct keys.
-- All new keys default to disabled (so enhancements stay OFF, which is
-- the entire point of Phase 2).
--
-- This is destructive for any per-key tweaks people made in the old UI —
-- but since none of the old keys actually worked anyway, there's nothing
-- of practical value to preserve.
-- ============================================================

DO $$
DECLARE
  default_config JSONB;
BEGIN
  -- Build the new default config: master disabled, all granular overrides empty
  -- (which means "follow the master toggle"). With master=disabled, every
  -- key effectively reads as disabled when resolved by toMetaSpec().
  default_config := jsonb_build_object(
    'disable_enhancements', true,
    'granular_overrides', '{}'::jsonb
  );

  -- 1. Reset the global launch defaults
  UPDATE app_settings
  SET value = default_config,
      updated_at = NOW()
  WHERE key = 'launch_defaults.global';

  -- If no row exists yet (shouldn't happen after Phase 2, but defensive), insert
  IF NOT FOUND THEN
    INSERT INTO app_settings (key, value)
    VALUES ('launch_defaults.global', default_config);
  END IF;

  -- 2. Reset all per-account overrides to the new defaults
  -- (Anyone who had set per-account tweaks loses them — but they were
  -- using non-functional keys, so nothing real is lost.)
  UPDATE account_launch_defaults
  SET config = default_config,
      updated_at = NOW();

  RAISE NOTICE 'Reset launch defaults to new key schema (master disabled, no granular overrides)';
END $$;
