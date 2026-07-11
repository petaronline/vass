/**
 * Settings routes — Meta connection management.
 *
 * Two-layer model (Patch 4.18.1):
 *
 *   • App ID + App Secret are WORKSPACE-WIDE — admin configures once.
 *     POST /settings/meta/credentials is admin-only.
 *
 *   • OAuth state (access token + connected FB user) is PER-USER.
 *     Every user OAuths individually against the workspace App. Each
 *     gets their own token, scoped to their own Facebook pages and ad
 *     accounts. /oauth-url, /callback, /disconnect are open to any
 *     authed user.
 *
 * Endpoints:
 *   GET  /settings/meta              → workspace App status + MY OAuth status
 *   POST /settings/meta/credentials  → admin saves the workspace App
 *   GET  /settings/meta/oauth-url    → URL to OAuth ME against the workspace App
 *   GET  /settings/meta/callback     → store MY token after Facebook redirect
 *   POST /settings/meta/disconnect   → clear MY token
 */
import { Router, Request, Response } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { requireAuth, requireRole } from '../middleware/auth';
import * as metaConn from '../services/meta-connection';
import * as metaApi from '../services/meta';
import { audit } from '../services/audit';
import { query } from '../db/pool';
import { env } from '../utils/env';

export const settingsRouter = Router();

function getRedirectUri(_req: Request): string {
  return `${env.FRONTEND_URL}/api/settings/meta/callback`;
}

// ------------------------------------------------------------
// GET /settings/meta
//
// Returns BOTH the workspace App status (is it configured?) AND the
// calling user's personal connection status (have they OAuthed?). The
// frontend uses both to decide what to render.
// ------------------------------------------------------------
settingsRouter.get('/meta', requireAuth, async (req: Request, res: Response) => {
  const [appId, conn] = await Promise.all([
    metaConn.getDisplayableAppId(),
    metaConn.getConnection(req.user!.id),
  ]);

  const isExpired = conn?.tokenExpiresAt
    ? conn.tokenExpiresAt.getTime() < Date.now()
    : false;

  res.json({
    // Workspace
    hasCredentials: !!appId,
    appId, // safe to display
    // Personal
    connected: !!(conn?.hasAccessToken) && !isExpired,
    connectedUserName: conn?.connectedUserName ?? null,
    connectedUserId: conn?.connectedUserMetaId ?? null,
    connectedAt: conn?.connectedAt ? conn.connectedAt.toISOString() : null,
    tokenExpiresAt: conn?.tokenExpiresAt ? conn.tokenExpiresAt.toISOString() : null,
    tokenExpired: isExpired,
  });
});

// ------------------------------------------------------------
// POST /settings/meta/credentials  (admin only)
// ------------------------------------------------------------
const credentialsSchema = z.object({
  appId: z.string().min(1).max(50),
  appSecret: z.string().min(1).max(200),
});

settingsRouter.post(
  '/meta/credentials',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid App ID or App Secret format' });
    }

    await metaConn.saveAppCredentials(
      req.user!.id,
      parsed.data.appId,
      parsed.data.appSecret
    );

    await audit({
      userId: req.user!.id,
      action: 'meta.credentials.saved',
      ipAddress: req.ip,
    });

    res.json({ ok: true });
  }
);

// ------------------------------------------------------------
// GET /settings/meta/oauth-url  (any authed user)
//
// Workspace App must be configured first.
// ------------------------------------------------------------
settingsRouter.get(
  '/meta/oauth-url',
  requireAuth,
  async (req: Request, res: Response) => {
    const creds = await metaConn.getAppCredentials();
    if (!creds) {
      return res.status(400).json({
        error: 'The workspace Meta App is not configured. Ask an admin to set it up in Settings → Meta.',
      });
    }

    const state = crypto.randomBytes(32).toString('base64url');
    await query(
      'INSERT INTO oauth_states (state, user_id) VALUES ($1, $2)',
      [state, req.user!.id]
    );

    const url = metaApi.buildOAuthUrl({
      appId: creds.appId,
      redirectUri: getRedirectUri(req),
      state,
    });

    res.json({ url });
  }
);

