/**
 * Meta sync runner.
 *
 * Processes jobs from the meta-sync BullMQ queue. Two job types share
 * the queue:
 *
 *   1. 'hourly-sweep' — empty payload. Walks every active organic
 *      account in the system and syncs each one in serial. Scheduled
 *      via BullMQ's repeatable-job feature.
 *
 *   2. 'on-demand'    — payload { accountId, userId, sinceSec, untilSec }
 *      Single-account pull over a specific window. Used by the
 *      "Load older history" endpoint to backfill beyond the rolling
 *      90-day cron horizon.
 *
 * Per-account failures are logged but never throw out of the worker.
 * The hourly sweep should move on to the next account if one fails,
 * not abort the whole batch.
 */

import { query } from '../db/pool';
import {
  MetaSyncJobData,
  createMetaSyncWorker,
  getMetaSyncQueue,
  type Worker,
} from './queue';
import * as metaSync from './meta-sync';
import { notify } from './notifications';

/** Repeatable-job key for the hourly sweep. Stable so we don't accumulate
 *  duplicates on worker restarts. */
const HOURLY_JOB_KEY = 'hourly-sweep';

/** How often the cron tick fires. */
const HOURLY_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Ensure the hourly repeatable job is scheduled. Idempotent — calling
 * this on every worker startup is safe; BullMQ deduplicates by job key.
 *
 * If the schedule needs to change later, also update the key (e.g.
 * 'hourly-sweep-v2') so the old schedule gets retired.
 */
export async function scheduleHourlySync(): Promise<void> {
  const queue = getMetaSyncQueue();
  await queue.add(
    HOURLY_JOB_KEY,
    {}, // empty payload — sweep all accounts
    {
      repeat: { every: HOURLY_INTERVAL_MS, immediately: true },
      jobId: HOURLY_JOB_KEY, // stable id => dedup on restart
    }
  );
  console.log(`[meta-sync-runner] Scheduled hourly sweep (every ${HOURLY_INTERVAL_MS}ms)`);
}

/**
 * Worker factory. Returns a Worker instance you can `close()` on shutdown.
 */
export function startMetaSyncWorker(): Worker<MetaSyncJobData> {
  return createMetaSyncWorker(async (data, jobName) => {
    if (jobName === HOURLY_JOB_KEY || !data.accountId) {
      await runHourlySweep();
      return;
    }
    // On-demand single-account job
    if (!data.userId || !data.accountId) {
      console.warn('[meta-sync-runner] on-demand job missing userId/accountId; skipping');
      return;
    }
    const window: metaSync.SyncWindow = {
      sinceSec: data.sinceSec ?? Math.floor(Date.now() / 1000) - 365 * 24 * 60 * 60,
      untilSec: data.untilSec ?? Math.floor(Date.now() / 1000),
    };
    const result = await metaSync.syncAccount(data.accountId, data.userId, window);
    if (result.error) {
      console.warn(`[meta-sync-runner] on-demand sync failed for ${data.accountId}:`, result.error);
    } else {
      console.log(
        `[meta-sync-runner] on-demand sync ${data.accountId}: ${result.upserted} upserted, ` +
          `${result.fetched} fetched, ${result.pagesWalked} pages`
      );
    }
  });
}

// =====================================================================
// Hourly sweep — iterate every active account, sync each
// =====================================================================

/**
 * The hourly sweep. Pulls the list of all active organic accounts and
 * syncs each one. Sequential to keep API call rate predictable.
 *
 * We pull a fresh list at the start of the sweep. Accounts disconnected
 * mid-sweep just fail their individual sync (the disconnect logic
 * clears the encrypted token; getAccountWithToken returns null) and
 * the loop moves on.
 */
