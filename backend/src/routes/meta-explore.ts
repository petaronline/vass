/**
 * Meta exploration endpoints.
 * Used by the Launch UI to populate the campaign + ad set dropdowns.
 *
 *   GET /meta/ad-accounts/:id/campaigns?activeOnly=true|false
 *   GET /meta/campaigns/:metaCampaignId/ad-sets?activeOnly=true|false
 *
 * The activeOnly param defaults to true. When true, only campaigns/ad sets
 * with effective_status=ACTIVE are returned. When false, everything except
 * DELETED/ARCHIVED.
 *
 * These are thin proxies — Vass doesn't store campaigns/ad sets, it just
 * passes them through. The ad account id in the first endpoint is Vass's
 * UUID (we look up the Meta ID + tenant via DB).
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { findAdAccountById } from '../services/ad-accounts';
import * as metaConn from "../services/meta-connection";
import * as meta from '../services/meta';

export const metaExploreRouter = Router();

const UUID_RX = /^[0-9a-f-]{36}$/i;
// Meta campaign IDs are big integers — accept digits only
const META_ID_RX = /^[0-9_act]+$/i;

/** Parse activeOnly query param. Defaults to true. */
function parseActiveOnly(req: Request): boolean {
  const raw = req.query.activeOnly;
  if (raw === undefined || raw === null) return true;
  if (typeof raw !== 'string') return true;
  return !(raw === 'false' || raw === '0');
}

metaExploreRouter.get(
  '/ad-accounts/:id/campaigns',
  requireAuth,
  async (req: Request, res: Response) => {
    const id = req.params.id as string;
    if (!UUID_RX.test(id)) {
      return res.status(400).json({ error: 'Invalid ad account id' });
    }
    const account = await findAdAccountById(req.user!.id, id);
    if (!account) {
      return res.status(404).json({ error: 'Ad account not found' });
    }
    if (!account.isEnabled) {
      return res.status(403).json({ error: 'Ad account is not enabled' });
    }
    const token = await metaConn.getAccessToken(req.user!.id);
    if (!token) {
      return res.status(400).json({ error: 'Meta is not connected' });
    }
    try {
      const campaigns = await meta.listCampaigns(token, account.metaAccountId, parseActiveOnly(req));
      res.json({ campaigns });
    } catch (err) {
      console.error('[meta/campaigns] failed:', err);
      res.status(502).json({
        error: err instanceof meta.MetaApiError ? err.message : 'Failed to list campaigns',
      });
    }
  }
);

metaExploreRouter.get(
  '/campaigns/:metaCampaignId/ad-sets',
  requireAuth,
  async (req: Request, res: Response) => {
    const id = req.params.metaCampaignId as string;
    if (!META_ID_RX.test(id)) {
      return res.status(400).json({ error: 'Invalid campaign id' });
    }
    const token = await metaConn.getAccessToken(req.user!.id);
    if (!token) {
      return res.status(400).json({ error: 'Meta is not connected' });
    }
    try {
      const adSets = await meta.listAdSets(token, id, parseActiveOnly(req));
      res.json({ adSets });
    } catch (err) {
      console.error('[meta/ad-sets] failed:', err);
      res.status(502).json({
        error: err instanceof meta.MetaApiError ? err.message : 'Failed to list ad sets',
      });
    }
  }
);

// ============================================================
// Patch 3.3 — inline ad set creation
// ============================================================

/** GET /meta/ad-accounts/:id/pixels — list pixels for an account */
metaExploreRouter.get(
  '/ad-accounts/:id/pixels',
  requireAuth,
  async (req: Request, res: Response) => {
    const id = req.params.id as string;
    if (!UUID_RX.test(id)) {
      return res.status(400).json({ error: 'Invalid ad account id' });
    }
    const account = await findAdAccountById(req.user!.id, id);
    if (!account) return res.status(404).json({ error: 'Ad account not found' });
    if (!account.isEnabled) return res.status(403).json({ error: 'Ad account is not enabled' });

    const token = await metaConn.getAccessToken(req.user!.id);
    if (!token) return res.status(400).json({ error: 'Meta is not connected' });

    try {
      const pixels = await meta.listPixelsForAccount(token, account.metaAccountId);
      res.json({ pixels });
    } catch (err) {
      console.error('[meta/pixels] failed:', err);
      res.status(502).json({
        error: err instanceof meta.MetaApiError ? err.message : 'Failed to list pixels',
      });
    }
  }
);

/** GET /meta/pixels/:pixelId/events — events tracked by a pixel */
metaExploreRouter.get(
  '/pixels/:pixelId/events',
  requireAuth,
  async (req: Request, res: Response) => {
    const id = req.params.pixelId as string;
    if (!META_ID_RX.test(id)) {
      return res.status(400).json({ error: 'Invalid pixel id' });
    }
    const token = await metaConn.getAccessToken(req.user!.id);
    if (!token) return res.status(400).json({ error: 'Meta is not connected' });

    try {
      const events = await meta.listPixelEvents(token, id);
      res.json({ events });
    } catch (err) {
      console.error('[meta/events] failed:', err);
      res.status(502).json({
        error: err instanceof meta.MetaApiError ? err.message : 'Failed to list pixel events',
      });
    }
  }
);

/** GET /meta/campaigns/:metaCampaignId/objective — read a campaign's objective */
metaExploreRouter.get(
  '/campaigns/:metaCampaignId/objective',
  requireAuth,
  async (req: Request, res: Response) => {
    const id = req.params.metaCampaignId as string;
    if (!META_ID_RX.test(id)) {
      return res.status(400).json({ error: 'Invalid campaign id' });
    }
    const token = await metaConn.getAccessToken(req.user!.id);
    if (!token) return res.status(400).json({ error: 'Meta is not connected' });

    try {
      const info = await meta.getCampaignObjective(token, id);
      res.json({ objective: info.objective, cboEnabled: info.cboEnabled });
    } catch (err) {
      console.error('[meta/objective] failed:', err);
      res.status(502).json({
        error: err instanceof meta.MetaApiError ? err.message : 'Failed to fetch objective',
      });
    }
  }
);

