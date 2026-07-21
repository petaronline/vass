/**
 * Page-scoped Meta token resolution.
 *
 * WHY THIS EXISTS
 *
 * Hiding a comment requires the owning Page's **page-scoped** token — a user
 * token will not do it. Comment Guard used to borrow those tokens from
 * `organic_connected_accounts`, the table the organic publishing flow fills
 * in, because that flow already requested `pages_manage_engagement`.
 *
 * That coupling is gone: organic now lives in its own app (Vass Organic) with
 * its own database, so this app can no longer read that table. Instead we ask
 * Meta directly. `GET /me/accounts` returns every Page the authenticated user
 * administers together with a page-scoped `access_token` for each, which is
 * exactly what we need and requires no local storage at all.
 *
 * REQUIRED SCOPES (see REQUIRED_SCOPES in meta.ts):
 *   pages_show_list          — enumerate the user's Pages
 *   pages_read_engagement    — read comments on those Pages' posts
 *   pages_manage_engagement  — hide/unhide those comments
 *
 * A user who connected Meta BEFORE those scopes were added holds a token
 * without them. `/me/accounts` then returns an OAuth error or an empty list;
 * both surface here as "no pages", which callers already handle by marking a
 * target `page_connected = false`. The user fixes it by reconnecting in
 * Settings → Meta. Nothing crashes, nothing silently no-ops.
 *
 * Tokens are deliberately NOT persisted. Page tokens derived from a
 * long-lived user token last as long as that token does, and re-fetching is
 * one cheap call — storing them would mean another encrypted secret to rotate
 * and invalidate for no benefit.
 */
import * as metaConn from './meta-connection';

const GRAPH_API_VERSION = 'v25.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/** Stop paging after this many pages of Pages. Nobody administers 500. */
const MAX_PAGES = 5;

/** How long a resolved page list stays fresh, in ms. */
const CACHE_TTL_MS = 10 * 60 * 1000;

export interface ManagedPage {
  /** Meta's Page id — the same value stored in comment_guard_targets.page_id. */
  pageId: string;
  name: string | null;
  /** Page-scoped token. Never logged, never written to the database. */
  accessToken: string;
}

interface CacheEntry {
  at: number;
  pages: ManagedPage[];
}

const cache = new Map<string, CacheEntry>();

/**
 * Drop a user's cached Page list. Call after the user reconnects Meta, so a
 * freshly-granted scope takes effect immediately instead of up to TTL later.
 */
export function invalidate(userId: string): void {
  cache.delete(userId);
}

interface MeAccountsResponse {
  data?: Array<{ id: string; name?: string; access_token?: string }>;
  paging?: { next?: string };
  error?: { message?: string; type?: string; code?: number };
}

/**
 * Every Page this user administers, with a page-scoped token for each.
 *
 * Returns [] — never throws — when the user has no Meta connection, holds a
 * token that predates the page scopes, or administers no Pages. Callers treat
 * all three the same way: the Page simply isn't moderatable.
 */
export async function listManagedPages(
  userId: string,
  opts: { force?: boolean } = {}
): Promise<ManagedPage[]> {
  if (!opts.force) {
    const hit = cache.get(userId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.pages;
  }

  const userToken = await metaConn.getAccessToken(userId);
  if (!userToken) {
    cache.set(userId, { at: Date.now(), pages: [] });
    return [];
  }

  const pages: ManagedPage[] = [];
  let url: string | null =
    `${GRAPH_BASE}/me/accounts?fields=id,name,access_token&limit=100` +
    `&access_token=${encodeURIComponent(userToken)}`;

  for (let page = 0; page < MAX_PAGES && url; page++) {
    let body: MeAccountsResponse;
    try {
      const res = await fetch(url);
      body = (await res.json()) as MeAccountsResponse;
    } catch (err) {
      // Network blip: don't poison the cache with an empty list.
      console.warn(
        `[page-tokens] /me/accounts failed for user ${userId}:`,
        err instanceof Error ? err.message : err
      );
      return pages;
    }

    if (body.error) {
      // Most commonly: the token predates the page scopes (code 200 /
      // OAuthException). Cache the empty result so a sweep over many targets
      // doesn't re-ask Meta once per target.
      console.warn(
        `[page-tokens] /me/accounts rejected for user ${userId}: ${body.error.message ?? 'unknown error'}`
      );
      cache.set(userId, { at: Date.now(), pages: [] });
      return [];
    }

    for (const row of body.data ?? []) {
      if (!row.id || !row.access_token) continue;
      pages.push({
        pageId: row.id,
        name: row.name ?? null,
        accessToken: row.access_token,
      });
    }

    url = body.paging?.next ?? null;
  }

  cache.set(userId, { at: Date.now(), pages });
  return pages;
}

/**
 * The page-scoped token for one Page, or null if this user doesn't administer
 * it (or lacks the scopes). Shape-compatible with the
 * `organic-connection.getFacebookPageToken` it replaced.
 */
export async function getPageToken(
  userId: string,
  pageId: string
): Promise<string | null> {
  const pages = await listManagedPages(userId);
  const hit = pages.find((p) => p.pageId === pageId);
  if (hit) return hit.accessToken;

  // Miss on a cached list: the user may have just been granted the Page.
  // Re-fetch once before giving up.
  const fresh = await listManagedPages(userId, { force: true });
  return fresh.find((p) => p.pageId === pageId)?.accessToken ?? null;
}