async function runHourlySweep(): Promise<void> {
  const t0 = Date.now();
  // Patch 4.38.5: pull each account's last_deep_reconcile_at so we can
  // decide per-account whether this run should be a fast 90-day sync or
  // a daily full-history DEEP reconcile (which lets the tombstone pass
  // clean up posts deleted on Meta at any age).
  const { rows: accounts } = await query<{
    id: string;
    user_id: string;
    platform: string;
    last_deep_reconcile_at: string | null;
  }>(
    `SELECT a.id, a.user_id, a.platform, st.last_deep_reconcile_at
       FROM organic_connected_accounts a
       LEFT JOIN meta_sync_state st ON st.organic_account_id = a.id
      WHERE a.disconnected_at IS NULL`
  );
  console.log(`[meta-sync-runner] Hourly sweep: ${accounts.length} accounts`);

  let succeeded = 0;
  let failed = 0;
  let deepRuns = 0;
  let totalUpserted = 0;
  /** userId → how many of their accounts failed this sweep (for one summary
   *  notification per user, instead of one per account per hour). */
  const failuresByUser = new Map<string, number>();

  const DEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (const a of accounts) {
    try {
      // Deep reconcile if we've never done one, or the last one is
      // older than ~24h. Otherwise a fast rolling-window sync.
      const lastDeep = a.last_deep_reconcile_at
        ? new Date(a.last_deep_reconcile_at).getTime()
        : 0;
      const wantsDeep = now - lastDeep >= DEEP_INTERVAL_MS;

      const window = wantsDeep
        ? await metaSync.deepReconcileWindowFor(a.id)
        : await metaSync.defaultSyncWindowFor(a.id);

      const result = await metaSync.syncAccount(a.id, a.user_id, window);

      if (result.error) {
        failed++;
        failuresByUser.set(a.user_id, (failuresByUser.get(a.user_id) ?? 0) + 1);
        console.warn(`[meta-sync-runner] ${a.platform} ${a.id} failed: ${result.error}`);
      } else {
        succeeded++;
        totalUpserted += result.upserted;
        // Only stamp the deep reconcile when it actually succeeded, so a
        // failed deep run is retried next sweep rather than deferred 24h.
        if (wantsDeep) {
          await metaSync.markDeepReconcile(a.id);
          deepRuns++;
          if (result.tombstoned > 0) {
            console.log(
              `[meta-sync-runner] deep reconcile ${a.platform} ${a.id}: ` +
                `removed ${result.tombstoned} deleted post(s)`
            );
          }
        }
      }
    } catch (err) {
      failed++;
      failuresByUser.set(a.user_id, (failuresByUser.get(a.user_id) ?? 0) + 1);
      console.error(`[meta-sync-runner] ${a.platform} ${a.id} threw:`, err);
    }
  }

  // ---- Notifications (best-effort; notify() never throws) ----
  const dayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // One summary per user per day — a single broken permission can fail dozens
  // of accounts every hour, so per-account alerts would be unusable.
  for (const [userId, count] of failuresByUser.entries()) {
    await notify({
      userId,
      type: 'sync.error',
      severity: 'warning',
      title: `${count} account${count === 1 ? '' : 's'} failed to sync`,
      body: 'Meta rejected the request — the connection may need reauthorising.',
      link: '/settings/social-profiles',
      dedupeKey: `syncfail:${userId}:${dayKey}`,
      metadata: { failed: count },
    });
  }

  // Tokens expiring within 7 days, deduped per account per day.
  try {
    const { rows: expiring } = await query<{
      id: string;
      user_id: string;
      platform: string;
      meta: Record<string, unknown> | null;
      token_expires_at: string;
    }>(
      `SELECT id, user_id, platform, meta, token_expires_at
         FROM organic_connected_accounts
        WHERE disconnected_at IS NULL
          AND token_expires_at IS NOT NULL
          AND token_expires_at <= NOW() + INTERVAL '7 days'`
    );
    for (const acc of expiring) {
      const name =
        (acc.meta?.name as string | undefined) ??
        (acc.meta?.username as string | undefined) ??
        acc.platform;
      await notify({
        userId: acc.user_id,
        type: 'meta.token_expiring',
        severity: 'warning',
        title: `${name} — access expires soon`,
        body: 'Reconnect this profile to avoid interrupted publishing and syncing.',
        link: '/settings/social-profiles',
        dedupeKey: `token:${acc.id}:${dayKey}`,
        metadata: { accountId: acc.id, platform: acc.platform, expiresAt: acc.token_expires_at },
      });
    }
  } catch (err) {
    console.warn('[meta-sync-runner] token-expiry check failed:', err);
  }

  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[meta-sync-runner] Sweep done: ${succeeded} ok, ${failed} failed, ` +
      `${deepRuns} deep, ${totalUpserted} total upserts in ${elapsedSec}s`
  );
}
