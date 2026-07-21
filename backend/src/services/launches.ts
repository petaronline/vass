/**
 * Launch service — orchestrator for bulk ad launching.
 *
 * Takes a LaunchSpec from the API (what to launch where), expands it
 * into the matrix of per-ad launches, persists everything to DB,
 * and queues one BullMQ job per ad.
 *
 * Phase 3.0 scope:
 *   - 1 creative (single image) → 1 existing ad set (no matrix yet)
 *
 * Phase 3.1 will expand this to:
 *   - N creatives → M ad sets matrix (N*M ads)
 *   - Per-creative copy
 *   - Ad name templating
 *
 * But the API + DB shape here already supports the matrix. The launch_batch
 * row + many ad_launches rows is the right model. 3.1 just adds UI to
 * populate more rows.
 */
import { transaction, query } from '../db/pool';
import { getLaunchAdQueue } from './queue';
import { audit } from './audit';
import { findAdAccountById } from './ad-accounts';
import { expandAdNameTemplate, DEFAULT_AD_NAME_TEMPLATE } from './ad-name-template';

export interface LaunchAdSpec {
  /** Meta ad set ID (e.g. "120209876543210000"), NOT a Vass UUID. */
  adSetId: string;
  /**
   * Display name for the ad set, used in templating ({ad_set_name}).
   * Captured at launch time so it stays fixed even if Meta renames the ad set.
   */
  adSetName: string;
}

export interface LaunchCopySpec {
  message: string;             // primary text
  headline?: string;
  description?: string;
  linkUrl: string;
  callToActionType?: string;   // 'SHOP_NOW' | 'LEARN_MORE' | ...
  /**
   * UTM-style URL parameters Meta appends to the destination at click time.
   * Sent as a separate `url_tags` field on the ad creative — does NOT modify
   * the linkUrl. Example: "utm_source=fb&utm_medium=cpc&utm_campaign={{ad.name}}".
   * Empty or missing = no url_tags sent (Meta uses no tracking params).
   */
  urlTags?: string;
}

export interface LaunchCreativeSpec {
  /**
   * One or more upload UUIDs forming this creative group. Multiple uploads
   * = a multi-placement creative (Patch 3.2). Vass groups by user intent
   * (filename-stem auto-pairing, drag-drop in UI). The worker pairs them
   * with Meta's asset_feed_spec at launch time.
   */
  uploadIds: string[];
  /** Display name (for the AdCreative.name field). */
  creativeName: string;
  /**
   * Optional per-creative copy override. Any provided fields win over the
   * base `copy` from the LaunchSpec. Unset fields fall back to base.
   */
  copyOverride?: Partial<LaunchCopySpec>;
}

export interface LaunchSpec {
  /** Vass UUID of the ad account in our DB. */
  adAccountId: string;
  /** Human-readable batch name (shown in Vass UI). */
  batchName?: string;
  /** Status to give created ads: DRAFT (paused in Meta), ACTIVE, or PAUSED. */
  desiredAdStatus: 'DRAFT' | 'ACTIVE' | 'PAUSED';
  /** Ad sets to launch into (1 to many — produces N ads). */
  adSets: LaunchAdSpec[];
  /** Creatives to launch (1 to many — produces M ads per ad set; total = M*N). */
  creatives: LaunchCreativeSpec[];
  /**
   * Base copy applied to all ads. Individual creatives can override fields
   * via `copyOverride`.
   */
  copy: LaunchCopySpec;
  /**
   * Template for naming each ad. Supports placeholders like {creative_name},
   * {ad_set_name}, {account_name}, {date}. See ad-name-template.ts.
   * If empty, defaults to "{creative_name} · {ad_set_name}".
   */
  adNameTemplate?: string;
}

export interface LaunchBatchSummary {
  id: string;
  name: string | null;
  status: string;
  desiredAdStatus: string;
  totalAdsPlanned: number;
  totalAdsLaunched: number;
  totalAdsFailed: number;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  adAccountId: string;
  adAccountName: string | null;
}

export interface AdLaunchSummary {
  id: string;
  batchId: string;
  adSetId: string;
  adName: string;
  status: string;
  errorMessage: string | null;
  metaAdId: string | null;
  metaCreativeId: string | null;
  attempts: number;
  uploadId: string | null;
  launchedAt: Date | null;
  updatedAt: Date;
}

/**
 * Create a launch batch from a LaunchSpec, expand to per-ad rows,
 * and queue the work. Returns the new batch id.
 */
