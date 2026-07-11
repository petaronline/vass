/**
 * Threads app credentials.
 *
 * Meta requires a separate Meta App registration for Threads (distinct
 * from the FB/IG one we use for ads + page publishing). This module is
 * the data-access layer for those creds — App ID, App Secret, optional
 * redirect URI override — stored as workspace-wide rows in app_settings.
 *
 * Mirrors meta-connection.ts in shape and crypto so the two flows stay
 * predictable.
 */

import { query } from '../db/pool';
import { encryptSecret, decryptSecret } from '../utils/crypto';
import { env } from '../utils/env';

// ─── Low-level getters ────────────────────────────────────────────────

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
    console.error('[threads-credentials] Could not decrypt secret for', key, e);
    return null;
  }
}

// ─── Public surface ───────────────────────────────────────────────────

export interface ThreadsAppCredentials {
  appId: string;
  appSecret: string;
  /** Falls back to ${FRONTEND_URL}/api/organic/threads/callback when unset. */
  redirectUri: string;
}

/** Returns null when any required value is missing. */
export async function getThreadsAppCredentials(): Promise<ThreadsAppCredentials | null> {
  const [appId, appSecret, redirectOverride] = await Promise.all([
    getKeyValue('threads.app_id'),
    getKeyEncrypted('threads.app_secret'),
    getKeyValue('threads.redirect_uri'),
  ]);
  if (!appId || !appSecret) return null;
  return {
    appId,
    appSecret,
    redirectUri:
      redirectOverride && redirectOverride.trim().length > 0
        ? redirectOverride
        : `${env.FRONTEND_URL}/api/organic/threads/callback`,
  };
}

/** True when admin has fully configured Threads creds. */
export async function hasThreadsCredentials(): Promise<boolean> {
  const c = await getThreadsAppCredentials();
  return c !== null;
}

/** Displayable shape for Settings UI — App Secret is never returned. */
export async function getDisplayableThreadsConfig(): Promise<{
  appId: string | null;
  hasSecret: boolean;
  redirectUri: string;
}> {
  const [appId, appSecret, redirectOverride] = await Promise.all([
    getKeyValue('threads.app_id'),
    getKeyEncrypted('threads.app_secret'),
    getKeyValue('threads.redirect_uri'),
  ]);
  return {
    appId,
    hasSecret: appSecret !== null && appSecret.length > 0,
    redirectUri:
      redirectOverride && redirectOverride.trim().length > 0
        ? redirectOverride
        : `${env.FRONTEND_URL}/api/organic/threads/callback`,
  };
}

/**
 * Save the Threads credentials. Any field omitted (undefined) is left
 * alone — admin can update App ID without re-entering the secret.
 * Passing an explicit empty string clears the value (used for "reset").
 */
export async function saveThreadsCredentials(
  adminUserId: string,
  input: {
    appId?: string;
    appSecret?: string;
    redirectUri?: string;
  }
): Promise<void> {
  if (input.appId !== undefined) {
    await query(
      `INSERT INTO app_settings (key, value, updated_by, updated_at)
       VALUES ('threads.app_id', $1, $2, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value,
             updated_by = EXCLUDED.updated_by,
             updated_at = NOW()`,
      [input.appId.trim() || null, adminUserId]
    );
  }
  if (input.appSecret !== undefined) {
    const enc = input.appSecret.trim().length > 0
      ? encryptSecret(input.appSecret.trim())
      : null;
    await query(
      `INSERT INTO app_settings (key, encrypted_value, updated_by, updated_at)
       VALUES ('threads.app_secret', $1, $2, NOW())
       ON CONFLICT (key) DO UPDATE
         SET encrypted_value = EXCLUDED.encrypted_value,
             updated_by = EXCLUDED.updated_by,
             updated_at = NOW()`,
      [enc, adminUserId]
    );
  }
  if (input.redirectUri !== undefined) {
    await query(
      `INSERT INTO app_settings (key, value, updated_by, updated_at)
       VALUES ('threads.redirect_uri', $1, $2, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value,
             updated_by = EXCLUDED.updated_by,
             updated_at = NOW()`,
      [input.redirectUri.trim() || null, adminUserId]
    );
  }
}
