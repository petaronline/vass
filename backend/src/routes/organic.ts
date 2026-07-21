/**
 * Organic publishing routes — connected accounts management.
 *
 * Patch 4.22 scope: OAuth connect/disconnect for FB Pages, Instagram,
 * and Threads. Publishing routes come in 4.23+.
 *
 * OAuth model:
 *   FB Pages + Instagram + Threads all flow through the workspace Meta App
 *   (same App ID/Secret as ads). We request additional scopes:
 *     - pages_manage_posts, pages_read_engagement  (FB Pages)
 *     - instagram_basic, instagram_content_publish (Instagram)
 *     - threads_basic, threads_content_publish      (Threads)
 *
 *   After the callback, we:
 *     1. Fetch the user token (same as ads OAuth).
 *     2. For FB Pages: call /{user-id}/accounts to list Pages, get
 *        per-page tokens, store each page as its own connected account.
 *     3. For Instagram: call the IG Graph API to get the IG Business
 *        Account linked to the user's FB Pages.
 *     4. For Threads: Threads uses its own separate OAuth endpoint
 *        (threads.net). Implemented in patch 4.25.
 *
 * Endpoints:
 *   GET  /organic/accounts                  → list my connected accounts
 *   GET  /organic/accounts/oauth-url        → get OAuth URL for a platform
 *   GET  /organic/accounts/callback         → OAuth callback (all platforms)
 *   DELETE /organic/accounts/:id            → disconnect an account
 */
import { Router, Request, Response } from 'express';
import crypto from 'node:crypto';
import { requireAuth } from '../middleware/auth';
import * as organicConn from '../services/organic-connection';
import * as metaConn from '../services/meta-connection';
import * as metaApi from '../services/meta';
import * as threadsConn from '../services/threads-connection';
import * as tiktokConn from '../services/tiktok-connection';
import * as tiktokCredentials from '../services/tiktok-credentials';
import * as linkedinConn from '../services/linkedin-connection';
import * as linkedinCredentials from '../services/linkedin-credentials';
import { audit } from '../services/audit';
import { query } from '../db/pool';
import { fetchInsightsForTarget } from '../services/organic-insights';
import * as metaSync from '../services/meta-sync';
import { env } from '../utils/env';

export const organicRouter = Router();

const GRAPH_API_VERSION = 'v25.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/**
 * Scopes needed for organic publishing beyond the base ads scopes.
 * We request all at once so users only need to OAuth once for both
 * ads and organic publishing.
 */
const ORGANIC_SCOPES_FB_PAGE = [
  ...metaApi.REQUIRED_SCOPES,
  'pages_manage_posts',
  'pages_read_engagement',
  'pages_manage_engagement', // posting comments on owned pages (Patch 4.31 first-comment)
  'pages_read_user_content',  // POST /{video-id}/thumbnails for custom Reel covers (Patch 4.33)
  'pages_show_list',
];

const ORGANIC_SCOPES_INSTAGRAM = [
  ...metaApi.REQUIRED_SCOPES,
  'pages_manage_posts',
  'pages_read_engagement',
  'pages_manage_engagement', // needed for IG → FB Page proxied comment posting
  'pages_read_user_content',  // (FB cover thumbnail consistency — IG accounts pivot through FB)
  'pages_show_list',
  'instagram_basic',
  'instagram_content_publish',
  'instagram_manage_comments', // first-comment posting on IG media (Patch 4.31)
  'instagram_manage_insights', // organic analytics — IG media insights (Patch 4.57)
  'instagram_manage_insights',
];

function getCallbackUri(): string {
  return `${env.FRONTEND_URL}/api/organic/accounts/callback`;
}

// -----------------------------------------------------------------------
// GET /organic/accounts
// -----------------------------------------------------------------------
organicRouter.get('/accounts', requireAuth, async (req: Request, res: Response) => {
  const accounts = await organicConn.listAccounts(req.user!.id);
  res.json({ accounts });
});

// -----------------------------------------------------------------------
// GET /organic/accounts/oauth-url?platform=facebook_page|instagram
// -----------------------------------------------------------------------
organicRouter.get('/accounts/oauth-url', requireAuth, async (req: Request, res: Response) => {
  const platform = req.query.platform as string;
  if (!['facebook_page', 'instagram'].includes(platform)) {
    return res.status(400).json({
      error: 'platform must be facebook_page or instagram. Threads OAuth comes in a later patch.',
    });
  }

  const creds = await metaConn.getAppCredentials();
  if (!creds) {
    return res.status(400).json({
      error: 'Workspace Meta App is not configured. Ask an admin to set it up in Settings → Meta.',
    });
  }

  const state = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO oauth_states (state, user_id, platform) VALUES ($1, $2, $3)`,
    [state, req.user!.id, platform]
  );

  const scopes =
    platform === 'instagram' ? ORGANIC_SCOPES_INSTAGRAM : ORGANIC_SCOPES_FB_PAGE;

  const url = metaApi.buildOAuthUrl({
    appId: creds.appId,
    redirectUri: getCallbackUri(),
    state,
    scopes,
    // Force the FB permissions dialog to re-show — including the Page
    // picker — so users can grant access to additional Pages they didn't
    // select last time. Without this, Facebook silently reuses the
    // existing grant and re-connects only the previously-selected Pages.
    reauthorize: true,
  });

  res.json({ url });
});

// -----------------------------------------------------------------------
// GET /organic/accounts/callback
// Handles both facebook_page and instagram flows.
// -----------------------------------------------------------------------
organicRouter.get('/accounts/callback', requireAuth, async (req: Request, res: Response) => {
  const code = typeof req.query.code === 'string' ? req.query.code : null;
  const state = typeof req.query.state === 'string' ? req.query.state : null;
  const error = typeof req.query.error === 'string' ? req.query.error : null;
  const errorDesc =
    typeof req.query.error_description === 'string' ? req.query.error_description : null;

  const redirectBack = (status: 'success' | 'error', message?: string) => {
    const url = new URL(`${env.FRONTEND_URL}/settings/social-profiles`);
    url.searchParams.set('oauth_status', status);
    if (message) url.searchParams.set('oauth_message', message);
    res.redirect(url.toString());
  };

  if (error) return redirectBack('error', errorDesc || error);
  if (!code || !state) return redirectBack('error', 'Missing code or state');

  // Validate state
  const { rows: stateRows } = await query<{
    user_id: string;
    expires_at: Date;
    platform: string;
  }>(`SELECT user_id, expires_at, platform FROM oauth_states WHERE state = $1 LIMIT 1`, [state]);

  if (stateRows.length === 0) return redirectBack('error', 'Invalid or expired state token');
  const stateRow = stateRows[0];
  if (stateRow.expires_at.getTime() < Date.now()) {
    return redirectBack('error', 'State token expired — please try again');
  }
  if (stateRow.user_id !== req.user!.id) {
    return redirectBack('error', 'State token belongs to a different user');
  }
  await query('DELETE FROM oauth_states WHERE state = $1', [state]);

  const platform = stateRow.platform as organicConn.OrganicPlatform;

  const creds = await metaConn.getAppCredentials();
  if (!creds) return redirectBack('error', 'Workspace Meta App credentials missing');

  try {
    // Exchange code → short token → long token (same pattern as ads OAuth)
    const short = await metaApi.exchangeCodeForToken({
      appId: creds.appId,
      appSecret: creds.appSecret,
      redirectUri: getCallbackUri(),
      code,
    });

    const long = await metaApi.exchangeForLongLivedToken({
      appId: creds.appId,
      appSecret: creds.appSecret,
      shortLivedToken: short.accessToken,
    });

    const expiresAt = new Date(Date.now() + long.expiresIn * 1000);
    const me = await metaApi.fetchMe(long.accessToken);

    if (platform === 'facebook_page') {
      // Fetch all FB Pages this user manages, get per-page tokens.
      const pagesResp = await fetch(
        `${GRAPH_BASE}/${me.id}/accounts?fields=id,name,picture.type(large){url,is_silhouette},category,fan_count,access_token&limit=50`,
        { headers: { Authorization: `Bearer ${long.accessToken}` } }
      );
      if (!pagesResp.ok) {
        throw new Error(`Failed to fetch FB Pages: ${pagesResp.status}`);
      }
      const pagesData = (await pagesResp.json()) as {
        data: Array<{
          id: string;
          name: string;
          access_token: string;
          category?: string;
          fan_count?: number;
          picture?: { data?: { url: string; is_silhouette?: boolean } };
        }>;
      };

      if (!pagesData.data || pagesData.data.length === 0) {
        return redirectBack('error', 'No Facebook Pages found. Make sure you manage at least one Page.');
      }

      let savedCount = 0;
      for (const page of pagesData.data) {
        // Store the STABLE redirect endpoint, not page.picture.data.url — the
        // signed CDN url expires ("URL signature expired"). /{id}/picture
        // 302-redirects to the current image on every request.
        const picUrl =
          page.picture?.data && !page.picture.data.is_silhouette
            ? `https://graph.facebook.com/${page.id}/picture?type=large`
            : null;

        await organicConn.saveAccount({
          userId: req.user!.id,
          platform: 'facebook_page',
          externalId: page.id,
          accessToken: page.access_token,
          tokenExpiresAt: null, // Page tokens from user token are long-lived
          parentUserToken: long.accessToken,
          scopes: ORGANIC_SCOPES_FB_PAGE,
          meta: {
            name: page.name,
            picture_url: picUrl,
            category: page.category ?? null,
            followers_count: page.fan_count ?? null,
          },
        });
        savedCount++;
      }

      await audit({
        userId: req.user!.id,
        action: 'organic.facebook_page.connected',
        metadata: { pages_count: savedCount, meta_user_id: me.id },
        ipAddress: req.ip,
      });

      return redirectBack(
        'success',
        `Connected ${savedCount} Facebook Page${savedCount === 1 ? '' : 's'}`
      );
    }

    if (platform === 'instagram') {
      // Get FB Pages, then for each find linked IG Business Account.
      const pagesResp = await fetch(
        `${GRAPH_BASE}/${me.id}/accounts?fields=id,name,access_token,instagram_business_account{id,name,username,profile_picture_url,followers_count}&limit=50`,
        { headers: { Authorization: `Bearer ${long.accessToken}` } }
      );
      if (!pagesResp.ok) {
        throw new Error(`Failed to fetch Pages for IG lookup: ${pagesResp.status}`);
      }
      const pagesData = (await pagesResp.json()) as {
        data: Array<{
          id: string;
          name: string;
          access_token: string;
          instagram_business_account?: {
            id: string;
            name?: string;
            username?: string;
            profile_picture_url?: string;
            followers_count?: number;
          };
        }>;
      };

      const igAccounts = pagesData.data.filter((p) => p.instagram_business_account);

      if (igAccounts.length === 0) {
        return redirectBack(
          'error',
          'No Instagram Business accounts found. Make sure your Instagram account is linked to a Facebook Page.'
        );
      }

      let savedCount = 0;
      for (const page of igAccounts) {
        const ig = page.instagram_business_account!;
        await organicConn.saveAccount({
          userId: req.user!.id,
          platform: 'instagram',
          externalId: ig.id,
          accessToken: page.access_token, // Page token gives IG access
          tokenExpiresAt: expiresAt,
          parentUserToken: long.accessToken,
          scopes: ORGANIC_SCOPES_INSTAGRAM,
          meta: {
            username: ig.username ?? null,
            name: ig.name ?? null,
            picture_url: ig.profile_picture_url ?? null,
            followers_count: ig.followers_count ?? null,
            linked_page_id: page.id,
            linked_page_name: page.name,
          },
        });
        savedCount++;
      }

      await audit({
        userId: req.user!.id,
        action: 'organic.instagram.connected',
        metadata: { accounts_count: savedCount, meta_user_id: me.id },
        ipAddress: req.ip,
      });

      return redirectBack(
        'success',
        `Connected ${savedCount} Instagram account${savedCount === 1 ? '' : 's'}`
      );
    }

    return redirectBack('error', `Unsupported platform: ${platform}`);
  } catch (err) {
    console.error('[organic/callback] OAuth failed:', err);
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return redirectBack('error', msg);
  }
});

// -----------------------------------------------------------------------
// DELETE /organic/accounts/:id
// -----------------------------------------------------------------------
organicRouter.delete('/accounts/:id', requireAuth, async (req: Request, res: Response) => {
  const accountId = String(req.params.id);
  const ok = await organicConn.disconnectAccount(req.user!.id, accountId);
  if (!ok) {
    return res.status(404).json({ error: 'Account not found or already disconnected' });
  }
  await audit({
    userId: req.user!.id,
    action: 'organic.account.disconnected',
    metadata: { account_id: accountId },
    ipAddress: req.ip,
  });
  res.json({ ok: true });
});

// =====================================================================
// Threads OAuth (Patch 4.34)
// =====================================================================
//
// Threads uses its own Meta App (different App ID + Secret than FB/IG)
// and its own host (threads.net for authorize, graph.threads.net for
// everything else). The admin configures the creds in
// Settings → Workspace API Keys → Threads.
//
// Endpoints:
//   GET /organic/threads/oauth-url        → returns the Threads OAuth URL
//   GET /organic/threads/callback         → handles the OAuth callback
//   GET /organic/threads/auto-link/:id    → for an existing IG account id,
//                                            tries to discover a linked
//                                            Threads profile via IG's
//                                            /me?fields=threads_user_id

