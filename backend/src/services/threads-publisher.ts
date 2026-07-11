/**
 * Threads publisher.
 *
 * Implements the Threads Posts API publishing flow:
 *   1. Single image / video / text / carousel post
 *   2. Reply chains up to 5 posts total (head + 4 replies)
 *
 * Threads runs on its OWN host (graph.threads.net), not graph.facebook.com,
 * and uses its own scope namespace (threads_*). Per-user access tokens
 * are stored in organic_connected_accounts the same way IG/FB tokens are.
 *
 * Publishing pattern is "two-step" like IG: create a container, then
 * call /threads_publish with the container id. For carousels it's
 * three-step (per-child containers → carousel container → publish).
 *
 * For reply chains we publish post 1, capture its Threads media id,
 * then create+publish each subsequent post with reply_to_id pointing
 * at the previous published id. If any reply fails mid-chain, prior
 * posts stay up — we surface this as a partial result.
 */

import { OrganicAccountWithToken } from './organic-connection';
import { PublishError } from './organic-publisher';

const THREADS_BASE = 'https://graph.threads.net/v1.0';

// Recommended wait between container create and publish. Meta's docs
// say "on average 30 seconds" — but in practice text-only and image
// posts publish much faster. We start lower and back off on retry.
const PUBLISH_WAIT_INITIAL_MS = 5_000;
const PUBLISH_WAIT_MAX_MS = 35_000;
const PUBLISH_POLL_INTERVAL_MS = 3_000;

const MAX_REPLY_CHAIN_LENGTH = 5; // head + 4 replies

export interface ThreadsMediaItem {
  uploadId: string;
  kind: 'image' | 'video';
}

/** A single post in a Threads thread (head or reply). */
export interface ThreadsPostInput {
  body: string;
  media: ThreadsMediaItem[];
}

export interface ThreadsPublishInput {
  account: OrganicAccountWithToken;
  /** Head post. */
  head: ThreadsPostInput;
  /** Optional reply posts (0..4). Total chain length head + replies ≤ 5. */
  replies: ThreadsPostInput[];
  /** Topic tag for the head post. Threads enforces max 50 chars, no
   *  periods/ampersands. We don't pre-validate — let Meta reject it
   *  and surface the error if the user got it wrong. */
  topicTag: string | null;
  /** Resolves an uploadId to a public HTTPS URL Meta can fetch. */
  buildPublicMediaUrl: (uploadId: string) => string;
}

export interface ThreadsPublishResult {
  /** Head post id, used for permalink. */
  headPostId: string;
  /** Threads media ids for each successfully published post in order. */
  publishedPostIds: string[];
  /** True when at least one reply failed but the head went up. */
  partial: boolean;
  /** Index of the first failed reply (0-based among replies, not the
   *  chain). Null when fully successful. */
  firstFailedReplyIndex: number | null;
  /** Error message for the first failure, if any. */
  firstFailureMessage: string | null;
  permalink: string | null;
}

// =====================================================================
// Entry point
// =====================================================================

export async function publishThread(input: ThreadsPublishInput): Promise<ThreadsPublishResult> {
  const { account, head, replies, topicTag, buildPublicMediaUrl } = input;

  if (replies.length + 1 > MAX_REPLY_CHAIN_LENGTH) {
    throw new PublishError(
      `Reply chain exceeds maximum length (${MAX_REPLY_CHAIN_LENGTH}).`,
      'threads_chain_too_long'
    );
  }

  // ─── Publish head post ───
  const headPostId = await publishSinglePost({
    threadsUserId: account.externalId,
    accessToken: account.accessToken,
    post: head,
    topicTag,
    replyToId: null,
    buildPublicMediaUrl,
  });

  const publishedPostIds: string[] = [headPostId];
  let firstFailedReplyIndex: number | null = null;
  let firstFailureMessage: string | null = null;

  // ─── Publish reply chain ───
  // Each reply's reply_to_id is the PREVIOUS published post — replies
  // chain off the previous reply, not the head. This is what Threads
  // does natively in the app.
  for (let i = 0; i < replies.length; i++) {
    const previousPostId = publishedPostIds[publishedPostIds.length - 1];
    try {
      const replyId = await publishSinglePost({
        threadsUserId: account.externalId,
        accessToken: account.accessToken,
        post: replies[i],
        // Topic tag is ONLY on the head per our product decision.
        topicTag: null,
        replyToId: previousPostId,
        buildPublicMediaUrl,
      });
      publishedPostIds.push(replyId);
    } catch (err) {
      // Mid-chain failure: stop, mark partial, leave what we have.
      firstFailedReplyIndex = i;
      firstFailureMessage = err instanceof Error ? err.message : 'Reply failed';
      console.warn(
        `[threads] Reply ${i + 1}/${replies.length} failed; chain truncated. Reason:`,
        firstFailureMessage
      );
      break;
    }
  }

  return {
    headPostId,
    publishedPostIds,
    partial: firstFailedReplyIndex !== null,
    firstFailedReplyIndex,
    firstFailureMessage,
    permalink: buildThreadsPermalink(account, headPostId),
  };
}

