/**
 * BullMQ queue setup.
 *
 * Both the API server (which adds jobs) and the worker (which processes them)
 * use this module so the queue names and Redis connection stay in sync.
 *
 * Job naming:
 *   - 'launch-ad' — the workhorse. Payload: { adLaunchId: uuid }
 *     The worker fetches the ad_launches row, runs the Meta API calls,
 *     updates the row with success/failure.
 */
import { Queue, QueueEvents, Worker, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../utils/env';

// BullMQ requires `maxRetriesPerRequest: null` to support blocking commands.
// We make ONE Redis connection per process and share it.
let connection: IORedis | null = null;

export function getRedisConnection(): IORedis {
  if (connection) return connection;
  connection = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  connection.on('error', (err) => {
    console.error('[redis] connection error:', err.message);
  });
  return connection;
}

export const QUEUE_NAMES = {
  launchAd: 'vass-launch-ad',
  auditScan: 'vass-audit-scan',
  auditFix: 'vass-audit-fix',
  organicPublish: 'vass-organic-publish',
  metaSync: 'vass-meta-sync',
  commentScan: 'vass-comment-scan',
  commentSweep: 'vass-comment-sweep',
} as const;

// The job-specific payload. Keeping this tiny (just an ID) — the worker
// fetches everything else from the DB. This means restarting workers
// always picks up the latest state, never stale snapshots from the queue.
export interface LaunchAdJobData {
  adLaunchId: string;
}

/** Audit scan job: scan all ads in a run's scope and write findings. */
export interface AuditScanJobData {
  runId: string;
}

/** Audit fix job: PATCH the Meta AdCreative for one finding. */
export interface AuditFixJobData {
  findingId: string;
  runId: string;
  /**
   * Reserved for future per-tag fix selection. Currently unused —
   * the audit-fix worker fixes all violations on the finding via
   * duplicate-and-replace (Meta doesn't support per-tag granularity
   * given how creative swapping works).
   */
  violationKeys?: string[];
}

let launchAdQueue: Queue<LaunchAdJobData> | null = null;

/**
 * Total BullMQ attempts for a launch-ad job. Exported so the worker can tell
 * when it's on the FINAL attempt and mark a transiently-failing launch as
 * terminally failed instead of leaving it stuck at status='launching' forever.
 * Keep in sync with defaultJobOptions.attempts below.
 */
export const LAUNCH_AD_MAX_ATTEMPTS = 3;

export function getLaunchAdQueue(): Queue<LaunchAdJobData> {
  if (launchAdQueue) return launchAdQueue;
  launchAdQueue = new Queue<LaunchAdJobData>(QUEUE_NAMES.launchAd, {
    connection: getRedisConnection() as ConnectionOptions,
    defaultJobOptions: {
      // Retries: 3 total attempts. Exponential backoff: 5s, 25s, 125s.
      attempts: LAUNCH_AD_MAX_ATTEMPTS,
      backoff: { type: 'exponential', delay: 5_000 },
      // Keep completed jobs around briefly for debugging, then auto-clean
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail:     { age: 86400 },
    },
  });
  return launchAdQueue;
}

// ----- Audit queues (Patch 2.5b) -----

let auditScanQueue: Queue<AuditScanJobData> | null = null;
export function getAuditScanQueue(): Queue<AuditScanJobData> {
  if (auditScanQueue) return auditScanQueue;
  auditScanQueue = new Queue<AuditScanJobData>(QUEUE_NAMES.auditScan, {
    connection: getRedisConnection() as ConnectionOptions,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 24 * 60 * 60 },
      removeOnFail:     { age: 7 * 24 * 60 * 60 },
    },
  });
  return auditScanQueue;
}

let auditFixQueue: Queue<AuditFixJobData> | null = null;
export function getAuditFixQueue(): Queue<AuditFixJobData> {
  if (auditFixQueue) return auditFixQueue;
  auditFixQueue = new Queue<AuditFixJobData>(QUEUE_NAMES.auditFix, {
    connection: getRedisConnection() as ConnectionOptions,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 3_000 },
      removeOnComplete: { age: 24 * 60 * 60 },
      removeOnFail:     { age: 7 * 24 * 60 * 60 },
    },
  });
  return auditFixQueue;
}

/**
 * Build a Worker. Called from worker.ts entry point, not from the API.
 * The processor function gets the job and runs Meta API calls.
 */
export function createLaunchAdWorker(
  processor: (data: LaunchAdJobData, jobId: string, attemptsMade: number) => Promise<void>
): Worker<LaunchAdJobData> {
  return new Worker<LaunchAdJobData>(
    QUEUE_NAMES.launchAd,
    async (job) => {
      // Wrap the processor so we can log uniformly. Errors bubble up
      // to BullMQ for retry handling. attemptsMade is 0-indexed (0 on the
      // first run) so the processor can detect the final attempt.
      console.log(`[worker] processing ${job.id} (attempt ${job.attemptsMade + 1})`);
      await processor(job.data, String(job.id), job.attemptsMade);
    },
    {
      connection: getRedisConnection() as ConnectionOptions,
      concurrency: 4, // up to 4 ads launching at once
      // Meta has per-app and per-account rate limits. 4 concurrent ad creations
      // is a conservative starting point that won't trip the per-account limit.
    }
  );
}

