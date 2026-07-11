/**
 * Launch defaults service.
 *
 * Two layers of config:
 *   - GLOBAL: stored in app_settings under 'launch_defaults.global'
 *   - PER-ACCOUNT: stored in account_launch_defaults (one row per ad_account_id)
 *
 * When launching into an account, we resolve the effective config by:
 *   1. Start with built-in defaults (everything disabled)
 *   2. Layer on the global config
 *   3. Layer on the per-account config if one exists
 *
 * The output is a normalized `LaunchDefaults` object, which can then be
 * converted to Meta's degrees_of_freedom_spec format via toMetaSpec().
 */
import { query } from '../db/pool';
import * as settings from './settings';

/**
 * Creative enhancement keys that Vass can toggle on/off.
 *
 * These are the exact keys Meta's `creative_features_spec` field accepts
 * (per docs at developers.facebook.com/docs/marketing-api/reference/ad-creative-features-spec).
 *
 * Vass focuses on the keys that affect single-image link ads — the
 * common case for performance marketing. Catalog/Reels/dynamic keys
 * (like product_metadata_automation, ig_reels_tag) are intentionally
 * excluded to keep the UI focused. Future patches can broaden the list.
 *
 * NOTE on the master toggle: Meta deprecated the `standard_enhancements`
 * field as of late 2024 (error subcode 3858504). To "disable Standard
 * Enhancements", we now opt out of each individual feature. The "Disable
 * enhancements" toggle in the Vass UI still exists as a convenience that
 * flips all individual keys, but we don't send `standard_enhancements`
 * itself to Meta anymore.
 *
 * When "enabled: false", we send OPT_OUT for that feature so Meta won't
 * apply it. When "enabled: true", we send OPT_IN.
 */
export const ENHANCEMENT_KEYS = [
  // Image transformations
  'adapt_to_placement',     // "Image touch-ups" — auto-crop / aspect adjust
  'image_animation',        // Animate static images
  'image_background_gen',   // AI-generated background extensions
  'image_templates',        // Apply image templates
  'image_touchups',         // Visual enhancements
  'show_summary',           // Add bullet-point summary overlays
  // Text transformations
  'text_optimizations',     // Rewrite/optimize primary text
  'text_translation',       // Translate text into other languages
  'text_overlay_translation', // Translate text rendered IN the image
  'description_automation', // Auto-fill description
  // CTA / link transformations
  'generate_cta',           // Modify CTA button
  'site_extensions',        // Add links to other pages
  'profile_extension',      // Add profile/account links
  // Other
  'music_generation',       // Add background music to silent video
  'inline_comment',         // Surface "relevant comments" overlay
] as const;

export type EnhancementKey = (typeof ENHANCEMENT_KEYS)[number];

export interface LaunchDefaultsConfig {
  /** Master toggle. When true, ALL enhancements default to disabled. */
  disable_enhancements: boolean;
  /**
   * Granular per-enhancement overrides. If a key is present here,
   * it OVERRIDES what the master toggle says.
   * Example: { disable_enhancements: true, granular_overrides: { add_music: true } }
   *          means "all off, but explicitly allow music."
   */
  granular_overrides: Partial<Record<EnhancementKey, boolean>>;
  /**
   * Whether to opt out of Meta's multi-advertiser ads (separate API field
   * from creative_features_spec). Since Aug 19 2024 Meta defaults to OPT_IN,
   * so by default Vass sends OPT_OUT.
   */
  disable_multi_advertiser_ads: boolean;
  /**
   * Default state of the "Active only" filter in the Launch UI. When true
   * (default), the campaign + ad set dropdowns hide anything not currently
   * serving. Users can flip the per-launch toggle to see everything.
   * Stored at the global level only (not per-account).
   */
  show_active_only_default: boolean;
}

export interface ResolvedLaunchDefaults {
  config: LaunchDefaultsConfig;
  source: 'account' | 'global' | 'builtin';
}

const BUILTIN_DEFAULT: LaunchDefaultsConfig = {
  disable_enhancements: true,
  granular_overrides: {},
  disable_multi_advertiser_ads: true,
  show_active_only_default: true,
};

// -----------------------------------------------------------------
// Storage layer
// -----------------------------------------------------------------

export async function getGlobalConfig(): Promise<LaunchDefaultsConfig> {
  const raw = await settings.getPlain('launch_defaults.global');
  if (!raw) return { ...BUILTIN_DEFAULT };
  try {
    const parsed = JSON.parse(raw);
    return normalizeConfig(parsed);
  } catch {
    return { ...BUILTIN_DEFAULT };
  }
}

export async function setGlobalConfig(
  config: LaunchDefaultsConfig,
  userId: string
): Promise<void> {
  const normalized = normalizeConfig(config);
  await settings.setPlain('launch_defaults.global', JSON.stringify(normalized), userId);
}

