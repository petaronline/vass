/**
 * LinkedIn OAuth (OAuth 2.0 authorization code) + token lifecycle +
 * identity / organization enumeration.
 *
 * Flow:
 *   1. Authorize: https://www.linkedin.com/oauth/v2/authorization?
 *        response_type=code&client_id=…&redirect_uri=…&state=…
 *        &scope=<space-separated>
 *      Scopes are SPACE-separated (unlike TikTok's commas).
 *   2. Exchange code: POST https://www.linkedin.com/oauth/v2/accessToken
 *        grant_type=authorization_code → access_token (~60d),
 *        refresh_token (~365d), expires_in, refresh_token_expires_in.
 *   3. Refresh: POST same endpoint, grant_type=refresh_token.
 *
 * Identity:
 *   - Member URN: GET https://api.linkedin.com/v2/userinfo (OpenID) →
 *     `sub` is the member id → author URN "urn:li:person:{sub}".
 *   - Org pages the member admins: GET /rest/organizationAcls?
 *     q=roleAssignee&role=ADMINISTRATOR (needs r_organization_social).
 *
 * NOTE (unverified-until-approval): exact token lifetimes, the
 * userinfo payload, and organizationAcls projection are per LinkedIn's
 * 2026 docs. These run for real only once the workspace's LinkedIn app
 * has Community Management approved. Marked spots may need adjusting
 * against the live app's actual responses.
 */

import { getLinkedInAppCredentials } from './linkedin-credentials';
import {
  getAccountWithToken,
  getRefreshToken,
  saveAccount,
  type OrganicAccountWithToken,
} from './organic-connection';
import { query } from '../db/pool';

const LINKEDIN_AUTHORIZE_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const LINKEDIN_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const LINKEDIN_USERINFO_URL = 'https://api.linkedin.com/v2/userinfo';
const LINKEDIN_ORG_ACLS_URL = 'https://api.linkedin.com/rest/organizationAcls';
const LINKEDIN_ORG_LOOKUP_URL = 'https://api.linkedin.com/rest/organizations';

/** Versioned-API header value (YYYYMM). LinkedIn requires this on
 *  /rest/* calls. Bump as LinkedIn sunsets old versions. */
export const LINKEDIN_VERSION = '202504';

/**
 * Profile-app scopes (App A: Share on LinkedIn + Sign In):
 *   - openid, profile  : identity (member URN via /v2/userinfo)
 *   - w_member_social  : post on behalf of the member (personal profile)
 */
export const LINKEDIN_PROFILE_SCOPES = ['openid', 'profile', 'w_member_social'];

/**
 * Org-app scopes (App B: Community Management API only):
 *   - w_organization_social : post on behalf of an org (company pages)
 *   - r_organization_social : enumerate the org pages the member admins
 * Note: the Community Management app cannot also carry openid/profile, so
 * we identify the member via organizationAcls rather than /v2/userinfo.
 */
export const LINKEDIN_ORG_SCOPES = ['w_organization_social', 'r_organization_social'];

/** @deprecated kept for any external references; profile scopes by default. */
export const LINKEDIN_SCOPES = LINKEDIN_PROFILE_SCOPES;

/** Build the authorize URL the user is redirected to. */
export function buildLinkedInOAuthUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: string[];
}): string {
  const scopes = args.scopes ?? LINKEDIN_PROFILE_SCOPES;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    state: args.state,
    scope: scopes.join(' '),
  });
  return `${LINKEDIN_AUTHORIZE_URL}?${params.toString()}`;
}