// ------------------------------------------------------------
// GET /settings/meta/callback  (any authed user)
//
// Stores the resulting token on req.user — each user gets their own.
// ------------------------------------------------------------
settingsRouter.get('/meta/callback', requireAuth, async (req: Request, res: Response) => {
  const code = typeof req.query.code === 'string' ? req.query.code : null;
  const state = typeof req.query.state === 'string' ? req.query.state : null;
  const error = typeof req.query.error === 'string' ? req.query.error : null;
  const errorDescription =
    typeof req.query.error_description === 'string' ? req.query.error_description : null;

  const redirectBack = (status: 'success' | 'error', message?: string) => {
    const url = new URL(`${env.FRONTEND_URL}/settings/meta`);
    url.searchParams.set('status', status);
    if (message) url.searchParams.set('message', message);
    res.redirect(url.toString());
  };

  if (error) return redirectBack('error', errorDescription || error);
  if (!code || !state) return redirectBack('error', 'Missing code or state parameter');

  const { rows: stateRows } = await query<{ user_id: string; expires_at: Date }>(
    `SELECT user_id, expires_at FROM oauth_states WHERE state = $1 LIMIT 1`,
    [state]
  );
  if (stateRows.length === 0) return redirectBack('error', 'Invalid or expired state token');
  const stateRow = stateRows[0];
  if (stateRow.expires_at.getTime() < Date.now()) {
    return redirectBack('error', 'State token expired — please try again');
  }
  if (stateRow.user_id !== req.user!.id) {
    return redirectBack('error', 'State token belongs to a different user');
  }

  await query('DELETE FROM oauth_states WHERE state = $1', [state]);

  // Workspace credentials — same for every user
  const creds = await metaConn.getAppCredentials();
  if (!creds) return redirectBack('error', 'Workspace Meta App credentials are missing');

  try {
    const short = await metaApi.exchangeCodeForToken({
      appId: creds.appId,
      appSecret: creds.appSecret,
      redirectUri: getRedirectUri(req),
      code,
    });

    const long = await metaApi.exchangeForLongLivedToken({
      appId: creds.appId,
      appSecret: creds.appSecret,
      shortLivedToken: short.accessToken,
    });

    const expiresAt = new Date(Date.now() + long.expiresIn * 1000);
    const me = await metaApi.fetchMe(long.accessToken);

    // Store on the calling user only
    await metaConn.saveAccessToken(
      req.user!.id,
      long.accessToken,
      expiresAt,
      me.id,
      me.name
    );

    await audit({
      userId: req.user!.id,
      action: 'meta.oauth.connected',
      metadata: { meta_user_id: me.id, meta_user_name: me.name },
      ipAddress: req.ip,
    });

    return redirectBack('success', `Connected as ${me.name}`);
  } catch (err) {
    console.error('[meta/callback] OAuth exchange failed:', err);
    const msg = err instanceof Error ? err.message : 'Unknown error during OAuth exchange';
    return redirectBack('error', msg);
  }
});

// ------------------------------------------------------------
// POST /settings/meta/disconnect  (any authed user, clears OWN token)
// ------------------------------------------------------------
settingsRouter.post(
  '/meta/disconnect',
  requireAuth,
  async (req: Request, res: Response) => {
    await metaConn.clearAccessToken(req.user!.id);
    await audit({
      userId: req.user!.id,
      action: 'meta.oauth.disconnected',
      ipAddress: req.ip,
    });
    res.json({ ok: true });
  }
);

// =====================================================================
// Threads App credentials (Patch 4.34)
//
// Separate from the Meta App creds because Meta requires a different
// app registration for Threads. Workspace-wide, admin-only writes.
// =====================================================================

import * as threadsCreds from '../services/threads-credentials';
import * as tiktokCreds from '../services/tiktok-credentials';
import * as linkedinCreds from '../services/linkedin-credentials';

