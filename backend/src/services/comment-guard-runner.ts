/**
 * Comment Guard runner.
 *
 * Owns the BullMQ wiring for comment moderation:
 *
 *   - A repeatable 'sweep-tick' fires every minute. On each tick the runner
 *     loads all active guards whose per-guard interval has elapsed and sweeps
 *     them. This gives configurable per-guard intervals (5/15/30/60 min) with
 *     a single global schedule — same pattern as the hourly Meta sync.
 *
 *   - The scan worker resolves a guard's scope into targets on demand.
 *
 *   - The sweep worker also handles on-demand 'sweep-one' jobs ("Sweep now").
 *
 * Per-guard failures are logged, never thrown out of the tick, so one bad
 * guard can't stall the rest.
 */
import {
  type CommentScanJobData,
  type CommentSweepJobData,
  createCommentScanWorker,
  createCommentSweepWorker,
  getCommentSweepQueue,
  type Worker,
} from './queue';
import * as guards from './comment-guards';
import { runGuardScan, runGuardSweep } from '../comment-guard-worker';

const TICK_JOB_KEY = 'sweep-tick';
const TICK_INTERVAL_MS = 60 * 1000; // check for due guards every minute

/** Schedule the repeatable sweep tick. Idempotent (deduped by job id). */
export async function scheduleCommentSweepTick(): Promise<void> {
  const queue = getCommentSweepQueue();
  await queue.add(
    TICK_JOB_KEY,
    {},
    {
      repeat: { every: TICK_INTERVAL_MS, immediately: true },
      jobId: TICK_JOB_KEY,
    }
  );
  console.log(`[comment-guard] Scheduled sweep tick (every ${TICK_INTERVAL_MS}ms)`);
}

/** One tick: sweep every active guard whose interval has elapsed. */
async function runSweepTick(): Promise<void> {
  const due = await guards.listDueGuards();
  if (due.length === 0) return;
  console.log(`[comment-guard] tick: ${due.length} guard(s) due`);
  for (const guard of due) {
    try {
      await runGuardSweep(guard.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[comment-guard] sweep of ${guard.id} failed: ${message}`);
    }
  }
}

export function startCommentScanWorker(): Worker<CommentScanJobData> {
  return createCommentScanWorker(async (data) => {
    await runGuardScan(data.guardId);
  });
}

export function startCommentSweepWorker(): Worker<CommentSweepJobData> {
  return createCommentSweepWorker(async (data, jobName) => {
    if (jobName === TICK_JOB_KEY || !data.guardId) {
      await runSweepTick();
      return;
    }
    // On-demand single-guard sweep ("Sweep now")
    await runGuardSweep(data.guardId);
  });
}
