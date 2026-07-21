/**
 * Worker entry point — runs as a separate process inside the backend container.
 *
 * Started by the container's start command (`node dist/worker.js` alongside
 * `node dist/server.js`). Subscribes to BullMQ's launch-ad queue and
 * processes one ad launch at a time (with concurrency=4).
 *
 * Per-job lifecycle:
 *   1. Fetch ad_launches row by id
 *   2. Increment attempts counter
 *   3. Mark status = 'launching'
 *   4. Read upload file from disk
 *   5. Upload image to Meta (or reuse existing meta_image_hash if already uploaded)
 *   6. Create AdCreative
 *   7. Create Ad
 *   8. On success: status='success', store IDs, update batch counters
 *   9. On failure: status='failed' if non-transient, otherwise throw to let
 *      BullMQ retry. On final failure: status='failed' + error_message.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';
import {
  createLaunchAdWorker,
  createAuditScanWorker,
  createAuditFixWorker,
  createOrganicPublishWorker,
  getRedisConnection,
  type LaunchAdJobData,
} from './services/queue';
import { runAuditScan, runAuditFix } from './audit-worker';
import { notify } from './services/notifications';
import {
  startCommentScanWorker,
  startCommentSweepWorker,
  scheduleCommentSweepTick,
} from './services/comment-guard-runner';
import { runPublish as runOrganicPublish } from './services/organic-publish-runner';
import { startMetaSyncWorker, scheduleHourlySync } from './services/meta-sync-runner';
import { closePool, query, transaction } from './db/pool';
import * as meta from './services/meta';
import * as metaConn from './services/meta-connection';
import * as launchDefaults from './services/launch-defaults';
import { findAdAccountById } from './services/ad-accounts';

// Where uploaded files live. The Docker volume mounts /uploads.
const UPLOAD_ROOT = process.env.UPLOAD_ROOT ?? '/uploads';

interface AdLaunchRow {
  id: string;
  batch_id: string;
  ad_set_id: string;
  ad_name: string;
  upload_id: string | null;
  payload: {
    copy: {
      message: string;
      headline?: string;
      description?: string;
      linkUrl: string;
      callToActionType?: string;
      /** UTM-style params Meta appends to the destination at click time. */
      urlTags?: string;
    };
    creativeName: string;
    desiredAdStatus: 'DRAFT' | 'ACTIVE' | 'PAUSED';
    /**
     * Full list of upload UUIDs for this ad's creative group.
     * Patch 3.2+: 1+ uploads (multiple = multi-placement creative).
     * Pre-3.2 launches won't have this field; we fall back to `upload_id` column.
     */
    uploadIds?: string[];
  };
  attempts: number;
  status?: string;
  [k: string]: unknown;
}

interface BatchInfo {
  ad_account_id: string;
  user_id: string;
  [k: string]: unknown;
}

interface UploadRow {
  id: string;
  storage_path: string;
  content_type: string;
  kind: 'image' | 'video';
  meta_image_hash: string | null;
  meta_video_id: string | null;
  width_px: number | null;
  height_px: number | null;
  aspect_bucket: string | null;
  [k: string]: unknown;
}

/**
 * The actual launch logic for one ad. Throws on transient errors
 * (BullMQ retries). Marks the ad_launches row as 'failed' on terminal
 * errors and returns normally (no throw, no retry).
 */
