/**
 * Organic publishing — connected accounts service.
 *
 * Handles read/write for the `organic_connected_accounts` table.
 * Encryption uses the same AES-256-GCM helper as the rest of Vass.
 *
 * Supported platforms: facebook_page | instagram | threads
 */
import { query } from '../db/pool';
import { encryptSecret, decryptSecret } from '../utils/crypto';

export type OrganicPlatform = 'facebook_page' | 'instagram' | 'threads' | 'tiktok' | 'linkedin';

export interface OrganicAccount {
  id: string;
  userId: string;
  platform: OrganicPlatform;
  externalId: string;
  brandId: string | null;
  tokenExpiresAt: Date | null;
  scopes: string[];
  meta: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrganicAccountWithToken extends OrganicAccount {
  accessToken: string;
}

function rowToAccount(row: any): OrganicAccount {
  return {
    id: row.id,
    userId: row.user_id,
    platform: row.platform,
    externalId: row.external_id,
    brandId: row.brand_id ?? null,
    tokenExpiresAt: row.token_expires_at ?? null,
    scopes: row.scopes ?? [],
    meta: row.meta ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** List all active (non-disconnected) accounts for a user. */
export async function listAccounts(userId: string): Promise<OrganicAccount[]> {
  const { rows } = await query<any>(
    `SELECT * FROM organic_connected_accounts
      WHERE user_id = $1 AND disconnected_at IS NULL
      ORDER BY platform, created_at ASC`,
    [userId]
  );
  return rows.map(rowToAccount);
}

/** List active accounts for a user filtered by platform. */
export async function listAccountsByPlatform(
  userId: string,
  platform: OrganicPlatform
): Promise<OrganicAccount[]> {
  const { rows } = await query<any>(
    `SELECT * FROM organic_connected_accounts
      WHERE user_id = $1 AND platform = $2 AND disconnected_at IS NULL
      ORDER BY created_at ASC`,
    [userId, platform]
  );
  return rows.map(rowToAccount);
}

/** Get a single account by its Vass ID (must belong to the user). */
export async function getAccount(
  userId: string,
  id: string
): Promise<OrganicAccount | null> {
  const { rows } = await query<any>(
    `SELECT * FROM organic_connected_accounts
      WHERE id = $1 AND user_id = $2 AND disconnected_at IS NULL
      LIMIT 1`,
    [id, userId]
  );
  return rows[0] ? rowToAccount(rows[0]) : null;
}

/** Get a single account with its decrypted access token. */
export async function getAccountWithToken(
  userId: string,
  id: string
): Promise<OrganicAccountWithToken | null> {
  const { rows } = await query<any>(
    `SELECT * FROM organic_connected_accounts
      WHERE id = $1 AND user_id = $2 AND disconnected_at IS NULL
      LIMIT 1`,
    [id, userId]
  );
  if (!rows[0]) return null;
  let accessToken: string;
  try {
    accessToken = decryptSecret(rows[0].access_token_encrypted);
  } catch {
    return null;
  }
  return { ...rowToAccount(rows[0]), accessToken };
}

/**
 * Get the decrypted **parent user token** for an account.
 *
 * Why this exists separately from `getAccountWithToken`:
 *
 * For FB Pages, `access_token_encrypted` stores the *Page-scoped* token —
 * which is what you need to publish posts, comment, etc. on that Page.
 * But some endpoints (notably `/pages/search` used by location tagging)
 * require a *User-scoped* token with the right user-level scopes. The
 * Page token doesn't have those scopes attached.
 *
 * We capture the parent user token at connect time
 * (`parent_user_token_encrypted`) precisely for these cases. Returns
 * null if the column was never populated (older connections from before
 * we stored it).
 */
export async function getParentUserToken(
  userId: string,
  id: string
): Promise<string | null> {
  const { rows } = await query<{ parent_user_token_encrypted: string | null }>(
    `SELECT parent_user_token_encrypted
       FROM organic_connected_accounts
      WHERE id = $1 AND user_id = $2 AND disconnected_at IS NULL
      LIMIT 1`,
    [id, userId]
  );
  if (!rows[0]?.parent_user_token_encrypted) return null;
  try {
    return decryptSecret(rows[0].parent_user_token_encrypted);
  } catch {
    return null;
  }
}

/**
 * TikTok: get the decrypted refresh token + its expiry for an account.
 * Used by the token-refresh flow to mint a fresh short-lived access
 * token when the current one is near expiry. Returns null if absent
 * (non-TikTok account, or refresh token never stored).
 */
export async function getRefreshToken(
  userId: string,
  id: string
): Promise<{ refreshToken: string; refreshExpiresAt: Date | null } | null> {
  const { rows } = await query<{
    refresh_token_encrypted: string | null;
    refresh_token_expires_at: Date | null;
  }>(
    `SELECT refresh_token_encrypted, refresh_token_expires_at
       FROM organic_connected_accounts
      WHERE id = $1 AND user_id = $2 AND disconnected_at IS NULL
      LIMIT 1`,
    [id, userId]
  );
  if (!rows[0]?.refresh_token_encrypted) return null;
  try {
    return {
      refreshToken: decryptSecret(rows[0].refresh_token_encrypted),
      refreshExpiresAt: rows[0].refresh_token_expires_at,
    };
  } catch {
    return null;
  }
}

export interface SaveAccountInput {
  userId: string;
  platform: OrganicPlatform;
  externalId: string;
  accessToken: string;
  tokenExpiresAt: Date | null;
  parentUserToken?: string;
  scopes: string[];
  meta: Record<string, unknown>;
  /** TikTok: encrypted-at-rest refresh token + its expiry. */
  refreshToken?: string;
  refreshTokenExpiresAt?: Date | null;
}

/**
 * Upsert an organic account connection. If a disconnected row exists for
 * the same (user, platform, externalId), it is reactivated. Otherwise a
 * new row is inserted.
 */
export async function saveAccount(input: SaveAccountInput): Promise<OrganicAccount> {
  const encToken = encryptSecret(input.accessToken);
  const encParent = input.parentUserToken
    ? encryptSecret(input.parentUserToken)
    : null;
  const encRefresh = input.refreshToken
    ? encryptSecret(input.refreshToken)
    : null;
  const refreshExpiry = input.refreshTokenExpiresAt ?? null;

  // Try to reactivate a previously disconnected row first.
  const { rows: existing } = await query<any>(
    `SELECT id FROM organic_connected_accounts
      WHERE user_id = $1 AND platform = $2 AND external_id = $3
      LIMIT 1`,
    [input.userId, input.platform, input.externalId]
  );

  if (existing.length > 0) {
    const { rows } = await query<any>(
      `UPDATE organic_connected_accounts
          SET access_token_encrypted       = $1,
              parent_user_token_encrypted  = $2,
              token_expires_at             = $3,
              scopes                       = $4,
              meta                         = $5,
              refresh_token_encrypted      = $7,
              refresh_token_expires_at     = $8,
              disconnected_at              = NULL,
              updated_at                   = NOW()
        WHERE id = $6
        RETURNING *`,
      [
        encToken,
        encParent,
        input.tokenExpiresAt,
        input.scopes,
        JSON.stringify(input.meta),
        existing[0].id,
        encRefresh,
        refreshExpiry,
      ]
    );
    return rowToAccount(rows[0]);
  }

  const { rows } = await query<any>(
    `INSERT INTO organic_connected_accounts (
        user_id, platform, external_id,
        access_token_encrypted, parent_user_token_encrypted,
        token_expires_at, scopes, meta,
        refresh_token_encrypted, refresh_token_expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      input.userId,
      input.platform,
      input.externalId,
      encToken,
      encParent,
      input.tokenExpiresAt,
      input.scopes,
      JSON.stringify(input.meta),
      encRefresh,
      refreshExpiry,
    ]
  );
  return rowToAccount(rows[0]);
}

/** Soft-delete: mark the account as disconnected. */
export async function disconnectAccount(
  userId: string,
  id: string
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE organic_connected_accounts
        SET disconnected_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND disconnected_at IS NULL`,
    [id, userId]
  );
  return (rowCount ?? 0) > 0;
}
