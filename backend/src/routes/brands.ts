/**
 * Brands routes — per-user brand groupings for connected social accounts.
 *
 * Endpoints:
 *   GET    /brands                          → list my brands
 *   POST   /brands                          → create a brand
 *   PATCH  /brands/:id                      → rename / recolor / reorder
 *   DELETE /brands/:id                      → delete (accounts drop to Unassigned)
 *   POST   /brands/assign-account           → set / clear an account's brand
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import * as brandsSvc from '../services/brands';

export const brandsRouter = Router();

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

// ------------------------------------------------------------
// GET /brands
// ------------------------------------------------------------
brandsRouter.get('/', requireAuth, async (req: Request, res: Response) => {
  const brands = await brandsSvc.listBrands(req.user!.id);
  res.json({ brands });
});

// ------------------------------------------------------------
// POST /brands
// ------------------------------------------------------------
const createSchema = z.object({
  name: z.string().min(1).max(80),
  color: z.string().regex(HEX_COLOR).optional(),
});

brandsRouter.post('/', requireAuth, async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Name is required (1–80 chars). Color must be #RRGGBB.' });
  }
  try {
    const brand = await brandsSvc.createBrand({
      userId: req.user!.id,
      name: parsed.data.name,
      color: parsed.data.color,
    });
    res.status(201).json({ brand });
  } catch (err) {
    // Likely a duplicate name. Unique violation = Postgres code 23505.
    const code = (err as { code?: string })?.code;
    if (code === '23505') {
      return res.status(409).json({ error: 'A brand with that name already exists' });
    }
    throw err;
  }
});

// ------------------------------------------------------------
// PATCH /brands/:id
// ------------------------------------------------------------
const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  color: z.string().regex(HEX_COLOR).optional(),
  sortOrder: z.number().int().optional(),
});

brandsRouter.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid update fields' });
  }
  try {
    const brand = await brandsSvc.updateBrand(
      req.user!.id,
      String(req.params.id),
      parsed.data
    );
    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }
    res.json({ brand });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === '23505') {
      return res.status(409).json({ error: 'A brand with that name already exists' });
    }
    throw err;
  }
});

// ------------------------------------------------------------
// DELETE /brands/:id
// ------------------------------------------------------------
brandsRouter.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  const ok = await brandsSvc.deleteBrand(req.user!.id, String(req.params.id));
  if (!ok) return res.status(404).json({ error: 'Brand not found' });
  res.json({ ok: true });
});

// ------------------------------------------------------------
// POST /brands/assign-account
//
// Body: { accountId, brandId } where brandId can be null to unassign.
// ------------------------------------------------------------
const assignSchema = z.object({
  accountId: z.string().uuid(),
  brandId: z.string().uuid().nullable(),
});

brandsRouter.post('/assign-account', requireAuth, async (req: Request, res: Response) => {
  const parsed = assignSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid accountId or brandId' });
  }
  const ok = await brandsSvc.assignAccountToBrand(
    req.user!.id,
    parsed.data.accountId,
    parsed.data.brandId
  );
  if (!ok) {
    return res.status(404).json({ error: 'Account or brand not found' });
  }
  res.json({ ok: true });
});

// =====================================================================
// Brand hashtags (Patch 4.29)
//
// GET  /brands/:id/hashtags   → list
// PUT  /brands/:id/hashtags   → replace-all
//
// Body: { tags: string[] }
// Each tag may or may not have a leading '#'; the service normalizes
// (lowercase + drops invalid chars) and dedupes. The persisted list is
// returned.
// =====================================================================

import * as brandHashtags from '../services/brand-hashtags';

const hashtagsSchema = z.object({
  tags: z.array(z.string()).max(100),
});

// Helper: confirm the brand belongs to the current user before doing
// anything else. Returns true if owned, false if not. Sends a 404 on
// false so callers can early-return.
async function userOwnsBrand(userId: string, brandId: string): Promise<boolean> {
  const b = await brandsSvc.getBrand(userId, brandId);
  return b !== null;
}

brandsRouter.get('/:id/hashtags', requireAuth, async (req: Request, res: Response) => {
  const brandId = String(req.params.id);
  if (!(await userOwnsBrand(req.user!.id, brandId))) {
    return res.status(404).json({ error: 'Brand not found' });
  }
  const hashtags = await brandHashtags.listForBrand(brandId);
  res.json({ hashtags });
});

brandsRouter.put('/:id/hashtags', requireAuth, async (req: Request, res: Response) => {
  const brandId = String(req.params.id);
  const parsed = hashtagsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Body must be { tags: string[] } with ≤100 entries.' });
  }
  if (!(await userOwnsBrand(req.user!.id, brandId))) {
    return res.status(404).json({ error: 'Brand not found' });
  }
  const hashtags = await brandHashtags.replaceForBrand(brandId, parsed.data.tags);
  res.json({ hashtags });
});
