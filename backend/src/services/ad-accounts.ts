/**
 * Ad accounts service (per-user as of Patch 4.18).
 *
 * Each Vass user has their OWN set of ad-account rows — they pull the list
 * from their own connected Meta account, and the rows are scoped by
 * user_id. The same Meta ad account can appear in multiple users' rows
 * (each user has independently connected and enabled it).
 *
 * Sync: fetches the latest list from Meta for the given user.
 *   - Adds new accounts (for this user) as enabled=true
 *   - Marks accounts that disappeared from Meta as status='disabled'
 */
import { transaction, query } from '../db/pool';
import * as meta from './meta';

export interface AdAccount {
  id: string;
  metaAccountId: string;
  name: string;
  currency: string | null;
  timezoneName: string | null;
  businessId: string | null;
  status: string;
  isEnabled: boolean;
  lastSyncedAt: Date | null;
  pageId: string | null;
  pictureUrl: string | null;
  instagramUserId: string | null;
  brandId: string | null;
}

function rowToAdAccount(row: any): AdAccount {
  return {
    id: row.id,
    metaAccountId: row.meta_account_id,
    name: row.name,
    currency: row.currency,
    timezoneName: row.timezone_name,
    businessId: row.business_id,
    status: row.status,
    isEnabled: row.is_enabled,
    lastSyncedAt: row.last_synced_at,
    pageId: row.page_id,
    pictureUrl: row.picture_url,
    instagramUserId: row.instagram_user_id,
    brandId: row.brand_id,
  };
}

// Common SELECT fragment so we don't drift between callers
const SELECT_FIELDS = `
  id, meta_account_id, name, currency, timezone_name, business_id,
  status, is_enabled, last_synced_at, page_id, picture_url, instagram_user_id,
  brand_id
`;

/** List a user's ad accounts. */
export async function listAdAccounts(
  userId: string,
  opts?: { onlyEnabled?: boolean }
): Promise<AdAccount[]> {
  const where = ['user_id = $1'];
  if (opts?.onlyEnabled) where.push(`is_enabled = TRUE AND status = 'active'`);
  const { rows } = await query<any>(
    `SELECT ${SELECT_FIELDS}
       FROM ad_accounts
      WHERE ${where.join(' AND ')}
      ORDER BY name ASC`,
    [userId]
  );
  return rows.map(rowToAdAccount);
}

/**
 * Find a user's ad account by its internal id. Scoped to the user so a
 * user can't reach another user's row even by guessing the UUID.
 */
export async function findAdAccountById(
  userId: string,
  id: string
): Promise<AdAccount | null> {
  const { rows } = await query<any>(
    `SELECT ${SELECT_FIELDS}
       FROM ad_accounts
      WHERE id = $1 AND user_id = $2
      LIMIT 1`,
    [id, userId]
  );
  return rows[0] ? rowToAdAccount(rows[0]) : null;
}

export async function setEnabled(
  userId: string,
  id: string,
  isEnabled: boolean
): Promise<AdAccount | null> {
  const { rows } = await query<any>(
    `UPDATE ad_accounts
        SET is_enabled = $3, updated_at = NOW()
      WHERE id = $1 AND user_id = $2
      RETURNING ${SELECT_FIELDS}`,
    [id, userId, isEnabled]
  );
  return rows[0] ? rowToAdAccount(rows[0]) : null;
}

/** Assign (or clear) the brand for one of the user's ad accounts.
 *  Pass brandId=null to un-group. The brand is validated to belong to
 *  the same user before assignment. */
