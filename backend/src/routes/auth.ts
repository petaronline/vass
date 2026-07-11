/**
 * Auth routes: POST /login, POST /logout, GET /me
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { verifyCredentials, updateSpotifyTrackUrl } from '../services/users';
import { createSession, revokeSession } from '../services/sessions';
import { audit } from '../services/audit';
import { requireAuth, SESSION_COOKIE_NAME } from '../middleware/auth';
import { isProduction } from '../utils/env';

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});

authRouter.post('/login', async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid email or password format' });
  }
  const { email, password } = parsed.data;
  const ipAddress = req.ip;
  const userAgent = req.headers['user-agent'] ?? undefined;

  const user = await verifyCredentials(email.toLowerCase(), password);

  if (!user) {
    await audit({
      action: 'user.login.failure',
      metadata: { email: email.toLowerCase() },
      ipAddress,
    });
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const { token, expiresAt } = await createSession(user.id, ipAddress, userAgent);

  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,            // not readable from JavaScript
    secure: isProduction,      // HTTPS-only in production
    sameSite: 'lax',           // CSRF protection, but still works for normal navigation
    expires: expiresAt,
    path: '/',
  });

  await audit({
    userId: user.id,
    action: 'user.login.success',
    ipAddress,
  });

  return res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      avatarUrl: user.avatarUrl,
    },
  });
});

authRouter.post('/logout', requireAuth, async (req: Request, res: Response) => {
  if (req.sessionToken) {
    await revokeSession(req.sessionToken);
  }
  res.clearCookie(SESSION_COOKIE_NAME);

  await audit({
    userId: req.user?.id,
    action: 'user.logout',
    ipAddress: req.ip,
  });

  return res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req: Request, res: Response) => {
  return res.json({
    user: {
      id: req.user!.id,
      email: req.user!.email,
      name: req.user!.name,
      role: req.user!.role,
      avatarUrl: req.user!.avatarUrl,
      spotifyTrackUrl: req.user!.spotifyTrackUrl,
    },
  });
});

/**
 * PATCH /auth/me — update user-editable fields on the current user.
 * For now: just `spotifyTrackUrl`. Pass `null` to clear it.
 */
authRouter.patch('/me', requireAuth, async (req: Request, res: Response) => {
  const body = req.body ?? {};
  // Validate the URL shape lightly — must be a Spotify-domain URL, or null.
  if ('spotifyTrackUrl' in body) {
    const v = body.spotifyTrackUrl;
    if (v === null || v === '') {
      await updateSpotifyTrackUrl(req.user!.id, null);
    } else if (typeof v === 'string' && v.length <= 500 && /^https:\/\/(open\.)?spotify\.com\//i.test(v)) {
      await updateSpotifyTrackUrl(req.user!.id, v);
    } else {
      return res.status(400).json({
        error: 'spotifyTrackUrl must be a Spotify URL (https://open.spotify.com/...) or null',
      });
    }
  }
  return res.json({ ok: true });
});