async function processLaunchAdJob(data: LaunchAdJobData): Promise<void> {
  const { adLaunchId } = data;

  // --- Load everything we need ---
  const { rows: launchRows } = await query<AdLaunchRow>(
    `SELECT id, batch_id, ad_set_id, ad_name, upload_id, payload, attempts
     FROM ad_launches WHERE id = $1 LIMIT 1`,
    [adLaunchId]
  );
  if (launchRows.length === 0) {
    console.warn(`[worker] ad_launch ${adLaunchId} not found, dropping`);
    return;
  }
  const launch = launchRows[0];

  // Skip if already succeeded (idempotency for retried jobs)
  if ((launch as any).status === 'success') {
    console.log(`[worker] ad_launch ${adLaunchId} already succeeded, skipping`);
    return;
  }

  // Mark as launching + increment attempts atomically
  await query(
    `UPDATE ad_launches
     SET status = 'launching', attempts = attempts + 1
     WHERE id = $1`,
    [adLaunchId]
  );

  try {
    // --- Load batch + ad account info ---
    // Patch 4.18: launch_batches.user_id tells us WHICH user's Meta
    // connection + ad-account rows to use. Pre-4.18 batches predate the
    // multi-user model — they're all owned by the original admin.
    const { rows: batchRows } = await query<BatchInfo>(
      `SELECT ad_account_id, user_id FROM launch_batches WHERE id = $1`,
      [launch.batch_id]
    );
    if (batchRows.length === 0) {
      throw new TerminalError('Parent batch not found');
    }
    const batchUserId = batchRows[0].user_id;
    const account = await findAdAccountById(batchUserId, batchRows[0].ad_account_id);
    if (!account) {
      throw new TerminalError('Ad account not found');
    }
    if (!account.pageId) {
      throw new TerminalError(
        'Ad account has no linked Page. Run a sync in Settings → Ad accounts.'
      );
    }

    // --- Load upload group ---
    // From Patch 3.2 onward, payload.uploadIds holds 1+ upload UUIDs. For
    // backward compatibility with pre-3.2 ad_launches still in the queue,
    // we fall back to the row's primary upload_id column.
    const payloadUploadIds: string[] = Array.isArray(launch.payload.uploadIds)
      ? launch.payload.uploadIds
      : launch.upload_id
      ? [launch.upload_id]
      : [];
    if (payloadUploadIds.length === 0) {
      throw new TerminalError('No uploads associated with this ad launch');
    }
    const { rows: uploadRows } = await query<UploadRow>(
      `SELECT id, storage_path, content_type, kind,
              meta_image_hash, meta_video_id,
              width_px, height_px, aspect_bucket
       FROM uploads WHERE id = ANY($1)`,
      [payloadUploadIds]
    );
    if (uploadRows.length !== payloadUploadIds.length) {
      throw new TerminalError('One or more uploads not found');
    }
    // Preserve the order from payload.uploadIds (DB doesn't preserve ANY() order)
    const uploads = payloadUploadIds
      .map((id) => uploadRows.find((r) => r.id === id))
      .filter((r): r is UploadRow => !!r);

    // --- Load Meta access token (for the user who created this batch) ---
    const accessToken = await metaConn.getAccessToken(batchUserId);
    if (!accessToken) {
      throw new TerminalError(
        'The user who created this launch has no Meta connection. Reconnect in Settings → Meta.'
      );
    }

    // --- Step 1: upload every asset to Meta ---
    // For each upload in the group, push to Meta (or reuse cached hash/video_id).
    // Track the resulting Meta asset reference for the creative-creation step.
    interface AssetRef {
      uploadId: string;
      kind: 'image' | 'video';
      bucket: meta.PlacementBucket | null; // null for 'other' or unknown
      imageHash?: string;
      videoId?: string;
      /** Auto-extracted thumbnail URL from Meta (videos only). */
      videoThumbnailUrl?: string;
    }
    const assets: AssetRef[] = [];

    for (const upload of uploads) {
      const ref: AssetRef = {
        uploadId: upload.id,
        kind: upload.kind,
        bucket:
          upload.aspect_bucket === '1_1' ||
          upload.aspect_bucket === '4_5' ||
          upload.aspect_bucket === '9_16'
            ? upload.aspect_bucket
            : null,
      };

      if (upload.kind === 'image') {
        let hash = upload.meta_image_hash ?? undefined;
        if (!hash) {
          const absPath = path.join(UPLOAD_ROOT, upload.storage_path);
          let bytes: Buffer;
          try {
            bytes = await fs.readFile(absPath);
          } catch (err) {
            throw new TerminalError(
              `Could not read uploaded file from ${absPath}: ${err instanceof Error ? err.message : err}`
            );
          }
          const result = await meta.uploadImage(
            accessToken,
            account.metaAccountId,
            bytes,
            path.basename(upload.storage_path)
          );
          hash = result.hash;
          await query(
            `UPDATE uploads SET meta_image_hash = $1, meta_uploaded_at = NOW() WHERE id = $2`,
            [hash, upload.id]
          );
        }
        ref.imageHash = hash;
      } else {
        let vid = upload.meta_video_id ?? undefined;
        if (!vid) {
          const absPath = path.join(UPLOAD_ROOT, upload.storage_path);
          let bytes: Buffer;
          try {
            bytes = await fs.readFile(absPath);
          } catch (err) {
            throw new TerminalError(
              `Could not read uploaded file from ${absPath}: ${err instanceof Error ? err.message : err}`
            );
          }
          const result = await meta.uploadVideo(
            accessToken,
            account.metaAccountId,
            bytes,
            path.basename(upload.storage_path)
          );
          vid = result.videoId;
          await query(
            `UPDATE uploads SET meta_video_id = $1, meta_uploaded_at = NOW() WHERE id = $2`,
            [vid, upload.id]
          );
        }
        // Always wait for ready — video may still be processing on retries.
        await meta.waitForVideoReady(accessToken, vid);
        ref.videoId = vid;
        // Fetch auto-extracted thumbnail URL — Meta requires every video_data
        // creative to have either image_hash or image_url.
        const thumbUrl = await meta.getVideoThumbnailUrl(accessToken, vid);
        if (!thumbUrl) {
          throw new TerminalError(
            `Video ${vid} has no thumbnails available — cannot create creative`
          );
        }
        ref.videoThumbnailUrl = thumbUrl;
      }

      assets.push(ref);
    }

    // --- Step 2: build creative_features_spec from launch defaults ---
    const resolvedDefaults = await launchDefaults.resolveForAccount(account.id);
    const featuresSpec = launchDefaults.toMetaSpec(resolvedDefaults.config);

    // --- Step 3: create AdCreative ---
    // Branch on the number of DISTINCT PLACEMENT GROUPS, NOT raw asset count.
    //   - <2 groups → simple object_story_spec (link_data or video_data)
    //   - 2+ groups → asset_feed_spec with per-placement customization rules
    // Why groups and not count/bucket: asset customization rules only make
    // sense when assets target DIFFERENT placements. 1_1 and 4_5 both target
    // feed, so a 4:5 + 1:1 pair (or two 4:5s) yields customization rules with
    // identical/overlapping placements — which Meta rejects with "Asset
    // Customization Rules field is not supported in asset feed" (subcode
    // 1885896). The meaningful axis is feed vs. story/reels.
    const placementGroupForBucket = (b: meta.PlacementBucket): 'feed' | 'story' =>
      b === '9_16' ? 'story' : 'feed';
    const distinctGroups = new Set(
      assets
        .map((a) => a.bucket)
        .filter((b): b is meta.PlacementBucket => b !== null)
        .map(placementGroupForBucket)
    );
    let creativeResult: meta.MetaAdCreativeResult;

    if (distinctGroups.size < 2) {
      // Single effective placement — use the simple path. Prefer an asset that
      // has a recognized bucket; fall back to the first asset otherwise.
      const a = assets.find((x) => x.bucket !== null) ?? assets[0];
      creativeResult = await meta.createAdCreative(accessToken, {
        metaAdAccountId: account.metaAccountId,
        name: launch.payload.creativeName || launch.ad_name,
        pageId: account.pageId,
        instagramUserId: account.instagramUserId ?? undefined,
        imageHash: a.imageHash,
        videoId: a.videoId,
        videoThumbnailUrl: a.videoThumbnailUrl,
        message: launch.payload.copy.message,
        headline: launch.payload.copy.headline,
        description: launch.payload.copy.description,
        linkUrl: launch.payload.copy.linkUrl,
        callToActionType: launch.payload.copy.callToActionType,
        // UTM-style URL params Meta appends to the destination at click time.
        // Stored in payload.copy.urlTags; "" / undefined = skip.
        urlTags: launch.payload.copy.urlTags,
        creativeFeaturesSpec: featuresSpec.creative_features_spec,
        multiAdvertiserOptOut: resolvedDefaults.config.disable_multi_advertiser_ads,
      });
    } else {
      // Multi-asset creative: build asset_feed_spec.
      // Only assets with a recognized bucket (1_1 / 4_5 / 9_16) participate.
      // Unknown-ratio assets are silently dropped — the launch will still
      // succeed if at least one asset has a bucket.
      const feedAssets: meta.AssetFeedAsset[] = assets
        .filter((a): a is AssetRef & { bucket: meta.PlacementBucket } => a.bucket !== null)
        .map((a) => ({
          bucket: a.bucket,
          imageHash: a.imageHash,
          videoId: a.videoId,
        }));
      if (feedAssets.length === 0) {
        throw new TerminalError(
          'Multi-asset creative requires at least one asset with a recognized aspect ratio (1:1, 4:5, or 9:16)'
        );
      }
      creativeResult = await meta.createAssetFeedAdCreative(accessToken, {
        metaAdAccountId: account.metaAccountId,
        name: launch.payload.creativeName || launch.ad_name,
        pageId: account.pageId,
        instagramUserId: account.instagramUserId ?? undefined,
        assets: feedAssets,
        message: launch.payload.copy.message,
        headline: launch.payload.copy.headline,
        description: launch.payload.copy.description,
        linkUrl: launch.payload.copy.linkUrl,
        callToActionType: launch.payload.copy.callToActionType,
        urlTags: launch.payload.copy.urlTags,
        creativeFeaturesSpec: featuresSpec.creative_features_spec,
        multiAdvertiserOptOut: resolvedDefaults.config.disable_multi_advertiser_ads,
      });
    }

    // --- Step 4: create Ad ---
    // DRAFT → PAUSED in Meta. PAUSED stays PAUSED. ACTIVE stays ACTIVE.
    const metaStatus: 'ACTIVE' | 'PAUSED' =
      launch.payload.desiredAdStatus === 'ACTIVE' ? 'ACTIVE' : 'PAUSED';

    const adResult = await meta.createAd(accessToken, {
      metaAdAccountId: account.metaAccountId,
      name: launch.ad_name,
      adSetId: launch.ad_set_id,
      creativeId: creativeResult.id,
      status: metaStatus,
    });

    // --- Step 5: success — update DB ---
    await transaction(async (client) => {
      await client.query(
        `UPDATE ad_launches
         SET status = 'success',
             meta_creative_id = $1,
             meta_ad_id = $2,
             error_message = NULL,
             launched_at = NOW(),
             response = $3
         WHERE id = $4`,
        [creativeResult.id, adResult.id, JSON.stringify(adResult), adLaunchId]
      );
      await updateBatchCounters(client, launch.batch_id);
    });

    console.log(`[worker] ${adLaunchId} → success (ad=${adResult.id})`);
  } catch (err) {
    await handleJobError(adLaunchId, launch.batch_id, err);
    // Rethrow only if transient — BullMQ will retry
    if (err instanceof TerminalError) return;
    if (meta.isTransientError(err)) {
      // Throw to let BullMQ retry per its backoff policy
      throw err;
    }
    // Otherwise it's a non-transient API error — we've recorded it, return normally
  }
}

class TerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalError';
  }
}

async function handleJobError(adLaunchId: string, batchId: string, err: unknown): Promise<void> {
  const msg =
    err instanceof Error
      ? `${err.name}: ${err.message}`
      : String(err);

  const isTerminal = err instanceof TerminalError || !meta.isTransientError(err);

  if (isTerminal) {
    // Mark failed terminally (no more retries)
    await transaction(async (client) => {
      await client.query(
        `UPDATE ad_launches
         SET status = 'failed', error_message = $1
         WHERE id = $2`,
        [msg, adLaunchId]
      );
      await updateBatchCounters(client, batchId);
    });
    console.error(`[worker] ${adLaunchId} → terminal failure: ${msg}`);
  } else {
    // Transient error: record the message but keep status='launching' so
    // BullMQ can retry. (Worker throws after handleJobError returns.)
    await query(
      `UPDATE ad_launches SET error_message = $1 WHERE id = $2`,
      [msg, adLaunchId]
    );
    console.warn(`[worker] ${adLaunchId} → transient error, will retry: ${msg}`);
  }
}

/**
 * Recompute the batch's counters and status based on its ad_launches.
 * Called inside the same transaction as the row update so we're consistent.
 */
async function updateBatchCounters(client: PoolClient, batchId: string): Promise<void> {
  const { rows } = await client.query<{
    total: string;
    succeeded: string;
    failed: string;
    in_flight: string;
  }>(
    `SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE status = 'success')::text AS succeeded,
        COUNT(*) FILTER (WHERE status = 'failed')::text AS failed,
        COUNT(*) FILTER (WHERE status IN ('pending','launching'))::text AS in_flight
     FROM ad_launches WHERE batch_id = $1`,
    [batchId]
  );
  const r = rows[0];
  const succeeded = Number(r.succeeded);
  const failed = Number(r.failed);
  const inFlight = Number(r.in_flight);
  const total = Number(r.total);

  let status = 'running';
  if (inFlight === 0) {
    if (failed === 0) status = 'completed';
    else if (succeeded === 0) status = 'failed';
    else status = 'partial';
  }

  await client.query(
    `UPDATE launch_batches
     SET total_ads_launched = $1,
         total_ads_failed = $2,
         status = $3,
         completed_at = CASE WHEN $4 = 0 THEN NOW() ELSE NULL END
     WHERE id = $5`,
    [succeeded, failed, status, inFlight, batchId]
  );

  // Notify the owner once the batch reaches a terminal state. The dedupe key
  // makes repeat calls a no-op, so this fires exactly once per batch.
  if (inFlight === 0) {
    try {
      const { rows: bRows } = await client.query<{ user_id: string; name: string | null }>(
        `SELECT user_id, name FROM launch_batches WHERE id = $1`,
        [batchId]
      );
      const b = bRows[0];
      if (b?.user_id) {
        const label = b.name || 'Launch';
        const title =
          status === 'completed'
            ? `${label} — ${succeeded} ad${succeeded === 1 ? '' : 's'} launched`
            : status === 'partial'
              ? `${label} — ${succeeded} launched, ${failed} failed`
              : `${label} — launch failed`;
        await notify({
          client,
          userId: b.user_id,
          type: `launch.${status}`,
          severity:
            status === 'completed' ? 'success' : status === 'partial' ? 'warning' : 'error',
          title,
          body:
            status === 'completed'
              ? null
              : `${failed} of ${total} ad${total === 1 ? '' : 's'} failed.`,
          link: `/launches/${batchId}`,
          dedupeKey: `launch:${batchId}`,
          metadata: { batchId, succeeded, failed, total, status },
        });
      }
    } catch {
      // Never let notification bookkeeping fail the batch update.
    }
  }
}

