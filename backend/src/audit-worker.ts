/**
 * Audit worker processors.
 *
 * Two job processors:
 *   - runAuditScan : reads ads + creatives from Meta, persists findings
 *   - runAuditFix  : PATCHes a single AdCreative on Meta to resolve a finding
 *
 * Both are called by worker.ts's BullMQ workers.
 */
import { query, transaction } from './db/pool';
import * as metaConn from './services/meta-connection';
import * as launchDefaults from './services/launch-defaults';
import * as audits from './services/audits';
import * as meta from './services/meta';
import { findAdAccountById } from './services/ad-accounts';

// ============================================================
// Scan
// ============================================================

export async function runAuditScan(runId: string): Promise<void> {
  // 1. Load the run row + ad account
  const run = await audits.getAuditRun(runId);
  if (!run) throw new Error(`Audit run ${runId} not found`);
  if (run.status === 'scanned') {
    console.log(`[audit-scan] ${runId} already scanned, skipping`);
    return;
  }

  // Patch 4.18: per-user scoping. The audit run knows which user created
  // it (audit_runs.user_id); we use that user's Meta connection + ad
  // accounts.
  const account = await findAdAccountById(run.user_id, run.ad_account_id);
  if (!account) throw new Error('Ad account not found');

  const accessToken = await metaConn.getAccessToken(run.user_id);
  if (!accessToken) {
    throw new Error('The user who started this audit has no Meta connection');
  }

  // 2. Mark as scanning
  await query(
    `UPDATE audit_runs
     SET status = 'scanning', started_at = NOW(), ads_total = 0,
         ads_scanned = 0, findings_count = 0
     WHERE id = $1`,
    [runId]
  );

  try {
    // 3. List ads across all target ad sets (sequentially — keeps API load low)
    let allAds: meta.MetaAdSummary[] = [];
    for (const adSetId of run.target_ad_set_ids) {
      const ads = await meta.listAdsInAdSet(accessToken, adSetId, run.active_only);
      allAds = allAds.concat(ads);
    }

    // Enforce hard cap (defense in depth — frontend also blocks)
    if (allAds.length > audits.MAX_ADS_PER_AUDIT) {
      throw new Error(
        `Scope contains ${allAds.length} ads, exceeds hard cap of ${audits.MAX_ADS_PER_AUDIT}. ` +
        `Narrow to fewer ad sets.`
      );
    }

    await query(`UPDATE audit_runs SET ads_total = $1 WHERE id = $2`, [
      allAds.length,
      runId,
    ]);

    if (allAds.length === 0) {
      // Nothing to scan — mark complete
      await query(
        `UPDATE audit_runs
         SET status = 'scanned', completed_at = NOW()
         WHERE id = $1`,
        [runId]
      );
      return;
    }

    // 4. Build list of creative IDs to fetch
    const creativeIds = allAds
      .map((a) => a.creative?.id)
      .filter((id): id is string => !!id);

    // De-duplicate (same creative may be used across multiple ads)
    const uniqueCreativeIds = Array.from(new Set(creativeIds));

    // 5. Fetch creative details in batches
    const creativesById = await meta.getAdCreativeDetails(
      accessToken,
      uniqueCreativeIds
    );

    // 6. Resolve account's effective defaults ONCE (per-account aware)
    const resolved = await launchDefaults.resolveForAccount(account.id);
    const defaultsConfig = resolved.config;

    // 7. Compare each ad → produce findings
    let scanned = 0;
    let findings = 0;
    for (const ad of allAds) {
      scanned++;
      const creativeId = ad.creative?.id;
      if (!creativeId) {
        // Ad has no creative (rare). Skip.
        continue;
      }
      const creative = creativesById.get(creativeId);
      if (!creative) {
        // Couldn't fetch — Meta sometimes returns nothing for archived creatives.
        // Skip silently; nothing to compare against.
        continue;
      }

      const found = {
        features: creative.degrees_of_freedom_spec?.creative_features_spec ?? {},
        multiAd: (creative.contextual_multi_ads?.enroll_status ?? null) as
          | 'OPT_IN'
          | 'OPT_OUT'
          | null,
      };
      const violations = audits.computeViolations(found, defaultsConfig);

      // Look up existing finding for this ad in this run (re-scan case)
      const { rows: existingRows } = await query<{ id: string; fix_status: string }>(
        `SELECT id, fix_status FROM audit_findings
         WHERE audit_run_id = $1 AND meta_ad_id = $2
         LIMIT 1`,
        [runId, ad.id]
      );
      const existing = existingRows[0];

      if (violations.length === 0) {
        // Ad is now clean. If we had a pending_publish finding for it, mark
        // it 'fixed' — the user's Meta publish was successful and the
        // violations are confirmed gone. Otherwise nothing to do.
        if (existing && existing.fix_status === 'pending_publish') {
          await query(
            `UPDATE audit_findings
             SET fix_status = 'fixed',
                 violations = '{}',
                 found_features = $2,
                 found_multi_ad = $3
             WHERE id = $1`,
            [existing.id, JSON.stringify(found.features), found.multiAd]
          );
        }
        // If the existing finding was 'fixed' or 'failed' or 'pending', also
        // update — but only counts toward findings_count if violations exist.
        continue;
      }

      // Violations exist on this ad.
      if (existing) {
        // Update existing finding in place. The fix_status logic:
        //   - If currently 'pending_publish' and we still see violations,
        //     the publish either didn't take, didn't get clicked, or Meta
        //     auto-re-enrolled new enhancements. Flip back to 'pending'.
        //   - If currently 'fixed' and we now see violations, something
        //     re-enabled them since last scan. Flip back to 'pending'.
        //   - If 'pending' / 'failed' / 'queued' / 'fixing' / 'skipped',
        //     leave fix_status alone (don't disturb in-flight work).
        const shouldResetToPending =
          existing.fix_status === 'pending_publish' ||
          existing.fix_status === 'fixed';

        await query(
          `UPDATE audit_findings
           SET meta_ad_name = $2,
               meta_ad_status = $3,
               meta_ad_set_id = $4,
               meta_creative_id = $5,
               found_features = $6,
               found_multi_ad = $7,
               violations = $8
               ${shouldResetToPending ? `, fix_status = 'pending', fix_error = NULL, new_creative_id = NULL` : ''}
           WHERE id = $1`,
          [
            existing.id,
            ad.name,
            ad.effective_status,
            ad.adset_id,
            creativeId,
            JSON.stringify(found.features),
            found.multiAd,
            violations,
          ]
        );
      } else {
        // First-time finding (initial scan, or a new ad that appeared)
        await query(
          `INSERT INTO audit_findings (
             audit_run_id, meta_ad_id, meta_ad_name, meta_ad_status, meta_ad_set_id,
             meta_creative_id, found_features, found_multi_ad, violations
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            runId,
            ad.id,
            ad.name,
            ad.effective_status,
            ad.adset_id,
            creativeId,
            JSON.stringify(found.features),
            found.multiAd,
            violations,
          ]
        );
      }
      findings++;

      // Progress nudge every 25 ads (don't UPDATE on every single one)
      if (scanned % 25 === 0) {
        await query(
          `UPDATE audit_runs SET ads_scanned = $1, findings_count = $2 WHERE id = $3`,
          [scanned, findings, runId]
        );
      }
    }

    // Final progress write + mark complete
    // findings_count = how many findings in this run still have violations
    // (used by UI as "N ads with enhancements on")
    const { rows: countRows } = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_findings
       WHERE audit_run_id = $1 AND array_length(violations, 1) > 0`,
      [runId]
    );
    const actualFindingsCount = parseInt(countRows[0]?.count ?? '0', 10);

    await query(
      `UPDATE audit_runs
       SET status = 'scanned', ads_scanned = $1, findings_count = $2,
           completed_at = NOW()
       WHERE id = $3`,
      [scanned, actualFindingsCount, runId]
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await query(
      `UPDATE audit_runs
       SET status = 'failed', error_message = $1, completed_at = NOW()
       WHERE id = $2`,
      [message.slice(0, 2000), runId]
    );
    throw err;
  }
}

// ============================================================
// Fix
// ============================================================

export async function runAuditFix(
  findingId: string,
  runId: string,
  violationKeys?: string[]
): Promise<void> {
  // 1. Load finding + run
  const { rows: findingRows } = await query<audits.AuditFindingRow>(
    `SELECT * FROM audit_findings WHERE id = $1`,
    [findingId]
  );
  const finding = findingRows[0];
  if (!finding) throw new Error(`Finding ${findingId} not found`);
  if (finding.fix_status === 'fixed') {
    console.log(`[audit-fix] ${findingId} already fixed, skipping`);
    return;
  }

  const run = await audits.getAuditRun(runId);
  if (!run) throw new Error(`Audit run ${runId} not found`);

  const account = await findAdAccountById(run.user_id, run.ad_account_id);
  if (!account) throw new Error('Ad account not found');

  const accessToken = await metaConn.getAccessToken(run.user_id);
  if (!accessToken) {
    throw new Error('The user who started this audit has no Meta connection');
  }

  // 2. Mark as fixing
  await query(
    `UPDATE audit_findings
     SET fix_status = 'fixing', fix_started_at = NOW(), fix_error = NULL
     WHERE id = $1`,
    [findingId]
  );

  try {
    // 3. Determine which violation keys to fix on this finding
    const allViolations = finding.violations ?? [];
    const keysToFix =
      violationKeys && violationKeys.length > 0
        ? violationKeys.filter((k) => allViolations.includes(k))
        : allViolations;

    if (keysToFix.length === 0) {
      await query(
        `UPDATE audit_findings
         SET fix_status = 'skipped', fix_completed_at = NOW()
         WHERE id = $1`,
        [findingId]
      );
      return;
    }

    // Split keys into "enhancement features" vs the special multi-ad flag
    const enhancementKeys = keysToFix.filter((k) => k !== 'multi_advertiser_ads');
    const wantsMultiAdOptOut = keysToFix.includes('multi_advertiser_ads');

    // 4. Read the FULL source creative — we need everything to clone it
    const source = await meta.getFullAdCreative(accessToken, finding.meta_creative_id);

    // 5. Create the replacement creative (cloned, with our changes applied)
    const { creativeId: newCreativeId } = await meta.createReplacementAdCreative(
      accessToken,
      {
        source,
        metaAdAccountId: account.metaAccountId,
        enhancementKeysToOptOut: enhancementKeys,
        optOutMultiAdvertiser: wantsMultiAdOptOut,
      }
    );

    // 6. Re-point the ad to the new creative
    await meta.attachCreativeToAd(accessToken, finding.meta_ad_id, newCreativeId);

    // 7. Mark pending_publish (NOT fixed) + persist the new creative ID
    //
    // IMPORTANT: At this point the API swap succeeded — the ad now points at
    // a new creative with the corrected enhancement spec. BUT Meta puts the
    // ad into "Unpublished edits" state. The live serving ad continues to
    // use the OLD creative until someone clicks Publish in Meta Ads Manager.
    //
    // The state will transition to 'fixed' only after a user-initiated
    // re-scan confirms the violations are actually gone post-publish.
    await query(
      `UPDATE audit_findings
       SET fix_status = 'pending_publish',
           fix_completed_at = NOW(),
           new_creative_id = $1
       WHERE id = $2`,
      [newCreativeId, findingId]
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await query(
      `UPDATE audit_findings
       SET fix_status = 'failed', fix_error = $1, fix_completed_at = NOW()
       WHERE id = $2`,
      [message.slice(0, 2000), findingId]
    );
    throw err;
  }
}