interface LinkedInTokenResponse {
  access_token: string;
  expires_in: number; // seconds (~5184000 = 60d)
  refresh_token?: string;
  refresh_token_expires_in?: number; // seconds (~31536000 = 365d)
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

async function postToken(body: Record<string, string>): Promise<LinkedInTokenResponse> {
  const res = await fetch(LINKEDIN_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const data = (await res.json()) as LinkedInTokenResponse;
  if (!res.ok || data.error) {
    throw new Error(
      `LinkedIn token request failed: ${data.error ?? res.status} — ${data.error_description ?? ''}`
    );
  }
  return data;
}

export interface LinkedInIdentity {
  /** Member id (the `sub` from /v2/userinfo). */
  memberId: string;
  name: string | null;
  pictureUrl: string | null;
}

/** Fetch the authenticated member's identity via OpenID userinfo. */
export async function fetchLinkedInIdentity(accessToken: string): Promise<LinkedInIdentity> {
  const res = await fetch(LINKEDIN_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = (await res.json()) as {
    sub?: string;
    name?: string;
    picture?: string;
    error?: string;
  };
  if (!res.ok || data.error || !data.sub) {
    throw new Error(`LinkedIn userinfo failed: ${data.error ?? res.status}`);
  }
  return {
    memberId: data.sub,
    name: data.name ?? null,
    pictureUrl: data.picture ?? null,
  };
}

export interface LinkedInOrg {
  /** Organization id (numeric, as string). Author URN is urn:li:organization:{id}. */
  orgId: string;
  name: string | null;
  logoUrl: string | null;
}

/**
 * Enumerate the organizations the member is an ADMINISTRATOR of.
 * Requires r_organization_social. Returns [] when the member admins no
 * pages (or the scope wasn't granted). Best-effort: org name/logo are
 * fetched in a follow-up lookup and degrade to null on failure.
 */
export async function fetchAdminedOrganizations(accessToken: string): Promise<LinkedInOrg[]> {
  const url = `${LINKEDIN_ORG_ACLS_URL}?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'LinkedIn-Version': LINKEDIN_VERSION,
      'X-Restli-Protocol-Version': '2.0.0',
    },
  });
  if (!res.ok) {
    // Scope may not be granted, or no orgs — treat as "no org pages".
    return [];
  }
  const data = (await res.json()) as {
    elements?: { organization?: string }[];
  };
  const orgUrns = (data.elements ?? [])
    .map((e) => e.organization)
    .filter((u): u is string => !!u);

  const orgs: LinkedInOrg[] = [];
  for (const urn of orgUrns) {
    // urn looks like "urn:li:organization:12345"
    const orgId = urn.split(':').pop() ?? '';
    if (!orgId) continue;
    let name: string | null = null;
    let logoUrl: string | null = null;
    try {
      const lookup = await fetch(`${LINKEDIN_ORG_LOOKUP_URL}/${orgId}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'LinkedIn-Version': LINKEDIN_VERSION,
          'X-Restli-Protocol-Version': '2.0.0',
        },
      });
      if (lookup.ok) {
        const od = (await lookup.json()) as { localizedName?: string };
        name = od.localizedName ?? null;
      }
    } catch {
      /* degrade to null */
    }
    orgs.push({ orgId, name, logoUrl });
  }
  return orgs;
}

/**
 * Exchange the authorization code for tokens and persist connection(s).
 *
 * Two app kinds (LinkedIn requires Community Management on its own app):
 *   - 'profile' (App A): identifies the member via /v2/userinfo and saves
 *     ONE person account ("person:{memberId}"). No org enumeration (the
 *     profile app lacks r_organization_social).
 *   - 'org' (App B): enumerates the company pages the member administers
 *     via organizationAcls and saves one account per page
 *     ("org:{orgId}"). No person row (this app can't post to a profile).
 *
 * Author URN + kind are stashed in meta so the publisher builds the right
 * `author` without re-deriving it. Returns one representative saved
 * account (the person for profile; the first page for org).
 */