export async function createLaunchBatch(opts: {
  spec: LaunchSpec;
  userId: string;
  ipAddress?: string;
}): Promise<{ batchId: string; planned: number }> {
  const { spec, userId, ipAddress } = opts;

  // Sanity-check the ad account exists & is enabled FOR THIS USER. We
  // scope by userId so user A can't launch into user B's ad account by
  // guessing the UUID.
  const account = await findAdAccountById(userId, spec.adAccountId);
  if (!account) {
    throw new Error(`Ad account ${spec.adAccountId} not found`);
  }
  if (!account.isEnabled || account.status !== 'active') {
    throw new Error(`Ad account ${account.name} is not enabled`);
  }

  // Sanity-check the upload(s) exist
  if (spec.creatives.length === 0) {
    throw new Error('At least one creative is required');
  }
  if (spec.adSets.length === 0) {
    throw new Error('At least one ad set is required');
  }

  // Flatten all upload IDs across all creative groups for the ownership check.
  // De-dup so the count comparison works even if the same upload is used in
  // multiple creative groups.
  const allUploadIds = Array.from(
    new Set(spec.creatives.flatMap((c) => c.uploadIds))
  );
  if (allUploadIds.length === 0) {
    throw new Error('Each creative must have at least one upload');
  }
  const { rows: uploadRows } = await query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM uploads WHERE id = ANY($1)`,
    [allUploadIds]
  );
  if (uploadRows.length !== allUploadIds.length) {
    throw new Error('One or more creative uploads not found');
  }
  // Light authorization: uploads must belong to the user creating the launch.
  for (const u of uploadRows) {
    if (u.user_id !== userId) {
      throw new Error('You can only launch with creatives you uploaded');
    }
  }

  // Build the matrix: every creative × every ad set.
  // For 3.0 this was always 1×1. For 3.1 it can be M×N.
  const adNameTemplate = spec.adNameTemplate?.trim() || DEFAULT_AD_NAME_TEMPLATE;
  const matrix: Array<{
    adSet: LaunchAdSpec;
    creative: LaunchCreativeSpec;
    /** Effective copy = base copy with creative's override fields applied. */
    effectiveCopy: LaunchCopySpec;
    /** Final ad name after template expansion. */
    adName: string;
  }> = [];
  let cellIndex = 0;
  for (const creative of spec.creatives) {
    for (const adSet of spec.adSets) {
      cellIndex++;
      // Merge: base copy ← creative override (only set fields win)
      const effectiveCopy: LaunchCopySpec = {
        ...spec.copy,
        ...(creative.copyOverride ?? {}),
      };
      const adName = expandAdNameTemplate(adNameTemplate, {
        creativeName: creative.creativeName,
        adSetName: adSet.adSetName,
        accountName: account.name,
        batchName: spec.batchName,
        index: cellIndex,
      });
      matrix.push({ adSet, creative, effectiveCopy, adName });
    }
  }

  // Persist everything in a transaction so we never end up with a batch
  // row but no ad_launch rows (or vice versa).
  const result = await transaction(async (client) => {
    // 1. Create the batch
    const { rows: batchRows } = await client.query<{ id: string }>(
      `INSERT INTO launch_batches (
         user_id, ad_account_id, name, source,
         target_ad_set_ids, total_ads_planned,
         status, desired_ad_status, config
       )
       VALUES ($1, $2, $3, 'manual', $4, $5, 'pending', $6, $7)
       RETURNING id`,
      [
        userId,
        spec.adAccountId,
        spec.batchName ?? null,
        spec.adSets.map((a) => a.adSetId),
        matrix.length,
        spec.desiredAdStatus,
        JSON.stringify({
          copy: spec.copy,
          creatives: spec.creatives,
          adNameTemplate,
        }),
      ]
    );
    const batchId = batchRows[0].id;

    // 2. Create one ad_launch row per matrix cell
    const insertedIds: string[] = [];
    for (const cell of matrix) {
      // Pick the first upload as the "primary" for the FK column on ad_launches.
      // The full list (for multi-placement creatives) goes in payload.
      const primaryUploadId = cell.creative.uploadIds[0];
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO ad_launches (
           batch_id, ad_set_id, ad_name, upload_id, status, payload
         )
         VALUES ($1, $2, $3, $4, 'pending', $5)
         RETURNING id`,
        [
          batchId,
          cell.adSet.adSetId,
          cell.adName,
          primaryUploadId,
          JSON.stringify({
            // Snapshot the effective copy + creative meta at queue time so
            // the worker reads back a stable payload even if the batch's
            // base config changes later.
            copy: cell.effectiveCopy,
            creativeName: cell.creative.creativeName,
            desiredAdStatus: spec.desiredAdStatus,
            // FULL list of uploads (1 or more) for this creative. The worker
            // looks at this — when length > 1 it builds an asset_feed_spec.
            uploadIds: cell.creative.uploadIds,
          }),
        ]
      );
      insertedIds.push(rows[0].id);
    }

    return { batchId, insertedIds };
  });

  // 3. Queue all the jobs (outside the transaction — Redis writes can't
  //    be rolled back by a Postgres rollback, so we do them after commit)
  const queue = getLaunchAdQueue();
  for (const adLaunchId of result.insertedIds) {
    const job = await queue.add(
      'launch-ad',
      { adLaunchId },
      { jobId: adLaunchId } // jobId = adLaunchId for easy correlation
    );
    // Store the BullMQ job id on the ad_launch row
    await query('UPDATE ad_launches SET job_id = $1 WHERE id = $2', [String(job.id), adLaunchId]);
  }

  // 4. Mark the batch as running now that jobs are queued
  await query(
    `UPDATE launch_batches SET status = 'running', started_at = NOW() WHERE id = $1`,
    [result.batchId]
  );

  await audit({
    userId,
    action: 'launch_batch.created',
    resourceType: 'launch_batch',
    resourceId: result.batchId,
    metadata: {
      planned: matrix.length,
      adAccount: account.name,
      desiredAdStatus: spec.desiredAdStatus,
    },
    ipAddress,
  });

  return { batchId: result.batchId, planned: matrix.length };
}

