/**
 * App settings service.
 *
 * Wraps the `app_settings` key/value table.
 * Distinguishes between plain values (App ID, user name) and encrypted
 * values (App Secret, Access Token).
 *
 * Settings keys are namespaced (e.g. 'meta.app_id'). When more integrations
 * arrive later we'll add more namespaces, not more tables.
 */
import { query } from '../db/pool';
import { encryptSecret, decryptSecret } from '../utils/crypto';

export async function getPlain(key: string): Promise<string | null> {
  const { rows } = await query<{ value: string | null }>(
    'SELECT value FROM app_settings WHERE key = $1 LIMIT 1',
    [key]
  );
  return rows[0]?.value ?? null;
}

export async function getEncrypted(key: string): Promise<string | null> {
  const { rows } = await query<{ encrypted_value: string | null }>(
    'SELECT encrypted_value FROM app_settings WHERE key = $1 LIMIT 1',
    [key]
  );
  const value = rows[0]?.encrypted_value;
  if (!value) return null;
  try {
    return decryptSecret(value);
  } catch (err) {
    console.error(`[settings] Failed to decrypt ${key}:`, err);
    return null;
  }
}

export async function setPlain(
  key: string,
  value: string | null,
  updatedBy?: string
): Promise<void> {
  await query(
    `INSERT INTO app_settings (key, value, updated_by, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [key, value, updatedBy ?? null]
  );
}

export async function setEncrypted(
  key: string,
  value: string | null,
  updatedBy?: string
): Promise<void> {
  const encrypted = value ? encryptSecret(value) : null;
  await query(
    `INSERT INTO app_settings (key, encrypted_value, updated_by, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [key, encrypted, updatedBy ?? null]
  );
}

/**
 * Read several keys at once.
 * Returns plain values; encrypted keys are decrypted automatically based on key name convention.
 */
const ENCRYPTED_KEYS = new Set(['meta.app_secret', 'meta.access_token']);

export async function getMany(keys: string[]): Promise<Record<string, string | null>> {
  if (keys.length === 0) return {};
  const { rows } = await query<{
    key: string;
    value: string | null;
    encrypted_value: string | null;
  }>(
    'SELECT key, value, encrypted_value FROM app_settings WHERE key = ANY($1::text[])',
    [keys]
  );
  const result: Record<string, string | null> = {};
  for (const key of keys) result[key] = null;
  for (const row of rows) {
    if (ENCRYPTED_KEYS.has(row.key)) {
      try {
        result[row.key] = row.encrypted_value ? decryptSecret(row.encrypted_value) : null;
      } catch {
        result[row.key] = null;
      }
    } else {
      result[row.key] = row.value;
    }
  }
  return result;
}

/**
 * Clear several keys at once (used on disconnect).
 */
export async function clearMany(keys: string[], updatedBy?: string): Promise<void> {
  if (keys.length === 0) return;
  await query(
    `UPDATE app_settings
     SET value = NULL, encrypted_value = NULL, updated_by = $2, updated_at = NOW()
     WHERE key = ANY($1::text[])`,
    [keys, updatedBy ?? null]
  );
}
