/**
 * Audit service — scan existing ads for enhancement / multi-ad violations.
 *
 * Workflow:
 *   1. createAuditRun()   — user picks scope, returns run id, queues scan job
 *   2. Worker scans       — fetches ads, compares against per-account defaults,
 *                           writes findings, updates progress
 *   3. listFindings()     — UI polls + renders results
 *   4. queueFixes()       — user selects findings to fix, worker writes to Meta
 *
 * Per-account defaults are resolved live each time (so changing global or
 * per-account settings between audit and fix uses the latest values).
 */
import { query, transaction } from '../db/pool';
import { getAuditScanQueue, getAuditFixQueue } from './queue';
import { audit } from './audit';
import { findAdAccountById } from './ad-accounts';
import * as launchDefaults from './launch-defaults';
import * as meta from './meta';
import { ENHANCEMENT_KEYS, type EnhancementKey } from './launch-defaults';

// Hard cap from product decision — anything over is rejected.
export const MAX_ADS_PER_AUDIT = 2000;

// ============================================================
// Types
// ============================================================

export interface AuditRunRow {
  id: string;
  user_id: string;
  ad_account_id: string;
  meta_campaign_id: string;
  meta_campaign_name: string | null;
  target_ad_set_ids: string[];
  active_only: boolean;
  status: 'pending' | 'scanning' | 'scanned' | 'failed';
  error_message: string | null;
  ads_total: number;
  ads_scanned: number;
  findings_count: number;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  [k: string]: unknown;
}

export interface AuditFindingRow {
  id: string;
  audit_run_id: string;
  meta_ad_id: string;
  meta_ad_name: string | null;
  meta_ad_status: string | null;
  meta_ad_set_id: string | null;
  meta_creative_id: string;
  found_features: Record<string, { enroll_status?: 'OPT_IN' | 'OPT_OUT' }>;
  found_multi_ad: 'OPT_IN' | 'OPT_OUT' | null;
  violations: string[];
  fix_status: 'pending' | 'queued' | 'fixing' | 'pending_publish' | 'fixed' | 'failed' | 'skipped';
  fix_error: string | null;
  fix_started_at: Date | null;
  fix_completed_at: Date | null;
  new_creative_id: string | null;
  created_at: Date;
  [k: string]: unknown;
}

export interface AuditCreateSpec {
  adAccountId: string;
  metaCampaignId: string;
  metaCampaignName?: string;
  targetAdSetIds: string[];
  activeOnly: boolean;
}

// ============================================================
// Create + queue a scan
// ============================================================

export async function createAuditRun(
  userId: string,
  spec: AuditCreateSpec
): Promise<{ runId: string }> {
  if (spec.targetAdSetIds.length === 0) {
    throw new Error('Pick at least one ad set to audit');
  }
  const account = await findAdAccountById(userId, spec.adAccountId);
  if (!account) throw new Error('Ad account not found');
  if (!account.isEnabled) throw new Error('Ad account is not enabled');

  const { rows } = await query<{ id: string }>(
    `INSERT INTO audit_runs (
       user_id, ad_account_id, meta_campaign_id, meta_campaign_name,
       target_ad_set_ids, active_only, status
     )
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')
     RETURNING id`,
    [
      userId,
      spec.adAccountId,
      spec.metaCampaignId,
      spec.metaCampaignName ?? null,
      spec.targetAdSetIds,
      spec.activeOnly,
    ]
  );
  const runId = rows[0].id;

  const queue = getAuditScanQueue();
  await queue.add(
    'scan',
    { runId },
    {
      attempts: 2,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 24 * 60 * 60 }, // keep 24h for debug
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    }
  );

  await audit({
    userId,
    action: 'audit.create',
    resourceType: 'audit_run',
    resourceId: runId,
    metadata: { ...spec },
  });

  return { runId };
}

// ============================================================
// Reading helpers
// ============================================================

export async function getAuditRun(runId: string): Promise<AuditRunRow | null> {
  const { rows } = await query<AuditRunRow>(
    `SELECT * FROM audit_runs WHERE id = $1`,
    [runId]
  );
  return rows[0] ?? null;
}

