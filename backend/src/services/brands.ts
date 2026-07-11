/**
 * Brands service — per-user grouping for connected social accounts.
 *
 * A brand is just a labeled container with a color. Accounts in
 * `organic_connected_accounts` reference a brand via `brand_id`
 * (nullable — NULL means "Unassigned").
 */
import { query } from '../db/pool';

export interface Brand {
  id: string;
  userId: string;
  name: string;
  color: string;
  sortOrder: number;
  /** First connected profile's picture URL — for sidebar thumbnails.
   *  Null when the brand has no profiles or none have a picture. */
  thumbnailUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function rowToBrand(row: any): Brand {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    color: row.color,
    sortOrder: row.sort_order,
    thumbnailUrl: row.thumbnail_url ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** List all brands belonging to the user with first-profile thumbnail attached. */
export async function listBrands(userId: string): Promise<Brand[]> {
  // The thumbnail subquery picks the first non-null picture_url from any
  // connected (non-disconnected) profile in the brand, ordered by the
  // profile's created_at so the choice is stable across refreshes.
  const { rows } = await query<any>(
    `SELECT b.*,
            (
              SELECT (oa.meta->>'picture_url')
              FROM organic_connected_accounts oa
              WHERE oa.brand_id = b.id
                AND oa.disconnected_at IS NULL
                AND oa.meta->>'picture_url' IS NOT NULL
              ORDER BY oa.created_at ASC
              LIMIT 1
            ) AS thumbnail_url
       FROM brands b
      WHERE b.user_id = $1
      ORDER BY b.sort_order ASC, lower(b.name) ASC`,
    [userId]
  );
  return rows.map(rowToBrand);
}

/** Fetch a single brand by id, only if it belongs to the user.
 *  Returns null when not found. Used for ownership checks before
 *  letting the user touch related resources (hashtags etc). */
export async function getBrand(userId: string, id: string): Promise<Brand | null> {
  const { rows } = await query<any>(
    `SELECT b.*,
            (
              SELECT (oa.meta->>'picture_url')
              FROM organic_connected_accounts oa
              WHERE oa.brand_id = b.id
                AND oa.disconnected_at IS NULL
                AND oa.meta->>'picture_url' IS NOT NULL
              ORDER BY oa.created_at ASC
              LIMIT 1
            ) AS thumbnail_url
       FROM brands b
      WHERE b.user_id = $1 AND b.id = $2
      LIMIT 1`,
    [userId, id]
  );
  if (rows.length === 0) return null;
  return rowToBrand(rows[0]);
}

export interface CreateBrandInput {
  userId: string;
  name: string;
  color?: string;
}

/** Create a brand. Throws if the name is taken (unique violation). */
export async function createBrand(input: CreateBrandInput): Promise<Brand> {
  const color = input.color ?? '#6366F1';
  const { rows } = await query<any>(
    `INSERT INTO brands (user_id, name, color)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [input.userId, input.name.trim(), color]
  );
  return rowToBrand(rows[0]);
}

export interface UpdateBrandInput {
  name?: string;
  color?: string;
  sortOrder?: number;
}

/** Update a brand's mutable fields. Returns null if the brand doesn't exist or doesn't belong to the user. */
export async function updateBrand(
  userId: string,
  id: string,
  input: UpdateBrandInput
): Promise<Brand | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (input.name !== undefined) {
    sets.push(`name = $${i++}`);
    values.push(input.name.trim());
  }
  if (input.color !== undefined) {
    sets.push(`color = $${i++}`);
    values.push(input.color);
  }
  if (input.sortOrder !== undefined) {
    sets.push(`sort_order = $${i++}`);
    values.push(input.sortOrder);
  }

  if (sets.length === 0) {
    // Nothing to update — just return the current row.
    const { rows } = await query<any>(
      `SELECT * FROM brands WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    return rows[0] ? rowToBrand(rows[0]) : null;
  }

  sets.push(`updated_at = NOW()`);
  values.push(id, userId);

  const { rows } = await query<any>(
    `UPDATE brands SET ${sets.join(', ')}
      WHERE id = $${i++} AND user_id = $${i}
      RETURNING *`,
    values
  );
  return rows[0] ? rowToBrand(rows[0]) : null;
}

/**
 * Delete a brand. Accounts assigned to it drop back to Unassigned
 * (ON DELETE SET NULL on the FK).
 */
export async function deleteBrand(userId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM brands WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Assign (or unassign) a connected account to a brand. Pass brandId=null
 * to move the account back to Unassigned.
 *
 * Verifies both the account and (if non-null) the brand belong to the user
 * before doing anything — important since both ids come from the client.
 */
export async function assignAccountToBrand(
  userId: string,
  accountId: string,
  brandId: string | null
): Promise<boolean> {
  if (brandId !== null) {
    // Verify the target brand belongs to the user.
    const { rows } = await query(
      `SELECT 1 FROM brands WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [brandId, userId]
    );
    if (rows.length === 0) return false;
  }

  const { rowCount } = await query(
    `UPDATE organic_connected_accounts
        SET brand_id = $1, updated_at = NOW()
      WHERE id = $2 AND user_id = $3 AND disconnected_at IS NULL`,
    [brandId, accountId, userId]
  );
  return (rowCount ?? 0) > 0;
}
