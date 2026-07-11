/**
 * Ad accounts routes (per-user as of Patch 4.18).
 *
 * Each user's ad accounts are separate. Sync and toggle no longer require
 * admin role — every user manages their own list of enabled ad accounts.
 *
 * GET    /ad-accounts          → list MY ad accounts
 * POST   /ad-accounts/sync     → re-fetch MY accounts from Meta
 * PATCH  /ad-accounts/:id      → toggle is_enabled on one of MY rows
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import * as adAccounts from '../services/ad-accounts';
import * as metaConn from '../services/meta-connection';
import { audit } from '../services/audit';

export const adAccountsRouter = Router();

// ------------------------------------------------------------
// GET /ad-accounts — list MY accounts
// Returns enabled-only by default; ?all=true to see disabled too.
// ------------------------------------------------------------
adAccountsRouter.get('/', requireAuth, async (req: Request, res: Response) => {
  const onlyEnabled = req.query.all !== 'true';
  const accounts = await adAccounts.listAdAccounts(req.user!.id, { onlyEnabled });
  res.json({ accounts });
});

// ------------------------------------------------------------
// POST /ad-accounts/sync — re-fetch MY accounts from Meta
// ------------------------------------------------------------
adAccountsRouter.post('/sync', requireAuth, async (req: Request, res: Response) => {
  const token = await metaConn.getAccessToken(req.user!.id);
  if (!token) {
    return res.status(400).json({ error: 'Meta is not connected. Connect first.' });
  }

  try {
    const result = await adAccounts.syncFromMeta(req.user!.id, token);
    await audit({
      userId: req.user!.id,
      action: 'ad_accounts.synced',
      metadata: result,
      ipAddress: req.ip,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[ad-accounts/sync] failed:', err);
    const msg = err instanceof Error ? err.message : 'Unknown sync error';
    res.status(500).json({ error: msg });
  }
});

// ------------------------------------------------------------
// PATCH /ad-accounts/:id — toggle is_enabled on one of MY rows
// ------------------------------------------------------------
// ------------------------------------------------------------
// PATCH /ad-accounts/:id — update is_enabled and/or brand_id
// Body may contain either or both:
//   { isEnabled: boolean }
//   { brandId: string | null }   (null = un-group)
// ------------------------------------------------------------
const patchSchema = z.object({
  isEnabled: z.boolean().optional(),
  brandId: z.string().uuid().nullable().optional(),
});

adAccountsRouter.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Body must include isEnabled (boolean) and/or brandId (uuid|null)' });
  }
  const id = req.params.id as string;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  const raw = (req.body ?? {}) as Record<string, unknown>;
  let account = null;

  // is_enabled toggle
  if (Object.prototype.hasOwnProperty.call(raw, 'isEnabled') && typeof parsed.data.isEnabled === 'boolean') {
    account = await adAccounts.setEnabled(req.user!.id, id, parsed.data.isEnabled);
    if (!account) {
      return res.status(404).json({ error: 'Ad account not found' });
    }
    await audit({
      userId: req.user!.id,
      action: 'ad_account.toggled',
      resourceType: 'ad_account',
      resourceId: id,
      metadata: { isEnabled: parsed.data.isEnabled },
      ipAddress: req.ip,
    });
  }

  // brand assignment
  if (Object.prototype.hasOwnProperty.call(raw, 'brandId')) {
    account = await adAccounts.setBrand(req.user!.id, id, parsed.data.brandId ?? null);
    if (!account) {
      return res.status(404).json({ error: 'Ad account or brand not found' });
    }
    await audit({
      userId: req.user!.id,
      action: 'ad_account.brand_assigned',
      resourceType: 'ad_account',
      resourceId: id,
      metadata: { brandId: parsed.data.brandId ?? null },
      ipAddress: req.ip,
    });
  }

  if (!account) {
    return res.status(400).json({ error: 'Nothing to update' });
  }
  res.json({ account });
});
