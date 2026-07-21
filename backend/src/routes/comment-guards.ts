/**
 * Comment Guard routes.
 *
 *   GET    /comment-guards/pages        — connected FB Pages (for the picker)
 *   POST   /comment-guards              — create a guard (scope + pages + rules)
 *   GET    /comment-guards              — list the user's guards
 *   GET    /comment-guards/:id          — guard + targets + recent actions
 *   PATCH  /comment-guards/:id          — update rules / interval / pause-resume
 *   POST   /comment-guards/:id/sweep    — sweep now
 *   POST   /comment-guards/:id/unhide   — unhide a previously hidden comment
 *   DELETE /comment-guards/:id          — delete the guard
 *
 * The frontend polls GET /comment-guards/:id to show live scan + hidden counts.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import * as guards from '../services/comment-guards';
import { listFacebookPages } from '../services/organic-connection';

export const commentGuardsRouter = Router();

const UUID_RE = /^[0-9a-f-]{36}$/i;

const rulesSchema = z.object({
  links: z.boolean().optional(),
  phone: z.boolean().optional(),
  profanity: z.boolean().optional(),
  keywords: z.array(z.string().min(1).max(100)).max(200).optional(),
});

const createSchema = z.object({
  adAccountId: z.string().uuid(),
  metaCampaignId: z.string().min(1).max(64),
  metaCampaignName: z.string().max(400).optional(),
  targetAdSetIds: z.array(z.string().min(1).max(64)).min(1).max(50),
  targetPageIds: z.array(z.string().min(1).max(64)).min(1).max(50),
  activeOnly: z.boolean().default(true),
  rules: rulesSchema.default({}),
  sweepIntervalMinutes: z.number().int().refine((n) => [5, 15, 30, 60].includes(n), {
    message: 'Interval must be 5, 15, 30, or 60 minutes',
  }).default(5),
});

// GET /comment-guards/pages — must be declared before '/:id'
commentGuardsRouter.get('/pages', requireAuth, async (req: Request, res: Response) => {
  const pages = await listFacebookPages(req.user!.id);
  res.json({ pages });
});

// POST /comment-guards
commentGuardsRouter.post('/', requireAuth, async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues });
  }
  try {
    const result = await guards.createGuard(req.user!.id, parsed.data);
    res.status(201).json({ guardId: result.guardId });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create guard' });
  }
});

// GET /comment-guards
commentGuardsRouter.get('/', requireAuth, async (req: Request, res: Response) => {
  const rows = await guards.listGuardsForUser(req.user!.id, 50);
  res.json({ guards: rows.map(rowToGuard) });
});

// GET /comment-guards/:id
commentGuardsRouter.get('/:id', requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid id' });
  const guard = await guards.getGuard(id);
  if (!guard || guard.user_id !== req.user!.id) {
    return res.status(404).json({ error: 'Guard not found' });
  }
  const [targets, actions] = await Promise.all([
    guards.listTargets(id),
    guards.listActions(id, 200),
  ]);
  res.json({
    guard: rowToGuard(guard),
    targets: targets.map(rowToTarget),
    actions: actions.map(rowToAction),
  });
});

// PATCH /comment-guards/:id
const patchSchema = z.object({
  rules: rulesSchema.optional(),
  sweepIntervalMinutes: z.number().int().optional(),
  status: z.enum(['active', 'paused']).optional(),
});
commentGuardsRouter.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid id' });
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues });
  }
  try {
    const updated = await guards.updateGuard(req.user!.id, id, parsed.data);
    if (!updated) return res.status(404).json({ error: 'Guard not found' });
    res.json({ guard: rowToGuard(updated) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update guard' });
  }
});

// POST /comment-guards/:id/sweep
commentGuardsRouter.post('/:id/sweep', requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const result = await guards.queueSweepNow(req.user!.id, id);
    if (!result.queued) return res.status(404).json({ error: 'Guard not found' });
    res.json({ sweepQueued: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to queue sweep' });
  }
});

// POST /comment-guards/:id/unhide  { actionId }
const unhideSchema = z.object({ actionId: z.string().uuid() });
commentGuardsRouter.post('/:id/unhide', requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid id' });
  const parsed = unhideSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues });
  }
  try {
    const result = await guards.unhideAction(req.user!.id, id, parsed.data.actionId);
    if (!result.ok) return res.status(400).json({ error: result.error ?? 'Failed to unhide' });
    res.json({ unhidden: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to unhide comment' });
  }
});

// DELETE /comment-guards/:id
commentGuardsRouter.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid id' });
  const ok = await guards.deleteGuard(req.user!.id, id);
  if (!ok) return res.status(404).json({ error: 'Guard not found' });
  res.json({ deleted: true });
});

// ----- helpers -----

function rowToGuard(r: guards.CommentGuardRow) {
  return {
    id: r.id,
    adAccountId: r.ad_account_id,
    metaCampaignId: r.meta_campaign_id,
    metaCampaignName: r.meta_campaign_name,
    targetAdSetIds: r.target_ad_set_ids,
    targetPageIds: r.target_page_ids,
    activeOnly: r.active_only,
    rules: r.rules,
    sweepIntervalMinutes: r.sweep_interval_minutes,
    status: r.status,
    errorMessage: r.error_message,
    adsTotal: r.ads_total,
    targetsTotal: r.targets_total,
    commentsHidden: r.comments_hidden,
    lastScannedAt: r.last_scanned_at,
    lastSweptAt: r.last_swept_at,
    createdAt: r.created_at,
  };
}

function rowToTarget(r: guards.CommentGuardTargetRow) {
  return {
    id: r.id,
    metaAdId: r.meta_ad_id,
    metaAdName: r.meta_ad_name,
    metaAdStatus: r.meta_ad_status,
    metaAdSetId: r.meta_ad_set_id,
    pageId: r.page_id,
    postId: r.post_id,
    pageConnected: r.page_connected,
    commentsHidden: r.comments_hidden,
    lastCheckedAt: r.last_checked_at,
    lastError: r.last_error,
  };
}

function rowToAction(r: guards.CommentGuardActionRow) {
  return {
    id: r.id,
    commentId: r.comment_id,
    matchedRule: r.matched_rule,
    matchedDetail: r.matched_detail,
    commentMessage: r.comment_message,
    authorName: r.author_name,
    permalinkUrl: r.permalink_url,
    hiddenAt: r.hidden_at,
    unhiddenAt: r.unhidden_at,
  };
}
