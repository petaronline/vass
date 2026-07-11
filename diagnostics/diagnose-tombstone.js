#!/usr/bin/env node
/**
 * diagnose-tombstone.js  (Patch 4.38.4)
 *
 * READ-ONLY diagnostic for the "deleted posts reappear on Pipeline"
 * bug. Changes nothing — it only SELECTs and prints a report.
 *
 * Run inside the backend container so it picks up DATABASE_URL:
 *
 *   docker cp diagnose-tombstone.js vass-backend:/tmp/diagnose-tombstone.js
 *   docker exec -it vass-backend node /tmp/diagnose-tombstone.js
 *
 * Optionally focus on a single post by body text or external id:
 *
 *   docker exec -it vass-backend node /tmp/diagnose-tombstone.js "black friday"
 *
 * What it checks (the candidate root causes):
 *   A. synced_meta_posts rows OUTSIDE the rolling 90-day sync window —
 *      the tombstone pass never touches these, so a post deleted on
 *      Meta but older than the window lives forever.
 *   B. organic_post_targets still 'published' with an external_post_id,
 *      whose published_at is OUTSIDE the window — same problem on the
 *      Vass side: they never get marked 'deleted'.
 *   C. synced rows that DO have a matching Vass target (should be
 *      deduped at read time) — sanity check the dedup join.
 *   D. Per-account sync health: last_synced_at age, stored-row counts,
 *      window coverage — surfaces accounts whose sync is stalled/errored
 *      (the tombstone pass is skipped when a sync errors).
 *   E. The exact rows the calendar endpoint WOULD return right now for
 *      a spot-check window, so we can see what's leaking.
 */

const { Client } = require('pg');

const FOCUS = process.argv[2] || null; // optional body/extid filter

// Mirror the backend's rolling window: default sync covers ~90 days.
const WINDOW_DAYS = 90;

