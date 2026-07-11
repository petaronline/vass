/**
 * Organic publish runner.
 *
 * Loads a post from the DB (with its targets and media), runs the
 * platform-specific publisher for each target, and writes the results
 * back.
 *
 * Called from two places:
 *   1. POST /organic/posts route, immediately, for publish-now posts.
 *   2. The organic-publish BullMQ worker when a scheduled job fires.
 *
 * The behavior is identical in both cases — the only difference is
 * whether the row was created with status='publishing' (publish-now)
 * or status='scheduled' (which we flip to 'publishing' here).
 *
 * Importantly: the runner reads the latest post state from the DB
 * every time it runs, so a post edited between schedule and execution
 * publishes its current content.
 *
 * Returns an aggregate summary the caller can use for its HTTP
 * response (publish-now) or just logging (worker).
 */
import { query } from '../db/pool';
import * as publisher from './organic-publisher';

export interface RunResult {
  status: 'published' | 'partial' | 'failed';
  succeeded: number;
  failed: number;
}

export async function runPublish(postId: string): Promise<RunResult> {
  // Snapshot the post itself so we can use its body when no override is set.
  const { rows: postRows } = await query<{
    id: string;
    user_id: string;
    body: string;
    first_comment: string | null;
    collaborators: string[] | null;
    cover_upload_id: string | null;
    topic_tag: string | null;
    document_title: string | null;
    reply_chain: { body: string }[];
    tiktok_privacy: string | null;
    tiktok_commercial_content: boolean;
    tiktok_your_brand: boolean;
    tiktok_branded_content: boolean;
    tiktok_disable_comment: boolean;
    tiktok_disable_duet: boolean;
    tiktok_disable_stitch: boolean;
  }>(
    `SELECT id, user_id, body, first_comment, collaborators, cover_upload_id,
            topic_tag, document_title, reply_chain,
            tiktok_privacy, tiktok_commercial_content, tiktok_your_brand,
            tiktok_branded_content, tiktok_disable_comment,
            tiktok_disable_duet, tiktok_disable_stitch
       FROM organic_posts WHERE id = $1 LIMIT 1`,
    [postId]
  );
  if (postRows.length === 0) {
    // Post got deleted between scheduling and firing — nothing to do.
    return { status: 'failed', succeeded: 0, failed: 0 };
  }
  const post = postRows[0];

  // Snapshot media. Single query, sorted. Includes reply_index so we
  // can partition into the head post (index 0) and reply posts (1..4).
  const { rows: mediaRows } = await query<{
    upload_id: string;
    kind: 'image' | 'video' | 'document';
    reply_index: number;
    target_id: string | null;
  }>(
    `SELECT upload_id, kind, reply_index, target_id FROM organic_post_media
      WHERE post_id = $1 ORDER BY reply_index ASC, sort_order ASC`,
    [postId]
  );
  // Shared head post media = reply_index 0 AND no target override.
  const mediaItems = mediaRows
    .filter((m) => m.reply_index === 0 && m.target_id === null)
    .map((m) => ({ uploadId: m.upload_id, kind: m.kind }));

  // Build the reply chain by combining text bodies (from reply_chain
  // JSON) with their media (from organic_post_media filtered by index).
  // The chain length is bounded by 4 in the DB; if reply_chain has
  // fewer entries than there's media for, we trust reply_chain (the
  // text is the authoritative count of replies).
  const replyChain = (post.reply_chain ?? []).map((r, idx) => {
    const replyIdx = idx + 1; // 1..4
    const media = mediaRows
      .filter((m) => m.reply_index === replyIdx && m.target_id === null)
      .map((m) => ({ uploadId: m.upload_id, kind: m.kind }));
    return { body: r.body, media };
  });

  // Snapshot targets. Filter out anything already done (idempotency for retries).
  const { rows: targetRows } = await query<{
    id: string;
    account_id: string;
    body_override: string | null;
    status: string;
  }>(
    `SELECT id, account_id, body_override, status FROM organic_post_targets
      WHERE post_id = $1 ORDER BY created_at ASC`,
    [postId]
  );

  // Flip aggregate status to 'publishing' (covers both schedule→fire
  // and any pre-existing draft state).
  await query(
    `UPDATE organic_posts SET status = 'publishing', updated_at = NOW() WHERE id = $1`,
    [postId]
  );

  let succeeded = 0;
  let failed = 0;

  for (const t of targetRows) {
    // Skip targets that already succeeded (worker retries). Failed
    // targets DO retry — the worker is responsible for the full set.
    if (t.status === 'published') {
      succeeded++;
      continue;
    }

    await query(
      `UPDATE organic_post_targets
          SET status = 'publishing', error_message = NULL, error_code = NULL,
              updated_at = NOW()
        WHERE id = $1`,
      [t.id]
    );

    try {
      // Cover URL is built the same way as other media — public token
      // URL that Meta can fetch (FB and IG both need to download the
      // image). Only generated when the post has a cover upload set.
      const coverUrl = post.cover_upload_id
        ? publisher.buildPublicMediaUrl(post.cover_upload_id)
        : null;

      // Per-network media: if this target has its own media rows, use them;
      // otherwise fall back to the shared head media.
      const targetOwnMedia = mediaRows
        .filter((m) => m.target_id === t.id && m.reply_index === 0)
        .map((m) => ({ uploadId: m.upload_id, kind: m.kind }));
      const effectiveMedia = targetOwnMedia.length > 0 ? targetOwnMedia : mediaItems;

      const result = await publisher.publishPost({
        userId: post.user_id,
        accountId: t.account_id,
        body: t.body_override ?? post.body ?? '',
        mediaItems: effectiveMedia,
        collaborators: post.collaborators ?? [],
        coverUrl,
        topicTag: post.topic_tag,
        documentTitle: post.document_title,
        replyChain,
        // TikTok per-post settings (ignored by other platforms).
        tiktok: {
          privacy: (post.tiktok_privacy ?? undefined) as
            | 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS'
            | 'FOLLOWER_OF_CREATOR' | 'SELF_ONLY' | undefined,
          commercialContent: post.tiktok_commercial_content,
          yourBrand: post.tiktok_your_brand,
          brandedContent: post.tiktok_branded_content,
          disableComment: post.tiktok_disable_comment,
          disableDuet: post.tiktok_disable_duet,
          disableStitch: post.tiktok_disable_stitch,
        },
      });
      // Surface soft warnings on the target row. Either:
      //   • Meta rejected collaborators but the post itself went up, OR
      //   • Threads reply chain truncated mid-publish (head + some
      //     replies up, rest failed).
      // Both cases keep status='published' because the user's primary
      // post is live; the UI shows the warning so they can manually fix.
      let warningNote: string | null = null;
      let warningCode: string | null = null;
      if (result.droppedCollaborators) {
        warningNote =
          'Posted, but Meta rejected the collaborator invite(s). Check that the usernames are correct, public, and not age-restricted.';
        warningCode = 'collaborators_dropped';
      } else if (
        result.threadsPublishedCount !== undefined &&
        result.threadsTotalCount !== undefined &&
        result.threadsPublishedCount < result.threadsTotalCount
      ) {
        warningNote =
          `Posted ${result.threadsPublishedCount} of ${result.threadsTotalCount} thread posts. ` +
          (result.threadsPartialReason
            ? `Mid-chain failure: ${result.threadsPartialReason}`
            : 'Some replies failed.');
        warningCode = 'threads_chain_partial';
      }
      await query(
        `UPDATE organic_post_targets
            SET status = 'published',
                external_post_id = $1,
                external_post_url = $2,
                published_at = NOW(),
                error_message = $3,
                error_code = $4,
                updated_at = NOW()
          WHERE id = $5`,
        [
          result.externalPostId,
          result.externalPostUrl,
          warningNote,
          warningCode,
          t.id,
        ]
      );
      succeeded++;

      // First comment — best-effort. If it fails, the main post is still
      // a success; we log the comment error to the target row but don't
      // flip its status. This matches user intent: "post happened" is
      // the primary success signal.
      if (post.first_comment && post.first_comment.trim()) {
        try {
          const commentId = await publisher.postFirstComment(
            post.user_id,
            t.account_id,
            result.externalPostId,
            post.first_comment.trim()
          );
          await query(
            `UPDATE organic_post_targets
                SET first_comment_external_id = $1,
                    first_comment_posted_at = NOW(),
                    updated_at = NOW()
              WHERE id = $2`,
            [commentId, t.id]
          );
        } catch (err) {
          // Don't change target status — the post itself succeeded.
          // Surface the failure via error_message so the user can see
          // why their first comment is missing.
          const msg = err instanceof Error ? err.message : 'first comment failed';
          console.warn('[organic/publish] first comment failed:', t.account_id, msg);
          await query(
            `UPDATE organic_post_targets
                SET error_message = $1,
                    error_code = 'first_comment_failed',
                    updated_at = NOW()
              WHERE id = $2`,
            [`First comment failed: ${msg}`, t.id]
          );
        }
      }
    } catch (err) {
      const message = err instanceof publisher.PublishError
        ? err.message
        : err instanceof Error ? err.message : 'Unknown error';
      const code = err instanceof publisher.PublishError ? err.code : 'unknown';
      console.error('[organic/publish] target failed:', t.account_id, message);
      await query(
        `UPDATE organic_post_targets
            SET status = 'failed',
                error_message = $1,
                error_code = $2,
                updated_at = NOW()
          WHERE id = $3`,
        [message, code, t.id]
      );
      failed++;
    }
  }

  const aggregate: 'published' | 'partial' | 'failed' =
    failed === 0 ? 'published' : succeeded === 0 ? 'failed' : 'partial';

  // Patch 4.42.0 — failure routing.
  //   • All succeeded  → 'published' (unchanged).
  //   • All failed     → the post goes BACK TO 'draft' so it lands in
  //                      Drafts; its targets reset to 'pending' for a
  //                      clean re-send. No 'failed' dead-end state.
  //   • Partial        → what published STAYS published (the post row
  //                      stays 'published'); the FAILED targets are
  //                      split off into a NEW draft that carries only
  //                      those targets, so re-sending can't double-post
  //                      to the ones that already went out.
  if (aggregate === 'published') {
    await query(
      `UPDATE organic_posts
          SET status = 'published', published_at = NOW(),
              scheduled_job_id = NULL, updated_at = NOW()
        WHERE id = $1`,
      [postId]
    );
  } else if (aggregate === 'failed') {
    // Whole post failed → back to draft. Reset status to 'pending' so it can
    // be retried, but PRESERVE error_message / error_code so the user can see
    // why each target failed when they reopen the draft. (Previously these
    // were wiped, leaving the draft with no failure reason.)
    await query(
      `UPDATE organic_posts
          SET status = 'draft', published_at = NULL,
              scheduled_for = NULL, scheduled_job_id = NULL, updated_at = NOW()
        WHERE id = $1`,
      [postId]
    );
    await query(
      `UPDATE organic_post_targets
          SET status = 'pending',
              updated_at = NOW()
        WHERE post_id = $1`,
      [postId]
    );
  } else {
    // Partial: the original post represents what published. Mark it
    // published (the succeeded targets), then split the failed targets
    // into a fresh draft.
    await query(
      `UPDATE organic_posts
          SET status = 'published', published_at = NOW(),
              scheduled_job_id = NULL, updated_at = NOW()
        WHERE id = $1`,
      [postId]
    );
    try {
      await splitFailedTargetsIntoDraft(postId, post, mediaRows);
    } catch (err) {
      console.error('[organic/publish] failed to split partial into draft:', err);
      // Non-fatal — the publish itself stands; the user can recreate
      // the missed targets manually if the split failed.
    }
  }

  return { status: aggregate, succeeded, failed };
}

