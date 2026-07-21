/**
 * Comment Guard service.
 *
 * A "guard" watches the ads in a campaign's ad sets (scoped to chosen Pages)
 * and hides comments matching its rules on each ad's underlying Page post.
 *
 * Meta has no API to disable comments, so this is reactive moderation:
 *   1. createGuard()  — user picks scope + Pages + rules, queues a scan
 *   2. Scan worker    — resolves ads → creatives → posts into guard targets
 *   3. Sweep tick     — every minute the runner sweeps any active guard whose
 *                       interval has elapsed, hiding new rule-matched comments
 *   4. Actions log    — every hidden comment is recorded (review + unhide)
 *
 * Only ads whose owning Page is connected in the organic system (so we hold a
 * page-scoped token) can be moderated; others are stored with
 * page_connected = false and surfaced in the UI as "connect Page to enable".
 */
import { query } from '../db/pool';
import { getCommentScanQueue, getCommentSweepQueue } from './queue';
import { audit } from './audit';
import { findAdAccountById } from './ad-accounts';
import * as meta from './meta';
import * as pageTokens from './page-tokens';
import {
  type CommentRules,
  normalizeRules,
  hasAnyRule,
} from './comment-rules';

// Same hard cap as audits — a guard over more ads than this is rejected.
export const MAX_ADS_PER_GUARD = 2000;

// Allowed sweep intervals (minutes). Default 5, configurable to longer.
export const ALLOWED_INTERVALS = [5, 15, 30, 60] as const;

// ============================================================
// Types
// ============================================================

export type CommentGuardStatus =
  | 'pending'
  | 'scanning'
  | 'active'
  | 'paused'
  | 'failed';

export interface CommentGuardRow {
  id: string;
  user_id: string;
  ad_account_id: string;
  meta_campaign_id: string;
  meta_campaign_name: string | null;
  target_ad_set_ids: string[];
  target_page_ids: string[];
  active_only: boolean;
  rules: CommentRules;
  sweep_interval_minutes: number;
  status: CommentGuardStatus;
  error_message: string | null;
  ads_total: number;
  targets_total: number;
  comments_hidden: number;
  last_scanned_at: Date | null;
  last_swept_at: Date | null;
  created_at: Date;
  updated_at: Date;
  [k: string]: unknown;
}

export interface CommentGuardTargetRow {
  id: string;
  guard_id: string;
  meta_ad_id: string;
  meta_ad_name: string | null;
  meta_ad_status: string | null;
  meta_ad_set_id: string | null;
  meta_creative_id: string | null;
  page_id: string | null;
  post_id: string | null;
  page_connected: boolean;
  comments_hidden: number;
  last_checked_at: Date | null;
  last_error: string | null;
  created_at: Date;
  [k: string]: unknown;
}

export interface CommentGuardActionRow {
  id: string;
  guard_id: string;
  target_id: string;
  comment_id: string;
  matched_rule: string;
  matched_detail: string | null;
  comment_message: string | null;
  author_name: string | null;
  permalink_url: string | null;
  hidden_at: Date;
  unhidden_at: Date | null;
  [k: string]: unknown;
}

export interface CreateGuardSpec {
  adAccountId: string;
  metaCampaignId: string;
  metaCampaignName?: string;
  targetAdSetIds: string[];
  targetPageIds: string[];
  activeOnly: boolean;
  rules: unknown;
  sweepIntervalMinutes: number;
}

// ============================================================
// Create + queue a scan
// ============================================================

