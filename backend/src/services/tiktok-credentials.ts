/**
 * TikTok app credentials.
 *
 * TikTok publishing uses TikTok's own developer app (Login Kit +
 * Content Posting API), entirely separate from the Meta/Threads apps.
 * This module is the data-access layer for those creds — Client Key,
 * Client Secret, optional redirect URI override — stored as
 * workspace-wide rows in app_settings.
 *
 * Mirrors threads-credentials.ts in shape and crypto so the flows stay
 * predictable.
 */

import { query } from '../db/pool';
import { decryptSecret } from '../utils/crypto';
import { env } from '../utils/env';

async function getKeyValue(key: string): Promise<string | null> {
  const { rows } = await query<{ value: string | null }>(
    `SELECT value FROM app_settings WHERE key = $1 LIMIT 1`,
    [key]
  );
  return rows[0]?.value ?? null;
}

async function getKeyEncrypted(key: string): Promise<string | null> {
  const { rows } = await query<{ encrypted_value: string | null }>(
    `SELECT encrypted_value FROM app_settings WHERE key = $1 LIMIT 1`,
    [key]
  );
  const enc = rows[0]?.encrypted_value;
  if (!enc) return null;
  try {
    return decryptSecret(enc);
  } catch (e) {
    console.error('[tiktok-credentials] Could not decrypt secret for', key, e);
    return null;
  }
}

export interface TikTokAppCredentials {
  clientKey: string;
  clientSecret: string;
  /** Falls back to ${FRONTEND_URL}/api/organic/tiktok/callback when unset. */
  redirectUri: string;
}

/** Returns null when any required value is missing. */
export async function getTikTokAppCredentials(): Promise<TikTokAppCredentials | null> {
  const [clientKey, clientSecret, redirectOverride] = await Promise.all([
    getKeyValue('tiktok.client_key'),
    getKeyEncrypted('tiktok.client_secret'),
    getKeyValue('tiktok.redirect_uri'),
  ]);
  if (!clientKey || !clientSecret) return null;
  return {
    clientKey,
    clientSecret,
    redirectUri:
      redirectOverride ||
      `${env.FRONTEND_URL}/api/organic/tiktok/callback`,
  };
}

/** Whether TikTok publishing is configured at the workspace level. */
export async function isTikTokConfigured(): Promise<boolean> {
  return (await getTikTokAppCredentials()) !== null;
}

// ─── Admin display + save (mirrors threads-credentials) ───────────────

import { encryptSecret } from '../utils/crypto';

/** Non-secret view of the TikTok config for the settings UI. */
export async function getDisplayableTikTokConfig(): Promise<{
  clientKey: string | null;
  hasSecret: boolean;
  redirectUri: string;
}> {
  const [clientKey, secret, redirectOverride] = await Promise.all([
    getKeyValue('tiktok.client_key'),
    getKeyEncrypted('tiktok.client_secret'),
    getKeyValue('tiktok.redirect_uri'),
  ]);
  return {
    clientKey,
    hasSecret: !!secret,
    redirectUri: redirectOverride || `${env.FRONTEND_URL}/api/organic/tiktok/callback`,
  };
}

/** Persist TikTok app credentials (admin only). Only the provided
 *  fields are written, so saving the key alone won't wipe the secret. */
export async function saveTikTokCredentials(
  adminUserId: string,
  input: { clientKey?: string; clientSecret?: string; redirectUri?: string }
): Promise<void> {
  if (input.clientKey !== undefined) {
    await query(
      `INSERT INTO app_settings (key, value, updated_by, updated_at)
       VALUES ('tiktok.client_key', $1, $2, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [input.clientKey.trim() || null, adminUserId]
    );
  }
  if (input.clientSecret !== undefined) {
    const enc = input.clientSecret.trim().length > 0
      ? encryptSecret(input.clientSecret.trim())
      : null;
    await query(
      `INSERT INTO app_settings (key, encrypted_value, updated_by, updated_at)
       VALUES ('tiktok.client_secret', $1, $2, NOW())
       ON CONFLICT (key) DO UPDATE
         SET encrypted_value = EXCLUDED.encrypted_value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [enc, adminUserId]
    );
  }
  if (input.redirectUri !== undefined) {
    await query(
      `INSERT INTO app_settings (key, value, updated_by, updated_at)
       VALUES ('tiktok.redirect_uri', $1, $2, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [input.redirectUri.trim() || null, adminUserId]
    );
  }
}