/**
 * Patch 4.42.0 — on a PARTIAL publish, clone the post into a new draft
 * that carries ONLY the failed targets (status reset to pending) plus a
 * copy of the media. The succeeded targets stay on the original
 * (published) post, so re-sending the draft can't double-post.
 */
async function splitFailedTargetsIntoDraft(
  originalPostId: string,
  post: {
    user_id: string;
    body: string;
    first_comment: string | null;
    collaborators: string[] | null;
    cover_upload_id: string | null;
    topic_tag: string | null;
    reply_chain: { body: string }[];
  },
  mediaRows: { upload_id: string; kind: 'image' | 'video' | 'document'; reply_index: number }[]
): Promise<void> {
  // Failed targets on the original post.
  const { rows: failedTargets } = await query<{
    account_id: string;
    platform: string;
    body_override: string | null;
  }>(
    `SELECT account_id, platform, body_override
       FROM organic_post_targets
      WHERE post_id = $1 AND status = 'failed'`,
    [originalPostId]
  );
  if (failedTargets.length === 0) return;

  // Carry over brand_id + upload_id (legacy single-image field) from
  // the original.
  const { rows: parentRows } = await query<{ brand_id: string | null; upload_id: string | null }>(
    `SELECT brand_id, upload_id FROM organic_posts WHERE id = $1`,
    [originalPostId]
  );
  const brandId = parentRows[0]?.brand_id ?? null;
  const uploadId = parentRows[0]?.upload_id ?? null;

  const { rows: newRows } = await query<{ id: string }>(
    `INSERT INTO organic_posts
       (user_id, brand_id, body, upload_id, first_comment, collaborators,
        cover_upload_id, topic_tag, reply_chain, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft')
     RETURNING id`,
    [
      post.user_id,
      brandId,
      post.body,
      uploadId,
      post.first_comment,
      post.collaborators ?? [],
      post.cover_upload_id,
      post.topic_tag,
      JSON.stringify((post.reply_chain ?? []).map((r) => ({ body: r.body }))),
    ]
  );
  const newPostId = newRows[0].id;

  // Clone media (head + replies), preserving per-reply sort order.
  const sortByReply = new Map<number, number>();
  for (const m of mediaRows) {
    const so = sortByReply.get(m.reply_index) ?? 0;
    await query(
      `INSERT INTO organic_post_media (post_id, upload_id, kind, sort_order, reply_index)
       VALUES ($1, $2, $3, $4, $5)`,
      [newPostId, m.upload_id, m.kind, so, m.reply_index]
    );
    sortByReply.set(m.reply_index, so + 1);
  }

  // Attach the failed targets to the new draft, reset to pending.
  for (const t of failedTargets) {
    await query(
      `INSERT INTO organic_post_targets
         (post_id, account_id, platform, body_override, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [newPostId, t.account_id, t.platform, t.body_override]
    );
  }
}