// =====================================================================
// Boot the worker
// =====================================================================

async function main() {
  console.log('[worker] starting…');
  const worker = createLaunchAdWorker(processLaunchAdJob);
  const auditScanWorker = createAuditScanWorker(async (data) => {
    await runAuditScan(data.runId);
  });
  const auditFixWorker = createAuditFixWorker(async (data) => {
    await runAuditFix(data.findingId, data.runId, data.violationKeys);
  });
  const organicPublishWorker = createOrganicPublishWorker(async (data) => {
    await runOrganicPublish(data.postId);
  });
  // Patch 4.35: hourly Meta sync. The worker handles both the
  // repeatable sweep job AND on-demand single-account jobs scheduled
  // from the API (e.g. "Load older history"). We register the hourly
  // repeatable job once on startup; BullMQ dedupes by job id.
  const metaSyncWorker = startMetaSyncWorker();
  await scheduleHourlySync().catch((err) => {
    console.error('[meta-sync] Failed to schedule hourly sweep:', err);
  });

  // Comment Guard: scan worker + sweep worker + repeatable 1-min tick.
  const commentScanWorker = startCommentScanWorker();
  const commentSweepWorker = startCommentSweepWorker();
  await scheduleCommentSweepTick().catch((err) => {
    console.error('[comment-guard] Failed to schedule sweep tick:', err);
  });

  worker.on('failed', (job, err) => {
    console.warn(`[worker] job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`);
  });
  worker.on('error', (err) => {
    console.error('[worker] error:', err.message);
  });
  auditScanWorker.on('failed', (job, err) => {
    console.warn(`[audit-scan] job ${job?.id} failed: ${err.message}`);
  });
  auditScanWorker.on('error', (err) => {
    console.error('[audit-scan] error:', err.message);
  });
  auditFixWorker.on('failed', (job, err) => {
    console.warn(`[audit-fix] job ${job?.id} failed: ${err.message}`);
  });
  auditFixWorker.on('error', (err) => {
    console.error('[audit-fix] error:', err.message);
  });
  organicPublishWorker.on('failed', (job, err) => {
    console.warn(`[organic-publish] job ${job?.id} failed: ${err.message}`);
  });
  organicPublishWorker.on('error', (err) => {
    console.error('[organic-publish] error:', err.message);
  });
  metaSyncWorker.on('failed', (job, err) => {
    console.warn(`[meta-sync] job ${job?.id} failed: ${err.message}`);
  });
  metaSyncWorker.on('error', (err) => {
    console.error('[meta-sync] error:', err.message);
  });
  commentScanWorker.on('failed', (job, err) => {
    console.warn(`[comment-scan] job ${job?.id} failed: ${err.message}`);
  });
  commentScanWorker.on('error', (err) => {
    console.error('[comment-scan] error:', err.message);
  });
  commentSweepWorker.on('failed', (job, err) => {
    console.warn(`[comment-sweep] job ${job?.id} failed: ${err.message}`);
  });
  commentSweepWorker.on('error', (err) => {
    console.error('[comment-sweep] error:', err.message);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[worker] shutting down…');
    await worker.close();
    await auditScanWorker.close();
    await auditFixWorker.close();
    await organicPublishWorker.close();
    await metaSyncWorker.close();
    await commentScanWorker.close();
    await commentSweepWorker.close();
    const conn = getRedisConnection();
    await conn.quit();
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('[worker] ready, waiting for jobs (launch + audit-scan + audit-fix + organic-publish + meta-sync)');
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
