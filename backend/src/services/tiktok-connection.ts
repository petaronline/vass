/**
 * TikTok OAuth (Login Kit) + token lifecycle.
 *
 * Flow (TikTok v2 OAuth):
 *   1. Authorize: https://www.tiktok.com/v2/auth/authorize/?client_key=…
 *        &scope=user.info.basic,video.publish,video.upload
 *        &response_type=code&redirect_uri=…&state=…
 *        Scopes are COMMA-separated.
 *   2. Exchange code: POST https://open.tiktokapis.com/v2/oauth/token/
 *        grant_type=authorization_code → returns access_token (~24h),
 *        refresh_token (~365d), open_id, scope, expires_in,
 *        refresh_expires_in.
 *   3. Refresh: POST same endpoint, grant_type=refresh_token.
 *
 * Unlike Threads/Meta, TikTok access tokens are short-lived (~24h), so
 * we MUST refresh before publishing. The refresh token lasts ~365d.
 *
 * Until the workspace's TikTok app passes TikTok's audit, posts are
 * forced to SELF_ONLY (private) visibility — that's a platform-side
 * restriction, not something we control here.
 */

import { getTikTokAppCredentials } from './tiktok-credentials';
import {
  getAccountWithToken,
  getRefreshToken,
  saveAccount,
  type OrganicAccountWithToken,
} from './organic-connection';

const TIKTOK_AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const TIKTOK_USERINFO_URL = 'https://open.tiktokapis.com/v2/user/info/';

/**
 * Scopes we request:
 *   - user.info.basic : open_id, display name, avatar (for the required
 *                       creator-info UX before posting)
 *   - video.publish   : Direct Post (publishes to the profile). Requires
 *                       audit; pre-audit posts are private-only.
 *   - video.upload    : Upload to inbox (creator finishes in-app).
 *                       Lighter approval; useful fallback.
 */
export const TIKTOK_SCOPES = ['user.info.basic', 'video.publish', 'video.upload'];

/** Build the authorize URL the user is redirected to. */
export function buildTikTokOAuthUrl(args: {
  clientKey: string;
  redirectUri: string;
  state: string;
  scopes?: string[];
}): string {
  const scopes = args.scopes ?? TIKTOK_SCOPES;
  const params = new URLSearchParams({
    client_key: args.clientKey,
    scope: scopes.join(','),
    response_type: 'code',
    redirect_uri: args.redirectUri,
    state: args.state,
  });
  return `${TIKTOK_AUTHORIZE_URL}?${params.toString()}`;
}

interface TikTokTokenResponse {
  access_token: string;
  expires_in: number; // seconds (~86400)
  open_id: string;
  refresh_token: string;
  refresh_expires_in: number; // seconds (~31536000)
  scope: string;
  token_type: string;
  error?: string;
  error_description?: string;
}