// =====================================================================
// Read APIs — used by the launches list page & live progress page
// =====================================================================

/**
 * Aggregate stats for the dashboard tiles:
 *   - adsLaunchedThisMonth: sum of successfully-launched ads in batches created
 *     since the start of the current month.
 *   - avgLaunchSeconds: mean wall-clock duration (completed_at - started_at)
 *     across batches that actually finished. null when there's nothing to average.
 * Scoped per-user unless userId is omitted (admin = whole workspace).
 */
export async function getLaunchStats(opts?: {
  userId?: string;
}): Promise<{ adsLaunchedThisMonth: number; avgLaunchSeconds: number | null }> {
  const params: any[] = [];
  let scope = '';
  if (opts?.userId) {
    params.push(opts.userId);
    scope = `AND user_id = $${params.length}`;
  }
  const { rows } = await query<{ ads_this_month: string; avg_seconds: string | null }>(
    `SELECT
        COALESCE(SUM(total_ads_launched) FILTER (
          WHERE created_at >= date_trunc('month', NOW())
        ), 0)::text AS ads_this_month,
        (AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) FILTER (
          WHERE completed_at IS NOT NULL AND started_at IS NOT NULL
                AND completed_at >= started_at
        ))::text AS avg_seconds
     FROM launch_batches
     WHERE 1 = 1 ${scope}`,
    params
  );
  const r = rows[0];
  return {
    adsLaunchedThisMonth: parseInt(r?.ads_this_month ?? '0', 10),
    avgLaunchSeconds:
      r?.avg_seconds != null && r.avg_seconds !== ''
        ? Math.round(parseFloat(r.avg_seconds))
        : null,
  };
}

export async function listLaunchBatches(opts?: {
  userId?: string;
  limit?: number;
}): Promise<LaunchBatchSummary[]> {
  const limit = opts?.limit ?? 50;
  const params: any[] = [limit];
  let whereClause = '';
  if (opts?.userId) {
    params.push(opts.userId);
    whereClause = `WHERE b.user_id = $${params.length}`;
  }
  const { rows } = await query<any>(
    `SELECT
        b.id, b.name, b.status, b.desired_ad_status,
        b.total_ads_planned, b.total_ads_launched, b.total_ads_failed,
        b.started_at, b.completed_at, b.created_at,
        b.ad_account_id, a.name AS ad_account_name
     FROM launch_batches b
     LEFT JOIN ad_accounts a ON a.id = b.ad_account_id
     ${whereClause}
     ORDER BY b.created_at DESC
     LIMIT $1`,
    params
  );
  return rows.map(rowToBatchSummary);
}

export async function findLaunchBatchById(
  batchId: string
): Promise<LaunchBatchSummary | null> {
  const { rows } = await query<any>(
    `SELECT
        b.id, b.name, b.status, b.desired_ad_status,
        b.total_ads_planned, b.total_ads_launched, b.total_ads_failed,
        b.started_at, b.completed_at, b.created_at,
        b.ad_account_id, a.name AS ad_account_name
     FROM launch_batches b
     LEFT JOIN ad_accounts a ON a.id = b.ad_account_id
     WHERE b.id = $1 LIMIT 1`,
    [batchId]
  );
  return rows[0] ? rowToBatchSummary(rows[0]) : null;
}