export async function listAuditRunsForUser(
  userId: string,
  limit = 25
): Promise<AuditRunRow[]> {
  const { rows } = await query<AuditRunRow>(
    `SELECT * FROM audit_runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

export async function listFindings(runId: string): Promise<AuditFindingRow[]> {
  const { rows } = await query<AuditFindingRow>(
    `SELECT * FROM audit_findings WHERE audit_run_id = $1
     ORDER BY meta_ad_status DESC, meta_ad_name ASC`,
    [runId]
  );
  return rows;
}

// ============================================================
// Compare: produces the violations list for one ad
// ============================================================

/**
 * Given what we found on Meta vs what defaults say, return list of violation keys.
 *
 * For creative_features_spec:
 *   - "violation" = found OPT_IN but default says OPT_OUT
 *   - We don't flag the reverse (found OPT_OUT, default OPT_IN) — those
 *     ads are technically conservative, not violations. Vass's job is to
 *     prevent enhancements being on when they should be off, not to force
 *     them on.
 *
 * For contextual_multi_ads:
 *   - If disable_multi_advertiser_ads is true AND found_multi_ad !== 'OPT_OUT',
 *     that's a violation. Note Meta's default is OPT_IN since Aug 2024, so
 *     missing/null also counts as a violation (means it's implicitly opted in).
 */
export function computeViolations(
  found: {
    features: Record<string, { enroll_status?: 'OPT_IN' | 'OPT_OUT' }>;
    multiAd: 'OPT_IN' | 'OPT_OUT' | null;
  },
  defaultsConfig: launchDefaults.LaunchDefaultsConfig
): string[] {
  const violations: string[] = [];

  // Resolve what defaults say for each enhancement
  const resolvedDefaults = launchDefaults.effectiveEnhancements(defaultsConfig);

  for (const key of ENHANCEMENT_KEYS) {
    const defaultOptIn = resolvedDefaults[key]; // true = default ON, false = default OFF
    const foundOptIn = found.features[key]?.enroll_status === 'OPT_IN';

    // Violation = found ON but defaults say OFF
    if (!defaultOptIn && foundOptIn) {
      violations.push(key);
    }
  }

  // Multi-advertiser check
  if (defaultsConfig.disable_multi_advertiser_ads) {
    // Defaults want OPT_OUT. Any other state (OPT_IN, null, missing) violates.
    if (found.multiAd !== 'OPT_OUT') {
      violations.push('multi_advertiser_ads');
    }
  }

  return violations;
}

// ============================================================
// Queue fixes
// ============================================================

/**
 * Selected violations per finding. When `violationKeys` is omitted for an
 * entry (or the array is empty), the fix worker will resolve to "all of
 * this finding's violations" — same as the old behavior.
 */
export interface FixSelection {
  findingId: string;
  violationKeys?: string[];
}

export async function queueFixes(
  userId: string,
  runId: string,
  selections: FixSelection[]
): Promise<{ queued: number }> {
  if (selections.length === 0) return { queued: 0 };

  // Bulk update those findings to fix_status='queued' (and confirm ownership
  // via the audit_runs join).
  const findingIds = selections.map((s) => s.findingId);
  const { rows: updated } = await query<{ id: string }>(
    `UPDATE audit_findings
     SET fix_status = 'queued'
     WHERE audit_run_id = $1
       AND id = ANY($2)
       AND fix_status IN ('pending', 'failed')
     RETURNING id`,
    [runId, findingIds]
  );

  if (updated.length === 0) return { queued: 0 };

  // Index selections by id so we can pass per-finding violation keys to jobs
  const byId = new Map<string, FixSelection>();
  for (const s of selections) byId.set(s.findingId, s);

  const queue = getAuditFixQueue();
  await Promise.all(
    updated.map((r) => {
      const sel = byId.get(r.id);
      return queue.add(
        'fix',
        {
          findingId: r.id,
          runId,
          violationKeys: sel?.violationKeys,
        },
        {
          attempts: 2,
          backoff: { type: 'exponential', delay: 3_000 },
          removeOnComplete: { age: 24 * 60 * 60 },
          removeOnFail: { age: 7 * 24 * 60 * 60 },
        }
      );
    })
  );

  await audit({
    userId,
    action: 'audit.queue_fixes',
    resourceType: 'audit_run',
    resourceId: runId,
    metadata: { queued: updated.length },
  });

  return { queued: updated.length };
}

// ============================================================
// Re-scan
// ============================================================
//
// After a user fixes ads in Vass and publishes them in Meta Ads Manager UI,
// they run a re-scan to verify the violations are actually gone. Re-scan
// re-runs the same scope as the original audit and updates each existing
// finding:
//   - Ad still has violations → finding's fix_status flips back to 'pending'
//     (user can re-fix)
//   - Ad no longer has violations → finding's fix_status becomes 'fixed'
//   - New ad discovered with violations (e.g. Meta auto-enrolled) → new finding
//     created
//
// The original audit_run is reused (we just re-process its scope). New
// findings get the same run_id. Re-scans can be triggered repeatedly.

export async function queueRescan(
  userId: string,
  runId: string
): Promise<{ queued: boolean }> {
  const run = await getAuditRun(runId);
  if (!run) throw new Error('Audit run not found');

  // Reset run to scanning so worker re-processes it
  await query(
    `UPDATE audit_runs
     SET status = 'scanning',
         started_at = NOW(),
         completed_at = NULL,
         error_message = NULL,
         ads_scanned = 0
     WHERE id = $1`,
    [runId]
  );

  // Queue the scan job. The scan worker is "re-scan aware" — if it sees
  // findings already exist for this run, it updates them in place rather
  // than creating duplicates.
  const queue = getAuditScanQueue();
  await queue.add(
    'scan',
    { runId },
    {
      attempts: 2,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 24 * 60 * 60 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    }
  );

  await audit({
    userId,
    action: 'audit.rescan',
    resourceType: 'audit_run',
    resourceId: runId,
  });

  return { queued: true };
}