organicRouter.get('/threads/oauth-url', requireAuth, async (req: Request, res: Response) => {
  const creds = await threadsConn.getThreadsAppCredentials();
  if (!creds) {
    return res.status(400).json({
      error:
        'Threads App is not configured. Ask an admin to set the App ID + Secret in Settings → Workspace API Keys → Threads.',
    });
  }

  const state = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO oauth_states (state, user_id, platform) VALUES ($1, $2, 'threads')`,
    [state, req.user!.id]
  );

  const url = threadsConn.buildThreadsOAuthUrl({
    appId: creds.appId,
    redirectUri: creds.redirectUri,
    state,
  });
  res.json({ url });
});

organicRouter.get('/threads/callback', requireAuth, async (req: Request, res: Response) => {
  const code = typeof req.query.code === 'string' ? req.query.code : null;
  const state = typeof req.query.state === 'string' ? req.query.state : null;
  const errorParam = typeof req.query.error === 'string' ? req.query.error : null;

  // Meta may redirect with ?error=access_denied when the user clicks
  // "Cancel" on the consent screen. Surface a friendly bounce.
  if (errorParam) {
    return res.redirect(
      `${env.FRONTEND_URL}/settings/social-profiles?threads_oauth_error=${encodeURIComponent(errorParam)}`
    );
  }
  if (!code || !state) {
    return res.status(400).send('Missing code or state');
  }

  // Validate state — same logic as the FB/IG callback.
  const { rows: stateRows } = await query<{
    user_id: string;
    expires_at: Date;
    platform: string;
  }>(
    `SELECT user_id, expires_at, platform FROM oauth_states WHERE state = $1 LIMIT 1`,
    [state]
  );
  if (stateRows.length === 0) {
    return res.status(400).send('Invalid state');
  }
  if (stateRows[0].user_id !== req.user!.id) {
    return res.status(403).send('State user mismatch');
  }
  if (stateRows[0].platform !== 'threads') {
    return res.status(400).send('State platform mismatch');
  }
  if (stateRows[0].expires_at < new Date()) {
    return res.status(400).send('State expired');
  }
  await query('DELETE FROM oauth_states WHERE state = $1', [state]);

  const creds = await threadsConn.getThreadsAppCredentials();
  if (!creds) {
    return res.status(400).send('Threads App is no longer configured');
  }

  try {
    // Exchange code → long-lived token. The token-exchange response
    // returns a `user_id` but we don't trust it for storage — it can be
    // an app-scoped id that doesn't work with read-by-id endpoints. We
    // call /me to get the canonical Threads user id and use THAT
    // throughout.
    const { accessToken, expiresAt } =
      await threadsConn.exchangeCodeForLongLivedToken({ creds, code });
    const profile = await threadsConn.fetchThreadsProfile({
      // threadsUserId here is just a sanity-check value; fetchThreadsProfile
      // uses /me (not /{id}) so the value isn't actually used to address.
      threadsUserId: '',
      accessToken,
    });
    await threadsConn.upsertThreadsConnection({
      userId: req.user!.id,
      threadsUserId: profile.id, // authoritative id from /me
      accessToken,
      expiresAt,
      profile,
      scopes: threadsConn.THREADS_SCOPES,
    });
    await audit({
      userId: req.user!.id,
      action: 'organic.account.connected',
      metadata: { platform: 'threads', username: profile.username },
      ipAddress: req.ip,
    });
    res.redirect(`${env.FRONTEND_URL}/settings/social-profiles?threads_connected=1`);
  } catch (err) {
    console.error('[organic/threads/callback] OAuth failed:', err);
    const msg = err instanceof Error ? err.message : 'OAuth failed';
    res.redirect(
      `${env.FRONTEND_URL}/settings/social-profiles?threads_oauth_error=${encodeURIComponent(msg)}`
    );
  }
});

// =====================================================================
// TikTok OAuth (Patch 4.43.0)
//   GET /organic/tiktok/oauth-url   → returns the TikTok Login Kit URL
//   GET /organic/tiktok/callback    → exchanges code, saves connection
// =====================================================================

organicRouter.get('/tiktok/oauth-url', requireAuth, async (req: Request, res: Response) => {
  const tiktokCreds = await tiktokCredentials.getTikTokAppCredentials();
  if (!tiktokCreds) {
    return res.status(400).json({
      error:
        'TikTok app is not configured. Ask an admin to set the Client Key + Secret in Settings → Workspace API Keys → TikTok.',
    });
  }

  const state = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO oauth_states (state, user_id, platform) VALUES ($1, $2, 'tiktok')`,
    [state, req.user!.id]
  );

  const url = tiktokConn.buildTikTokOAuthUrl({
    clientKey: tiktokCreds.clientKey,
    redirectUri: tiktokCreds.redirectUri,
    state,
  });
  res.json({ url });
});

organicRouter.get('/tiktok/callback', requireAuth, async (req: Request, res: Response) => {
  const code = typeof req.query.code === 'string' ? req.query.code : null;
  const state = typeof req.query.state === 'string' ? req.query.state : null;
  const errorParam = typeof req.query.error === 'string' ? req.query.error : null;

  if (errorParam) {
    return res.redirect(
      `${env.FRONTEND_URL}/settings/social-profiles?tiktok_oauth_error=${encodeURIComponent(errorParam)}`
    );
  }
  if (!code || !state) {
    return res.status(400).send('Missing code or state');
  }

  const { rows: stateRows } = await query<{
    user_id: string;
    expires_at: Date;
    platform: string;
  }>(
    `SELECT user_id, expires_at, platform FROM oauth_states WHERE state = $1 LIMIT 1`,
    [state]
  );
  if (stateRows.length === 0) return res.status(400).send('Invalid state');
  if (stateRows[0].user_id !== req.user!.id) return res.status(403).send('State user mismatch');
  if (stateRows[0].platform !== 'tiktok') return res.status(400).send('State platform mismatch');
  if (stateRows[0].expires_at < new Date()) return res.status(400).send('State expired');
  await query('DELETE FROM oauth_states WHERE state = $1', [state]);

  try {
    const saved = await tiktokConn.exchangeCodeAndSave({ userId: req.user!.id, code });
    await audit({
      userId: req.user!.id,
      action: 'organic.account.connected',
      metadata: { platform: 'tiktok', username: (saved.meta as { username?: string }).username ?? null },
      ipAddress: req.ip,
    });
    res.redirect(`${env.FRONTEND_URL}/settings/social-profiles?tiktok_connected=1`);
  } catch (err) {
    console.error('[organic/tiktok/callback] OAuth failed:', err);
    const msg = err instanceof Error ? err.message : 'OAuth failed';
    res.redirect(
      `${env.FRONTEND_URL}/settings/social-profiles?tiktok_oauth_error=${encodeURIComponent(msg)}`
    );
  }
});

/**
 * Creator info for a connected TikTok account — used by the composer to
 * satisfy TikTok's mandatory pre-post UX (show creator name/avatar +
 * the privacy levels TikTok allows for this creator). Refreshes the
 * token if needed.
 */
organicRouter.get('/tiktok/creator-info/:accountId', requireAuth, async (req: Request, res: Response) => {
  const accountId = String(req.params.accountId);
  const account = await organicConn.getAccount(req.user!.id, accountId);
  if (!account || account.platform !== 'tiktok') {
    return res.status(404).json({ error: 'TikTok account not found' });
  }
  try {
    const { queryCreatorInfo } = await import('../services/tiktok-publisher');
    const info = await queryCreatorInfo(req.user!.id, accountId);
    res.json(info);
  } catch (err) {
    console.error('[organic/tiktok/creator-info] failed:', err);
    res.status(502).json({
      error: err instanceof Error ? err.message : 'Failed to fetch TikTok creator info',
    });
  }
});

// =====================================================================
// LinkedIn OAuth (Patch 4.45.0)
//   GET /organic/linkedin/oauth-url   → returns the LinkedIn auth URL
//   GET /organic/linkedin/callback    → exchanges code, saves connection(s)
//
// A single LinkedIn authorization can back multiple Vass accounts: the
// member's personal profile plus one row per company page they admin.
// exchangeCodeAndSave handles fanning those out.
// =====================================================================

organicRouter.get('/linkedin/oauth-url', requireAuth, async (req: Request, res: Response) => {
  const liCreds = await linkedinCredentials.getLinkedInAppCredentials();
  if (!liCreds) {
    return res.status(400).json({
      error:
        'LinkedIn app is not configured. Ask an admin to set the Client ID + Secret in Settings → Workspace API Keys → LinkedIn.',
    });
  }

  const state = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO oauth_states (state, user_id, platform) VALUES ($1, $2, 'linkedin')`,
    [state, req.user!.id]
  );

  const url = linkedinConn.buildLinkedInOAuthUrl({
    clientId: liCreds.clientId,
    redirectUri: liCreds.redirectUri,
    state,
  });
  res.json({ url });
});

organicRouter.get('/linkedin/callback', requireAuth, async (req: Request, res: Response) => {
  const code = typeof req.query.code === 'string' ? req.query.code : null;
  const state = typeof req.query.state === 'string' ? req.query.state : null;
  const errorParam = typeof req.query.error === 'string' ? req.query.error : null;

  if (errorParam) {
    return res.redirect(
      `${env.FRONTEND_URL}/settings/social-profiles?linkedin_oauth_error=${encodeURIComponent(errorParam)}`
    );
  }
  if (!code || !state) {
    return res.status(400).send('Missing code or state');
  }

  const { rows: stateRows } = await query<{
    user_id: string;
    expires_at: Date;
    platform: string;
  }>(
    `SELECT user_id, expires_at, platform FROM oauth_states WHERE state = $1 LIMIT 1`,
    [state]
  );
  if (stateRows.length === 0) return res.status(400).send('Invalid state');
  if (stateRows[0].user_id !== req.user!.id) return res.status(403).send('State user mismatch');
  if (stateRows[0].platform !== 'linkedin') return res.status(400).send('State platform mismatch');
  if (stateRows[0].expires_at < new Date()) return res.status(400).send('State expired');
  await query('DELETE FROM oauth_states WHERE state = $1', [state]);

  try {
    const saved = await linkedinConn.exchangeCodeAndSave({ userId: req.user!.id, code });
    await audit({
      userId: req.user!.id,
      action: 'organic.account.connected',
      metadata: { platform: 'linkedin', name: (saved.meta as { name?: string }).name ?? null },
      ipAddress: req.ip,
    });
    res.redirect(`${env.FRONTEND_URL}/settings/social-profiles?linkedin_connected=1`);
  } catch (err) {
    console.error('[organic/linkedin/callback] OAuth failed:', err);
    const msg = err instanceof Error ? err.message : 'OAuth failed';
    res.redirect(
      `${env.FRONTEND_URL}/settings/social-profiles?linkedin_oauth_error=${encodeURIComponent(msg)}`
    );
  }
});

// =====================================================================
// LinkedIn ORG OAuth (Patch 4.46.0) — separate app for company pages.
// Community Management API must be the sole product on its own app, so
// pages use a second set of credentials (linkedin_org.*) + org scopes.
//   GET /organic/linkedin-org/oauth-url
//   GET /organic/linkedin-org/callback
// =====================================================================

organicRouter.get('/linkedin-org/oauth-url', requireAuth, async (req: Request, res: Response) => {
  const liCreds = await linkedinCredentials.getLinkedInAppCredentials('org');
  if (!liCreds) {
    return res.status(400).json({
      error:
        'LinkedIn Pages app is not configured. Ask an admin to set the Client ID + Secret for the Community Management app in Settings → Connections → LinkedIn (Pages).',
    });
  }

  const state = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO oauth_states (state, user_id, platform) VALUES ($1, $2, 'linkedin_org')`,
    [state, req.user!.id]
  );

  const url = linkedinConn.buildLinkedInOAuthUrl({
    clientId: liCreds.clientId,
    redirectUri: liCreds.redirectUri,
    state,
    scopes: linkedinConn.LINKEDIN_ORG_SCOPES,
  });
  res.json({ url });
});

organicRouter.get('/linkedin-org/callback', requireAuth, async (req: Request, res: Response) => {
  const code = typeof req.query.code === 'string' ? req.query.code : null;
  const state = typeof req.query.state === 'string' ? req.query.state : null;
  const errorParam = typeof req.query.error === 'string' ? req.query.error : null;

  if (errorParam) {
    return res.redirect(
      `${env.FRONTEND_URL}/settings/social-profiles?linkedin_oauth_error=${encodeURIComponent(errorParam)}`
    );
  }
  if (!code || !state) {
    return res.status(400).send('Missing code or state');
  }

  const { rows: stateRows } = await query<{
    user_id: string;
    expires_at: Date;
    platform: string;
  }>(
    `SELECT user_id, expires_at, platform FROM oauth_states WHERE state = $1 LIMIT 1`,
    [state]
  );
  if (stateRows.length === 0) return res.status(400).send('Invalid state');
  if (stateRows[0].user_id !== req.user!.id) return res.status(403).send('State user mismatch');
  if (stateRows[0].platform !== 'linkedin_org') return res.status(400).send('State platform mismatch');
  if (stateRows[0].expires_at < new Date()) return res.status(400).send('State expired');
  await query('DELETE FROM oauth_states WHERE state = $1', [state]);

  try {
    const saved = await linkedinConn.exchangeCodeAndSave({
      userId: req.user!.id,
      code,
      kind: 'org',
    });
    await audit({
      userId: req.user!.id,
      action: 'organic.account.connected',
      metadata: { platform: 'linkedin', kind: 'org', name: (saved.meta as { name?: string }).name ?? null },
      ipAddress: req.ip,
    });
    res.redirect(`${env.FRONTEND_URL}/settings/social-profiles?linkedin_connected=1`);
  } catch (err) {
    console.error('[organic/linkedin-org/callback] OAuth failed:', err);
    const msg = err instanceof Error ? err.message : 'OAuth failed';
    res.redirect(
      `${env.FRONTEND_URL}/settings/social-profiles?linkedin_oauth_error=${encodeURIComponent(msg)}`
    );
  }
});

/**
 * Auto-link: given an existing IG connection id, see if the IG account
 * is linked to a Threads profile. We use the IG token to call
 * /me?fields=threads_user_id. If we find one, return it as a hint —
 * the user still has to go through Threads OAuth to grant Threads-scoped
 * tokens. We can't reuse the IG token for Threads publishing.
 */