export async function setBrand(
  userId: string,
  id: string,
  brandId: string | null
): Promise<AdAccount | null> {
  if (brandId) {
    const { rows: brandRows } = await query<{ id: string }>(
      `SELECT id FROM brands WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [brandId, userId]
    );
    if (brandRows.length === 0) return null;
  }
  const { rows } = await query<any>(
    `UPDATE ad_accounts
        SET brand_id = $3, updated_at = NOW()
      WHERE id = $1 AND user_id = $2
      RETURNING ${SELECT_FIELDS}`,
    [id, userId, brandId]
  );
  return rows[0] ? rowToAdAccount(rows[0]) : null;
}

/**
 * Sync this user's ad accounts from Meta. The Meta access token must be
 * the SAME user's token — caller is responsible for passing the right one.
 *
 * Returns counts: { added, updated, disappeared } scoped to this user.
 */
export async function syncFromMeta(
  userId: string,
  accessToken: string
): Promise<{ added: number; updated: number; disappeared: number; total: number }> {
  const fromMeta = await meta.listAdAccounts(accessToken);
  const metaIds = new Set(fromMeta.map((a) => a.id));

  // For each account, get its Page + Instagram identity
  const lookupInfo = new Map<string, {
    pageId: string | null;
    pictureUrl: string | null;
    instagramUserId: string | null;
  }>();
  const CONCURRENCY = 5;
  for (let i = 0; i < fromMeta.length; i += CONCURRENCY) {
    const batch = fromMeta.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (acct) => {
        const identity = await meta.fetchAccountIdentity(accessToken, acct.id).catch(() => ({
          pageId: null,
          pictureUrl: null,
          instagramUserId: null,
        }));
        return { metaAccountId: acct.id, ...identity };
      })
    );
    for (const r of results) {
      lookupInfo.set(r.metaAccountId, {
        pageId: r.pageId,
        pictureUrl: r.pictureUrl,
        instagramUserId: r.instagramUserId,
      });
    }
  }

  return transaction(async (client) => {
    // What's currently in THIS USER's DB rows
    const { rows: existing } = await client.query<{
      meta_account_id: string;
      status: string;
    }>(
      `SELECT meta_account_id, status FROM ad_accounts WHERE user_id = $1`,
      [userId]
    );
    const existingIds = new Set(existing.map((r) => r.meta_account_id));

    let added = 0;
    let updated = 0;
    let disappeared = 0;

    for (const acct of fromMeta) {
      const isNew = !existingIds.has(acct.id);
      const status = acct.account_status === 1 ? 'active' : 'disabled';
      const info = lookupInfo.get(acct.id);

      // Upsert keyed on (user_id, meta_account_id) — same Meta account can
      // exist in other users' rows untouched.
      await client.query(
        `INSERT INTO ad_accounts (
            user_id, meta_account_id, name, currency, timezone_name, business_id, status,
            page_id, picture_url, instagram_user_id, last_synced_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
         ON CONFLICT (user_id, meta_account_id) DO UPDATE SET
           name = EXCLUDED.name,
           currency = EXCLUDED.currency,
           timezone_name = EXCLUDED.timezone_name,
           business_id = EXCLUDED.business_id,
           status = EXCLUDED.status,
           page_id = COALESCE(EXCLUDED.page_id, ad_accounts.page_id),
           picture_url = COALESCE(EXCLUDED.picture_url, ad_accounts.picture_url),
           instagram_user_id = COALESCE(EXCLUDED.instagram_user_id, ad_accounts.instagram_user_id),
           last_synced_at = NOW()`,
        [
          userId,
          acct.id,
          acct.name,
          acct.currency,
          acct.timezone_name,
          acct.business?.id ?? null,
          status,
          info?.pageId ?? null,
          info?.pictureUrl ?? null,
          info?.instagramUserId ?? null,
        ]
      );

      if (isNew) added++;
      else updated++;
    }

    // Mark this user's accounts that disappeared from Meta as disabled
    for (const row of existing) {
      if (!metaIds.has(row.meta_account_id) && row.status !== 'disabled') {
        await client.query(
          `UPDATE ad_accounts SET status = 'disabled', last_synced_at = NOW()
             WHERE user_id = $1 AND meta_account_id = $2`,
          [userId, row.meta_account_id]
        );
        disappeared++;
      }
    }

    return { added, updated, disappeared, total: fromMeta.length };
  });
}