export function createAuditScanWorker(
  processor: (data: AuditScanJobData, jobId: string) => Promise<void>
): Worker<AuditScanJobData> {
  return new Worker<AuditScanJobData>(
    QUEUE_NAMES.auditScan,
    async (job) => {
      console.log(`[audit-scan] processing ${job.id} (attempt ${job.attemptsMade + 1})`);
      await processor(job.data, String(job.id));
    },
    {
      connection: getRedisConnection() as ConnectionOptions,
      // Scans are themselves rate-limited per Meta account; running 2 concurrent
      // scans is safe because each one is for a single (possibly different) account.
      concurrency: 2,
    }
  );
}

export function createAuditFixWorker(
  processor: (data: AuditFixJobData, jobId: string) => Promise<void>
): Worker<AuditFixJobData> {
  return new Worker<AuditFixJobData>(
    QUEUE_NAMES.auditFix,
    async (job) => {
      console.log(`[audit-fix] processing ${job.id} (attempt ${job.attemptsMade + 1})`);
      await processor(job.data, String(job.id));
    },
    {
      connection: getRedisConnection() as ConnectionOptions,
      // Single AdCreative PATCH per ad. Concurrency 3 is safe for any one account.
      concurrency: 3,
    }
  );
}

// ----- Organic publish queue (Patch 4.29) -----
//
// Scheduling pattern: when a post is scheduled, we enqueue a delayed
// job with `delay: scheduled_for_ms - Date.now()`. BullMQ holds it in
// Redis until the delay expires, then makes it available to the worker.
//
// On cancel: remove the job by id (best-effort; if it already started,
// the worker is responsible for the no-op via DB-status check).
// On reschedule: remove + re-add with new delay.
//
// Job payload is just the post id — the worker fetches everything
// (targets, media, account tokens) from the DB at run time so a
// post edited between schedule and execution publishes the current
// content rather than a frozen snapshot.

export interface OrganicPublishJobData {
  postId: string;
}

let organicPublishQueue: Queue<OrganicPublishJobData> | null = null;

export function getOrganicPublishQueue(): Queue<OrganicPublishJobData> {
  if (organicPublishQueue) return organicPublishQueue;
  organicPublishQueue = new Queue<OrganicPublishJobData>(QUEUE_NAMES.organicPublish, {
    connection: getRedisConnection() as ConnectionOptions,
    defaultJobOptions: {
      // Organic publish failures are mostly Meta-side issues (rate
      // limits, transient errors). Three attempts with backoff is the
      // sweet spot — anything more retries past the point where the
      // post is visibly late.
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 }, // 30s, 2.5m, 12m
      removeOnComplete: { age: 24 * 60 * 60 },
      removeOnFail:     { age: 7 * 24 * 60 * 60 },
    },
  });
  return organicPublishQueue;
}

export function createOrganicPublishWorker(
  processor: (data: OrganicPublishJobData, jobId: string) => Promise<void>
): Worker<OrganicPublishJobData> {
  return new Worker<OrganicPublishJobData>(
    QUEUE_NAMES.organicPublish,
    async (job) => {
      console.log(`[organic-publish] processing ${job.id} (post ${job.data.postId}, attempt ${job.attemptsMade + 1})`);
      await processor(job.data, String(job.id));
    },
    {
      connection: getRedisConnection() as ConnectionOptions,
      // Organic publishing is sequential per-post inside the worker
      // (each target hits Meta one after another). Concurrency 2 lets
      // two separate posts go at the same time, low enough to stay
      // well clear of Meta rate limits.
      concurrency: 2,
    }
  );
}

// ─── Meta sync queue (Patch 4.35) ──────────────────────────────────────
// Two kinds of jobs share this queue:
//   1. The hourly tick job — payload is empty (jobName='hourly-sweep').
//      The worker iterates all connected accounts and syncs each.
//   2. On-demand per-account jobs — payload { accountId, sinceSec, untilSec }
//      Used by the "Load older history" endpoint to backfill specific
//      windows beyond the rolling 90-day cron horizon.

export interface MetaSyncJobData {
  /** Empty for the hourly sweep job; populated for on-demand pulls. */
  accountId?: string;
  userId?: string;
  sinceSec?: number;
  untilSec?: number;
}

let metaSyncQueue: Queue<MetaSyncJobData> | null = null;