export async function listAdLaunches(batchId: string): Promise<AdLaunchSummary[]> {
  const { rows } = await query<any>(
    `SELECT id, batch_id, ad_set_id, ad_name, status, error_message,
            meta_ad_id, meta_creative_id, attempts, upload_id,
            launched_at, updated_at
     FROM ad_launches
     WHERE batch_id = $1
     ORDER BY created_at ASC`,
    [batchId]
  );
  return rows.map(rowToAdLaunchSummary);
}

/**
 * Re-queue a failed ad_launch for another attempt.
 * Resets status to 'pending', clears the error, and adds a new BullMQ job.
 */
/**
 * Retry one ad launch. Optionally accepts overrides that are merged into the
 * stored payload before re-queueing — used by the "Edit & retry" UI for ads
 * that failed due to bad CTA / copy / URL.
 */
export interface RetryOverrides {
  copy?: {
    message?: string;
    headline?: string;
    description?: string;
    linkUrl?: string;
    callToActionType?: string;
    urlTags?: string;
  };
  creativeName?: string;
}

export async function retryAdLaunch(
  adLaunchId: string,
  overrides?: RetryOverrides
): Promise<void> {
  const { rows } = await query<{ id: string; batch_id: string; status: string; payload: any }>(
    `SELECT id, batch_id, status, payload FROM ad_launches WHERE id = $1`,
    [adLaunchId]
  );
  if (rows.length === 0) throw new Error('ad_launch not found');
  if (!['failed', 'pending'].includes(rows[0].status)) {
    throw new Error(`Cannot retry: current status is '${rows[0].status}'`);
  }

  // If overrides provided, merge them into the stored payload (only mutating
  // the keys the user actually set — others stay as they were).
  let payloadUpdate = '';
  const params: any[] = [adLaunchId];
  if (overrides) {
    const existing = rows[0].payload ?? {};
    const mergedCopy = {
      ...(existing.copy ?? {}),
      ...(overrides.copy ?? {}),
    };
    const merged = {
      ...existing,
      copy: mergedCopy,
      ...(overrides.creativeName ? { creativeName: overrides.creativeName } : {}),
    };
    payloadUpdate = `, payload = $2::jsonb`;
    params.push(JSON.stringify(merged));
  }

  await query(
    `UPDATE ad_launches
     SET status = 'pending', error_message = NULL${payloadUpdate}
     WHERE id = $1`,
    params
  );

  await query(
    `UPDATE launch_batches
     SET status = 'running', completed_at = NULL
     WHERE id = $1 AND status IN ('completed', 'partial', 'failed')`,
    [rows[0].batch_id]
  );

  const queue = getLaunchAdQueue();
  const job = await queue.add('launch-ad', { adLaunchId }, { jobId: `${adLaunchId}-retry-${Date.now()}` });
  await query('UPDATE ad_launches SET job_id = $1 WHERE id = $2', [String(job.id), adLaunchId]);
}

// =====================================================================
// Clear launch history.
//
// Wipes Vass's local record of past launches. Cascades into ad_launches via
// the ON DELETE CASCADE on launch_batches → ad_launches. Does NOT touch
// live Meta ads — they keep running. This is purely a UI-cleanup tool.
//
// Scope:
//   - userId set → delete only batches that user created
//   - userId omitted (admin) → delete every batch in the workspace
//
// Does NOT delete in-flight batches (pending / running) so we don't leave
// orphaned BullMQ jobs writing into deleted DB rows.
// =====================================================================
export async function clearLaunchHistory(
  opts: { userId?: string }
): Promise<number> {
  const conditions: string[] = [
    `status NOT IN ('pending', 'running')`, // safety: don't kill live work
  ];
  const params: any[] = [];
  if (opts.userId) {
    params.push(opts.userId);
    conditions.push(`user_id = $${params.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await query<{ id: string }>(
    `DELETE FROM launch_batches ${where} RETURNING id`,
    params
  );
  return result.rows.length;
}

// =====================================================================
// Row mappers
// =====================================================================

function rowToBatchSummary(row: any): LaunchBatchSummary {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    desiredAdStatus: row.desired_ad_status,
    totalAdsPlanned: row.total_ads_planned,
    totalAdsLaunched: row.total_ads_launched,
    totalAdsFailed: row.total_ads_failed,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    adAccountId: row.ad_account_id,
    adAccountName: row.ad_account_name,
  };
}

function rowToAdLaunchSummary(row: any): AdLaunchSummary {
  return {
    id: row.id,
    batchId: row.batch_id,
    adSetId: row.ad_set_id,
    adName: row.ad_name,
    status: row.status,
    errorMessage: row.error_message,
    metaAdId: row.meta_ad_id,
    metaCreativeId: row.meta_creative_id,
    attempts: row.attempts,
    uploadId: row.upload_id,
    launchedAt: row.launched_at,
    updatedAt: row.updated_at,
  };
}