async function postToken(body: Record<string, string>): Promise<TikTokTokenResponse> {
  const res = await fetch(TIKTOK_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const data = (await res.json()) as TikTokTokenResponse;
  if (!res.ok || data.error) {
    throw new Error(
      `TikTok token request failed: ${data.error ?? res.status} — ${data.error_description ?? ''}`
    );
  }
  return data;
}

export interface TikTokCreatorInfo {
  openId: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

/** Fetch basic creator profile using a valid access token.
 *
 * `username` requires the `user.info.profile` scope. If we request it without
 * that scope, TikTok rejects the ENTIRE request, so we'd get no display name
 * or avatar either. Pass the granted scopes so we only ask for `username`
 * when it's actually allowed; otherwise we stick to the basic fields that
 * `user.info.basic` covers (open_id, avatar_url, display_name). */
export async function fetchTikTokCreatorInfo(
  accessToken: string,
  grantedScopes?: string[]
): Promise<TikTokCreatorInfo> {
  const canReadProfile = (grantedScopes ?? []).includes('user.info.profile');
  const fields = canReadProfile
    ? 'open_id,union_id,avatar_url,display_name,username'
    : 'open_id,union_id,avatar_url,display_name';
  const url = `${TIKTOK_USERINFO_URL}?fields=${fields}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = (await res.json()) as {
    data?: { user?: { open_id?: string; avatar_url?: string; display_name?: string; username?: string } };
    error?: { code?: string; message?: string };
  };
  if (!res.ok || (data.error && data.error.code && data.error.code !== 'ok')) {
    throw new Error(`TikTok user info failed: ${data.error?.message ?? res.status}`);
  }
  const u = data.data?.user ?? {};
  return {
    openId: u.open_id ?? '',
    username: u.username ?? null,
    displayName: u.display_name ?? null,
    avatarUrl: u.avatar_url ?? null,
  };
}

/**
 * Exchange the authorization code for tokens and persist a connection.
 * Returns the saved account.
 */
export async function exchangeCodeAndSave(args: {
  userId: string;
  code: string;
}): Promise<OrganicAccountWithToken> {
  const creds = await getTikTokAppCredentials();
  if (!creds) throw new Error('TikTok app is not configured.');

  const token = await postToken({
    client_key: creds.clientKey,
    client_secret: creds.clientSecret,
    code: args.code,
    grant_type: 'authorization_code',
    redirect_uri: creds.redirectUri,
  });

  const now = Date.now();
  const tokenExpiresAt = new Date(now + token.expires_in * 1000);
  const refreshExpiresAt = new Date(now + token.refresh_expires_in * 1000);

  // Pull creator profile for display metadata. Pass the granted scopes so
  // we don't request `username` (profile scope) when only basic was granted —
  // which would fail the whole call and lose the name + avatar too.
  const grantedScopes = token.scope ? token.scope.split(',') : TIKTOK_SCOPES;
  let creator: TikTokCreatorInfo;
  try {
    creator = await fetchTikTokCreatorInfo(token.access_token, grantedScopes);
  } catch {
    creator = { openId: token.open_id, username: null, displayName: null, avatarUrl: null };
  }

  await saveAccount({
    userId: args.userId,
    platform: 'tiktok',
    externalId: token.open_id,
    accessToken: token.access_token,
    tokenExpiresAt,
    refreshToken: token.refresh_token,
    refreshTokenExpiresAt: refreshExpiresAt,
    scopes: token.scope ? token.scope.split(',') : TIKTOK_SCOPES,
    meta: {
      username: creator.username,
      name: creator.displayName,
      picture_url: creator.avatarUrl,
    },
  });

  // Re-read with token for the caller.
  const saved = await getAccountWithTokenByOpenId(args.userId, token.open_id);
  if (!saved) throw new Error('Failed to persist TikTok connection.');
  return saved;
}

async function getAccountWithTokenByOpenId(
  userId: string,
  openId: string
): Promise<OrganicAccountWithToken | null> {
  // saveAccount returns the account; but to keep the token in hand we
  // re-fetch via the generic getter using the row id. Simpler: the
  // publisher always resolves a fresh token via ensureFreshToken below,
  // so we look up by (user, openId).
  const { query } = await import('../db/pool');
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM organic_connected_accounts
      WHERE user_id = $1 AND platform = 'tiktok' AND external_id = $2
        AND disconnected_at IS NULL LIMIT 1`,
    [userId, openId]
  );
  if (!rows[0]) return null;
  return getAccountWithToken(userId, rows[0].id);
}

/**
 * Ensure the account has a non-expired access token, refreshing if
 * needed. Returns a valid access token. Throws if the refresh token is
 * itself expired/missing (caller should prompt re-auth).
 *
 * We refresh when the access token expires within 5 minutes, to avoid
 * racing a publish against expiry.
 */
export async function ensureFreshToken(userId: string, accountId: string): Promise<string> {
  const acct = await getAccountWithToken(userId, accountId);
  if (!acct) throw new Error('TikTok account not found.');

  const expiresAt = acct.tokenExpiresAt ? new Date(acct.tokenExpiresAt).getTime() : 0;
  const skewMs = 5 * 60 * 1000;
  if (expiresAt - Date.now() > skewMs) {
    return acct.accessToken; // still fresh
  }

  // Refresh.
  const refresh = await getRefreshToken(userId, accountId);
  if (!refresh) {
    throw new Error('TikTok refresh token missing — the account must be reconnected.');
  }
  if (refresh.refreshExpiresAt && new Date(refresh.refreshExpiresAt).getTime() < Date.now()) {
    throw new Error('TikTok refresh token expired — the account must be reconnected.');
  }

  const creds = await getTikTokAppCredentials();
  if (!creds) throw new Error('TikTok app is not configured.');

  const token = await postToken({
    client_key: creds.clientKey,
    client_secret: creds.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refresh.refreshToken,
  });

  const now = Date.now();
  await saveAccount({
    userId,
    platform: 'tiktok',
    externalId: token.open_id,
    accessToken: token.access_token,
    tokenExpiresAt: new Date(now + token.expires_in * 1000),
    refreshToken: token.refresh_token,
    refreshTokenExpiresAt: new Date(now + token.refresh_expires_in * 1000),
    scopes: token.scope ? token.scope.split(',') : TIKTOK_SCOPES,
    // Preserve existing display meta — refresh doesn't return profile.
    meta: acct.meta ?? {},
  });

  return token.access_token;
}