export function getMetaSyncQueue(): Queue<MetaSyncJobData> {
  if (metaSyncQueue) return metaSyncQueue;
  metaSyncQueue = new Queue<MetaSyncJobData>(QUEUE_NAMES.metaSync, {
    connection: getRedisConnection() as ConnectionOptions,
    defaultJobOptions: {
      // Meta sync failures should retry less aggressively than publish:
      // an hour-late sync isn't user-visible, and we re-run on the next
      // hourly tick anyway. Two attempts is enough to ride out a
      // transient blip.
      attempts: 2,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { age: 24 * 60 * 60 },
      removeOnFail:     { age: 7 * 24 * 60 * 60 },
    },
  });
  return metaSyncQueue;
}

export function createMetaSyncWorker(
  processor: (data: MetaSyncJobData, jobName: string) => Promise<void>
): Worker<MetaSyncJobData> {
  return new Worker<MetaSyncJobData>(
    QUEUE_NAMES.metaSync,
    async (job) => {
      console.log(`[meta-sync] processing ${job.id} (${job.name}, attempt ${job.attemptsMade + 1})`);
      await processor(job.data, job.name);
    },
    {
      connection: getRedisConnection() as ConnectionOptions,
      // One sync at a time per process — keeps Meta API call rate
      // predictable and avoids the runaway-parallelism problem when
      // many accounts are connected.
      concurrency: 1,
    }
  );
}

// ─── Comment Guard queues ──────────────────────────────────────────────
// Two queues, mirroring audit's scan/act split:
//
//   commentScan  — { guardId }. Resolve the guard's scope into monitored
//                  post targets (campaign → ad sets → ads → creative → post).
//
//   commentSweep — shares two job types:
//     'sweep-tick' (empty payload) — repeatable every 60s; the runner walks
//        all active guards and sweeps any whose interval has elapsed.
//     'sweep-one'  ({ guardId })   — on-demand "sweep now" from the API.

export interface CommentScanJobData {
  guardId: string;
}

export interface CommentSweepJobData {
  /** Empty for the repeatable tick; set for an on-demand single-guard sweep. */
  guardId?: string;
}

let commentScanQueue: Queue<CommentScanJobData> | null = null;
export function getCommentScanQueue(): Queue<CommentScanJobData> {
  if (commentScanQueue) return commentScanQueue;
  commentScanQueue = new Queue<CommentScanJobData>(QUEUE_NAMES.commentScan, {
    connection: getRedisConnection() as ConnectionOptions,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 24 * 60 * 60 },
      removeOnFail:     { age: 7 * 24 * 60 * 60 },
    },
  });
  return commentScanQueue;
}

let commentSweepQueue: Queue<CommentSweepJobData> | null = null;
export function getCommentSweepQueue(): Queue<CommentSweepJobData> {
  if (commentSweepQueue) return commentSweepQueue;
  commentSweepQueue = new Queue<CommentSweepJobData>(QUEUE_NAMES.commentSweep, {
    connection: getRedisConnection() as ConnectionOptions,
    defaultJobOptions: {
      // A missed sweep is caught by the next tick, so retry lightly.
      attempts: 2,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: { age: 6 * 60 * 60 },
      removeOnFail:     { age: 24 * 60 * 60 },
    },
  });
  return commentSweepQueue;
}

export function createCommentScanWorker(
  processor: (data: CommentScanJobData, jobId: string) => Promise<void>
): Worker<CommentScanJobData> {
  return new Worker<CommentScanJobData>(
    QUEUE_NAMES.commentScan,
    async (job) => {
      console.log(`[comment-scan] processing ${job.id} (attempt ${job.attemptsMade + 1})`);
      await processor(job.data, String(job.id));
    },
    {
      connection: getRedisConnection() as ConnectionOptions,
      concurrency: 2,
    }
  );
}

export function createCommentSweepWorker(
  processor: (data: CommentSweepJobData, jobName: string) => Promise<void>
): Worker<CommentSweepJobData> {
  return new Worker<CommentSweepJobData>(
    QUEUE_NAMES.commentSweep,
    async (job) => {
      await processor(job.data, job.name);
    },
    {
      connection: getRedisConnection() as ConnectionOptions,
      // One sweep pass at a time keeps the Graph API call rate predictable.
      concurrency: 1,
    }
  );
}

export async function closeQueues(): Promise<void> {
  if (launchAdQueue) {
    await launchAdQueue.close();
    launchAdQueue = null;
  }
  if (auditScanQueue) {
    await auditScanQueue.close();
    auditScanQueue = null;
  }
  if (auditFixQueue) {
    await auditFixQueue.close();
    auditFixQueue = null;
  }
  if (organicPublishQueue) {
    await organicPublishQueue.close();
    organicPublishQueue = null;
  }
  if (metaSyncQueue) {
    await metaSyncQueue.close();
    metaSyncQueue = null;
  }
  if (commentScanQueue) {
    await commentScanQueue.close();
    commentScanQueue = null;
  }
  if (commentSweepQueue) {
    await commentSweepQueue.close();
    commentSweepQueue = null;
  }
  if (connection) {
    await connection.quit();
    connection = null;
  }
}

// Re-export so callers can listen for events
export { QueueEvents, type Worker };