export async function getAccountConfig(
  adAccountId: string
): Promise<LaunchDefaultsConfig | null> {
  const { rows } = await query<{ config: LaunchDefaultsConfig }>(
    'SELECT config FROM account_launch_defaults WHERE ad_account_id = $1',
    [adAccountId]
  );
  if (rows.length === 0) return null;
  return normalizeConfig(rows[0].config);
}

export async function setAccountConfig(
  adAccountId: string,
  config: LaunchDefaultsConfig | null,
  userId: string
): Promise<void> {
  if (config === null) {
    // null = "use global default" — delete the row
    await query('DELETE FROM account_launch_defaults WHERE ad_account_id = $1', [adAccountId]);
    return;
  }
  const normalized = normalizeConfig(config);
  await query(
    `INSERT INTO account_launch_defaults (ad_account_id, config, updated_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (ad_account_id) DO UPDATE
     SET config = EXCLUDED.config, updated_by = EXCLUDED.updated_by`,
    [adAccountId, JSON.stringify(normalized), userId]
  );
}

// -----------------------------------------------------------------
// Resolution — what config should we use for a launch into account X?
// -----------------------------------------------------------------

export async function resolveForAccount(
  adAccountId: string
): Promise<ResolvedLaunchDefaults> {
  const accountConfig = await getAccountConfig(adAccountId);
  if (accountConfig) {
    return { config: accountConfig, source: 'account' };
  }
  const globalConfig = await getGlobalConfig();
  return { config: globalConfig, source: 'global' };
}

// -----------------------------------------------------------------
// Normalization — sanity check + defaults
// -----------------------------------------------------------------

function normalizeConfig(input: unknown): LaunchDefaultsConfig {
  const obj = (input ?? {}) as Partial<LaunchDefaultsConfig>;
  const result: LaunchDefaultsConfig = {
    disable_enhancements:
      typeof obj.disable_enhancements === 'boolean' ? obj.disable_enhancements : true,
    granular_overrides: {},
    // Default to opt-out, matching the BUILTIN_DEFAULT
    disable_multi_advertiser_ads:
      typeof obj.disable_multi_advertiser_ads === 'boolean'
        ? obj.disable_multi_advertiser_ads
        : true,
    show_active_only_default:
      typeof obj.show_active_only_default === 'boolean'
        ? obj.show_active_only_default
        : true,
  };
  if (obj.granular_overrides && typeof obj.granular_overrides === 'object') {
    for (const key of ENHANCEMENT_KEYS) {
      const v = (obj.granular_overrides as Record<string, unknown>)[key];
      if (typeof v === 'boolean') {
        result.granular_overrides[key] = v;
      }
    }
  }
  return result;
}

// -----------------------------------------------------------------
// Effective per-enhancement state — what's REALLY enabled?
// -----------------------------------------------------------------

/**
 * Given a config, returns the resolved on/off state for every enhancement.
 * Used by both:
 *   - The UI (to render the "effective" view of toggles)
 *   - The launch pipeline (Phase 3) when building the Meta API payload
 */
export function effectiveEnhancements(
  config: LaunchDefaultsConfig
): Record<EnhancementKey, boolean> {
  const masterEnabled = !config.disable_enhancements; // master toggle: master ON = enhancements ENABLED
  const result = {} as Record<EnhancementKey, boolean>;
  for (const key of ENHANCEMENT_KEYS) {
    const override = config.granular_overrides[key];
    result[key] = override !== undefined ? override : masterEnabled;
  }
  return result;
}

// -----------------------------------------------------------------
// Meta API spec — converts our normalized config to the format Meta wants.
// Used during Phase 3 when actually launching ads.
// -----------------------------------------------------------------

/**
 * Convert our config to Meta's `degrees_of_freedom_spec` JSON.
 *
 * Meta's API spec (simplified, current as of v21.0):
 * {
 *   creative_features_spec: {
 *     standard_enhancements: { enroll_status: 'OPT_IN' | 'OPT_OUT' },
 *     image_text_translation: { enroll_status: 'OPT_IN' | 'OPT_OUT' },
 *     ...
 *   }
 * }
 *
 * Each enhancement is OPT_IN (Meta will apply it) or OPT_OUT (Meta will not).
 *
 * NOTE: This is the SHAPE of what we produce. Phase 3 will use this when
 * actually creating AdCreative objects via Meta's Marketing API.
 */
export function toMetaSpec(config: LaunchDefaultsConfig): {
  creative_features_spec: Record<string, { enroll_status: 'OPT_IN' | 'OPT_OUT' }>;
} {
  const effective = effectiveEnhancements(config);
  const spec: Record<string, { enroll_status: 'OPT_IN' | 'OPT_OUT' }> = {};
  for (const key of ENHANCEMENT_KEYS) {
    spec[key] = { enroll_status: effective[key] ? 'OPT_IN' : 'OPT_OUT' };
  }
  return { creative_features_spec: spec };
}
