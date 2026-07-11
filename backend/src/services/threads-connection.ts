/**
 * Threads OAuth + profile/connection helpers.
 *
 * Threads runs on a different host than the FB Graph API and uses a
 * slightly different OAuth dance:
 *
 *   1. Authorize: https://threads.net/oauth/authorize?...&scope=A,B,C
 *        Note: scopes are **comma-separated** (not space-separated),
 *        which is the standard OAuth pattern. Threads enforces commas.
 *   2. Exchange code:  POST https://graph.threads.net/oauth/access_token
 *        Returns a short-lived (~1h) access_token + user_id.
 *   3. Upgrade to long-lived (60d):
 *        GET https://graph.threads.net/access_token?grant_type=th_exchange_token
 *
 * We always upgrade to long-lived right away, matching the IG flow.
 * The 60-day token is what we store. Refresh is the user's problem
 * for now — when it expires they reconnect (same as IG today).
 */

import { query } from '../db/pool';
import { encryptSecret } from '../utils/crypto';
import { getThreadsAppCredentials, ThreadsAppCredentials } from './threads-credentials';

const THREADS_AUTHORIZE_URL = 'https://threads.net/oauth/authorize';
const THREADS_TOKEN_URL = 'https://graph.threads.net/oauth/access_token';
const THREADS_LONG_LIVED_URL = 'https://graph.threads.net/access_token';
const THREADS_GRAPH_BASE = 'https://graph.threads.net/v1.0';

/** Scopes we need for organic publishing. threads_basic gives us
 *  identity + read of own posts; threads_content_publish lets us
 *  POST containers and publish them. */
export const THREADS_SCOPES = [
  'threads_basic',
  'threads_content_publish',
  'threads_manage_insights', // organic analytics — Threads post insights (Patch 4.57)
];

// =====================================================================
// OAuth URL builder
// =====================================================================

export function buildThreadsOAuthUrl(args: {
  appId: string;
  redirectUri: string;
  state: string;
  scopes?: string[];
}): string {
  const scopes = args.scopes ?? THREADS_SCOPES;
  // Scopes MUST be comma-separated (Threads-specific quirk).
  const params = new URLSearchParams({
    client_id: args.appId,
    redirect_uri: args.redirectUri,
    scope: scopes.join(','),
    response_type: 'code',
    state: args.state,
  });
  return `${THREADS_AUTHORIZE_URL}?${params}`;
}

// =====================================================================
// Token exchange
// =====================================================================

interface ShortLivedTokenResponse {
  access_token: string;
  user_id: number | string;
}

interface LongLivedTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

/** Exchange the authorization code from the callback for a short-lived
 *  token, then immediately upgrade it to long-lived. Returns the
 *  long-lived token + the Threads user id + the absolute expiry. */
export async function exchangeCodeForLongLivedToken(args: {
  creds: ThreadsAppCredentials;
  code: string;
}): Promise<{ accessToken: string; userId: string; expiresAt: Date }> {
  // ── Step 1: code → short-lived
  const shortForm = new URLSearchParams({
    client_id: args.creds.appId,
    client_secret: args.creds.appSecret,
    grant_type: 'authorization_code',
    redirect_uri: args.creds.redirectUri,
    code: args.code,
  });
  const shortResp = await fetch(THREADS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: shortForm,
  });
  const shortData = (await shortResp.json()) as
    | ShortLivedTokenResponse
    | { error_type?: string; error_message?: string; code?: number };
  if (!shortResp.ok || 'error_type' in shortData) {
    const msg =
      'error_message' in shortData ? shortData.error_message : `HTTP ${shortResp.status}`;
    throw new Error(`Threads token exchange failed: ${msg}`);
  }
  const shortToken = (shortData as ShortLivedTokenResponse).access_token;
  const userId = String((shortData as ShortLivedTokenResponse).user_id);

  // ── Step 2: short → long-lived (60-day)
  // NOTE: th_exchange_token does NOT take client_id — only client_secret
  // and access_token. Sending client_id makes the endpoint return 400.
  const longParams = new URLSearchParams({
    grant_type: 'th_exchange_token',
    client_secret: args.creds.appSecret,
    access_token: shortToken,
  });
  const longResp = await fetch(`${THREADS_LONG_LIVED_URL}?${longParams}`, {
    method: 'GET',
  });
  const longData = (await longResp.json()) as
    | LongLivedTokenResponse
    | { error_type?: string; error_message?: string };
  if (!longResp.ok || 'error_type' in longData) {
    const msg =
      'error_message' in longData ? longData.error_message : `HTTP ${longResp.status}`;
    throw new Error(`Threads long-lived token exchange failed: ${msg}`);
  }
  const longToken = (longData as LongLivedTokenResponse).access_token;
  const expiresIn = (longData as LongLivedTokenResponse).expires_in;
  const expiresAt = new Date(Date.now() + expiresIn * 1000);

  return { accessToken: longToken, userId, expiresAt };
}

// =====================================================================
// Profile fetch
// =====================================================================

export interface ThreadsProfile {
  id: string;
  username: string;
  name: string;
  pictureUrl: string | null;
}

