/**
 * Ad-launches routes — operations on individual ad launches.
 *
 *   POST /ad-launches/:id/retry  → re-queue one specific failed/pending ad.
 *     Optional body: { copy?: {message,headline,description,linkUrl,callToActionType},
 *                      creativeName? } — overrides merged into stored payload.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { retryAdLaunch } from '../services/launches';
import { query } from '../db/pool';
import * as metaConn from '../services/meta-connection';
import * as meta from '../services/meta';

export const adLaunchesRouter = Router();

const UUID_RX = /^[0-9a-f-]{36}$/i;

const retrySchema = z.object({
  copy: z
    .object({
      message: z.string().optional(),
      headline: z.string().optional(),
      description: z.string().optional(),
      linkUrl: z.string().optional(),
      callToActionType: z.string().optional(),
      urlTags: z.string().max(500).optional(),
    })
    .optional(),
  creativeName: z.string().optional(),
}).optional();

adLaunchesRouter.post('/:id/retry', requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (!UUID_RX.test(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  // Body is optional; if present, validate. Empty body == retry as-is.
  const parsed = req.body && Object.keys(req.body).length > 0
    ? retrySchema.safeParse(req.body)
    : { success: true as const, data: undefined };
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid overrides' });
  }
  try {
    await retryAdLaunch(id, parsed.data);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Retry failed' });
  }
});

/**
 * GET /ad-launches/:id  → fetch one ad_launch + its payload so the Edit
 * modal can pre-fill the form with the current copy/CTA/URL.
 *
 * Also resolves the ad set's campaign objective (via Meta) so the modal
 * can filter the CTA dropdown to values Meta will accept. Best-effort —
 * if Meta isn't reachable or the ad set was deleted, objective is null
 * and the modal falls back to the full CTA list.
 */
adLaunchesRouter.get('/:id', requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (!UUID_RX.test(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  const { rows } = await query<{
    id: string;
    ad_name: string;
    ad_set_id: string;
    payload: any;
    status: string;
    error_message: string | null;
  }>(
    `SELECT id, ad_name, ad_set_id, payload, status, error_message FROM ad_launches WHERE id = $1`,
    [id]
  );
  if (rows.length === 0) {
    return res.status(404).json({ error: 'Not found' });
  }
  const r = rows[0];

  // Best-effort lookup of the ad set's campaign objective. Used to filter
  // the CTA dropdown in the Edit modal. Failures are silent — modal just
  // shows the full CTA list when objective is null.
  let objective: string | null = null;
  try {
    const token = await metaConn.getAccessToken(req.user!.id);
    if (token) {
      objective = await meta.getAdSetCampaignObjective(token, r.ad_set_id);
    }
  } catch {
    objective = null;
  }

  res.json({
    id: r.id,
    adName: r.ad_name,
    status: r.status,
    errorMessage: r.error_message,
    creativeName: r.payload?.creativeName ?? null,
    objective,
    copy: {
      message: r.payload?.copy?.message ?? '',
      headline: r.payload?.copy?.headline ?? '',
      description: r.payload?.copy?.description ?? '',
      linkUrl: r.payload?.copy?.linkUrl ?? '',
      callToActionType: r.payload?.copy?.callToActionType ?? '',
      urlTags: r.payload?.copy?.urlTags ?? '',
    },
  });
});
