/**
 * Brand hashtags service.
 *
 * Per-brand preset hashtags surfaced in the composer toolbar.
 *
 * UX shape:
 *   - User edits a brand and types tags in a chip input
 *   - Frontend sends the FULL list back on save
 *   - We replace-all (delete + insert) inside a transaction
 *
 * Replace-all means we don't have to think about diffs, and the list
 * is small enough (typically <30 tags per brand) that any perf
 * difference is irrelevant.
 *
 * Storage convention: tag is stored WITHOUT the leading '#', lowercased.
 * The composer adds '#' at insert time. This makes uniqueness and
 * validation straightforward (`^[a-z0-9_]{1,100}$`).
 */
import { query, transaction } from '../db/pool';

export interface BrandHashtag {
  id: string;
  brandId: string;
  tag: string;
  sortOrder: number;
  createdAt: Date;
}

function rowToHashtag(row: any): BrandHashtag {
  return {
    id: row.id,
    brandId: row.brand_id,
    tag: row.tag,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

/** Normalize a user-typed tag to storage form: strip leading '#',
 *  lowercase, drop invalid characters. Returns null if nothing usable
 *  is left after normalization. */
export function normalizeTag(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let t = raw.trim();
  if (t.startsWith('#')) t = t.slice(1);
  t = t.toLowerCase();
  // Replace whitespace with underscore (common user habit: "small business" → "small_business")
  t = t.replace(/\s+/g, '_');
  // Drop characters outside [a-z0-9_]
  t = t.replace(/[^a-z0-9_]/g, '');
  if (!t) return null;
  if (t.length > 100) t = t.slice(0, 100);
  return t;
}

/** List the hashtags for a brand. Ownership check happens at the route. */
export async function listForBrand(brandId: string): Promise<BrandHashtag[]> {
  const { rows } = await query<any>(
    `SELECT * FROM brand_hashtags
      WHERE brand_id = $1
      ORDER BY sort_order ASC, created_at ASC`,
    [brandId]
  );
  return rows.map(rowToHashtag);
}

/** Replace the entire hashtag list for a brand atomically. Returns the
 *  new persisted list. Duplicates and invalid entries are dropped
 *  silently — the route validates the input shape. */
export async function replaceForBrand(brandId: string, rawTags: string[]): Promise<BrandHashtag[]> {
  // Normalize + dedupe while preserving the order the user gave us.
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of rawTags) {
    const n = normalizeTag(raw);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    normalized.push(n);
  }

  await transaction(async (client) => {
    await client.query('DELETE FROM brand_hashtags WHERE brand_id = $1', [brandId]);
    for (let i = 0; i < normalized.length; i++) {
      await client.query(
        `INSERT INTO brand_hashtags (brand_id, tag, sort_order)
         VALUES ($1, $2, $3)`,
        [brandId, normalized[i], i]
      );
    }
  });

  return listForBrand(brandId);
}