organicRouter.get('/threads/auto-link/:igAccountId', requireAuth, async (req: Request, res: Response) => {
  const igAccountId = String(req.params.igAccountId);
  const account = await organicConn.getAccountWithToken(req.user!.id, igAccountId);
  if (!account || account.platform !== 'instagram') {
    return res.status(404).json({ error: 'Instagram account not found' });
  }
  const threadsUserId = await threadsConn.discoverLinkedThreadsUserId(account.accessToken);
  res.json({ threadsUserId, hasLinkedThreads: threadsUserId !== null });
});

// =====================================================================
// Posts (Patch 4.25 — publish-now)
// =====================================================================
//
// POST /organic/posts          → publish to N target profiles (sync)
// GET  /organic/posts          → list my recent posts
// GET  /organic/posts/:id      → fetch one with per-target details

import { z as zod } from 'zod';
import { runPublish as runOrganicPublish } from '../services/organic-publish-runner';
import { getOrganicPublishQueue } from '../services/queue';

const mediaItemSchema = zod.object({
  uploadId: zod.string().uuid(),
  kind: zod.enum(['image', 'video', 'document']),
});

const publishSchema = zod.object({
  body: zod.string().max(8000).default(''),
  /** @deprecated kept for back-compat — clients should send mediaItems[]. */
  uploadId: zod.string().uuid().nullable().optional(),
  /** Ordered media. All-image (1-10) OR a single video. Empty = text-only. */
  mediaItems: zod.array(mediaItemSchema).max(10).optional().default([]),
  brandId: zod.string().uuid().nullable().optional(),
  /** ISO 8601 datetime. When present AND in the future, the post is
   *  enqueued as a delayed job. When absent/past, publish-now. */
  scheduledFor: zod.string().datetime({ offset: true }).nullable().optional(),
  /** Optional first comment — posted on each target after the main
   *  post succeeds. Max 2200 chars (IG limit; FB's is higher so we
   *  use the smaller for cross-platform safety). */
  firstComment: zod.string().max(2200).nullable().optional(),
  /** IG collaborators — usernames. Up to 3, per Meta's cap. Silently
   *  dropped for FB targets (no API equivalent). */
  collaborators: zod.array(zod.string().min(1).max(30)).max(3).nullable().optional(),
  /** Optional custom cover image for video posts. Upload ID points to
   *  an image in the uploads table. IG sets it via cover_url on the
   *  container (in-flight); FB applies post-publish via
   *  /{video-id}/thumbnails (best-effort). Ignored if media is not a
   *  single video. */
  coverUploadId: zod.string().uuid().nullable().optional(),
  /** Threads-only: topic tag on the head post (max 50 chars, no
   *  periods/ampersands/whitespace — Threads enforces these rules).
   *  Silently dropped by FB/IG. */
  topicTag: zod.string().max(50).nullable().optional(),
  /** LinkedIn-only: title for a PDF document post (max 100 chars). Required
   *  by LinkedIn when a document is attached; validated against media below. */
  documentTitle: zod.string().max(100).nullable().optional(),
  /** Threads-only: up to 4 reply posts. Total chain = head + 4 max.
   *  Each reply has its own body and (optional) media. FB/IG drop the
   *  entire chain silently. */
  replyChain: zod.array(
    zod.object({
      body: zod.string().max(500),
      mediaItems: zod.array(mediaItemSchema).max(10).optional().default([]),
    })
  ).max(4).optional().default([]),
  targets: zod.array(
    zod.object({
      accountId: zod.string().uuid(),
      /** Optional per-target body override. */
      bodyOverride: zod.string().max(8000).nullable().optional(),
      /** Optional per-target media override (per-network customization).
       *  When present, these replace the shared head media for this target
       *  only. Absent/empty = use the shared media. */
      mediaItems: zod.array(mediaItemSchema).max(10).optional(),
      /** Per-target LinkedIn document title (when this target's media is a
       *  PDF). Falls back to the post-level documentTitle if absent. */
      documentTitle: zod.string().max(100).nullable().optional(),
    })
  ).max(50).default([]),
  /** Patch 4.37.0: when true, save the post as a draft (status='draft').
   *  Skips schedule enqueue, skips publish. Targets/body can be empty.
   *  The composer's "Save as draft" button sends this. */
  asDraft: zod.boolean().optional().default(false),
  /** Patch 4.43.0: TikTok per-post settings. Applied to TikTok targets
   *  only; ignored by FB/IG/Threads. Privacy is clamped to SELF_ONLY by
   *  TikTok until the app is audited. */
  tiktok: zod.object({
    privacy: zod.enum([
      'PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY',
    ]).optional(),
    commercialContent: zod.boolean().optional(),
    yourBrand: zod.boolean().optional(),
    brandedContent: zod.boolean().optional(),
    disableComment: zod.boolean().optional(),
    disableDuet: zod.boolean().optional(),
    disableStitch: zod.boolean().optional(),
  }).nullable().optional(),
});

