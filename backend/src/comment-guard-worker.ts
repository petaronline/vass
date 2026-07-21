/**
 * Comment Guard worker processors.
 *
 *   runGuardScan  — resolve a guard's scope (campaign → ad sets → ads →
 *                   creatives → underlying posts) into monitored targets.
 *   runGuardSweep — for one guard, fetch new comments on each monitored post
 *                   and hide the ones matching the guard's rules.
 *
 * The scan uses the user's ads token; hiding uses the owning Page's
 * page-scoped token (from the organic connection).
 */
import { query } from './db/pool';
import * as metaConn from './services/meta-connection';
import * as guards from './services/comment-guards';
import * as meta from './services/meta';
import * as pageTokens from './services/page-tokens';
import { findAdAccountById } from './services/ad-accounts';
import { matchComment } from './services/comment-rules';
import { notify } from './services/notifications';

const toUnix = (d: Date | null | undefined): number =>
  d ? Math.floor(d.getTime() / 1000) : 0;

/** Page id is the prefix of an effective_object_story_id ("{pageid}_{postid}"). */
function pageIdFromPostId(postId: string | undefined | null): string | null {
  if (!postId) return null;
  const idx = postId.indexOf('_');
  return idx > 0 ? postId.slice(0, idx) : null;
}

// ============================================================
// Scan — resolve targets
// ============================================================