export async function createGuard(
  userId: string,
  spec: CreateGuardSpec
): Promise<{ guardId: string }> {
  if (spec.targetAdSetIds.length === 0) {
    throw new Error('Pick at least one ad set to guard');
  }
  if (spec.targetPageIds.length === 0) {
    throw new Error('Pick at least one Page to administer');
  }
  const rules = normalizeRules(spec.rules);
  if (!hasAnyRule(rules)) {
    throw new Error('Enable at least one rule (links, phone, profanity, or a keyword)');
  }
  const interval = ALLOWED_INTERVALS.includes(spec.sweepIntervalMinutes as any)
    ? spec.sweepIntervalMinutes
    : 5;

  const account = await findAdAccountById(userId, spec.adAccountId);
  if (!account) throw new Error('Ad account not found');
  if (!account.isEnabled) throw new Error('Ad account is not enabled');

  const { rows } = await query<{ id: string }>(
    `INSERT INTO comment_guards (
       user_id, ad_account_id, meta_campaign_id, meta_campaign_name,
       target_ad_set_ids, target_page_ids, active_only, rules,
       sweep_interval_minutes, status
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
     RETURNING id`,
    [
      userId,
      spec.adAccountId,
      spec.metaCampaignId,
      spec.metaCampaignName ?? null,
      spec.targetAdSetIds,
      spec.targetPageIds,
      spec.activeOnly,
      JSON.stringify(rules),
      interval,
    ]
  );
  const guardId = rows[0].id;

  await getCommentScanQueue().add(
    'scan',
    { guardId },
    {
      attempts: 2,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 24 * 60 * 60 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    }
  );

  await audit({
    userId,
    action: 'comment_guard.create',
    resourceType: 'comment_guard',
    resourceId: guardId,
    metadata: { ...spec, rules },
  });

  return { guardId };
}

// ============================================================
// Reading helpers
// ============================================================

export async function getGuard(guardId: string): Promise<CommentGuardRow | null> {
  const { rows } = await query<CommentGuardRow>(
    `SELECT * FROM comment_guards WHERE id = $1`,
    [guardId]
  );
  return rows[0] ?? null;
}

export async function listGuardsForUser(
  userId: string,
  limit = 50
): Promise<CommentGuardRow[]> {
  const { rows } = await query<CommentGuardRow>(
    `SELECT * FROM comment_guards WHERE user_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

export async function listTargets(guardId: string): Promise<CommentGuardTargetRow[]> {
  const { rows } = await query<CommentGuardTargetRow>(
    `SELECT * FROM comment_guard_targets WHERE guard_id = $1
     ORDER BY page_connected DESC, meta_ad_status DESC, meta_ad_name ASC`,
    [guardId]
  );
  return rows;
}

export async function listActions(
  guardId: string,
  limit = 200
): Promise<CommentGuardActionRow[]> {
  const { rows } = await query<CommentGuardActionRow>(
    `SELECT * FROM comment_guard_actions WHERE guard_id = $1
     ORDER BY hidden_at DESC LIMIT $2`,
    [guardId, limit]
  );
  return rows;
}

/** Active guards whose sweep interval has elapsed (used by the tick). */
export async function listDueGuards(): Promise<CommentGuardRow[]> {
  const { rows } = await query<CommentGuardRow>(
    `SELECT * FROM comment_guards
      WHERE status = 'active'
        AND (
          last_swept_at IS NULL
          OR last_swept_at <= NOW() - (sweep_interval_minutes || ' minutes')::interval
        )
      ORDER BY last_swept_at ASC NULLS FIRST`
  );
  return rows;
}

// ============================================================
// Mutations
// ============================================================

export async function updateGuard(
  userId: string,
  guardId: string,
  patch: { rules?: unknown; sweepIntervalMinutes?: number; status?: 'active' | 'paused' }
): Promise<CommentGuardRow | null> {
  const guard = await getGuard(guardId);
  if (!guard || guard.user_id !== userId) return null;

  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (patch.rules !== undefined) {
    const rules = normalizeRules(patch.rules);
    if (!hasAnyRule(rules)) {
      throw new Error('Enable at least one rule');
    }
    sets.push(`rules = $${i++}`);
    params.push(JSON.stringify(rules));
  }
  if (patch.sweepIntervalMinutes !== undefined) {
    const interval = ALLOWED_INTERVALS.includes(patch.sweepIntervalMinutes as any)
      ? patch.sweepIntervalMinutes
      : 5;
    sets.push(`sweep_interval_minutes = $${i++}`);
    params.push(interval);
  }
  if (patch.status !== undefined) {
    // Only allow pause/resume here; scanning/failed/pending are worker-managed.
    // Resuming a guard that never finished scanning is disallowed.
    if (patch.status === 'active' && guard.status === 'scanning') {
      throw new Error('Guard is still scanning');
    }
    sets.push(`status = $${i++}`);
    params.push(patch.status);
  }

  if (sets.length === 0) return guard;

  sets.push(`updated_at = NOW()`);
  params.push(guardId);
  const { rows } = await query<CommentGuardRow>(
    `UPDATE comment_guards SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    params
  );

  await audit({
    userId,
    action: 'comment_guard.update',
    resourceType: 'comment_guard',
    resourceId: guardId,
    metadata: { patch },
  });

  return rows[0] ?? null;
}