// GET /settings/threads-app — readable by any authed user (no secrets returned)
settingsRouter.get('/threads-app', requireAuth, async (_req: Request, res: Response) => {
  const display = await threadsCreds.getDisplayableThreadsConfig();
  res.json({
    appId: display.appId,
    hasSecret: display.hasSecret,
    redirectUri: display.redirectUri,
    hasCredentials: display.appId !== null && display.hasSecret,
  });
});

// POST /settings/threads-app  (admin only)
const threadsCredentialsSchema = z.object({
  appId: z.string().min(1).max(50).optional(),
  appSecret: z.string().min(1).max(500).optional(),
  redirectUri: z.string().url().max(500).optional(),
});

settingsRouter.post(
  '/threads-app',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    const parsed = threadsCredentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid Threads credentials format' });
    }
    await threadsCreds.saveThreadsCredentials(req.user!.id, parsed.data);
    await audit({
      userId: req.user!.id,
      action: 'threads.credentials.saved',
      ipAddress: req.ip,
    });
    res.json({ ok: true });
  }
);

// GET /settings/tiktok-app — readable by any authed user (no secrets)
settingsRouter.get('/tiktok-app', requireAuth, async (_req: Request, res: Response) => {
  const display = await tiktokCreds.getDisplayableTikTokConfig();
  res.json({
    clientKey: display.clientKey,
    hasSecret: display.hasSecret,
    redirectUri: display.redirectUri,
    hasCredentials: display.clientKey !== null && display.hasSecret,
  });
});

// POST /settings/tiktok-app  (admin only)
const tiktokCredentialsSchema = z.object({
  clientKey: z.string().min(1).max(100).optional(),
  clientSecret: z.string().min(1).max(500).optional(),
  redirectUri: z.string().url().max(500).optional(),
});

settingsRouter.post(
  '/tiktok-app',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    const parsed = tiktokCredentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid TikTok credentials format' });
    }
    await tiktokCreds.saveTikTokCredentials(req.user!.id, parsed.data);
    await audit({
      userId: req.user!.id,
      action: 'tiktok.credentials.saved',
      ipAddress: req.ip,
    });
    res.json({ ok: true });
  }
);

// GET /settings/linkedin-app — readable by any authed user (no secrets)
settingsRouter.get('/linkedin-app', requireAuth, async (_req: Request, res: Response) => {
  const display = await linkedinCreds.getDisplayableLinkedInConfig();
  res.json({
    clientId: display.clientId,
    hasSecret: display.hasSecret,
    redirectUri: display.redirectUri,
    hasCredentials: display.clientId !== null && display.hasSecret,
  });
});

// POST /settings/linkedin-app  (admin only)
const linkedinCredentialsSchema = z.object({
  clientId: z.string().min(1).max(100).optional(),
  clientSecret: z.string().min(1).max(500).optional(),
  redirectUri: z.string().url().max(500).optional(),
});

settingsRouter.post(
  '/linkedin-app',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    const parsed = linkedinCredentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid LinkedIn credentials format' });
    }
    await linkedinCreds.saveLinkedInCredentials(req.user!.id, parsed.data);
    await audit({
      userId: req.user!.id,
      action: 'linkedin.credentials.saved',
      ipAddress: req.ip,
    });
    res.json({ ok: true });
  }
);

// GET /settings/linkedin-org-app — Community Management (Pages) app creds
settingsRouter.get('/linkedin-org-app', requireAuth, async (_req: Request, res: Response) => {
  const display = await linkedinCreds.getDisplayableLinkedInConfig('org');
  res.json({
    clientId: display.clientId,
    hasSecret: display.hasSecret,
    redirectUri: display.redirectUri,
    hasCredentials: display.clientId !== null && display.hasSecret,
  });
});

// POST /settings/linkedin-org-app  (admin only)
settingsRouter.post(
  '/linkedin-org-app',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    const parsed = linkedinCredentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid LinkedIn credentials format' });
    }
    await linkedinCreds.saveLinkedInCredentials(req.user!.id, parsed.data, 'org');
    await audit({
      userId: req.user!.id,
      action: 'linkedin.org.credentials.saved',
      ipAddress: req.ip,
    });
    res.json({ ok: true });
  }
);