/** POST /meta/ad-accounts/:id/ad-sets — create a new ad set under a campaign */
import { z } from 'zod';
const createAdSetSchema = z.object({
  metaCampaignId: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  status: z.enum(['ACTIVE', 'PAUSED']),
  budgetMode: z.enum(['daily', 'lifetime']),
  budgetAmountMinorUnits: z.number().int().positive().max(100_000_000_000), // $1B sanity cap
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  optimizationGoal: z.string().min(1).max(64),
  billingEvent: z.string().min(1).max(64).optional(),
  bidStrategy: z.string().min(1).max(64).optional(),
  countries: z.array(z.string().length(2)).min(1).max(60),
  ageMin: z.number().int().min(13).max(65),
  ageMax: z.number().int().min(13).max(65),
  gender: z.enum(['all', 'male', 'female']),
  placementsAuto: z.boolean(),
  publisherPlatforms: z
    .array(z.enum(['facebook', 'instagram', 'messenger', 'audience_network']))
    .optional(),
  pixelId: z.string().optional(),
  customEventType: z.string().optional(),
  pageId: z.string().optional(),
  /**
   * If true, the parent campaign has Campaign Budget Optimization on.
   * In that case Vass must NOT send a daily_budget/lifetime_budget on
   * the ad set — Meta rejects with subcode 4834009 ('uniform pixel' error).
   * Frontend detects this from getCampaignObjective and passes it through.
   */
  cboEnabled: z.boolean().optional(),
});

metaExploreRouter.post(
  '/ad-accounts/:id/ad-sets',
  requireAuth,
  async (req: Request, res: Response) => {
    const id = req.params.id as string;
    if (!UUID_RX.test(id)) {
      return res.status(400).json({ error: 'Invalid ad account id' });
    }
    const account = await findAdAccountById(req.user!.id, id);
    if (!account) return res.status(404).json({ error: 'Ad account not found' });
    if (!account.isEnabled) return res.status(403).json({ error: 'Ad account is not enabled' });

    const parsed = createAdSetSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues });
    }

    // Cross-field validation
    if (parsed.data.ageMin > parsed.data.ageMax) {
      return res.status(400).json({ error: 'Age min must be ≤ age max' });
    }
    if (parsed.data.budgetMode === 'lifetime' && !parsed.data.endTime && !parsed.data.cboEnabled) {
      return res.status(400).json({ error: 'End time is required for lifetime budgets' });
    }
    if (!parsed.data.placementsAuto && (!parsed.data.publisherPlatforms || parsed.data.publisherPlatforms.length === 0)) {
      return res.status(400).json({ error: 'Pick at least one placement platform (or use Automatic)' });
    }

    const token = await metaConn.getAccessToken(req.user!.id);
    if (!token) return res.status(400).json({ error: 'Meta is not connected' });

    try {
      const result = await meta.createAdSet(token, {
        metaAdAccountId: account.metaAccountId,
        ...parsed.data,
      });
      res.status(201).json({ id: result.id });
    } catch (err) {
      console.error('[meta/create-ad-set] failed:', err);
      res.status(502).json({
        error: err instanceof meta.MetaApiError ? err.message : 'Failed to create ad set',
      });
    }
  }
);

/** POST /meta/ad-accounts/:id/campaigns — create a new campaign */
const createCampaignSchema = z
  .object({
    name: z.string().min(1).max(400),
    objective: z.enum([
      'OUTCOME_AWARENESS',
      'OUTCOME_TRAFFIC',
      'OUTCOME_ENGAGEMENT',
      'OUTCOME_LEADS',
      'OUTCOME_APP_PROMOTION',
      'OUTCOME_SALES',
    ]),
    status: z.enum(['ACTIVE', 'PAUSED']),
    cboEnabled: z.boolean(),
    budgetMode: z.enum(['daily', 'lifetime']).optional(),
    budgetAmountMinorUnits: z.number().int().positive().max(100_000_000_000).optional(),
    bidStrategy: z.string().min(1).max(64).optional(),
  })
  .refine(
    (d) => !d.cboEnabled || (d.budgetMode && d.budgetAmountMinorUnits && d.budgetAmountMinorUnits > 0),
    { message: 'CBO campaigns require a budget mode + amount' }
  );

metaExploreRouter.post(
  '/ad-accounts/:id/campaigns',
  requireAuth,
  async (req: Request, res: Response) => {
    const id = req.params.id as string;
    if (!UUID_RX.test(id)) {
      return res.status(400).json({ error: 'Invalid ad account id' });
    }
    const account = await findAdAccountById(req.user!.id, id);
    if (!account) return res.status(404).json({ error: 'Ad account not found' });
    if (!account.isEnabled) return res.status(403).json({ error: 'Ad account is not enabled' });

    const parsed = createCampaignSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues });
    }

    const token = await metaConn.getAccessToken(req.user!.id);
    if (!token) return res.status(400).json({ error: 'Meta is not connected' });

    try {
      const result = await meta.createCampaign(token, {
        metaAdAccountId: account.metaAccountId,
        ...parsed.data,
      });
      res.status(201).json({ id: result.id });
    } catch (err) {
      console.error('[meta/create-campaign] failed:', err);
      res.status(502).json({
        error: err instanceof meta.MetaApiError ? err.message : 'Failed to create campaign',
      });
    }
  }
);