export async function runGuardScan(guardId: string): Promise<void> {
  const guard = await guards.getGuard(guardId);
  if (!guard) throw new Error(`Comment guard ${guardId} not found`);

  const account = await findAdAccountById(guard.user_id, guard.ad_account_id);
  if (!account) throw new Error('Ad account not found');

  const accessToken = await metaConn.getAccessToken(guard.user_id);
  if (!accessToken) {
    throw new Error('The user who owns this guard has no Meta connection');
  }

  await query(`UPDATE comment_guards SET status = 'scanning', error_message = NULL WHERE id = $1`, [
    guardId,
  ]);

  try {
    // 1. List ads across the target ad sets
    let allAds: meta.MetaAdSummary[] = [];
    for (const adSetId of guard.target_ad_set_ids) {
      const ads = await meta.listAdsInAdSet(accessToken, adSetId, guard.active_only);
      allAds = allAds.concat(ads);
    }
    if (allAds.length > guards.MAX_ADS_PER_GUARD) {
      throw new Error(
        `Scope contains ${allAds.length} ads, exceeds hard cap of ${guards.MAX_ADS_PER_GUARD}. Narrow the ad sets.`
      );
    }

    // 2. Resolve each ad's underlying post via its creative
    const creativeIds = Array.from(
      new Set(allAds.map((a) => a.creative?.id).filter((id): id is string => !!id))
    );
    const postRefs = await meta.getCreativePostRefs(accessToken, creativeIds);

    // 3. Which of the selected Pages are actually connected right now
    const connectedPages = await pageTokens.listManagedPages(guard.user_id);
    const connectedPageIds = new Set(connectedPages.map((p) => p.pageId));
    const selectedPageIds = new Set(guard.target_page_ids);

    // 4. Upsert a target per ad whose Page is in the selected set
    let targetCount = 0;
    for (const ad of allAds) {
      const creativeId = ad.creative?.id ?? null;
      const ref = creativeId ? postRefs.get(creativeId) : undefined;
      const postId = ref?.effective_object_story_id ?? ref?.object_story_id ?? null;
      const pageId = pageIdFromPostId(postId);

      // Out of scope: ad's Page wasn't selected by the user.
      if (!pageId || !selectedPageIds.has(pageId)) continue;

      const pageConnected = connectedPageIds.has(pageId) && !!postId;

      await query(
        `INSERT INTO comment_guard_targets (
           guard_id, meta_ad_id, meta_ad_name, meta_ad_status, meta_ad_set_id,
           meta_creative_id, page_id, post_id, page_connected
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (guard_id, meta_ad_id) DO UPDATE SET
           meta_ad_name     = EXCLUDED.meta_ad_name,
           meta_ad_status   = EXCLUDED.meta_ad_status,
           meta_ad_set_id   = EXCLUDED.meta_ad_set_id,
           meta_creative_id = EXCLUDED.meta_creative_id,
           page_id          = EXCLUDED.page_id,
           post_id          = EXCLUDED.post_id,
           page_connected   = EXCLUDED.page_connected`,
        [
          guardId,
          ad.id,
          ad.name,
          ad.effective_status,
          ad.adset_id,
          creativeId,
          pageId,
          postId,
          pageConnected,
        ]
      );
      targetCount++;
    }

    // 5. Activate the guard so the sweep tick starts moderating it
    await query(
      `UPDATE comment_guards
         SET status = 'active', ads_total = $2, targets_total = $3,
             last_scanned_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [guardId, allAds.length, targetCount]
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await query(
      `UPDATE comment_guards SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2`,
      [message.slice(0, 2000), guardId]
    );
    throw err;
  }
}

// ============================================================
// Sweep — hide matched comments
// ============================================================

export async function runGuardSweep(guardId: string): Promise<void> {
  const guard = await guards.getGuard(guardId);
  if (!guard) return;
  if (guard.status !== 'active') return; // paused/failed/scanning → skip

  const targets = await guards.listTargets(guardId);
  const moderatable = targets.filter((t) => t.page_connected && t.post_id);
  if (moderatable.length === 0) {
    await query(`UPDATE comment_guards SET last_swept_at = NOW() WHERE id = $1`, [guardId]);
    return;
  }

  // Page tokens are per-Page; fetch each once and reuse across its targets.
  const tokenCache = new Map<string, string | null>();
  const getPageToken = async (pageId: string): Promise<string | null> => {
    if (tokenCache.has(pageId)) return tokenCache.get(pageId)!;
    const tok = await pageTokens.getPageToken(guard.user_id, pageId);
    tokenCache.set(pageId, tok);
    return tok;
  };

  let hiddenThisSweep = 0;

  for (const target of moderatable) {
    const pageId = target.page_id!;
    const postId = target.post_id!;
    try {
      const pageToken = await getPageToken(pageId);
      if (!pageToken) {
        // Page got disconnected since scan — flag it and move on.
        await query(
          `UPDATE comment_guard_targets
             SET page_connected = FALSE, last_error = 'Page token unavailable', last_checked_at = NOW()
           WHERE id = $1`,
          [target.id]
        );
        continue;
      }

      const since = toUnix(target.last_checked_at);
      const comments = await meta.listPostComments(pageToken, postId, since || undefined);

      let hiddenForTarget = 0;
      for (const c of comments) {
        if (c.is_hidden) continue; // already hidden (by us or manually)
        const match = matchComment(c.message, guard.rules);
        if (!match) continue;

        await meta.setCommentHidden(pageToken, c.id, true);

        // Log it. UNIQUE(guard_id, comment_id) makes this idempotent across
        // overlapping sweeps — only the first insert counts.
        const { rowCount } = await query(
          `INSERT INTO comment_guard_actions (
             guard_id, target_id, comment_id, matched_rule, matched_detail,
             comment_message, author_name, permalink_url
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (guard_id, comment_id) DO NOTHING`,
          [
            guardId,
            target.id,
            c.id,
            match.rule,
            match.detail,
            (c.message ?? '').slice(0, 2000),
            c.from?.name ?? null,
            c.permalink_url ?? null,
          ]
        );
        if ((rowCount ?? 0) > 0) hiddenForTarget++;
      }

      await query(
        `UPDATE comment_guard_targets
           SET last_checked_at = NOW(), last_error = NULL,
               comments_hidden = comments_hidden + $2
         WHERE id = $1`,
        [target.id, hiddenForTarget]
      );
      hiddenThisSweep += hiddenForTarget;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await query(
        `UPDATE comment_guard_targets SET last_error = $2, last_checked_at = NOW() WHERE id = $1`,
        [target.id, message.slice(0, 500)]
      );
      // Don't abort the whole guard on one post's failure.
    }
  }

  await query(
    `UPDATE comment_guards
       SET last_swept_at = NOW(), comments_hidden = comments_hidden + $2, updated_at = NOW()
     WHERE id = $1`,
    [guardId, hiddenThisSweep]
  );

  // Tell the owner when a sweep actually hid something. Deduped per guard per
  // hour so a 5-minute sweep cadence can't spam the bell.
  if (hiddenThisSweep > 0) {
    const hourKey = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
    const label = guard.meta_campaign_name || 'Comment Guard';
    await notify({
      userId: guard.user_id,
      type: 'comment_guard.hidden',
      severity: 'info',
      title: `${hiddenThisSweep} comment${hiddenThisSweep === 1 ? '' : 's'} hidden`,
      body: `On ads in ${label}.`,
      link: '/comment-guard',
      dedupeKey: `cg:${guardId}:${hourKey}`,
      metadata: { guardId, hidden: hiddenThisSweep },
    });
  }
}