function hr(title) {
  console.log('\n' + '='.repeat(72));
  console.log(title);
  console.log('='.repeat(72));
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set. Run me inside the backend container.');
    process.exit(1);
  }
  const db = new Client({ connectionString: url });
  await db.connect();

  const focusClause = FOCUS
    ? `AND (s.body ILIKE '%${FOCUS.replace(/'/g, "''")}%' OR s.external_post_id = '${FOCUS.replace(/'/g, "''")}')`
    : '';
  const focusClauseT = FOCUS
    ? `AND (p.body ILIKE '%${FOCUS.replace(/'/g, "''")}%' OR t.external_post_id = '${FOCUS.replace(/'/g, "''")}')`
    : '';

  if (FOCUS) console.log(`\n[focus filter active] "${FOCUS}"`);

  // ── D. Per-account sync health ───────────────────────────────────
  hr('D. Per-account sync health');
  const health = await db.query(`
    SELECT a.id, a.platform,
           COALESCE(a.meta->>'name', a.meta->>'username', a.external_id) AS name,
           a.disconnected_at,
           st.last_synced_at,
           st.last_attempt_at,
           st.last_error,
           st.initial_sync_completed,
           EXTRACT(EPOCH FROM (NOW() - st.last_synced_at))/3600 AS hours_since_sync,
           (SELECT COUNT(*) FROM synced_meta_posts s WHERE s.organic_account_id = a.id) AS synced_total,
           (SELECT COUNT(*) FROM synced_meta_posts s
              WHERE s.organic_account_id = a.id
                AND s.posted_at < NOW() - INTERVAL '${WINDOW_DAYS} days') AS synced_outside_window
      FROM organic_connected_accounts a
      LEFT JOIN meta_sync_state st ON st.organic_account_id = a.id
     WHERE a.disconnected_at IS NULL
     ORDER BY hours_since_sync DESC NULLS FIRST
  `);
  for (const r of health.rows) {
    const stale = r.hours_since_sync == null ? 'NEVER SYNCED'
      : Number(r.hours_since_sync) > 6 ? `STALE (${Math.round(r.hours_since_sync)}h)`
      : `ok (${Math.round(r.hours_since_sync)}h)`;
    const errFlag = r.last_error ? `  ERR:${String(r.last_error).slice(0, 40)}` : '';
    console.log(
      `  ${(r.name || r.id).slice(0, 26).padEnd(26)} ${r.platform.padEnd(14)} ` +
      `sync:${stale.padEnd(16)} synced:${String(r.synced_total).padStart(4)} ` +
      `outside-window:${String(r.synced_outside_window).padStart(4)}${errFlag}`
    );
  }

  // ── A. Synced rows outside the rolling window ────────────────────
  hr(`A. synced_meta_posts OUTSIDE the ${WINDOW_DAYS}-day window (never tombstoned)`);
  const outside = await db.query(`
    SELECT s.id, s.organic_account_id, s.platform, s.external_post_id,
           s.posted_at, LEFT(s.body, 50) AS body_preview
      FROM synced_meta_posts s
      JOIN organic_connected_accounts a ON a.id = s.organic_account_id
     WHERE a.disconnected_at IS NULL
       AND s.posted_at < NOW() - INTERVAL '${WINDOW_DAYS} days'
       ${focusClause}
     ORDER BY s.posted_at DESC
     LIMIT 40
  `);
  console.log(`  ${outside.rowCount} rows (showing up to 40):`);
  for (const r of outside.rows) {
    console.log(`  ${String(r.posted_at).slice(0, 10)}  ext:${r.external_post_id.slice(0, 24).padEnd(24)} ${r.body_preview || ''}`);
  }
  if (outside.rowCount > 0) {
    console.log('\n  >>> If deleted posts here keep reappearing, ROOT CAUSE A is confirmed:');
    console.log('  >>> the tombstone pass only reconciles the rolling window, so older');
    console.log('  >>> synced rows are never removed even after deletion on Meta.');
  }

  // ── B. Published Vass targets outside the window ─────────────────
  hr(`B. organic_post_targets 'published' OUTSIDE the ${WINDOW_DAYS}-day window`);
  const oldTargets = await db.query(`
    SELECT t.id, t.account_id, t.platform, t.external_post_id, t.status,
           t.published_at, LEFT(p.body, 50) AS body_preview
      FROM organic_post_targets t
      JOIN organic_posts p ON p.id = t.post_id
     WHERE t.status = 'published'
       AND t.external_post_id IS NOT NULL
       AND t.published_at < NOW() - INTERVAL '${WINDOW_DAYS} days'
       ${focusClauseT}
     ORDER BY t.published_at DESC
     LIMIT 40
  `);
  console.log(`  ${oldTargets.rowCount} published targets older than the window (showing up to 40):`);
  for (const r of oldTargets.rows) {
    console.log(`  ${String(r.published_at).slice(0, 10)}  ext:${(r.external_post_id||'').slice(0, 24).padEnd(24)} ${r.body_preview || ''}`);
  }

  // ── C. Dedup sanity: synced rows that DO match a Vass target ─────
  hr('C. Dedup sanity — synced rows matching a Vass target (should be hidden at read time)');
  const dupes = await db.query(`
    SELECT s.id, s.external_post_id, s.posted_at,
           t.status AS vass_target_status, LEFT(s.body, 40) AS body_preview
      FROM synced_meta_posts s
      JOIN organic_post_targets t
        ON t.account_id = s.organic_account_id
       AND t.external_post_id = s.external_post_id
     ${FOCUS ? `WHERE (s.body ILIKE '%${FOCUS.replace(/'/g, "''")}%' OR s.external_post_id = '${FOCUS.replace(/'/g, "''")}')` : ''}
     ORDER BY s.posted_at DESC
     LIMIT 40
  `);
  console.log(`  ${dupes.rowCount} synced rows have a matching Vass target:`);
  for (const r of dupes.rows) {
    console.log(`  ${String(r.posted_at).slice(0, 10)}  ext:${r.external_post_id.slice(0, 24).padEnd(24)} vass-target:${(r.vass_target_status||'').padEnd(10)} ${r.body_preview || ''}`);
  }
  console.log('\n  Note: these are deduped in the calendar response, but if a Vass');
  console.log('  target is tombstoned (status=deleted) while the synced row remains,');
  console.log('  the synced copy can re-surface. Watch for vass-target:deleted rows.');

  // ── E. What the calendar would return for a recent window ────────
  hr('E. Spot-check: synced rows in the last 30 days (what Pipeline shows from sync)');
  const recent = await db.query(`
    SELECT s.external_post_id, s.posted_at, s.platform,
           COALESCE(a.meta->>'name', a.external_id) AS account,
           LEFT(s.body, 40) AS body_preview,
           EXISTS (
             SELECT 1 FROM organic_post_targets t
              WHERE t.account_id = s.organic_account_id
                AND t.external_post_id = s.external_post_id
           ) AS has_vass_target
      FROM synced_meta_posts s
      JOIN organic_connected_accounts a ON a.id = s.organic_account_id
     WHERE a.disconnected_at IS NULL
       AND s.posted_at >= NOW() - INTERVAL '30 days'
       ${focusClause}
     ORDER BY s.posted_at DESC
     LIMIT 40
  `);
  console.log(`  ${recent.rowCount} synced rows in last 30d (showing up to 40):`);
  for (const r of recent.rows) {
    console.log(`  ${String(r.posted_at).slice(0, 10)}  ${(r.account||'').slice(0,18).padEnd(18)} dedup:${r.has_vass_target ? 'Y' : 'n'} ${r.body_preview || ''}`);
  }

  hr('Summary');
  console.log(`  A. synced outside window:        ${outside.rowCount}`);
  console.log(`  B. published targets outside win: ${oldTargets.rowCount}`);
  console.log(`  C. synced w/ matching vass target: ${dupes.rowCount}`);
  const neverSynced = health.rows.filter(r => r.hours_since_sync == null).length;
  const stale = health.rows.filter(r => r.hours_since_sync != null && Number(r.hours_since_sync) > 6).length;
  console.log(`  D. accounts never synced:         ${neverSynced}`);
  console.log(`  D. accounts stale (>6h):          ${stale}`);
  console.log('\n  Paste this whole output back and I will pinpoint the fix.');

  await db.end();
}

main().catch((err) => {
  console.error('Diagnostic failed:', err);
  process.exit(1);
});