/** Queue an immediate one-off sweep (used by the "Sweep now" button). */
export async function queueSweepNow(
  userId: string,
  guardId: string
): Promise<{ queued: boolean }> {
  const guard = await getGuard(guardId);
  if (!guard || guard.user_id !== userId) return { queued: false };
  if (guard.status !== 'active') {
    throw new Error('Only an active guard can be swept');
  }
  await getCommentSweepQueue().add(
    'sweep-one',
    { guardId },
    {
      attempts: 2,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: { age: 6 * 60 * 60 },
      removeOnFail: { age: 24 * 60 * 60 },
    }
  );
  return { queued: true };
}

export async function deleteGuard(userId: string, guardId: string): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM comment_guards WHERE id = $1 AND user_id = $2`,
    [guardId, userId]
  );
  if ((rowCount ?? 0) > 0) {
    await audit({
      userId,
      action: 'comment_guard.delete',
      resourceType: 'comment_guard',
      resourceId: guardId,
    });
    return true;
  }
  return false;
}

/**
 * Un-hide a previously hidden comment: calls Meta to set is_hidden=false, marks
 * the action row unhidden, and decrements the hidden counters. Returns false if
 * the action doesn't exist, is already unhidden, or the Page token is gone.
 */
export async function unhideAction(
  userId: string,
  guardId: string,
  actionId: string
): Promise<{ ok: boolean; error?: string }> {
  const guard = await getGuard(guardId);
  if (!guard || guard.user_id !== userId) return { ok: false, error: 'Guard not found' };

  const { rows } = await query<{
    id: string;
    comment_id: string;
    target_id: string;
    page_id: string | null;
    unhidden_at: Date | null;
  }>(
    `SELECT a.id, a.comment_id, a.target_id, t.page_id, a.unhidden_at
       FROM comment_guard_actions a
       JOIN comment_guard_targets t ON t.id = a.target_id
      WHERE a.id = $1 AND a.guard_id = $2
      LIMIT 1`,
    [actionId, guardId]
  );
  const action = rows[0];
  if (!action) return { ok: false, error: 'Action not found' };
  if (action.unhidden_at) return { ok: true }; // already unhidden — idempotent
  if (!action.page_id) return { ok: false, error: 'Missing Page for this comment' };

  const pageToken = await pageTokens.getPageToken(userId, action.page_id);
  if (!pageToken) return { ok: false, error: 'Page is no longer connected' };

  await meta.setCommentHidden(pageToken, action.comment_id, false);

  await markActionUnhidden(guardId, actionId);
  await query(
    `UPDATE comment_guard_targets SET comments_hidden = GREATEST(comments_hidden - 1, 0) WHERE id = $1`,
    [action.target_id]
  );
  await query(
    `UPDATE comment_guards SET comments_hidden = GREATEST(comments_hidden - 1, 0) WHERE id = $1`,
    [guardId]
  );

  await audit({
    userId,
    action: 'comment_guard.unhide',
    resourceType: 'comment_guard',
    resourceId: guardId,
    metadata: { commentId: action.comment_id },
  });

  return { ok: true };
}

/** Mark one action row unhidden. Returns the row (or null). */
export async function markActionUnhidden(
  guardId: string,
  actionId: string
): Promise<CommentGuardActionRow | null> {
  const { rows } = await query<CommentGuardActionRow>(
    `UPDATE comment_guard_actions
        SET unhidden_at = NOW()
      WHERE id = $1 AND guard_id = $2 AND unhidden_at IS NULL
      RETURNING *`,
    [actionId, guardId]
  );
  return rows[0] ?? null;
}
