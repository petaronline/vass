/**
 * Launch endpoints — create batches, list them, watch progress, retry.
 *
 *   POST   /launches                         → create a new launch batch (validates spec, queues jobs)
 *   GET    /launches                         → list batches (current user, paginated)
 *   GET    /launches/:id                     → batch + all its ad_launches (for the progress page)
 *   POST   /launches/:id/retry-failed        → re-queue all failed ads in this batch
 *   POST   /ad-launches/:id/retry            → re-queue one specific failed ad
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import {
  createLaunchBatch,
  listLaunchBatches,
  findLaunchBatchById,
  listAdLaunches,
  retryAdLaunch,
  clearLaunchHistory,
} from '../services/launches';

export const launchesRouter = Router();

const UUID_RX = /^[0-9a-f-]{36}$/i;

const copyFieldsSchema = z.object({
  message: z.string().min(1).max(2000).optional(),
  headline: z.string().max(200).optional(),
  description: z.string().max(200).optional(),
  linkUrl: z
    .string()
    .url()
    .refine((u) => u.startsWith('https://'), {
      message: 'linkUrl must start with https://',
    })
    .optional(),
  callToActionType: z.string().max(64).optional(),
  // UTM-style params Meta appends to the destination URL at click time.
  // Empty / omitted = no url_tags sent.
  urlTags: z.string().max(500).optional(),
});

const launchSpecSchema = z.object({
  adAccountId: z.string().uuid(),
  batchName: z.string().min(1).max(200).optional(),
  desiredAdStatus: z.enum(['DRAFT', 'ACTIVE', 'PAUSED']).default('DRAFT'),
  adSets: z
    .array(
      z.object({
        adSetId: z.string().min(1).max(64),
        adSetName: z.string().min(1).max(400),
      })
    )
    .min(1)
    .max(50),
  creatives: z
    .array(
      z.object({
        // 1+ upload IDs per creative. Multiple = multi-placement creative.
        uploadIds: z.array(z.string().uuid()).min(1).max(5),
        creativeName: z.string().min(1).max(200),
        copyOverride: copyFieldsSchema.optional(),
      })
    )
    .min(1)
    .max(20),
  copy: z.object({
    message: z.string().min(1).max(2000),
    headline: z.string().max(200).optional(),
    description: z.string().max(200).optional(),
    linkUrl: z
      .string()
      .url()
      .refine((u) => u.startsWith('https://'), {
        message: 'linkUrl must start with https://',
      }),
    callToActionType: z.string().max(64).optional(),
    urlTags: z.string().max(500).optional(),
  }),
  adNameTemplate: z.string().max(400).optional(),
});

// =====================================================================
// POST /launches — create a new batch
// =====================================================================
launchesRouter.post('/', requireAuth, async (req: Request, res: Response) => {
  const parsed = launchSpecSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid launch spec', detail: parsed.error.flatten() });
  }
  try {
    const result = await createLaunchBatch({
      spec: parsed.data,
      userId: req.user!.id,
      ipAddress: req.ip,
    });
    res.json(result);
  } catch (err) {
    console.error('[launches] create failed:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Launch creation failed' });
  }
});

// =====================================================================
// GET /launches — list (admin sees all, others see their own)
// =====================================================================
launchesRouter.get('/', requireAuth, async (req: Request, res: Response) => {
  const isAdmin = req.user!.role === 'admin';
  const batches = await listLaunchBatches({
    userId: isAdmin ? undefined : req.user!.id,
    limit: 50,
  });
  res.json({ batches });
});

// =====================================================================
// GET /launches/:id — batch + ad_launches (for progress page)
// =====================================================================
launchesRouter.get('/:id', requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (!UUID_RX.test(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  const batch = await findLaunchBatchById(id);
  if (!batch) {
    return res.status(404).json({ error: 'Launch batch not found' });
  }
  const adLaunches = await listAdLaunches(id);
  res.json({ batch, adLaunches });
});

// =====================================================================
// POST /launches/:id/retry-failed — re-queue every failed ad in a batch
// =====================================================================
launchesRouter.post(
  '/:id/retry-failed',
  requireAuth,
  async (req: Request, res: Response) => {
    const id = req.params.id as string;
    if (!UUID_RX.test(id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const batch = await findLaunchBatchById(id);
    if (!batch) {
      return res.status(404).json({ error: 'Launch batch not found' });
    }
    const allLaunches = await listAdLaunches(id);
    const failed = allLaunches.filter((l) => l.status === 'failed');
    let count = 0;
    for (const l of failed) {
      try {
        await retryAdLaunch(l.id);
        count++;
      } catch (err) {
        console.warn(`[retry-failed] could not retry ${l.id}:`, err);
      }
    }
    res.json({ ok: true, retried: count });
  }
);

// =====================================================================
// DELETE /launches — clear launch history.
// Members see + delete only their own batches; admins delete everything.
// Doesn't touch live Meta ads — only Vass's local launch_batches +
// ad_launches records.
// =====================================================================
launchesRouter.delete('/', requireAuth, async (req: Request, res: Response) => {
  const isAdmin = req.user!.role === 'admin';
  try {
    const deleted = await clearLaunchHistory({
      userId: isAdmin ? undefined : req.user!.id,
    });
    res.json({ ok: true, deleted });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Clear history failed',
    });
  }
});