export async function fetchThreadsProfile(args: {
  threadsUserId: string;
  accessToken: string;
}): Promise<ThreadsProfile> {
  // We use the /me shortcut here, not /{user-id}. Fetching by explicit
  // user id requires Threads' Profile Discovery permission set, which
  // we don't request (and it requires App Review). /me works with just
  // threads_basic. The numeric user id is already known from the token
  // exchange response, so we don't NEED to re-derive it from the
  // profile call — but we still pull `id` from the response as a
  // sanity check that the token belongs to the user we think it does.
  const fields = ['id', 'username', 'name', 'threads_profile_picture_url'].join(',');
  const params = new URLSearchParams({
    fields,
    access_token: args.accessToken,
  });
  const resp = await fetch(`${THREADS_GRAPH_BASE}/me?${params}`, {
    method: 'GET',
  });
  const data = (await resp.json()) as {
    id?: string;
    username?: string;
    name?: string;
    threads_profile_picture_url?: string;
    error?: { message?: string };
  };
  if (!resp.ok || data.error || !data.id) {
    throw new Error(
      data.error?.message ?? `Threads profile fetch failed (${resp.status})`
    );
  }
  // Sanity: token belongs to a different user than we expected.
  // Treat as soft error — log + continue with the id from the response.
  // Skip the check when the caller passed an empty expected id (callers
  // use that when they just want /me's authoritative id, not a check).
  if (args.threadsUserId && data.id !== args.threadsUserId) {
    console.warn(
      `[threads] Profile id mismatch: caller expected ${args.threadsUserId}, ` +
        `/me returned ${data.id}. Using /me value.`
    );
  }
  return {
    id: data.id,
    username: data.username ?? '',
    name: data.name ?? data.username ?? '',
    pictureUrl: data.threads_profile_picture_url ?? null,
  };
}

// =====================================================================
// Persistence — upsert into organic_connected_accounts
// =====================================================================

/** Insert (or revive a soft-deleted) Threads connection for this user. */
export async function upsertThreadsConnection(args: {
  userId: string;
  threadsUserId: string;
  accessToken: string;
  expiresAt: Date;
  profile: ThreadsProfile;
  scopes: string[];
}): Promise<{ id: string }> {
  const encrypted = encryptSecret(args.accessToken);
  const meta = {
    username: args.profile.username,
    name: args.profile.name,
    picture_url: args.profile.pictureUrl,
  };

  // If there's an existing (active or soft-deleted) row for this
  // user+platform+external_id, update it in place. Otherwise insert.
  const { rows } = await query<{ id: string }>(
    `INSERT INTO organic_connected_accounts
       (user_id, platform, external_id, access_token_encrypted,
        token_expires_at, scopes, meta, disconnected_at)
     VALUES ($1, 'threads', $2, $3, $4, $5, $6, NULL)
     ON CONFLICT (user_id, platform, external_id)
       WHERE disconnected_at IS NULL
     DO UPDATE SET
       access_token_encrypted = EXCLUDED.access_token_encrypted,
       token_expires_at = EXCLUDED.token_expires_at,
       scopes = EXCLUDED.scopes,
       meta = EXCLUDED.meta,
       updated_at = NOW()
     RETURNING id`,
    [args.userId, args.threadsUserId, encrypted, args.expiresAt, args.scopes, meta]
  );

  if (rows.length > 0) return { id: rows[0].id };

  // ON CONFLICT didn't match because the existing row is soft-deleted
  // (disconnected_at IS NOT NULL). Revive it by updating the disconnected row.
  const { rows: revived } = await query<{ id: string }>(
    `UPDATE organic_connected_accounts
        SET access_token_encrypted = $3,
            token_expires_at = $4,
            scopes = $5,
            meta = $6,
            disconnected_at = NULL,
            updated_at = NOW()
      WHERE user_id = $1 AND platform = 'threads' AND external_id = $2
      RETURNING id`,
    [args.userId, args.threadsUserId, encrypted, args.expiresAt, args.scopes, meta]
  );
  if (revived.length === 0) {
    throw new Error('Failed to persist Threads connection (upsert mismatch)');
  }
  return { id: revived[0].id };
}

// =====================================================================
// Auto-link: discover a Threads account from an existing IG connection
// =====================================================================

/**
 * Some IG Business accounts have a linked Threads profile. The IG token
 * (from our existing IG OAuth) can read it via /me?fields=threads_user_id.
 *
 * Returns the Threads user id (string) when linkable, or null when:
 *   - the IG account doesn't have a Threads profile
 *   - the IG token doesn't have the right scopes
 *   - the field isn't present in the response
 *
 * Note: this gives us the threads user id, but NOT a Threads-scoped
 * access token. The user still has to grant Threads scopes via OAuth
 * for us to publish. We surface this discovery as a "quick connect"
 * affordance in the UI — clicking it pre-fills the OAuth flow with
 * a hint about which Threads account we expect.
 */
export async function discoverLinkedThreadsUserId(
  igAccessToken: string
): Promise<string | null> {
  // The threads_user_id field on IG /me is documented but inconsistently
  // available. We probe it gently — any error means "not linkable".
  try {
    const params = new URLSearchParams({
      fields: 'threads_user_id',
      access_token: igAccessToken,
    });
    const resp = await fetch(
      `https://graph.facebook.com/v25.0/me?${params}`,
      { method: 'GET' }
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { threads_user_id?: string | number };
    return data.threads_user_id ? String(data.threads_user_id) : null;
  } catch {
    return null;
  }
}

// Re-export creds getter for routes
export { getThreadsAppCredentials } from './threads-credentials';