// =====================================================================
// Single-post pipeline (used for head and for each reply)
// =====================================================================

async function publishSinglePost(args: {
  threadsUserId: string;
  accessToken: string;
  post: ThreadsPostInput;
  topicTag: string | null;
  replyToId: string | null;
  buildPublicMediaUrl: (uploadId: string) => string;
}): Promise<string> {
  const { threadsUserId, accessToken, post, topicTag, replyToId, buildPublicMediaUrl } = args;

  let containerId: string;

  if (post.media.length === 0) {
    containerId = await createTextContainer({
      threadsUserId,
      accessToken,
      text: post.body,
      topicTag,
      replyToId,
    });
  } else if (post.media.length === 1) {
    const m = post.media[0];
    containerId = await createSingleMediaContainer({
      threadsUserId,
      accessToken,
      text: post.body,
      mediaType: m.kind === 'image' ? 'IMAGE' : 'VIDEO',
      mediaUrl: buildPublicMediaUrl(m.uploadId),
      topicTag,
      replyToId,
    });
  } else {
    // Carousel — 2..20 children. Create each child container first,
    // then create the parent carousel container with `children`.
    const childIds: string[] = [];
    for (const m of post.media) {
      const childId = await createCarouselChildContainer({
        threadsUserId,
        accessToken,
        mediaType: m.kind === 'image' ? 'IMAGE' : 'VIDEO',
        mediaUrl: buildPublicMediaUrl(m.uploadId),
      });
      childIds.push(childId);
    }
    containerId = await createCarouselContainer({
      threadsUserId,
      accessToken,
      text: post.body,
      childIds,
      topicTag,
      replyToId,
    });
  }

  // Wait for the container to be ready, then publish. We poll status
  // because the recommended "30s sleep" wastes user time on simple
  // text posts.
  await waitForContainerReady(containerId, accessToken);
  return publishContainer({ threadsUserId, accessToken, creationId: containerId });
}

// =====================================================================
// Container creation primitives
// =====================================================================

async function createTextContainer(args: {
  threadsUserId: string;
  accessToken: string;
  text: string;
  topicTag: string | null;
  replyToId: string | null;
}): Promise<string> {
  const params = new URLSearchParams({
    media_type: 'TEXT',
    text: args.text,
    access_token: args.accessToken,
  });
  if (args.topicTag) params.set('topic_tag', args.topicTag);
  if (args.replyToId) params.set('reply_to_id', args.replyToId);
  return postContainer(args.threadsUserId, params, 'text container');
}

async function createSingleMediaContainer(args: {
  threadsUserId: string;
  accessToken: string;
  text: string;
  mediaType: 'IMAGE' | 'VIDEO';
  mediaUrl: string;
  topicTag: string | null;
  replyToId: string | null;
}): Promise<string> {
  const params = new URLSearchParams({
    media_type: args.mediaType,
    text: args.text,
    access_token: args.accessToken,
  });
  if (args.mediaType === 'IMAGE') {
    params.set('image_url', args.mediaUrl);
  } else {
    params.set('video_url', args.mediaUrl);
  }
  if (args.topicTag) params.set('topic_tag', args.topicTag);
  if (args.replyToId) params.set('reply_to_id', args.replyToId);
  return postContainer(args.threadsUserId, params, 'single-media container');
}

async function createCarouselChildContainer(args: {
  threadsUserId: string;
  accessToken: string;
  mediaType: 'IMAGE' | 'VIDEO';
  mediaUrl: string;
}): Promise<string> {
  const params = new URLSearchParams({
    media_type: args.mediaType,
    is_carousel_item: 'true',
    access_token: args.accessToken,
  });
  if (args.mediaType === 'IMAGE') {
    params.set('image_url', args.mediaUrl);
  } else {
    params.set('video_url', args.mediaUrl);
  }
  return postContainer(args.threadsUserId, params, 'carousel child');
}

