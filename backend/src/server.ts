/**
 * Vass — backend entry point.
 *
 * Boot order:
 *   1. Load + validate env vars (utils/env.ts will throw if anything's wrong)
 *   2. Apply security middleware (helmet, CORS, cookie parser, body parser)
 *   3. Mount routes
 *   4. Start the HTTP server
 *   5. Set up graceful shutdown
 */
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import { env, isProduction } from './utils/env';
import { closePool } from './db/pool';
import { cleanupExpiredSessions } from './services/sessions';

import { authRouter } from './routes/auth';
import { healthRouter } from './routes/health';
import { settingsRouter } from './routes/settings';
import { adAccountsRouter } from './routes/ad-accounts';
import { launchDefaultsRouter } from './routes/launch-defaults';
import { uploadsRouter } from './routes/uploads';
import { launchesRouter } from './routes/launches';
import { adLaunchesRouter } from './routes/ad-launches';
import { metaExploreRouter } from './routes/meta-explore';
import { auditsRouter } from './routes/audits';
import { commentGuardsRouter } from './routes/comment-guards';
import { sheetImportsRouter } from './routes/sheet-imports';
import { brandingRouter } from './routes/branding';
import { teamRouter } from './routes/team';
import { organicRouter } from './routes/organic';
import { brandsRouter } from './routes/brands';

const app = express();

// Trust the reverse proxy (Apache/nginx in front of us). Required for
// req.ip and secure cookies to work correctly.
app.set('trust proxy', 1);

// ---- Security & parsing middleware ----
app.use(
  helmet({
    contentSecurityPolicy: false, // we serve no HTML, so CSP doesn't apply here
  })
);

app.use(
  cors({
    origin: env.FRONTEND_URL,
    credentials: true, // allow cookies across origins
  })
);

app.use(express.json({ limit: '4mb' }));
app.use(cookieParser());

// ---- Request logging (minimal) ----
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ---- Routes ----
app.use('/', healthRouter);
app.use('/auth', authRouter);
// launchDefaultsRouter has paths under both /settings/... and /ad-accounts/...
// so we mount it at root and let it own its own paths
app.use('/', launchDefaultsRouter);
app.use('/settings', settingsRouter);
app.use('/ad-accounts', adAccountsRouter);
app.use('/uploads', uploadsRouter);
app.use('/launches', launchesRouter);
app.use('/ad-launches', adLaunchesRouter);
app.use('/meta', metaExploreRouter);
app.use('/audits', auditsRouter);
app.use('/comment-guards', commentGuardsRouter);
app.use('/sheet-imports', sheetImportsRouter);
app.use('/branding', brandingRouter);
app.use('/team', teamRouter);
app.use('/organic', organicRouter);
app.use('/brands', brandsRouter);

// ---- 404 handler ----
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ---- Error handler (must be 4 args for Express to recognize it) ----
app.use(
  (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[error]', err);
    res.status(500).json({
      error: isProduction ? 'Internal server error' : err.message,
    });
  }
);

// ---- Start ----
const server = app.listen(env.PORT, '0.0.0.0', () => {
  console.log(`[vass] Backend listening on 0.0.0.0:${env.PORT} (${env.NODE_ENV})`);
});

// ---- Periodic session cleanup (once per hour) ----
const cleanupInterval = setInterval(async () => {
  try {
    const deleted = await cleanupExpiredSessions();
    if (deleted > 0) console.log(`[cleanup] Removed ${deleted} expired sessions`);
  } catch (err) {
    console.error('[cleanup] Error during cleanup:', err);
  }
  // Also clean expired oauth states
  try {
    const { query } = await import('./db/pool');
    const result = await query('DELETE FROM oauth_states WHERE expires_at < NOW()');
    if (result.rowCount > 0) console.log(`[cleanup] Removed ${result.rowCount} expired oauth states`);
  } catch (err) {
    console.error('[cleanup] Error during oauth state cleanup:', err);
  }
}, 1000 * 60 * 60);

// ---- Graceful shutdown ----
async function shutdown(signal: string): Promise<void> {
  console.log(`[vass] ${signal} received, shutting down gracefully...`);
  clearInterval(cleanupInterval);
  server.close(() => {
    console.log('[vass] HTTP server closed');
  });
  await closePool();
  console.log('[vass] Database pool closed');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
