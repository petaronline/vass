/**
 * Meta connection service.
 *
 * Two layers:
 *   1. **Workspace-wide Meta App** (App ID + App Secret) — one row each
 *      in `app_settings`. Set by an admin, used by every user in the
 *      workspace. Same shape as before per-user isolation (Patch 4.17
 *      and earlier).
 *   2. **Per-user OAuth state** (long-lived access token + connected FB
 *      user snapshot) — one row per Vass user in `user_meta_connections`.
 *      Each user OAuths against the workspace App, gets their own
 *      user-scoped token, and sees only their own Facebook pages/ad
 *      accounts.
 *
 * Encryption: the same AES-256-GCM helper used elsewhere. App Secret and
 * access tokens are stored encrypted; everything else is plaintext.
 */
import { query } from '../db/pool';
import { encryptSecret, decryptSecret } from '../utils/crypto';

// =====================================================================
// Workspace-wide Meta App (admin configures once)
// =====================================================================

const KEY_APP_ID     = 'meta.app_id';
const KEY_APP_SECRET = 'meta.app_secret';

/** Read App ID (plaintext). */
async function getWorkspaceAppId(): Promise<string | null> {
  const { rows } = await query<{ value: string | null }>(
    `SELECT value FROM app_settings WHERE key = $1 LIMIT 1`,
    [KEY_APP_ID]
  );
  return rows[0]?.value ?? null;
}

/** Read App Secret (decrypted). */
async function getWorkspaceAppSecret(): Promise<string | null> {
  const { rows } = await query<{ encrypted_value: string | null }>(
    `SELECT encrypted_value FROM app_settings WHERE key = $1 LIMIT 1`,
    [KEY_APP_SECRET]
  );
  const enc = rows[0]?.encrypted_value;
  if (!enc) return null;
  try {
    return decryptSecret(enc);
  } catch {
    return null;
  }
}

/**
 * Workspace-level App credentials. Returns null if either is missing or
 * the App Secret can't be decrypted. Use this for OAuth code exchange and
 * any back-channel call needing the app credentials directly.
 *
 * NOTE: not user-scoped — every user in the workspace uses these. Only
 * admins should be able to set/change them (enforced at the route layer).
 */
export async function getAppCredentials(): Promise<{
  appId: string;
  appSecret: string;
} | null> {
  const [appId, appSecret] = await Promise.all([
    getWorkspaceAppId(),
    getWorkspaceAppSecret(),
  ]);
  if (!appId || !appSecret) return null;
  return { appId, appSecret };
}

/** True when an admin has saved the workspace App ID + Secret. */
export async function hasWorkspaceCredentials(): Promise<boolean> {
  const creds = await getAppCredentials();
  return creds !== null;
}

/** Get just the App ID for display in Settings. App Secret is never returned. */
export async function getDisplayableAppId(): Promise<string | null> {
  return getWorkspaceAppId();
}

/** Save (or replace) the workspace App ID + Secret. Admin-only at route level. */
export async function saveAppCredentials(
  adminUserId: string,
  appId: string,
  appSecret: string
): Promise<void> {
  const enc = encryptSecret(appSecret);
  // app_settings has key-level upsert semantics; we touch two rows.
  await query(
    `INSERT INTO app_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET
        value      = EXCLUDED.value,
        updated_by = EXCLUDED.updated_by,
        updated_at = NOW()`,
    [KEY_APP_ID, appId, adminUserId]
  );
  await query(
    `INSERT INTO app_settings (key, encrypted_value, updated_by, updated_at)
       VALUES ($1, $2, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET
        encrypted_value = EXCLUDED.encrypted_value,
        updated_by      = EXCLUDED.updated_by,
        updated_at      = NOW()`,
    [KEY_APP_SECRET, enc, adminUserId]
  );
}

// =====================================================================
// Per-user OAuth state
// =====================================================================

export interface UserMetaConnection {
  userId: string;
  hasAccessToken: boolean;
  tokenExpiresAt: Date | null;
  connectedUserMetaId: string | null;
  connectedUserName: string | null;
  connectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function rowToUserConnection(row: any): UserMetaConnection {
  return {
    userId: row.user_id,
    hasAccessToken: !!row.access_token_encrypted,
    tokenExpiresAt: row.token_expires_at,
    connectedUserMetaId: row.connected_user_meta_id ?? null,
    connectedUserName: row.connected_user_name ?? null,
    connectedAt: row.connected_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Safe-to-display projection of a user's OAuth state. */
export async function getConnection(
  userId: string
): Promise<UserMetaConnection | null> {
  const { rows } = await query<any>(
    `SELECT * FROM user_meta_connections WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  return rows[0] ? rowToUserConnection(rows[0]) : null;
}

/** Returns the decrypted access token, or null if unset / unreadable. */
export async function getAccessToken(userId: string): Promise<string | null> {
  const { rows } = await query<{ access_token_encrypted: string | null }>(
    `SELECT access_token_encrypted
       FROM user_meta_connections
      WHERE user_id = $1
      LIMIT 1`,
    [userId]
  );
  const enc = rows[0]?.access_token_encrypted;
  if (!enc) return null;
  try {
    return decryptSecret(enc);
  } catch {
    return null;
  }
}

/**
 * Persist a user's access token + connected-user snapshot after a
 * successful OAuth code exchange. Creates the row if missing (the user
 * might not have one yet — they only get one when they OAuth).
 */
export async function saveAccessToken(
  userId: string,
  accessToken: string,
  expiresAt: Date | null,
  metaUserId: string,
  metaUserName: string
): Promise<void> {
  const enc = encryptSecret(accessToken);
  await query(
    `INSERT INTO user_meta_connections (
        user_id, access_token_encrypted, token_expires_at,
        connected_user_meta_id, connected_user_name, connected_at,
        updated_at
     )
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET
        access_token_encrypted = EXCLUDED.access_token_encrypted,
        token_expires_at       = EXCLUDED.token_expires_at,
        connected_user_meta_id = EXCLUDED.connected_user_meta_id,
        connected_user_name    = EXCLUDED.connected_user_name,
        connected_at           = NOW(),
        updated_at             = NOW()`,
    [userId, enc, expiresAt, metaUserId, metaUserName]
  );
}

/** Disconnect: clear the token + connected-user fields. The row itself
 *  stays around (cheap, and keeps future re-connects simple). */
export async function clearAccessToken(userId: string): Promise<void> {
  await query(
    `UPDATE user_meta_connections
        SET access_token_encrypted = NULL,
            token_expires_at       = NULL,
            connected_user_meta_id = NULL,
            connected_user_name    = NULL,
            connected_at           = NULL,
            updated_at             = NOW()
      WHERE user_id = $1`,
    [userId]
  );
}

/** Drop the row entirely. Used for cleanup; normal disconnect is the clear. */
export async function deleteConnection(userId: string): Promise<void> {
  await query(`DELETE FROM user_meta_connections WHERE user_id = $1`, [userId]);
}