export async function exchangeCodeAndSave(args: {
  userId: string;
  code: string;
  kind?: import('./linkedin-credentials').LinkedInAppKind;
}): Promise<OrganicAccountWithToken> {
  const kind = args.kind ?? 'profile';
  const creds = await getLinkedInAppCredentials(kind);
  if (!creds) throw new Error(`LinkedIn ${kind} app is not configured.`);

  const token = await postToken({
    grant_type: 'authorization_code',
    code: args.code,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    redirect_uri: creds.redirectUri,
  });

  const now = Date.now();
  const tokenExpiresAt = new Date(now + token.expires_in * 1000);
  const refreshExpiresAt = token.refresh_token_expires_in
    ? new Date(now + token.refresh_token_expires_in * 1000)
    : null;
  const defaultScopes = kind === 'org' ? LINKEDIN_ORG_SCOPES : LINKEDIN_PROFILE_SCOPES;
  const scopes = token.scope ? token.scope.split(/[\s,]+/).filter(Boolean) : defaultScopes;

  if (kind === 'profile') {
    const identity = await fetchLinkedInIdentity(token.access_token);
    await saveAccount({
      userId: args.userId,
      platform: 'linkedin',
      externalId: `person:${identity.memberId}`,
      accessToken: token.access_token,
      tokenExpiresAt,
      refreshToken: token.refresh_token,
      refreshTokenExpiresAt: refreshExpiresAt,
      scopes,
      meta: {
        kind: 'person',
        author_urn: `urn:li:person:${identity.memberId}`,
        name: identity.name,
        picture_url: identity.pictureUrl,
      },
    });
    const saved = await getAccountWithTokenByExternalId(
      args.userId,
      `person:${identity.memberId}`
    );
    if (!saved) throw new Error('Failed to persist LinkedIn profile connection.');
    return saved;
  }

  // kind === 'org': enumerate admined pages, save one row each.
  const orgs = await fetchAdminedOrganizations(token.access_token);
  if (orgs.length === 0) {
    throw new Error(
      'No LinkedIn company pages found for this account. You must be an ADMINISTRATOR of at least one page.'
    );
  }
  let firstExternalId: string | null = null;
  for (const org of orgs) {
    const externalId = `org:${org.orgId}`;
    if (!firstExternalId) firstExternalId = externalId;
    await saveAccount({
      userId: args.userId,
      platform: 'linkedin',
      externalId,
      accessToken: token.access_token,
      tokenExpiresAt,
      refreshToken: token.refresh_token,
      refreshTokenExpiresAt: refreshExpiresAt,
      scopes,
      meta: {
        kind: 'organization',
        author_urn: `urn:li:organization:${org.orgId}`,
        name: org.name,
        picture_url: org.logoUrl,
      },
    });
  }
  const saved = await getAccountWithTokenByExternalId(args.userId, firstExternalId!);
  if (!saved) throw new Error('Failed to persist LinkedIn page connection.');
  return saved;
}

async function getAccountWithTokenByExternalId(
  userId: string,
  externalId: string
): Promise<OrganicAccountWithToken | null> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM organic_connected_accounts
      WHERE user_id = $1 AND platform = 'linkedin' AND external_id = $2
        AND disconnected_at IS NULL LIMIT 1`,
    [userId, externalId]
  );
  if (!rows[0]) return null;
  return getAccountWithToken(userId, rows[0].id);
}

/**
 * Ensure the account has a non-expired access token, refreshing if
 * needed. Returns a valid access token. Throws if the refresh token is
 * missing/expired (caller should prompt re-auth).
 *
 * LinkedIn access tokens last ~60d, so refresh is rare — but we still
 * refresh within a 1-day skew to avoid publishing on a stale token.
 *
 * NOTE: refreshing rotates the token for THIS row only. Sibling rows
 * (other org pages from the same authorization) keep their stored
 * token until they're independently refreshed on their next publish.
 * That's fine — each refresh returns a fully valid token.
 */
export async function ensureFreshToken(userId: string, accountId: string): Promise<string> {
  const acct = await getAccountWithToken(userId, accountId);
  if (!acct) throw new Error('LinkedIn account not found.');

  const expiresAt = acct.tokenExpiresAt ? new Date(acct.tokenExpiresAt).getTime() : 0;
  const skewMs = 24 * 60 * 60 * 1000; // 1 day
  if (expiresAt - Date.now() > skewMs) {
    return acct.accessToken; // still fresh
  }

  const refresh = await getRefreshToken(userId, accountId);
  if (!refresh) {
    throw new Error('LinkedIn refresh token missing — the account must be reconnected.');
  }
  if (refresh.refreshExpiresAt && new Date(refresh.refreshExpiresAt).getTime() < Date.now()) {
    throw new Error('LinkedIn refresh token expired — the account must be reconnected.');
  }

  const creds = await getLinkedInAppCredentials();
  if (!creds) throw new Error('LinkedIn app is not configured.');

  const token = await postToken({
    grant_type: 'refresh_token',
    refresh_token: refresh.refreshToken,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });

  const now = Date.now();
  await saveAccount({
    userId,
    platform: 'linkedin',
    externalId: acct.externalId,
    accessToken: token.access_token,
    tokenExpiresAt: new Date(now + token.expires_in * 1000),
    refreshToken: token.refresh_token ?? refresh.refreshToken,
    refreshTokenExpiresAt: token.refresh_token_expires_in
      ? new Date(now + token.refresh_token_expires_in * 1000)
      : refresh.refreshExpiresAt,
    scopes: token.scope ? token.scope.split(/[\s,]+/).filter(Boolean) : acct.scopes,
    meta: acct.meta ?? {},
  });

  return token.access_token;
}