async function createCarouselContainer(args: {
  threadsUserId: string;
  accessToken: string;
  text: string;
  childIds: string[];
  topicTag: string | null;
  replyToId: string | null;
}): Promise<string> {
  const params = new URLSearchParams({
    media_type: 'CAROUSEL',
    children: args.childIds.join(','),
    text: args.text,
    access_token: args.accessToken,
  });
  if (args.topicTag) params.set('topic_tag', args.topicTag);
  if (args.replyToId) params.set('reply_to_id', args.replyToId);
  return postContainer(args.threadsUserId, params, 'carousel container');
}

async function postContainer(
  threadsUserId: string,
  params: URLSearchParams,
  description: string
): Promise<string> {
  const resp = await fetch(`${THREADS_BASE}/${threadsUserId}/threads`, {
    method: 'POST',
    body: params,
  });
  const data = (await resp.json()) as {
    id?: string;
    error?: { message?: string; code?: number; error_subcode?: number };
  };
  if (!resp.ok || data.error || !data.id) {
    throw new PublishError(
      data.error?.message ?? `Threads ${description} create failed (${resp.status})`,
      String(data.error?.error_subcode ?? data.error?.code ?? resp.status)
    );
  }
  return data.id;
}

// =====================================================================
// Status polling + publish
// =====================================================================

async function waitForContainerReady(containerId: string, accessToken: string): Promise<void> {
  // We poll for `status_code === FINISHED`. Threads docs recommend an
  // average 30s sleep, but text and image posts often finish in 1-5s.
  // Video can take longer.
  const start = Date.now();
  // Initial gentle wait so even fast posts get a chance.
  await sleep(PUBLISH_WAIT_INITIAL_MS);

  while (Date.now() - start < PUBLISH_WAIT_MAX_MS) {
    const params = new URLSearchParams({
      fields: 'status,error_message',
      access_token: accessToken,
    });
    const resp = await fetch(`${THREADS_BASE}/${containerId}?${params}`, { method: 'GET' });
    const data = (await resp.json()) as {
      status?: string;
      error_message?: string;
      error?: { message?: string };
    };
    if (resp.ok && data.status) {
      if (data.status === 'FINISHED') return;
      if (data.status === 'ERROR' || data.status === 'EXPIRED') {
        throw new PublishError(
          data.error_message ?? `Container processing failed: ${data.status}`,
          'threads_container_error'
        );
      }
      // IN_PROGRESS / PUBLISHED — keep polling. PUBLISHED can appear
      // for replies in some rare cases; treat as ready.
      if (data.status === 'PUBLISHED') return;
    } else if (data.error?.message) {
      // Some transient errors can be ignored; we'll keep polling within
      // the deadline. Persistent failure manifests as the polling loop
      // timing out, which we surface below.
      console.warn('[threads] Container status check warned:', data.error.message);
    }
    await sleep(PUBLISH_POLL_INTERVAL_MS);
  }
  // Out of patience. Attempt the publish anyway — for many text posts
  // it'll succeed even if /status hasn't reported FINISHED yet. If the
  // publish itself fails, the error from there is more useful than a
  // generic timeout here.
}

async function publishContainer(args: {
  threadsUserId: string;
  accessToken: string;
  creationId: string;
}): Promise<string> {
  const params = new URLSearchParams({
    creation_id: args.creationId,
    access_token: args.accessToken,
  });
  const resp = await fetch(`${THREADS_BASE}/${args.threadsUserId}/threads_publish`, {
    method: 'POST',
    body: params,
  });
  const data = (await resp.json()) as {
    id?: string;
    error?: { message?: string; code?: number; error_subcode?: number };
  };
  if (!resp.ok || data.error || !data.id) {
    throw new PublishError(
      data.error?.message ?? `Threads publish failed (${resp.status})`,
      String(data.error?.error_subcode ?? data.error?.code ?? resp.status)
    );
  }
  return data.id;
}

// =====================================================================
// Helpers
// =====================================================================

function buildThreadsPermalink(
  account: OrganicAccountWithToken,
  postId: string
): string | null {
  // Threads permalinks look like https://www.threads.net/@{username}/post/{shortcode}.
  // We don't have the shortcode from the publish response, only the
  // numeric media id. Best we can do is a deeplink-style /post/<id> URL,
  // which threads.net does redirect properly for own posts.
  const username = (account.meta as { username?: string } | null)?.username;
  if (!username) return null;
  return `https://www.threads.net/@${username}/post/${postId}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