organicRouter.post('/posts', requireAuth, async (req: Request, res: Response) => {
  const parsed = publishSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid request — needs body, mediaItems[] (optional), brandId (optional), scheduledFor (optional), and targets[]',
    });
  }
  const {
    body,
    uploadId,
    mediaItems: rawMediaItems,
    brandId,
    scheduledFor,
    firstComment,
    collaborators,
    coverUploadId,
    topicTag,
    documentTitle,
    replyChain,
    targets,
    asDraft,
    tiktok,
  } = parsed.data;
  const userId = req.user!.id;

  // Back-compat: if a legacy uploadId arrived without mediaItems, treat
  // it as a single image. New clients send mediaItems[] directly.
  const mediaItems = rawMediaItems.length > 0
    ? rawMediaItems
    : uploadId
      ? [{ uploadId, kind: 'image' as const }]
      : [];

  // Constraint check: all-image OR single video.
  const videoCount = mediaItems.filter((m) => m.kind === 'video').length;
  const imageCount = mediaItems.filter((m) => m.kind === 'image').length;
  if (videoCount > 0 && (videoCount > 1 || imageCount > 0)) {
    return res.status(400).json({
      error: 'A post is either multiple images (carousel) or a single video — not mixed.',
    });
  }

  // Drafts can be entirely empty (user is just saving WIP). Publish/
  // schedule paths still require content + at least one target.
  if (!asDraft) {
    if (!body.trim() && mediaItems.length === 0) {
      return res.status(400).json({ error: 'Post needs text or media (or both).' });
    }
    if (targets.length === 0) {
      return res.status(400).json({ error: 'At least one target is required to publish or schedule.' });
    }
  }

  // Resolve schedule. If scheduledFor is in the past (or unset), treat as publish-now.
  const scheduledDate = scheduledFor ? new Date(scheduledFor) : null;
  const now = new Date();
  // 30-second grace window — anything <30s in the future just runs now
  // rather than getting queued for a barely-perceptible delay.
  const isScheduled = scheduledDate !== null && scheduledDate.getTime() - now.getTime() > 30_000;

  // Verify upload ownership before we record anything
  if (mediaItems.length > 0) {
    const uploadIds = mediaItems.map((m) => m.uploadId);
    const { rows: ownedRows } = await query<{ id: string }>(
      `SELECT id FROM uploads WHERE user_id = $1 AND id = ANY($2::uuid[])`,
      [userId, uploadIds]
    );
    if (ownedRows.length !== uploadIds.length) {
      return res.status(400).json({ error: 'One or more media items are not accessible.' });
    }
  }

  // Verify targets belong to user + are connected
  const accountIds = targets.map((t) => t.accountId);
  const { rows: accountRows } = await query<{ id: string; platform: string }>(
    `SELECT id, platform FROM organic_connected_accounts
      WHERE user_id = $1 AND id = ANY($2::uuid[]) AND disconnected_at IS NULL`,
    [userId, accountIds]
  );
  if (accountRows.length !== targets.length) {
    return res.status(400).json({ error: 'One or more targets are unavailable.' });
  }
  const platformById = new Map(accountRows.map((r) => [r.id, r.platform]));

  // Create the post row. Status reflects the path (draft, scheduled, or publishing).
  const firstUploadId = mediaItems.length > 0 ? mediaItems[0].uploadId : null;
  const initialStatus = asDraft ? 'draft' : isScheduled ? 'scheduled' : 'publishing';
  const initialTargetStatus = asDraft ? 'pending' : isScheduled ? 'scheduled' : 'pending';

  const { rows: postRows } = await query<{ id: string }>(
    `INSERT INTO organic_posts
       (user_id, brand_id, body, upload_id, status, scheduled_for,
        first_comment, collaborators, cover_upload_id,
        topic_tag, document_title, reply_chain,
        tiktok_privacy, tiktok_commercial_content, tiktok_your_brand,
        tiktok_branded_content, tiktok_disable_comment,
        tiktok_disable_duet, tiktok_disable_stitch)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             $13, $14, $15, $16, $17, $18, $19)
     RETURNING id`,
    [
      userId,
      brandId ?? null,
      body,
      firstUploadId,
      initialStatus,
      isScheduled ? scheduledDate : null,
      firstComment && firstComment.trim() ? firstComment.trim() : null,
      collaborators ?? [],
      coverUploadId ?? null,
      topicTag && topicTag.trim() ? topicTag.trim() : null,
      documentTitle && documentTitle.trim() ? documentTitle.trim() : null,
      // Persist only the bodies — reply media goes to organic_post_media
      // keyed by reply_index. Even when the chain has no media this is a
      // valid (empty-array) JSONB value.
      JSON.stringify(replyChain.map((r) => ({ body: r.body }))),
      // TikTok per-post settings (null/false when not provided).
      tiktok?.privacy ?? null,
      tiktok?.commercialContent ?? false,
      tiktok?.yourBrand ?? false,
      tiktok?.brandedContent ?? false,
      tiktok?.disableComment ?? false,
      tiktok?.disableDuet ?? false,
      tiktok?.disableStitch ?? false,
    ]
  );
  const postId = postRows[0].id;

  // Persist head-post media (reply_index = 0)
  for (let i = 0; i < mediaItems.length; i++) {
    const m = mediaItems[i];
    await query(
      `INSERT INTO organic_post_media (post_id, upload_id, kind, sort_order, reply_index)
       VALUES ($1, $2, $3, $4, 0)`,
      [postId, m.uploadId, m.kind, i]
    );
  }

  // Persist reply media keyed by 1-based reply_index. Reply 1's media
  // gets reply_index=1, reply 2's gets reply_index=2, etc. The DB
  // CHECK constraint bounds this 0..4.
  for (let r = 0; r < replyChain.length; r++) {
    const replyMedia = replyChain[r].mediaItems ?? [];
    for (let i = 0; i < replyMedia.length; i++) {
      const m = replyMedia[i];
      await query(
        `INSERT INTO organic_post_media (post_id, upload_id, kind, sort_order, reply_index)
         VALUES ($1, $2, $3, $4, $5)`,
        [postId, m.uploadId, m.kind, i, r + 1]
      );
    }
  }

  // Persist target rows. When a target carries its own media override
  // (per-network customization), write those rows tagged with the target_id
  // so the runner uses them instead of the shared head media.
  for (const t of targets) {
    const { rows: tRows } = await query<{ id: string }>(
      `INSERT INTO organic_post_targets
         (post_id, account_id, platform, body_override, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [postId, t.accountId, platformById.get(t.accountId), t.bodyOverride ?? null, initialTargetStatus]
    );
    const targetId = tRows[0].id;
    if (t.mediaItems && t.mediaItems.length > 0) {
      for (let i = 0; i < t.mediaItems.length; i++) {
        const m = t.mediaItems[i];
        await query(
          `INSERT INTO organic_post_media (post_id, target_id, upload_id, kind, sort_order, reply_index)
           VALUES ($1, $2, $3, $4, $5, 0)`,
          [postId, targetId, m.uploadId, m.kind, i]
        );
      }
    }
  }

  // ── Draft path: persisted, no publish, no schedule. Return immediately.
  if (asDraft) {
    await audit({
      userId,
      action: 'organic.post.saved_draft',
      metadata: { post_id: postId, targets: targets.length, media_count: mediaItems.length },
      ipAddress: req.ip,
    });
    return res.status(201).json({
      postId,
      status: 'draft',
    });
  }

  // ── Scheduled path: enqueue delayed job and return ──
  if (isScheduled && scheduledDate) {
    const delay = scheduledDate.getTime() - now.getTime();
    const job = await getOrganicPublishQueue().add(
      'publish',
      { postId },
      { delay }
    );
    // Store the job id so we can cancel/reschedule
    await query(
      `UPDATE organic_posts SET scheduled_job_id = $1, updated_at = NOW() WHERE id = $2`,
      [String(job.id), postId]
    );
    await audit({
      userId,
      action: 'organic.post.scheduled',
      metadata: { post_id: postId, scheduled_for: scheduledDate.toISOString(), targets: targets.length, media_count: mediaItems.length },
      ipAddress: req.ip,
    });
    return res.status(202).json({
      postId,
      status: 'scheduled',
      scheduledFor: scheduledDate.toISOString(),
    });
  }

  // ── Publish-now path: run synchronously via the shared runner ──
  const result = await runOrganicPublish(postId);

  await audit({
    userId,
    action: 'organic.post.published',
    metadata: { post_id: postId, targets: targets.length, succeeded: result.succeeded, failed: result.failed, media_count: mediaItems.length },
    ipAddress: req.ip,
  });

  res.status(201).json({
    postId,
    status: result.status,
    succeeded: result.succeeded,
    failed: result.failed,
  });
});

// =====================================================================
// Drafts (Patch 4.37.0)
//
// Drafts are organic_posts rows with status='draft'. They:
//   • Can have empty body, no media, and no targets
//   • Don't get queued for publish or scheduled
//   • Live brand-scoped (brand_id filter)
//   • Can be edited in place via PATCH (replaces media + targets)
//   • Can be promoted by simply switching to /organic/posts (publish)
//     or /organic/posts with scheduledFor (schedule) — done by the
//     composer when "Publish" or "Schedule" is clicked while editing
//     an existing draft.
// =====================================================================

// ─── GET /organic/drafts — list drafts for the active user/brand
organicRouter.get('/drafts', requireAuth, async (req: Request, res: Response) => {
  const brandId =
    typeof req.query.brandId === 'string' && req.query.brandId.trim() !== ''
      ? req.query.brandId
      : null;
  const accountIdsParam =
    typeof req.query.accountIds === 'string' ? req.query.accountIds : null;
  const accountIds = accountIdsParam
    ? accountIdsParam.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : null;

  const params: Array<string | string[] | null> = [req.user!.id];
  let brandClause = '';
  if (brandId) {
    params.push(brandId);
    brandClause = `AND p.brand_id = $${params.length}::uuid`;
  }

  // Patch 4.37.0.1: when accountIds is provided, require the draft to
  // have at least one target in that set. Drafts with no targets are
  // excluded whenever an explicit account filter is present.
  let accountClause = '';
  if (accountIds && accountIds.length > 0) {
    params.push(accountIds);
    accountClause = `AND EXISTS (
        SELECT 1 FROM organic_post_targets t2
         WHERE t2.post_id = p.id AND t2.account_id = ANY($${params.length}::uuid[])
      )`;
  }

  const { rows } = await query<any>(
    `WITH first_media AS (
        SELECT DISTINCT ON (post_id) post_id, upload_id, kind
          FROM organic_post_media
         WHERE reply_index = 0
         ORDER BY post_id, sort_order ASC
     )
     SELECT p.id, p.brand_id, p.body, p.upload_id, p.created_at, p.updated_at,
            p.topic_tag, p.document_title,
            fm.upload_id AS media_upload_id,
            fm.kind      AS media_kind,
            COALESCE(
              ARRAY_AGG(DISTINCT t.platform) FILTER (WHERE t.platform IS NOT NULL),
              ARRAY[]::TEXT[]
            ) AS platforms,
            COALESCE(
              ARRAY_AGG(DISTINCT t.account_id) FILTER (WHERE t.account_id IS NOT NULL),
              ARRAY[]::UUID[]
            ) AS account_ids,
            COUNT(t.id)::int AS target_count
       FROM organic_posts p
       LEFT JOIN organic_post_targets t ON t.post_id = p.id
       LEFT JOIN first_media fm         ON fm.post_id = p.id
      WHERE p.user_id = $1
        AND p.status = 'draft'
        ${brandClause}
        ${accountClause}
      GROUP BY p.id, fm.upload_id, fm.kind
      ORDER BY p.updated_at DESC
      LIMIT 200`,
    params
  );

  res.json({
    drafts: rows.map((r) => ({
      id: r.id,
      brandId: r.brand_id,
      body: r.body,
      topicTag: r.topic_tag,
      documentTitle: r.document_title ?? null,
      mediaUploadId: r.media_upload_id ?? null,
      mediaKind: r.media_kind ?? null,
      platforms: r.platforms ?? [],
      accountIds: r.account_ids ?? [],
      targetCount: r.target_count ?? 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
});

// ─── PATCH /organic/posts/:id — update an existing draft in place
//
// The composer's "Save as draft" button on an already-loaded draft
// calls this. Replaces media and targets (cleanest semantics — the
// composer's current state IS the new draft).
organicRouter.patch('/posts/:id', requireAuth, async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const parsed = publishSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const {
    body,
    uploadId,
    mediaItems: rawMediaItems,
    brandId,
    firstComment,
    collaborators,
    coverUploadId,
    topicTag,
    documentTitle,
    replyChain,
    targets,
    asDraft,
    scheduledFor,
  } = parsed.data;
  const userId = req.user!.id;

  // Patch 4.41.0: drafts AND scheduled posts are editable in place.
  // Published/publishing/partial/failed posts can't be edited (already
  // sent or mid-flight) — those use cancel/retry flows.
  const { rows: existing } = await query<{ status: string; scheduled_job_id: string | null }>(
    `SELECT status, scheduled_job_id FROM organic_posts WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  if (existing.length === 0) {
    return res.status(404).json({ error: 'Post not found' });
  }
  const existingStatus = existing[0].status;
  const existingJobId = existing[0].scheduled_job_id;
  const isScheduledEdit = existingStatus === 'scheduled';
  if (existingStatus !== 'draft' && existingStatus !== 'scheduled') {
    return res.status(400).json({ error: `Cannot edit a ${existingStatus} post.` });
  }
  // For a DRAFT edit the composer sends asDraft=true (saving back as a
  // draft). For a SCHEDULED edit asDraft is false — we keep it scheduled
  // and re-queue. Reject the only nonsensical combo: asDraft on a
  // scheduled post (that would be "unschedule", which is Cancel's job).
  if (!isScheduledEdit && !asDraft) {
    return res.status(400).json({
      error: 'PATCH only supports draft-mode updates for drafts. Use POST to publish or schedule.',
    });
  }

  // Back-compat: single uploadId → media item
  const mediaItems = rawMediaItems.length > 0
    ? rawMediaItems
    : uploadId
      ? [{ uploadId, kind: 'image' as const }]
      : [];

  const videoCount = mediaItems.filter((m) => m.kind === 'video').length;
  const imageCount = mediaItems.filter((m) => m.kind === 'image').length;
  if (videoCount > 0 && (videoCount > 1 || imageCount > 0)) {
    return res.status(400).json({
      error: 'A post is either multiple images (carousel) or a single video — not mixed.',
    });
  }

  // Verify upload ownership
  if (mediaItems.length > 0) {
    const uploadIds = mediaItems.map((m) => m.uploadId);
    const { rows: ownedRows } = await query<{ id: string }>(
      `SELECT id FROM uploads WHERE user_id = $1 AND id = ANY($2::uuid[])`,
      [userId, uploadIds]
    );
    if (ownedRows.length !== uploadIds.length) {
      return res.status(400).json({ error: 'One or more media items are not accessible.' });
    }
  }

  // Verify targets
  const accountIds = targets.map((t) => t.accountId);
  let platformById = new Map<string, string>();
  if (accountIds.length > 0) {
    const { rows: accountRows } = await query<{ id: string; platform: string }>(
      `SELECT id, platform FROM organic_connected_accounts
        WHERE user_id = $1 AND id = ANY($2::uuid[]) AND disconnected_at IS NULL`,
      [userId, accountIds]
    );
    if (accountRows.length !== targets.length) {
      return res.status(400).json({ error: 'One or more targets are unavailable.' });
    }
    platformById = new Map(accountRows.map((r) => [r.id, r.platform]));
  }

  const firstUploadId = mediaItems.length > 0 ? mediaItems[0].uploadId : null;

  // Update the parent row. brand_id is allowed to change so a user
  // who switches the active brand selector can re-save the draft
  // under that brand.
  await query(
    `UPDATE organic_posts
        SET brand_id = $2,
            body = $3,
            upload_id = $4,
            first_comment = $5,
            collaborators = $6,
            cover_upload_id = $7,
            topic_tag = $8,
            reply_chain = $9,
            document_title = $10,
            updated_at = NOW()
      WHERE id = $1`,
    [
      id,
      brandId ?? null,
      body,
      firstUploadId,
      firstComment && firstComment.trim() ? firstComment.trim() : null,
      collaborators ?? [],
      coverUploadId ?? null,
      topicTag && topicTag.trim() ? topicTag.trim() : null,
      JSON.stringify(replyChain.map((r) => ({ body: r.body }))),
      documentTitle && documentTitle.trim() ? documentTitle.trim() : null,
    ]
  );

  // Replace media (head + reply). Hard-delete old rows; insert new.
  await query(`DELETE FROM organic_post_media WHERE post_id = $1`, [id]);
  for (let i = 0; i < mediaItems.length; i++) {
    const m = mediaItems[i];
    await query(
      `INSERT INTO organic_post_media (post_id, upload_id, kind, sort_order, reply_index)
       VALUES ($1, $2, $3, $4, 0)`,
      [id, m.uploadId, m.kind, i]
    );
  }
  for (let r = 0; r < replyChain.length; r++) {
    const replyMedia = replyChain[r].mediaItems ?? [];
    for (let i = 0; i < replyMedia.length; i++) {
      const m = replyMedia[i];
      await query(
        `INSERT INTO organic_post_media (post_id, upload_id, kind, sort_order, reply_index)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, m.uploadId, m.kind, i, r + 1]
      );
    }
  }

  // Replace targets (and their per-target media overrides).
  await query(`DELETE FROM organic_post_targets WHERE post_id = $1`, [id]);
  for (const t of targets) {
    const { rows: tRows } = await query<{ id: string }>(
      `INSERT INTO organic_post_targets
         (post_id, account_id, platform, body_override, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING id`,
      [id, t.accountId, platformById.get(t.accountId), t.bodyOverride ?? null]
    );
    const targetId = tRows[0].id;
    if (t.mediaItems && t.mediaItems.length > 0) {
      for (let i = 0; i < t.mediaItems.length; i++) {
        const m = t.mediaItems[i];
        await query(
          `INSERT INTO organic_post_media (post_id, target_id, upload_id, kind, sort_order, reply_index)
           VALUES ($1, $2, $3, $4, $5, 0)`,
          [id, targetId, m.uploadId, m.kind, i]
        );
      }
    }
  }

  // Patch 4.41.0: for a SCHEDULED edit, keep the post scheduled and
  // re-queue its publish job. The publish runner re-reads post content
  // + targets at fire time, so content/target edits need no re-queue —
  // but a TIME change does (remove old delayed job, add a new one).
  let finalStatus = isScheduledEdit ? 'scheduled' : 'draft';
  let finalScheduledFor: string | null = null;
  if (isScheduledEdit) {
    const newDate = scheduledFor ? new Date(scheduledFor) : null;
    if (!newDate || isNaN(newDate.getTime())) {
      return res.status(400).json({ error: 'A scheduled post requires a valid scheduledFor.' });
    }
    if (newDate.getTime() - Date.now() < 30_000) {
      return res.status(400).json({ error: 'scheduledFor must be at least 30 seconds in the future.' });
    }
    // Remove the old delayed job (if any) and enqueue a fresh one.
    if (existingJobId) {
      try {
        const oldJob = await getOrganicPublishQueue().getJob(existingJobId);
        if (oldJob) await oldJob.remove();
      } catch (err) {
        console.warn('[organic/edit-scheduled] failed to remove old job:', err);
      }
    }
    const job = await getOrganicPublishQueue().add(
      'publish',
      { postId: id },
      { delay: newDate.getTime() - Date.now() }
    );
    await query(
      `UPDATE organic_posts
          SET status = 'scheduled', scheduled_for = $1, scheduled_job_id = $2, updated_at = NOW()
        WHERE id = $3`,
      [newDate, String(job.id), id]
    );
    finalScheduledFor = newDate.toISOString();
  }

  await audit({
    userId,
    action: isScheduledEdit ? 'organic.post.scheduled_updated' : 'organic.post.draft_updated',
    metadata: { post_id: id, targets: targets.length, media_count: mediaItems.length },
    ipAddress: req.ip,
  });

  res.json({ postId: id, status: finalStatus, scheduledFor: finalScheduledFor });
});

// ─── DELETE /organic/posts/:id — only allowed for drafts
organicRouter.delete('/posts/:id', requireAuth, async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const { rows } = await query<{ status: string }>(
    `SELECT status FROM organic_posts WHERE id = $1 AND user_id = $2`,
    [id, req.user!.id]
  );
  if (rows.length === 0) {
    return res.status(404).json({ error: 'Post not found' });
  }
  if (rows[0].status !== 'draft') {
    return res.status(400).json({ error: `Only drafts can be deleted (this is ${rows[0].status}).` });
  }
  // ON DELETE CASCADE will clean up targets + media.
  await query(`DELETE FROM organic_posts WHERE id = $1`, [id]);
  await audit({
    userId: req.user!.id,
    action: 'organic.post.draft_deleted',
    metadata: { post_id: id },
    ipAddress: req.ip,
  });
  res.json({ ok: true });
});

// ─── Schedule cancel / reschedule ──────────────────────────────────────────

/** Cancel a scheduled post — removes the BullMQ job and marks the post
 *  as 'cancelled'. No-op for posts not in 'scheduled' status. */
organicRouter.delete('/posts/:id/schedule', requireAuth, async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const { rows } = await query<{ scheduled_job_id: string | null; status: string }>(
    `SELECT scheduled_job_id, status FROM organic_posts
      WHERE id = $1 AND user_id = $2`,
    [id, req.user!.id]
  );
  if (rows.length === 0) {
    return res.status(404).json({ error: 'Post not found' });
  }
  if (rows[0].status !== 'scheduled') {
    return res.status(400).json({ error: `Post is ${rows[0].status}, not scheduled.` });
  }
  if (rows[0].scheduled_job_id) {
    // Best-effort: ignore "job not found" since it may already have started
    try {
      const job = await getOrganicPublishQueue().getJob(rows[0].scheduled_job_id);
      if (job) await job.remove();
    } catch (err) {
      console.warn('[organic/cancel] failed to remove job:', err);
    }
  }
  await query(
    `UPDATE organic_posts SET status = 'cancelled', scheduled_job_id = NULL, updated_at = NOW()
      WHERE id = $1`,
    [id]
  );
  res.json({ ok: true });
});

const rescheduleSchema = zod.object({
  scheduledFor: zod.string().datetime({ offset: true }),
});

/** Reschedule a scheduled post to a new time. */
organicRouter.patch('/posts/:id/schedule', requireAuth, async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const parsed = rescheduleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Body must be { scheduledFor: ISO datetime }.' });
  }
  const newDate = new Date(parsed.data.scheduledFor);
  if (newDate.getTime() - Date.now() < 30_000) {
    return res.status(400).json({ error: 'scheduledFor must be at least 30 seconds in the future.' });
  }

  const { rows } = await query<{ scheduled_job_id: string | null; status: string }>(
    `SELECT scheduled_job_id, status FROM organic_posts
      WHERE id = $1 AND user_id = $2`,
    [id, req.user!.id]
  );
  if (rows.length === 0) {
    return res.status(404).json({ error: 'Post not found' });
  }
  if (rows[0].status !== 'scheduled') {
    return res.status(400).json({ error: `Post is ${rows[0].status}, not scheduled.` });
  }
  // Remove old job, enqueue new
  if (rows[0].scheduled_job_id) {
    try {
      const oldJob = await getOrganicPublishQueue().getJob(rows[0].scheduled_job_id);
      if (oldJob) await oldJob.remove();
    } catch (err) {
      console.warn('[organic/reschedule] failed to remove old job:', err);
    }
  }
  const job = await getOrganicPublishQueue().add(
    'publish',
    { postId: id },
    { delay: newDate.getTime() - Date.now() }
  );
  await query(
    `UPDATE organic_posts
        SET scheduled_for = $1, scheduled_job_id = $2, updated_at = NOW()
      WHERE id = $3`,
    [newDate, String(job.id), id]
  );
  res.json({ ok: true, scheduledFor: newDate.toISOString() });
});

// ─── Place search REMOVED in 4.32.5 ──────────────────────────────────────
//
// The /pages/search endpoint requires Meta App Review for either "Page
// Public Content Access" or "Page Public Metadata Access" features —
// the pages_read_engagement scope alone is not sufficient, contrary to
// the misleading error message Meta returns. Since we haven't been
// through App Review, this endpoint cannot work.
//
// The `location_id` / `location_name` columns are kept in the schema
// for forward compatibility; the publisher signatures still accept a
// nullable locationId (so a future Google Places integration or
// manual-paste UI can plug in). Just no longer exposed via UI/route.

// ------------------------------------------------------------
// GET /organic/posts — list recent posts for the user
// ------------------------------------------------------------
organicRouter.get('/posts', requireAuth, async (req: Request, res: Response) => {
  const { rows } = await query<any>(
    `SELECT p.id, p.brand_id, p.body, p.upload_id, p.status,
            p.scheduled_for, p.published_at, p.created_at,
            p.topic_tag,
            COALESCE(jsonb_array_length(p.reply_chain), 0) AS reply_chain_length,
            COUNT(t.id) AS targets_total,
            COUNT(*) FILTER (WHERE t.status = 'published') AS targets_published,
            COUNT(*) FILTER (WHERE t.status = 'failed')    AS targets_failed,
            COALESCE(
              ARRAY_AGG(DISTINCT t.platform) FILTER (WHERE t.platform IS NOT NULL),
              ARRAY[]::TEXT[]
            ) AS platforms
       FROM organic_posts p
       LEFT JOIN organic_post_targets t ON t.post_id = p.id
      WHERE p.user_id = $1
      GROUP BY p.id
      ORDER BY p.created_at DESC
      LIMIT 200`,
    [req.user!.id]
  );
  res.json({
    posts: rows.map((r) => ({
      id: r.id,
      brandId: r.brand_id,
      body: r.body,
      uploadId: r.upload_id,
      status: r.status,
      scheduledFor: r.scheduled_for,
      publishedAt: r.published_at,
      createdAt: r.created_at,
      targetsTotal: Number(r.targets_total),
      targetsPublished: Number(r.targets_published),
      targetsFailed: Number(r.targets_failed),
      platforms: r.platforms ?? [],
      topicTag: r.topic_tag,
      replyChainLength: Number(r.reply_chain_length ?? 0),
    })),
  });
});

// =====================================================================
// GET /organic/calendar  (Patch 4.35)
//
// Returns a unified, deduplicated timeline of:
//   • Vass-created posts (scheduled or published), from organic_posts
//   • Already-published posts pulled from Meta/Threads, from
//     synced_meta_posts
//
// Dedup: synced_meta_posts rows whose external_post_id matches an
// organic_post_targets.external_post_id (for any target of the same
// account) are omitted. Vass-tracked posts always win — they have
// the richer metadata (reply chain, topic tag, scheduling info).
//
// Filters:
//   ?from=ISO-DATE          required — lower bound (matches scheduled_for / posted_at)
//   ?to=ISO-DATE            required — upper bound
//   ?brandId=UUID           optional — limits to accounts in this brand
//   ?accountIds=UUID,UUID   optional — explicit account filter (comma-separated)
//
// When both brandId and accountIds are present, accountIds wins
// (lets the per-account chip filter override the brand). When neither
// is present, returns everything the user can see.
// =====================================================================

organicRouter.get('/calendar', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;

  const fromParam = typeof req.query.from === 'string' ? req.query.from : null;
  const toParam = typeof req.query.to === 'string' ? req.query.to : null;
  if (!fromParam || !toParam) {
    return res.status(400).json({ error: 'from and to are required ISO date strings' });
  }
  const fromDate = new Date(fromParam);
  const toDate = new Date(toParam);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return res.status(400).json({ error: 'from and to must be valid ISO date strings' });
  }

  const brandId =
    typeof req.query.brandId === 'string' && req.query.brandId.trim() !== ''
      ? req.query.brandId
      : null;
  const accountIdsParam =
    typeof req.query.accountIds === 'string' ? req.query.accountIds : null;
  const accountIds = accountIdsParam
    ? accountIdsParam.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : null;

  // Patch 4.36: `statuses` query param toggles post-type bucket filters.
  // Two buckets the UI exposes: 'scheduled' and 'published'.
  //   - 'scheduled' covers Vass posts with status IN ('scheduled','publishing').
  //   - 'published' covers Vass posts with status='published' AND all
  //     synced_meta_posts rows (synced posts are always already published).
  //
  // Default = both buckets enabled (return everything). If the param is
  // present but neither bucket is in it, we treat that as "show nothing".
  const statusesParam =
    typeof req.query.statuses === 'string' ? req.query.statuses : null;
  const statusBuckets = new Set<'scheduled' | 'published'>(
    statusesParam === null
      ? ['scheduled', 'published']
      : statusesParam
          .split(',')
          .map((s) => s.trim())
          .filter((s): s is 'scheduled' | 'published' => s === 'scheduled' || s === 'published')
  );
  const wantScheduled = statusBuckets.has('scheduled');
  const wantPublished = statusBuckets.has('published');

  // Resolve the effective account-id set we're filtering by.
  // Order of precedence: explicit accountIds → brandId → all user's accounts.
  let effectiveAccountIds: string[] | null = null;
  if (accountIds && accountIds.length > 0) {
    effectiveAccountIds = accountIds;
  } else if (brandId) {
    const { rows: brandAccounts } = await query<{ id: string }>(
      `SELECT id FROM organic_connected_accounts
        WHERE user_id = $1 AND brand_id = $2 AND disconnected_at IS NULL`,
      [userId, brandId]
    );
    effectiveAccountIds = brandAccounts.map((r) => r.id);
    // If the brand has no accounts, return empty rather than "all".
    if (effectiveAccountIds.length === 0) {
      return res.json({ posts: [] });
    }
  }

  // ─── Pull Vass posts ───
  // Brand filter is on organic_posts.brand_id directly. Account filter
  // means: include posts where at least one target's account_id is in
  // the set.
  const vassRows = (await pullVassCalendarRows(
    userId,
    fromDate,
    toDate,
    brandId,
    effectiveAccountIds
  )).filter((r) => {
    // Bucket the Vass row.
    if (r.status === 'published' || r.status === 'partial') {
      return wantPublished;
    }
    // scheduled or publishing
    return wantScheduled;
  });

  // ─── Pull synced Meta posts (only when 'published' is wanted) ───
  // synced_meta_posts are always already published. Skip the DB hit
  // entirely when the user has unchecked 'published'.
  const syncedRows = wantPublished
    ? await pullSyncedCalendarRows(userId, fromDate, toDate, effectiveAccountIds)
    : [];

  // ─── Dedup: drop synced rows whose external_post_id appears in
  //     Vass's organic_post_targets for the same account. ───
  if (syncedRows.length > 0) {
    const { rows: vassExternals } = await query<{
      account_id: string;
      external_post_id: string;
    }>(
      `SELECT t.account_id, t.external_post_id
         FROM organic_post_targets t
         JOIN organic_posts p ON p.id = t.post_id
        WHERE p.user_id = $1
          AND t.external_post_id IS NOT NULL`,
      [userId]
    );
    const vassKeys = new Set(
      vassExternals.map((r) => `${r.account_id}:${r.external_post_id}`)
    );
    for (let i = syncedRows.length - 1; i >= 0; i--) {
      const acctId = syncedRows[i].accountIds[0];
      const extId = syncedRows[i].externalPostId;
      if (!acctId || !extId) continue;
      const key = `${acctId}:${extId}`;
      if (vassKeys.has(key)) {
        syncedRows.splice(i, 1);
      }
    }
  }

  // ─── Merge + return ───
  // Sort by effective timestamp DESC (scheduled_for or published_at
  // for Vass posts, posted_at for synced). The client renders these
  // in calendar cells / list rows.
  res.json({
    posts: [...vassRows, ...syncedRows].sort((a, b) => {
      const ta = new Date(a.timestamp).getTime();
      const tb = new Date(b.timestamp).getTime();
      return tb - ta;
    }),
  });
});

interface CalendarRow {
  /** Stable id (UUID for both sources). Vass posts use organic_posts.id,
   *  synced use synced_meta_posts.id. Different ID spaces — caller should
   *  treat them as opaque + use `source` to disambiguate. */
  id: string;
  /** 'vass' = originated in Vass (scheduled or published); 'synced' =
   *  pulled from Meta/Threads, Vass doesn't own it. */
  source: 'vass' | 'synced';
  /** Status — used for visual treatment (outlined vs solid card). */
  status:
    | 'scheduled'
    | 'publishing'
    | 'published'
    | 'partial'
    | 'failed'
    | 'cancelled';
  brandId: string | null;
  body: string | null;
  /** When this post happens — scheduled_for for future Vass posts,
   *  published_at or posted_at for past posts. */
  timestamp: string;
  /** For thumbnails on the calendar card. */
  mediaUrl: string | null;
  mediaType: string | null;
  /** Platforms involved. Vass posts may target multiple; synced posts
   *  are always exactly one. */
  platforms: ('facebook_page' | 'instagram' | 'threads')[];
  /** Account ids involved (for the per-account chip filter). */
  accountIds: string[];
  /** Permalink for click-through. Only present for published posts. */
  permalink: string | null;
  /** Platform's own post id, used for dedup (synced vs Vass-published).
   *  Vass posts can have multiple targets each with their own
   *  external_post_id — we expose just one here, for synced-row matching.
   *  Null for posts that haven't been published yet. */
  externalPostId: string | null;
  /** Threads only — surfaces as a small pill. */
  topicTag: string | null;
  replyChainLength: number;
}

async function pullVassCalendarRows(
  userId: string,
  from: Date,
  to: Date,
  brandId: string | null,
  accountIds: string[] | null
): Promise<CalendarRow[]> {
  // Effective timestamp = COALESCE(published_at, scheduled_for, created_at).
  // We filter on that and surface the result as `timestamp`.
  // accountIds filter is "post has a target with one of these accounts".
  // brandId filter is on organic_posts.brand_id directly.

  const params: unknown[] = [userId, from, to];
  let accountClause = '';
  let brandClause = '';

  if (brandId) {
    params.push(brandId);
    brandClause = `AND (p.brand_id = $${params.length} OR p.brand_id IS NULL)`;
  }
  if (accountIds && accountIds.length > 0) {
    params.push(accountIds);
    accountClause = `AND EXISTS (
        SELECT 1 FROM organic_post_targets t2
         WHERE t2.post_id = p.id AND t2.account_id = ANY($${params.length}::uuid[])
      )`;
  }

  const { rows } = await query<any>(
    `WITH first_media AS (
        SELECT DISTINCT ON (post_id) post_id, upload_id, kind
          FROM organic_post_media
         WHERE reply_index = 0
         ORDER BY post_id, sort_order ASC
     )
     SELECT p.id, p.brand_id, p.body, p.status, p.upload_id,
            p.scheduled_for, p.published_at, p.created_at,
            p.topic_tag,
            COALESCE(jsonb_array_length(p.reply_chain), 0) AS reply_chain_length,
            COALESCE(p.published_at, p.scheduled_for, p.created_at) AS timestamp,
            fm.upload_id AS media_upload_id,
            fm.kind      AS media_kind,
            COALESCE(
              ARRAY_AGG(DISTINCT t.platform) FILTER (WHERE t.platform IS NOT NULL),
              ARRAY[]::TEXT[]
            ) AS platforms,
            COALESCE(
              ARRAY_AGG(DISTINCT t.account_id) FILTER (WHERE t.account_id IS NOT NULL),
              ARRAY[]::UUID[]
            ) AS account_ids,
            MAX(t.external_post_url) AS first_permalink,
            -- How many of the post's targets are still live (i.e. not
            -- tombstoned by 4.36.4 or marked failed/skipped). We use
            -- this in the HAVING below to drop published posts whose
            -- every platform copy was deleted.
            COUNT(*) FILTER (WHERE t.status NOT IN ('deleted', 'failed', 'skipped')) AS live_target_count
       FROM organic_posts p
       -- Only join LIVE targets. Tombstoned/failed targets shouldn't
       -- show up in platforms[] or account_ids[].
       LEFT JOIN organic_post_targets t
         ON t.post_id = p.id
        AND t.status NOT IN ('deleted', 'failed', 'skipped')
       LEFT JOIN first_media fm ON fm.post_id = p.id
      WHERE p.user_id = $1
        AND COALESCE(p.published_at, p.scheduled_for, p.created_at) BETWEEN $2 AND $3
        -- Patch 4.35.2: hide failed/cancelled/draft from the calendar.
        AND p.status NOT IN ('failed', 'cancelled', 'draft')
        ${brandClause}
        ${accountClause}
      GROUP BY p.id, fm.upload_id, fm.kind
      -- Patch 4.36.4: for published/partial posts, require at least one
      -- live target. Scheduled posts may have no targets yet (the
      -- publisher creates them on dispatch), so they're exempt.
      HAVING (p.status IN ('scheduled', 'publishing'))
          OR COUNT(*) FILTER (WHERE t.status NOT IN ('deleted', 'failed', 'skipped')) > 0
      ORDER BY timestamp DESC
      LIMIT 1000`,
    params
  );

  return rows.map((r) => ({
    id: r.id,
    source: 'vass' as const,
    status: r.status,
    brandId: r.brand_id,
    body: r.body,
    timestamp: r.timestamp,
    // For Vass posts we don't expose a CDN media URL here — clients
    // can fall back to /api/uploads/<id>/file if they need the thumb.
    // We send the upload id under a key the client knows how to render.
    mediaUrl: r.media_upload_id ? `vass-upload:${r.media_upload_id}` : null,
    mediaType: r.media_kind === 'video' ? 'VIDEO' : r.media_kind === 'image' ? 'IMAGE' : null,
    platforms: r.platforms ?? [],
    accountIds: r.account_ids ?? [],
    permalink: r.first_permalink ?? null,
    externalPostId: null, // Vass rows don't need self-dedup
    topicTag: r.topic_tag,
    replyChainLength: Number(r.reply_chain_length ?? 0),
  }));
}

async function pullSyncedCalendarRows(
  userId: string,
  from: Date,
  to: Date,
  accountIds: string[] | null
): Promise<CalendarRow[]> {
  // Always limit to accounts the user owns. accountIds (when present)
  // further narrows.
  const params: unknown[] = [userId, from, to];
  let accountClause = '';
  if (accountIds && accountIds.length > 0) {
    params.push(accountIds);
    accountClause = `AND s.organic_account_id = ANY($${params.length}::uuid[])`;
  }

  const { rows } = await query<any>(
    `SELECT s.id, s.organic_account_id, s.platform, s.external_post_id,
            s.external_post_url, s.body, s.media_url, s.media_type,
            s.posted_at, a.brand_id
       FROM synced_meta_posts s
       JOIN organic_connected_accounts a ON a.id = s.organic_account_id
      WHERE a.user_id = $1
        AND a.disconnected_at IS NULL
        AND s.posted_at BETWEEN $2 AND $3
        ${accountClause}
      ORDER BY s.posted_at DESC
      LIMIT 1000`,
    params
  );

  return rows.map((r) => ({
    id: r.id,
    source: 'synced' as const,
    status: 'published' as const,
    brandId: r.brand_id ?? null,
    body: r.body,
    timestamp: r.posted_at,
    mediaUrl: r.media_url,
    mediaType: r.media_type,
    platforms: [r.platform],
    accountIds: [r.organic_account_id],
    permalink: r.external_post_url,
    externalPostId: r.external_post_id,
    topicTag: null,
    replyChainLength: 0,
  }));
}

// =====================================================================
// POST /organic/calendar/load-older  (Patch 4.35)
//
// Schedules an on-demand backfill beyond the rolling 90-day cron
// horizon. Returns immediately; the user polls the calendar endpoint
// again after a moment to see the new posts.
//
// Payload:
//   { accountIds: UUID[]; untilDate: ISO-DATE }
//
// Behavior: enqueues a meta-sync job per account with the requested
// `untilSec` and `sinceSec = untilSec - 365 days`. The worker walks
// through, dedups, upserts.
// =====================================================================

organicRouter.post('/calendar/load-older', requireAuth, async (req: Request, res: Response) => {
  const body = req.body as { accountIds?: string[]; untilDate?: string };
  const accountIds = Array.isArray(body.accountIds) ? body.accountIds : [];
  const untilDate = typeof body.untilDate === 'string' ? new Date(body.untilDate) : null;
  if (accountIds.length === 0 || !untilDate || Number.isNaN(untilDate.getTime())) {
    return res.status(400).json({ error: 'accountIds and a valid untilDate are required' });
  }

  // Verify all accounts belong to this user.
  const { rows: owned } = await query<{ id: string }>(
    `SELECT id FROM organic_connected_accounts
      WHERE user_id = $1 AND id = ANY($2::uuid[]) AND disconnected_at IS NULL`,
    [req.user!.id, accountIds]
  );
  if (owned.length !== accountIds.length) {
    return res.status(403).json({ error: 'One or more accountIds do not belong to you' });
  }

  // Enqueue a per-account on-demand sync. We use the meta-sync queue
  // rather than running inline so the response stays fast and the
  // user's session doesn't hold open a connection during a long
  // multi-page fetch.
  const untilSec = Math.floor(untilDate.getTime() / 1000);
  const sinceSec = untilSec - 365 * 24 * 60 * 60;

  // Import inline to avoid top-of-file changes; this is the only place
  // the route file touches BullMQ.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getMetaSyncQueue } = await import('../services/queue');
  const queue = getMetaSyncQueue();
  for (const accountId of accountIds) {
    await queue.add('on-demand', {
      accountId,
      userId: req.user!.id,
      sinceSec,
      untilSec,
    });
  }

  res.json({ ok: true, queued: accountIds.length });
});

// =====================================================================
// POST /organic/calendar/refresh  (Patch 4.36.1)
//
// Synchronously runs a Meta sync for a SINGLE account and returns the
// result. Used by the manual refresh button on the Pipeline. Unlike
// load-older (which enqueues), this runs inline so the user can see
// the refreshed posts the moment the call returns.
//
// Window: 90 days back from now (matches the hourly cron's refresh
// window). The initial 365-day backfill is reserved for the load-older
// flow.
//
// Payload: { accountId: UUID }
// Returns: { ok: true; fetched: number; upserted: number; error: string|null }
// =====================================================================

organicRouter.post('/calendar/refresh', requireAuth, async (req: Request, res: Response) => {
  const body = req.body as { accountId?: string };
  const accountId = typeof body.accountId === 'string' ? body.accountId : null;
  if (!accountId) {
    return res.status(400).json({ error: 'accountId required' });
  }

  // Ownership check
  const { rows: owned } = await query<{ id: string }>(
    `SELECT id FROM organic_connected_accounts
      WHERE user_id = $1 AND id = $2 AND disconnected_at IS NULL
      LIMIT 1`,
    [req.user!.id, accountId]
  );
  if (owned.length === 0) {
    return res.status(403).json({ error: 'Account not found or disconnected' });
  }

  // Pull the same module the runner uses. Inline so we can await
  // and surface the result directly to the client.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const metaSync = await import('../services/meta-sync');
  const nowSec = Math.floor(Date.now() / 1000);
  const window = {
    sinceSec: nowSec - 90 * 24 * 60 * 60,
    untilSec: nowSec,
  };
  const result = await metaSync.syncAccount(accountId, req.user!.id, window);

  res.json({
    ok: !result.error,
    fetched: result.fetched,
    upserted: result.upserted,
    pagesWalked: result.pagesWalked,
    error: result.error,
  });
});

// ------------------------------------------------------------
// GET /organic/posts/:id — fetch a single post with per-target details
// ------------------------------------------------------------
organicRouter.get('/posts/:id', requireAuth, async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const { rows: postRows } = await query<any>(
    `SELECT * FROM organic_posts WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [id, req.user!.id]
  );
  if (postRows.length === 0) {
    return res.status(404).json({ error: 'Post not found' });
  }
  const { rows: targetRows } = await query<any>(
    `SELECT t.*,
            a.meta->>'name'      AS account_name,
            a.meta->>'username'  AS account_username,
            a.meta->>'picture_url' AS account_picture_url
       FROM organic_post_targets t
       LEFT JOIN organic_connected_accounts a ON a.id = t.account_id
      WHERE t.post_id = $1
      ORDER BY t.created_at ASC`,
    [id]
  );

  // Media items in carousel order, including reply_index so the client
  // can partition head media vs reply media.
  const { rows: mediaRows } = await query<any>(
    `SELECT m.id, m.upload_id, m.kind, m.sort_order, m.reply_index,
            u.content_type, u.width_px, u.height_px
       FROM organic_post_media m
       LEFT JOIN uploads u ON u.id = m.upload_id
      WHERE m.post_id = $1
      ORDER BY m.reply_index ASC, m.sort_order ASC`,
    [id]
  );

  const p = postRows[0];
  res.json({
    post: {
      id: p.id,
      brandId: p.brand_id,
      body: p.body,
      uploadId: p.upload_id,
      status: p.status,
      scheduledFor: p.scheduled_for,
      publishedAt: p.published_at,
      createdAt: p.created_at,
      firstComment: p.first_comment,
      collaborators: p.collaborators ?? [],
      coverUploadId: p.cover_upload_id,
      topicTag: p.topic_tag,
      documentTitle: p.document_title ?? null,
      replyChain: p.reply_chain ?? [],
    },
    media: mediaRows.map((m) => ({
      id: m.id,
      uploadId: m.upload_id,
      kind: m.kind,
      sortOrder: m.sort_order,
      replyIndex: m.reply_index,
      contentType: m.content_type,
      widthPx: m.width_px,
      heightPx: m.height_px,
    })),
    targets: targetRows.map((t) => ({
      id: t.id,
      accountId: t.account_id,
      platform: t.platform,
      bodyOverride: t.body_override,
      status: t.status,
      externalPostId: t.external_post_id,
      externalPostUrl: t.external_post_url,
      errorMessage: t.error_message,
      errorCode: t.error_code,
      publishedAt: t.published_at,
      account: {
        name: t.account_name,
        username: t.account_username,
        pictureUrl: t.account_picture_url,
      },
    })),
  });
});

// =====================================================================
// Ideas + folders (Patch 4.37.1)
//
// Notion-style scratch space. Both ideas and folders are brand-scoped.
// Folders are one-to-many with ideas (an idea can be in zero or one
// folder). All content fields on an idea are optional except brand.
//
// Endpoints:
//   GET    /organic/idea-folders[?brandId]
//   POST   /organic/idea-folders         { brandId, name, color?, emoji? }
//   PATCH  /organic/idea-folders/:id     { name?, color?, emoji? }
//   DELETE /organic/idea-folders/:id     (ideas inside are unfiled, not deleted)
//
//   GET    /organic/ideas[?brandId][&folderId]
//   POST   /organic/ideas                { brandId, title?, body?, uploadId?, mediaKind?, linkUrl?, folderId? }
//   PATCH  /organic/ideas/:id            same shape, all optional
//   DELETE /organic/ideas/:id
// =====================================================================

// ─── Folder schemas
const folderCreateSchema = zod.object({
  brandId: zod.string().uuid(),
  name: zod.string().min(1).max(80),
  color: zod.string().max(20).nullable().optional(),
  emoji: zod.string().max(8).nullable().optional(),
});
const folderUpdateSchema = zod.object({
  name: zod.string().min(1).max(80).optional(),
  color: zod.string().max(20).nullable().optional(),
  emoji: zod.string().max(8).nullable().optional(),
});

// ─── List folders for a brand
organicRouter.get('/idea-folders', requireAuth, async (req: Request, res: Response) => {
  const brandId =
    typeof req.query.brandId === 'string' && req.query.brandId.trim() !== ''
      ? req.query.brandId
      : null;
  const params: Array<string> = [req.user!.id];
  let brandClause = '';
  if (brandId) {
    params.push(brandId);
    brandClause = `AND f.brand_id = $${params.length}::uuid`;
  }
  const { rows } = await query<any>(
    `SELECT f.id, f.brand_id, f.name, f.color, f.emoji,
            f.created_at, f.updated_at,
            (SELECT COUNT(*)::int FROM organic_ideas i
              WHERE i.folder_id = f.id) AS idea_count
       FROM organic_idea_folders f
      WHERE f.user_id = $1
        ${brandClause}
      ORDER BY f.created_at ASC`,
    params
  );
  res.json({
    folders: rows.map((r) => ({
      id: r.id,
      brandId: r.brand_id,
      name: r.name,
      color: r.color,
      emoji: r.emoji,
      ideaCount: r.idea_count ?? 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
});

// ─── Create folder
organicRouter.post('/idea-folders', requireAuth, async (req: Request, res: Response) => {
  const parsed = folderCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid folder payload' });
  }
  const { brandId, name, color, emoji } = parsed.data;
  // Verify brand belongs to user
  const { rows: brandRows } = await query<{ id: string }>(
    `SELECT id FROM brands WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [brandId, req.user!.id]
  );
  if (brandRows.length === 0) {
    return res.status(404).json({ error: 'Brand not found' });
  }
  const { rows } = await query<any>(
    `INSERT INTO organic_idea_folders (user_id, brand_id, name, color, emoji)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, brand_id, name, color, emoji, created_at, updated_at`,
    [req.user!.id, brandId, name, color ?? null, emoji ?? null]
  );
  const r = rows[0];
  res.status(201).json({
    folder: {
      id: r.id,
      brandId: r.brand_id,
      name: r.name,
      color: r.color,
      emoji: r.emoji,
      ideaCount: 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    },
  });
});

// ─── Update folder
organicRouter.patch('/idea-folders/:id', requireAuth, async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const parsed = folderUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid update payload' });
  }
  const { name, color, emoji } = parsed.data;
  // Distinguish "key absent" (don't touch) from "key=null" (clear).
  // zod's .optional() includes the key as undefined when missing, so
  // we use the raw req.body for presence detection.
  const raw = (req.body ?? {}) as Record<string, unknown>;
  const setColor = Object.prototype.hasOwnProperty.call(raw, 'color');
  const setEmoji = Object.prototype.hasOwnProperty.call(raw, 'emoji');

  // Verify ownership
  const { rows: existing } = await query<{ id: string }>(
    `SELECT id FROM organic_idea_folders WHERE id = $1 AND user_id = $2`,
    [id, req.user!.id]
  );
  if (existing.length === 0) {
    return res.status(404).json({ error: 'Folder not found' });
  }
  await query(
    `UPDATE organic_idea_folders
        SET name  = COALESCE($2, name),
            color = CASE WHEN $3::boolean THEN $4 ELSE color END,
            emoji = CASE WHEN $5::boolean THEN $6 ELSE emoji END,
            updated_at = NOW()
      WHERE id = $1`,
    [
      id,
      name ?? null,
      setColor,
      color ?? null,
      setEmoji,
      emoji ?? null,
    ]
  );
  const { rows } = await query<any>(
    `SELECT f.id, f.brand_id, f.name, f.color, f.emoji,
            f.created_at, f.updated_at,
            (SELECT COUNT(*)::int FROM organic_ideas i
              WHERE i.folder_id = f.id) AS idea_count
       FROM organic_idea_folders f
      WHERE f.id = $1`,
    [id]
  );
  const r = rows[0];
  res.json({
    folder: {
      id: r.id,
      brandId: r.brand_id,
      name: r.name,
      color: r.color,
      emoji: r.emoji,
      ideaCount: r.idea_count ?? 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    },
  });
});

// ─── Delete folder (ideas inside become unfiled via FK ON DELETE SET NULL)
organicRouter.delete('/idea-folders/:id', requireAuth, async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const { rowCount } = await query(
    `DELETE FROM organic_idea_folders WHERE id = $1 AND user_id = $2`,
    [id, req.user!.id]
  );
  if (rowCount === 0) {
    return res.status(404).json({ error: 'Folder not found' });
  }
  res.json({ ok: true });
});

// ─── Idea schemas
// Patch 4.37.5: idea schemas now accept either brandId or accountId
// (or both). brandId can be null when the user is in a profile-only
// scope (e.g. an ungrouped account). The route enforces "at least one
// must be set".
const ideaCreateSchema = zod.object({
  brandId: zod.string().uuid().nullable().optional(),
  accountId: zod.string().uuid().nullable().optional(),
  folderId: zod.string().uuid().nullable().optional(),
  title: zod.string().max(200).nullable().optional(),
  body: zod.string().max(8000).optional().default(''),
  uploadId: zod.string().uuid().nullable().optional(),
  mediaKind: zod.enum(['image', 'video']).nullable().optional(),
  linkUrl: zod.string().max(2000).nullable().optional(),
});
const ideaUpdateSchema = zod.object({
  brandId: zod.string().uuid().nullable().optional(),
  accountId: zod.string().uuid().nullable().optional(),
  folderId: zod.string().uuid().nullable().optional(),
  title: zod.string().max(200).nullable().optional(),
  body: zod.string().max(8000).optional(),
  uploadId: zod.string().uuid().nullable().optional(),
  mediaKind: zod.enum(['image', 'video']).nullable().optional(),
  linkUrl: zod.string().max(2000).nullable().optional(),
});

function mapIdeaRow(r: any) {
  return {
    id: r.id,
    brandId: r.brand_id,
    accountId: r.account_id,
    folderId: r.folder_id,
    title: r.title,
    body: r.body,
    uploadId: r.upload_id,
    mediaKind: r.media_kind,
    linkUrl: r.link_url,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ─── List ideas
//
// Filter options:
//   - brandId        — single brand (back-compat)
//   - brandIds       — comma-separated list of brand ids
//   - accountId      — single account
//   - accountIds     — comma-separated list of account ids
//   - folderId       — single folder ('__unfiled__' for unfiled)
//
// "Brand scope" semantics: ideas where i.brand_id IS in the brand list
// OR i.account_id belongs to one of those brands. This way profile-
// tied ideas surface under their parent brand without a special case
// on the client.
organicRouter.get('/ideas', requireAuth, async (req: Request, res: Response) => {
  // Parse list-shaped params. Accept both single and CSV forms.
  const parseList = (single: unknown, plural: unknown): string[] => {
    const out = new Set<string>();
    if (typeof single === 'string' && single.trim()) out.add(single.trim());
    if (typeof plural === 'string' && plural.trim()) {
      for (const s of plural.split(',')) {
        const trimmed = s.trim();
        if (trimmed) out.add(trimmed);
      }
    }
    return Array.from(out);
  };
  const brandIds = parseList(req.query.brandId, req.query.brandIds);
  const accountIds = parseList(req.query.accountId, req.query.accountIds);
  const folderId =
    typeof req.query.folderId === 'string' && req.query.folderId.trim() !== ''
      ? req.query.folderId
      : null;

  const params: Array<unknown> = [req.user!.id];

  // Brand scope: include ideas tied directly to those brands AND ideas
  // tied to accounts in those brands. We compute the union of:
  //   - brandIds passed directly
  //   - brand_ids of any accountIds (looked up here in JS would mean
  //     an extra query; instead we do it as a subselect)
  let scopeClause = '';
  if (brandIds.length > 0 || accountIds.length > 0) {
    const clauses: string[] = [];
    if (brandIds.length > 0) {
      params.push(brandIds);
      clauses.push(`i.brand_id = ANY($${params.length}::uuid[])`);
      // Also: ideas whose account belongs to one of these brands
      clauses.push(
        `i.account_id IN (
           SELECT a.id FROM organic_connected_accounts a
            WHERE a.brand_id = ANY($${params.length}::uuid[])
              AND a.user_id = $1
         )`
      );
    }
    if (accountIds.length > 0) {
      params.push(accountIds);
      clauses.push(`i.account_id = ANY($${params.length}::uuid[])`);
    }
    scopeClause = `AND (${clauses.join(' OR ')})`;
  }

  let folderClause = '';
  if (folderId === '__unfiled__') {
    folderClause = 'AND i.folder_id IS NULL';
  } else if (folderId) {
    params.push(folderId);
    folderClause = `AND i.folder_id = $${params.length}::uuid`;
  }

  const { rows } = await query<any>(
    `SELECT i.id, i.brand_id, i.account_id, i.folder_id, i.title, i.body,
            i.upload_id, i.media_kind, i.link_url,
            i.created_at, i.updated_at
       FROM organic_ideas i
      WHERE i.user_id = $1
        ${scopeClause}
        ${folderClause}
      ORDER BY i.updated_at DESC
      LIMIT 500`,
    params
  );
  res.json({ ideas: rows.map(mapIdeaRow) });
});

// ─── Create idea
organicRouter.post('/ideas', requireAuth, async (req: Request, res: Response) => {
  const parsed = ideaCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid idea payload' });
  }
  const { brandId: rawBrandId, accountId, folderId, title, body, uploadId, mediaKind, linkUrl } = parsed.data;
  if (!rawBrandId && !accountId) {
    return res.status(400).json({ error: 'Idea needs a brandId or accountId (or both)' });
  }

  // If accountId is given but no brandId, derive brandId from the
  // account's parent brand. This satisfies the "profile-tied ideas
  // still show under their brand" requirement.
  let effectiveBrandId: string | null = rawBrandId ?? null;
  if (accountId) {
    const { rows: acctRows } = await query<{ id: string; brand_id: string | null }>(
      `SELECT id, brand_id FROM organic_connected_accounts
        WHERE id = $1 AND user_id = $2`,
      [accountId, req.user!.id]
    );
    if (acctRows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }
    // Auto-fill brand from the account when not provided. Stays NULL
    // if the account is ungrouped.
    if (!effectiveBrandId) effectiveBrandId = acctRows[0].brand_id;
  }

  // Verify brand if we have one
  if (effectiveBrandId) {
    const { rows: brandRows } = await query<{ id: string }>(
      `SELECT id FROM brands WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [effectiveBrandId, req.user!.id]
    );
    if (brandRows.length === 0) {
      return res.status(404).json({ error: 'Brand not found' });
    }
  }
  // Verify folder if provided (must be in same brand as the idea)
  if (folderId) {
    const { rows: folderRows } = await query<{ id: string }>(
      `SELECT id FROM organic_idea_folders
        WHERE id = $1 AND user_id = $2
          AND ($3::uuid IS NULL OR brand_id = $3::uuid)`,
      [folderId, req.user!.id, effectiveBrandId]
    );
    if (folderRows.length === 0) {
      return res.status(404).json({ error: 'Folder not found (or in a different brand)' });
    }
  }
  // Verify upload if provided
  if (uploadId) {
    const { rows: uploadRows } = await query<{ id: string }>(
      `SELECT id FROM uploads WHERE id = $1 AND user_id = $2`,
      [uploadId, req.user!.id]
    );
    if (uploadRows.length === 0) {
      return res.status(404).json({ error: 'Upload not found' });
    }
  }
  const { rows } = await query<any>(
    `INSERT INTO organic_ideas
       (user_id, brand_id, account_id, folder_id, title, body, upload_id, media_kind, link_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      req.user!.id,
      effectiveBrandId,
      accountId ?? null,
      folderId ?? null,
      title ?? null,
      body ?? '',
      uploadId ?? null,
      mediaKind ?? null,
      linkUrl ?? null,
    ]
  );
  res.status(201).json({ idea: mapIdeaRow(rows[0]) });
});

// ─── Update idea
organicRouter.patch('/ideas/:id', requireAuth, async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const parsed = ideaUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid update' });
  }

  // Verify ownership; also fetch current brand/account for downstream
  // validation.
  const { rows: existing } = await query<{ brand_id: string | null; account_id: string | null }>(
    `SELECT brand_id, account_id FROM organic_ideas WHERE id = $1 AND user_id = $2`,
    [id, req.user!.id]
  );
  if (existing.length === 0) {
    return res.status(404).json({ error: 'Idea not found' });
  }

  const p = parsed.data;
  const raw = (req.body ?? {}) as Record<string, unknown>;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(raw, k);

  // If accountId is changing, optionally re-derive brand from the new
  // account (only if brandId isn't being set explicitly in the same
  // call). Mirrors create behavior.
  let derivedBrandId: string | null | undefined = undefined;
  if (has('accountId') && p.accountId) {
    const { rows: acctRows } = await query<{ brand_id: string | null }>(
      `SELECT brand_id FROM organic_connected_accounts
        WHERE id = $1 AND user_id = $2`,
      [p.accountId, req.user!.id]
    );
    if (acctRows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }
    if (!has('brandId')) derivedBrandId = acctRows[0].brand_id;
  }

  // Verify brand if provided
  if (has('brandId') && p.brandId) {
    const { rows: brandRows } = await query<{ id: string }>(
      `SELECT id FROM brands WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [p.brandId, req.user!.id]
    );
    if (brandRows.length === 0) {
      return res.status(404).json({ error: 'Brand not found' });
    }
  }

  // Verify folder is in the same brand context if changed
  if (p.folderId) {
    const nextBrandId = has('brandId')
      ? p.brandId ?? null
      : derivedBrandId !== undefined
        ? derivedBrandId
        : existing[0].brand_id;
    const { rows: folderRows } = await query<{ id: string }>(
      `SELECT id FROM organic_idea_folders
        WHERE id = $1 AND user_id = $2
          AND ($3::uuid IS NULL OR brand_id = $3::uuid)`,
      [p.folderId, req.user!.id, nextBrandId]
    );
    if (folderRows.length === 0) {
      return res.status(404).json({ error: 'Folder not found (or in a different brand)' });
    }
  }
  if (p.uploadId) {
    const { rows: uploadRows } = await query<{ id: string }>(
      `SELECT id FROM uploads WHERE id = $1 AND user_id = $2`,
      [p.uploadId, req.user!.id]
    );
    if (uploadRows.length === 0) {
      return res.status(404).json({ error: 'Upload not found' });
    }
  }

  // Build dynamic SET clause based on which fields are present in the
  // payload. We use the raw req.body to distinguish "key absent" from
  // "key=null" — zod's .optional() pads missing keys with undefined.
  const sets: string[] = [];
  const params: Array<string | null> = [];
  const setField = (col: string, key: keyof typeof p, jsonKey: string) => {
    if (has(jsonKey)) {
      params.push((p[key] as string | null | undefined) ?? null);
      sets.push(`${col} = $${params.length + 1}`);
    }
  };
  setField('brand_id', 'brandId', 'brandId');
  setField('account_id', 'accountId', 'accountId');
  // If we auto-derived a brand because accountId changed and brandId
  // wasn't explicitly set, apply that too.
  if (derivedBrandId !== undefined && !has('brandId')) {
    params.push(derivedBrandId);
    sets.push(`brand_id = $${params.length + 1}`);
  }
  setField('folder_id', 'folderId', 'folderId');
  setField('title', 'title', 'title');
  if (has('body')) {
    params.push(p.body ?? '');
    sets.push(`body = $${params.length + 1}`);
  }
  setField('upload_id', 'uploadId', 'uploadId');
  setField('media_kind', 'mediaKind', 'mediaKind');
  setField('link_url', 'linkUrl', 'linkUrl');

  if (sets.length === 0) {
    // Nothing to change. Return the current row.
    const { rows } = await query<any>(`SELECT * FROM organic_ideas WHERE id = $1`, [id]);
    return res.json({ idea: mapIdeaRow(rows[0]) });
  }
  sets.push(`updated_at = NOW()`);

  const { rows } = await query<any>(
    `UPDATE organic_ideas
        SET ${sets.join(', ')}
      WHERE id = $1
      RETURNING *`,
    [id, ...params]
  );
  res.json({ idea: mapIdeaRow(rows[0]) });
});

// ─── Delete idea
organicRouter.delete('/ideas/:id', requireAuth, async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const { rowCount } = await query(
    `DELETE FROM organic_ideas WHERE id = $1 AND user_id = $2`,
    [id, req.user!.id]
  );
  if (rowCount === 0) {
    return res.status(404).json({ error: 'Idea not found' });
  }
  res.json({ ok: true });
});

// =====================================================================
// Organic Analytics (Patch 4.57.0)
// =====================================================================
//
// Two endpoints:
//   GET /organic/analytics          — aggregate across a brand + date window
//   GET /organic/posts/:id/insights — per-post target breakdown
//
// Fetch policy (set with the user): on each load we live-fetch insights for
// targets whose post published within the last ~1 month (numbers still move),
// and serve everything older from the latest stored snapshot. A force-refresh
// flag re-pulls the whole window regardless of age.

const RECENT_FETCH_DAYS = 31;

interface InsightRow extends Record<string, unknown> {
  impressions: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  clicks: number | null;
  saves: number | null;
  video_views: number | null;
  engagement: number | null;
  extra: Record<string, unknown>;
}

/** Persist a freshly fetched snapshot. Works for both Vass-published posts
 *  (targetId/postId present) and sync-only posts (those are NULL; the row is
 *  identified by account_id + external_post_id). */
async function storeInsightSnapshot(args: {
  targetId: string | null;
  postId: string | null;
  accountId: string;
  externalPostId: string;
  platform: string;
  m: {
    impressions: number | null; reach: number | null; likes: number | null;
    comments: number | null; shares: number | null; clicks: number | null;
    saves: number | null; videoViews: number | null; engagement: number | null;
    extra: Record<string, unknown>;
  };
}): Promise<void> {
  const { targetId, postId, accountId, externalPostId, platform, m } = args;
  await query(
    `INSERT INTO organic_post_insights
       (target_id, post_id, account_id, external_post_id, platform,
        impressions, reach, likes, comments, shares, clicks, saves,
        video_views, engagement, extra, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())`,
    [
      targetId, postId, accountId, externalPostId, platform,
      m.impressions, m.reach, m.likes, m.comments, m.shares, m.clicks, m.saves,
      m.videoViews, m.engagement, JSON.stringify(m.extra ?? {}),
    ]
  );
}

organicRouter.get('/analytics', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const brandId =
    typeof req.query.brandId === 'string' && req.query.brandId.trim() !== ''
      ? req.query.brandId
      : null;
  const accountIdsParam =
    typeof req.query.accountIds === 'string' ? req.query.accountIds : null;
  const accountIds = accountIdsParam
    ? accountIdsParam.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : null;
  const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';

  // Date range: explicit from/to ISO dates. Falls back to last 7 days.
  const parseDate = (v: unknown): Date | null => {
    if (typeof v !== 'string' || !v.trim()) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const now = new Date();
  const toDate = parseDate(req.query.to) ?? now;
  const fromDate =
    parseDate(req.query.from) ?? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  // Optional single-platform filter.
  const platformFilter =
    typeof req.query.platform === 'string' && req.query.platform.trim() !== '' && req.query.platform !== 'all'
      ? req.query.platform.trim()
      : null;

  // 1) Resolve the post set from BOTH sources, scoped by the owning account:
  //   (a) posts published THROUGH Vass            → organic_post_targets
  //   (b) posts pulled from the network by sync    → synced_meta_posts
  // Deduped on (account, external_post_id): a Vass-published post also shows
  // up in sync, and we prefer the Vass row so we keep its post_id + body.
  // Ownership + brand + account scoping all route through
  // organic_connected_accounts (synced rows have no brand_id of their own).
  const params: Array<string | string[] | number | Date> = [userId, fromDate, toDate];
  let brandClause = '';
  if (brandId) {
    params.push(brandId);
    brandClause = `AND acc.brand_id = $${params.length}::uuid`;
  }
  let accountClause = '';
  if (accountIds && accountIds.length > 0) {
    params.push(accountIds);
    accountClause = `AND acc.id = ANY($${params.length}::uuid[])`;
  }
  let platformClause = '';
  if (platformFilter) {
    params.push(platformFilter);
    platformClause = `AND acc.platform = $${params.length}`;
  }

  const { rows: targets } = await query<any>(
    `WITH vass AS (
        SELECT t.id            AS target_id,
               t.post_id       AS post_id,
               t.account_id    AS account_id,
               t.platform      AS platform,
               t.external_post_id,
               t.published_at  AS published_at,
               COALESCE(p.body, '') AS body
          FROM organic_post_targets t
          JOIN organic_posts p ON p.id = t.post_id
          JOIN organic_connected_accounts acc ON acc.id = t.account_id
         WHERE acc.user_id = $1
           AND t.status = 'published'
           AND t.external_post_id IS NOT NULL
           AND t.published_at >= $2::timestamptz
           AND t.published_at <  ($3::timestamptz + interval '1 day')
           ${brandClause}
           ${accountClause}
           ${platformClause}
     ),
     synced AS (
        SELECT NULL::uuid       AS target_id,
               NULL::uuid       AS post_id,
               acc.id           AS account_id,
               s.platform       AS platform,
               s.external_post_id,
               s.posted_at      AS published_at,
               COALESCE(s.body, '') AS body
          FROM synced_meta_posts s
          JOIN organic_connected_accounts acc ON acc.id = s.organic_account_id
         WHERE acc.user_id = $1
           AND s.posted_at >= $2::timestamptz
           AND s.posted_at <  ($3::timestamptz + interval '1 day')
           AND NOT EXISTS (
             SELECT 1 FROM organic_post_targets t2
              WHERE t2.account_id = s.organic_account_id
                AND t2.external_post_id = s.external_post_id
                AND t2.status = 'published'
           )
           ${brandClause}
           ${accountClause}
           ${platformClause}
     )
     SELECT * FROM vass
     UNION ALL
     SELECT * FROM synced
     ORDER BY published_at DESC
     LIMIT 500`,
    params
  );

  // 2) For each target: live-fetch if recent or forced, else use stored latest.
  const recentCutoff = Date.now() - RECENT_FETCH_DAYS * 24 * 60 * 60 * 1000;
  const perPost: any[] = [];
  const availability: Record<string, { available: boolean; reason?: string }> = {};

  for (const t of targets) {
    const publishedMs = t.published_at ? new Date(t.published_at).getTime() : 0;
    const isRecent = publishedMs >= recentCutoff;
    const shouldFetch = forceRefresh || isRecent;

    let metrics: InsightRow | null = null;

    if (shouldFetch) {
      const result = await fetchInsightsForTarget({
        userId,
        accountId: t.account_id,
        platform: t.platform,
        externalPostId: t.external_post_id,
      });
      if (result.ok) {
        availability[t.platform] = { available: true };
        await storeInsightSnapshot({
          targetId: t.target_id ?? null,
          postId: t.post_id ?? null,
          accountId: t.account_id,
          externalPostId: t.external_post_id,
          platform: t.platform,
          m: result.metrics,
        });
        metrics = {
          impressions: result.metrics.impressions,
          reach: result.metrics.reach,
          likes: result.metrics.likes,
          comments: result.metrics.comments,
          shares: result.metrics.shares,
          clicks: result.metrics.clicks,
          saves: result.metrics.saves,
          video_views: result.metrics.videoViews,
          engagement: result.metrics.engagement,
          extra: result.metrics.extra,
        };
      } else {
        // A per-post skip (e.g. a single deleted/stale media id) must NOT mark
        // the whole network unavailable. Only real network/scope errors do.
        const r = result as { perPostSkip?: boolean; reason: string };
        if (!r.perPostSkip && (!availability[t.platform] || availability[t.platform].available === false)) {
          availability[t.platform] = { available: false, reason: result.reason };
        }
      }
    }

    // Fall back to the latest stored snapshot if we didn't fetch (or fetch
    // failed). Keyed on account + external post id so it works for both
    // Vass-published and sync-only posts.
    if (!metrics) {
      const { rows: snap } = await query<InsightRow>(
        `SELECT impressions, reach, likes, comments, shares, clicks, saves,
                video_views, engagement, extra
           FROM organic_post_insights
          WHERE account_id = $1 AND external_post_id = $2
          ORDER BY fetched_at DESC
          LIMIT 1`,
        [t.account_id, t.external_post_id]
      );
      if (snap[0]) metrics = snap[0];
    }

    if (metrics) {
      perPost.push({
        targetId: t.target_id,
        postId: t.post_id,
        accountId: t.account_id,
        platform: t.platform,
        publishedAt: t.published_at,
        body: (t.body ?? '').slice(0, 140),
        metrics,
      });
    }
  }

  // 3) Aggregate totals.
  const totals = perPost.reduce(
    (acc, p) => {
      acc.impressions += p.metrics.impressions ?? 0;
      acc.reach += p.metrics.reach ?? 0;
      acc.likes += p.metrics.likes ?? 0;
      acc.comments += p.metrics.comments ?? 0;
      acc.shares += p.metrics.shares ?? 0;
      acc.clicks += p.metrics.clicks ?? 0;
      acc.saves += p.metrics.saves ?? 0;
      acc.videoViews += p.metrics.video_views ?? 0;
      acc.engagement += p.metrics.engagement ?? 0;
      return acc;
    },
    { impressions: 0, reach: 0, likes: 0, comments: 0, shares: 0, clicks: 0, saves: 0, videoViews: 0, engagement: 0 }
  );

  res.json({
    from: fromDate.toISOString(),
    to: toDate.toISOString(),
    platform: platformFilter ?? 'all',
    postCount: perPost.length,
    totals,
    posts: perPost,
    availability,
  });
});

organicRouter.get('/posts/:id/insights', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const postId = String(req.params.id);

  // Verify ownership.
  const { rows: owns } = await query(
    `SELECT id FROM organic_posts WHERE id = $1 AND user_id = $2`,
    [postId, userId]
  );
  if (owns.length === 0) {
    return res.status(404).json({ error: 'Post not found' });
  }

  const { rows: targets } = await query<any>(
    `SELECT id AS target_id, account_id, platform, external_post_id, published_at, status
       FROM organic_post_targets
      WHERE post_id = $1`,
    [postId]
  );

  const out: any[] = [];
  for (const t of targets) {
    let metrics: InsightRow | null = null;
    let note: string | null = null;
    if (t.status === 'published' && t.external_post_id) {
      const result = await fetchInsightsForTarget({
        userId,
        accountId: t.account_id,
        platform: t.platform,
        externalPostId: t.external_post_id,
      });
      if (result.ok) {
        await storeInsightSnapshot({
          targetId: t.target_id, postId, accountId: t.account_id,
          externalPostId: t.external_post_id, platform: t.platform, m: result.metrics,
        });
        metrics = {
          impressions: result.metrics.impressions, reach: result.metrics.reach,
          likes: result.metrics.likes, comments: result.metrics.comments,
          shares: result.metrics.shares, clicks: result.metrics.clicks,
          saves: result.metrics.saves, video_views: result.metrics.videoViews,
          engagement: result.metrics.engagement, extra: result.metrics.extra,
        };
      } else {
        note = result.reason;
        const { rows: snap } = await query<InsightRow>(
          `SELECT impressions, reach, likes, comments, shares, clicks, saves,
                  video_views, engagement, extra
             FROM organic_post_insights
            WHERE account_id = $1 AND external_post_id = $2
            ORDER BY fetched_at DESC LIMIT 1`,
          [t.account_id, t.external_post_id]
        );
        if (snap[0]) metrics = snap[0];
      }
    } else {
      note = 'Not published yet.';
    }
    out.push({
      targetId: t.target_id,
      accountId: t.account_id,
      platform: t.platform,
      publishedAt: t.published_at,
      metrics,
      note,
    });
  }

  res.json({ postId, targets: out });
});

// =====================================================================
// TEMP diagnostic v2 (Patch 4.58.3) — remove after debugging.
// Runs the REAL analytics resolution for the last 90 days and shows, per
// post: the stored external_post_id, the fetch result (ok / skip / error),
// and the resolved metrics. Visit /api/organic/_diag/analytics
// =====================================================================
organicRouter.get('/_diag/analytics', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const from = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const { rows: targets } = await query<any>(
    `WITH vass AS (
        SELECT t.account_id, t.platform, t.external_post_id, t.published_at
          FROM organic_post_targets t
          JOIN organic_connected_accounts acc ON acc.id = t.account_id
         WHERE acc.user_id = $1 AND t.status='published' AND t.external_post_id IS NOT NULL
           AND t.published_at >= $2::timestamptz
     ), synced AS (
        SELECT acc.id AS account_id, s.platform, s.external_post_id, s.posted_at AS published_at
          FROM synced_meta_posts s
          JOIN organic_connected_accounts acc ON acc.id = s.organic_account_id
         WHERE acc.user_id = $1 AND s.posted_at >= $2::timestamptz
     )
     SELECT * FROM vass UNION ALL SELECT * FROM synced
     ORDER BY published_at DESC LIMIT 40`,
    [userId, from]
  );
  const out: any[] = [];
  for (const t of targets) {
    const result = await fetchInsightsForTarget({
      userId, accountId: t.account_id, platform: t.platform, externalPostId: t.external_post_id,
    });
    out.push({
      platform: t.platform,
      external_post_id: t.external_post_id,
      published_at: t.published_at,
      ok: result.ok,
      reason: result.ok ? null : (result as any).reason,
      perPostSkip: result.ok ? null : (result as any).perPostSkip ?? null,
      metrics: result.ok ? result.metrics : null,
    });
  }
  res.json({ window_days: 90, count: out.length, posts: out });
});

// TEMP diagnostic (4.58.5) — force a live IG sync + report. /api/organic/_diag/sync
organicRouter.get('/_diag/sync', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { rows } = await query<any>(
    `SELECT id, external_id, platform FROM organic_connected_accounts
      WHERE user_id=$1 AND platform='instagram' AND disconnected_at IS NULL LIMIT 1`,
    [userId]
  );
  if (!rows[0]) return res.json({ note: 'no IG account' });
  const acc = rows[0];
  const out: any = { account_id: acc.id, external_id: acc.external_id };
  try {
    const win = await metaSync.deepReconcileWindowFor(acc.id);
    out.window = { sinceSec: win.sinceSec, untilSec: win.untilSec,
      since: new Date(win.sinceSec * 1000).toISOString(),
      until: new Date(win.untilSec * 1000).toISOString() };
    const result = await metaSync.syncAccount(acc.id, userId, win);
    out.syncResult = result;
    const { rows: cnt } = await query<any>(
      `SELECT COUNT(*)::int AS n, MIN(posted_at) AS oldest, MAX(posted_at) AS newest
         FROM synced_meta_posts WHERE organic_account_id=$1`, [acc.id]);
    out.storedRows = cnt[0];
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }
  res.json(out);
});
