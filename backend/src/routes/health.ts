/**
 * Health check — pings the DB to confirm we're alive.
 * Used by Docker healthchecks and any uptime monitor you add later.
 */
import { Router, Request, Response } from 'express';
import { query } from '../db/pool';

export const healthRouter = Router();

healthRouter.get('/health', async (_req: Request, res: Response) => {
  try {
    await query('SELECT 1');
    return res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[health] DB check failed:', err);
    return res.status(503).json({ status: 'unhealthy', error: 'Database unreachable' });
  }
});
