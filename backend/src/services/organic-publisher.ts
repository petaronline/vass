/**
 * Organic publishing service.
 *
 * Patch 4.27 adds multi-media support:
 *   - Multiple images → carousel (FB attached_media, IG CAROUSEL container)
 *   - Single video   → IG Reels (Meta deprecated legacy video), FB video post
 *   - Single image   → existing single-photo flow (unchanged)
 *
 * Constraint enforced at the route layer (and assumed here): a post is
 * either all-image OR a single video. We DO NOT mix in this patch.
 *
 * Media URLs sent to Meta are HMAC-signed public URLs with 1h TTL — see
 * crypto.ts. Tokens are minted right before each Graph call.
 */

import { env } from '../utils/env';
import { makeUploadPublicToken } from '../utils/crypto';
import { getAccountWithToken, OrganicAccountWithToken } from './organic-connection';
import * as threadsPub from './threads-publisher';

const GRAPH_API_VERSION = 'v25.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/** Container-status poll cap. IG containers usually finish in 1-5s for
 *  images. Videos (Reels) can take 30s+ on the first attempt. */
const IG_CONTAINER_MAX_POLLS_IMAGE = 30;
const IG_CONTAINER_MAX_POLLS_VIDEO = 60;
const IG_CONTAINER_POLL_INTERVAL_MS = 1500;

export type MediaKind = 'image' | 'video' | 'document';
export interface MediaItem {
  uploadId: string;
  kind: MediaKind;
}

export interface PublishInput {
  userId: string;
  /** The account we're publishing to (must belong to userId). */
  accountId: string;
  /** Post body. For IG this becomes the caption. */
  body: string;
  /** Ordered media items. Empty = text-only.
   *  All-image (1-10) OR a single video. Enforced upstream. */
  mediaItems: MediaItem[];
  /** LinkedIn-only: title for a document (PDF) post. Required by LinkedIn
   *  when the media is a document; ignored for other platforms/kinds. */
  documentTitle?: string | null;
  /** Optional Facebook Page ID of a place to tag.
   *  FB uses this as `place`, IG uses it as `location_id`. */
  locationId?: string | null;
  /** IG collaborators — up to 3 usernames. Silently dropped for
   *  non-IG platforms since Meta doesn't expose collab invites
   *  for FB Page posts via Graph API. */
  collaborators?: string[];
  /** Optional public HTTPS URL of a custom cover image for video
   *  posts (Reels). Applied to IG via the container's `cover_url`
   *  param; FB gets it post-publish via `/{video-id}/thumbnails`
   *  (best-effort — silently skipped if the FB scope is missing).
   *  Ignored for non-video posts. */
  coverUrl?: string | null;
  /** Threads-only: topic tag on the head post (max 50 chars).
   *  Silently dropped for FB/IG. */
  topicTag?: string | null;
  /** Threads-only: reply posts after the head. Up to 4 entries.
   *  Each entry's media is separate from the head media. FB/IG
   *  drop the entire chain silently. */
  replyChain?: { body: string; media: MediaItem[] }[];
  /** TikTok-only: privacy + commercial-disclosure + interaction toggles.
   *  Ignored by FB/IG/Threads. When absent for a TikTok target, safe
   *  defaults are used (private + no disclosure). */
  tiktok?: {
    privacy?: 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'FOLLOWER_OF_CREATOR' | 'SELF_ONLY';
    commercialContent?: boolean;
    yourBrand?: boolean;
    brandedContent?: boolean;
    disableComment?: boolean;
    disableDuet?: boolean;
    disableStitch?: boolean;
  };
}

export interface PublishResult {
  externalPostId: string;
  externalPostUrl: string | null;
  /** Soft warning: true if we requested collaborators but Meta rejected
   *  them, so we retried without. The post itself succeeded. */
  droppedCollaborators?: boolean;
  /** Threads-only: how many posts in the chain actually went up. */
  threadsPublishedCount?: number;
  /** Threads-only: total intended chain length (head + replies). */
  threadsTotalCount?: number;
  /** Threads-only: when the chain truncated mid-publish, the error from
   *  the first failing reply. Head is always up if we returned a result. */
  threadsPartialReason?: string | null;
}

export class PublishError extends Error {
  code: string;
  constructor(message: string, code: string = 'unknown') {
    super(message);
    this.name = 'PublishError';
    this.code = code;
  }
}

// =====================================================================
// Entry point
// =====================================================================

export async function publishPost(input: PublishInput): Promise<PublishResult> {
  const account = await getAccountWithToken(input.userId, input.accountId);
  if (!account) {
    throw new PublishError('Account not found or disconnected', 'account_not_found');
  }

  const media = input.mediaItems;
  const hasVideo = media.some((m) => m.kind === 'video');
  const imageCount = media.filter((m) => m.kind === 'image').length;

  // Defensive — should be caught at the route layer
  if (hasVideo && media.length > 1) {
    throw new PublishError('Mixed/multi video is not supported in this patch.', 'mixed_media');
  }
  if (imageCount > 10) {
    throw new PublishError('Max 10 images per carousel.', 'too_many_images');
  }

  const locationId = input.locationId ?? null;
  const collaborators = (input.collaborators ?? []).filter((u) => u && u.trim()).slice(0, 3);
  const coverUrl = input.coverUrl ?? null;
  const topicTag = input.topicTag ?? null;
  const replyChain = input.replyChain ?? [];

  if (account.platform === 'facebook_page') {
    // FB drops Threads-specific fields silently (topicTag, replyChain)
    // and has no collab-invite API (collaborators also silently dropped).
    return publishToFacebookPage(account, input.body, media, locationId, coverUrl);
  }
  if (account.platform === 'instagram') {
    // IG drops Threads-specific fields silently.
    return publishToInstagram(account, input.body, media, locationId, collaborators, coverUrl);
  }
  if (account.platform === 'threads') {
    // Threads drops FB/IG-specific fields silently (locationId,
    // collaborators, coverUrl).
    return publishToThreads(account, input.body, media, topicTag, replyChain);
  }
  if (account.platform === 'tiktok') {
    // TikTok: media required, no text-only. Privacy/disclosure come
    // from input.tiktok (defaults to private + no disclosure).
    // Dynamic import avoids a load-time circular dependency
    // (tiktok-publisher imports shared helpers from this module).
    const { publishToTikTok } = await import('./tiktok-publisher');
    const tk = input.tiktok ?? {};
    return publishToTikTok(input.userId, input.accountId, input.body, media, {
      privacy: tk.privacy ?? 'SELF_ONLY',
      disclosure: {
        commercialContent: !!tk.commercialContent,
        yourBrand: !!tk.yourBrand,
        brandedContent: !!tk.brandedContent,
      },
      disableComment: tk.disableComment,
      disableDuet: tk.disableDuet,
      disableStitch: tk.disableStitch,
    });
  }
  if (account.platform === 'linkedin') {
    // LinkedIn: text-only, single image, multi-image carousel, or a
    // single video. Drops FB/IG/Threads/TikTok-specific fields silently.
    // Dynamic import mirrors the TikTok branch (linkedin-publisher
    // imports PublishError/MediaItem/PublishResult from this module).
    const { publishToLinkedIn } = await import('./linkedin-publisher');
    return publishToLinkedIn(input.userId, input.accountId, input.body, media, input.documentTitle ?? undefined);
  }
  throw new PublishError(`Unsupported platform: ${account.platform}`, 'unsupported_platform');
}

/**
 * Post a first-comment reply on a just-published post. Best-effort —
 * we don't fail the whole publish if the comment fails. Returns the
 * comment id on success, throws on failure (caller decides whether to
 * propagate).
 *
 * FB: POST /{post-id}/comments  → { id }
 * IG: POST /{media-id}/comments → { id }   (requires instagram_manage_comments)
 *
 * Same endpoint shape for both, so we keep a single helper.
 */
export async function postFirstComment(
  userId: string,
  accountId: string,
  externalPostId: string,
  message: string
): Promise<string> {
  const account = await getAccountWithToken(userId, accountId);
  if (!account) {
    throw new PublishError('Account not found for comment', 'account_not_found');
  }
  const params = new URLSearchParams({
    message,
    access_token: account.accessToken,
  });
  const resp = await fetch(`${GRAPH_BASE}/${externalPostId}/comments`, {
    method: 'POST',
    body: params,
  });
  const data = (await resp.json()) as {
    id?: string;
    error?: { message?: string; code?: number; error_subcode?: number };
  };
  if (!resp.ok || data.error || !data.id) {
    throw new PublishError(
      data.error?.message ?? `First comment failed (${resp.status})`,
      String(data.error?.error_subcode ?? data.error?.code ?? resp.status)
    );
  }
  return data.id;
}

// =====================================================================
// Facebook Page
// =====================================================================

async function publishToFacebookPage(
  account: OrganicAccountWithToken,
  body: string,
  media: MediaItem[],
  locationId: string | null,
  coverUrl: string | null
): Promise<PublishResult> {
  const pageId = account.externalId;
  const accessToken = account.accessToken;

  // Text-only → /feed
  if (media.length === 0) {
    return fbPostText(pageId, accessToken, body, locationId);
  }

  // Single video → /videos. Cover image is applied post-publish via
  // /{video-id}/thumbnails (FB has no in-flight cover param for /videos).
  if (media.length === 1 && media[0].kind === 'video') {
    return fbPostVideo(pageId, accessToken, body, buildPublicMediaUrl(media[0].uploadId), locationId, coverUrl);
  }

  // Single image → /photos (existing flow, unchanged)
  if (media.length === 1 && media[0].kind === 'image') {
    return fbPostPhoto(pageId, accessToken, body, buildPublicMediaUrl(media[0].uploadId), locationId);
  }

  // Multiple images → unpublished photos + /feed with attached_media
  return fbPostCarousel(pageId, accessToken, body, media, locationId);
}

async function fbPostText(
  pageId: string,
  accessToken: string,
  body: string,
  locationId: string | null
): Promise<PublishResult> {
  const params = new URLSearchParams({ message: body, access_token: accessToken });
  if (locationId) params.set('place', locationId);
  const resp = await fetch(`${GRAPH_BASE}/${pageId}/feed`, { method: 'POST', body: params });
  const data = (await resp.json()) as {
    id?: string;
    error?: { message?: string; code?: number; error_subcode?: number };
  };
  if (!resp.ok || data.error || !data.id) {
    throw new PublishError(
      data.error?.message ?? `FB Page feed failed (${resp.status})`,
      String(data.error?.error_subcode ?? data.error?.code ?? resp.status)
    );
  }
  return { externalPostId: data.id, externalPostUrl: `https://www.facebook.com/${data.id}` };
}

async function fbPostPhoto(
  pageId: string,
  accessToken: string,
  body: string,
  imageUrl: string,
  locationId: string | null
): Promise<PublishResult> {
  const params = new URLSearchParams({
    url: imageUrl,
    caption: body,
    access_token: accessToken,
  });
  if (body) params.set('message', body);
  if (locationId) params.set('place', locationId);
  const resp = await fetch(`${GRAPH_BASE}/${pageId}/photos`, { method: 'POST', body: params });
  const data = (await resp.json()) as {
    post_id?: string;
    id?: string;
    error?: { message?: string; code?: number; error_subcode?: number };
  };
  if (!resp.ok || data.error) {
    throw new PublishError(
      data.error?.message ?? `FB Page photo failed (${resp.status})`,
      String(data.error?.error_subcode ?? data.error?.code ?? resp.status)
    );
  }
  const postId = data.post_id ?? data.id!;
  return { externalPostId: postId, externalPostUrl: `https://www.facebook.com/${postId}` };
}

async function fbPostVideo(
  pageId: string,
  accessToken: string,
  body: string,
  videoUrl: string,
  locationId: string | null,
  coverUrl: string | null
): Promise<PublishResult> {
  // /videos accepts a file_url — Meta downloads and processes asynchronously.
  // For now we don't wait for processing; the post id returned is durable.
  const params = new URLSearchParams({
    file_url: videoUrl,
    description: body,
    access_token: accessToken,
  });
  if (locationId) params.set('place', locationId);
  const resp = await fetch(`${GRAPH_BASE}/${pageId}/videos`, { method: 'POST', body: params });
  const data = (await resp.json()) as {
    id?: string;
    error?: { message?: string; code?: number; error_subcode?: number };
  };
  if (!resp.ok || data.error || !data.id) {
    throw new PublishError(
      data.error?.message ?? `FB Page video failed (${resp.status})`,
      String(data.error?.error_subcode ?? data.error?.code ?? resp.status)
    );
  }
  const videoId = data.id;

  // Best-effort cover upload. Meta needs the video associated with the
  // page before accepting a thumbnail, which is immediate after /videos
  // returns (the page is implied by the page-scoped token). We fail
  // silently — the post itself is already up; a missing custom cover
  // is a cosmetic loss, not a publishing loss.
  if (coverUrl) {
    try {
      await fbSetVideoThumbnail(videoId, accessToken, coverUrl);
    } catch (e) {
      console.warn(`[organic/publish] FB cover upload failed for video ${videoId}:`, e);
    }
  }

  return { externalPostId: videoId, externalPostUrl: `https://www.facebook.com/${videoId}` };
}

/** Upload a custom thumbnail for an already-posted FB video.
 *  Endpoint: POST /{video-id}/thumbnails with multipart source=@file.
 *  Requires the pages_read_user_content scope, which we added in 4.33. */
async function fbSetVideoThumbnail(
  videoId: string,
  accessToken: string,
  coverUrl: string
): Promise<void> {
  // Fetch the cover image bytes from our own upload server. We can't
  // forward a URL to Meta directly here — /{video-id}/thumbnails expects
  // a multipart file, not a URL.
  const imgResp = await fetch(coverUrl);
  if (!imgResp.ok) {
    throw new Error(`Could not fetch cover image: HTTP ${imgResp.status}`);
  }
  const imgBlob = await imgResp.blob();

  const form = new FormData();
  form.append('source', imgBlob, 'cover.jpg');
  form.append('is_preferred', 'true');
  form.append('access_token', accessToken);

  const resp = await fetch(`${GRAPH_BASE}/${videoId}/thumbnails`, {
    method: 'POST',
    body: form,
  });
  const data = (await resp.json()) as {
    success?: boolean;
    error?: { message?: string };
  };
  if (!resp.ok || data.error) {
    throw new Error(data.error?.message ?? `Thumbnail POST failed (${resp.status})`);
  }
}

async function fbPostCarousel(
  pageId: string,
  accessToken: string,
  body: string,
  media: MediaItem[],
  locationId: string | null
): Promise<PublishResult> {
  // Step 1: Upload each image as an unpublished photo, get back media_fbid.
  // `published=false` keeps the photo from appearing on the page until the
  // /feed post that ties them together is created.
  const mediaFbids: string[] = [];
  for (const m of media) {
    const url = buildPublicMediaUrl(m.uploadId);
    const params = new URLSearchParams({
      url,
      published: 'false',
      access_token: accessToken,
    });
    const resp = await fetch(`${GRAPH_BASE}/${pageId}/photos`, { method: 'POST', body: params });
    const data = (await resp.json()) as {
      id?: string;
      error?: { message?: string; code?: number; error_subcode?: number };
    };
    if (!resp.ok || data.error || !data.id) {
      throw new PublishError(
        data.error?.message ?? `FB carousel child upload failed (${resp.status})`,
        String(data.error?.error_subcode ?? data.error?.code ?? resp.status)
      );
    }
    mediaFbids.push(data.id);
  }

  // Step 2: Create the /feed post with attached_media referencing the uploads.
  // attached_media is a JSON array of { media_fbid: "..." } objects, passed
  // as form fields with bracket indexing per Meta's convention.
  const params = new URLSearchParams({ message: body, access_token: accessToken });
  if (locationId) params.set('place', locationId);
  mediaFbids.forEach((id, i) => {
    params.set(`attached_media[${i}]`, JSON.stringify({ media_fbid: id }));
  });
  const resp = await fetch(`${GRAPH_BASE}/${pageId}/feed`, { method: 'POST', body: params });
  const data = (await resp.json()) as {
    id?: string;
    error?: { message?: string; code?: number; error_subcode?: number };
  };
  if (!resp.ok || data.error || !data.id) {
    throw new PublishError(
      data.error?.message ?? `FB carousel feed post failed (${resp.status})`,
      String(data.error?.error_subcode ?? data.error?.code ?? resp.status)
    );
  }
  return { externalPostId: data.id, externalPostUrl: `https://www.facebook.com/${data.id}` };
}

// =====================================================================
// Instagram
// =====================================================================

async function publishToInstagram(
  account: OrganicAccountWithToken,
  body: string,
  media: MediaItem[],
  locationId: string | null,
  collaborators: string[],
  coverUrl: string | null
): Promise<PublishResult> {
  if (media.length === 0) {
    throw new PublishError(
      'Instagram posts require an image or video.',
      'ig_text_only_unsupported'
    );
  }

  const igUserId = account.externalId;
  const accessToken = account.accessToken;

  // Single video → REELS. Cover image (if any) is passed via cover_url
  // on the container — IG accepts this in-flight, unlike FB.
  if (media.length === 1 && media[0].kind === 'video') {
    return igPostReel(igUserId, accessToken, body, buildPublicMediaUrl(media[0].uploadId), locationId, collaborators, coverUrl);
  }

  // Single image → IMAGE (cover doesn't apply)
  if (media.length === 1 && media[0].kind === 'image') {
    return igPostImage(igUserId, accessToken, body, buildPublicMediaUrl(media[0].uploadId), locationId, collaborators);
  }

  // Multi-image → CAROUSEL (cover doesn't apply)
  return igPostCarousel(igUserId, accessToken, body, media, locationId, collaborators);
}

// =====================================================================
// Threads dispatch (Patch 4.34)
//
// All the actual work lives in threads-publisher.ts. This function is
// a thin adapter: it converts our publisher's PublishResult shape into
// what the runner expects, and forwards the topicTag + replyChain.
// =====================================================================

async function publishToThreads(
  account: OrganicAccountWithToken,
  body: string,
  media: MediaItem[],
  topicTag: string | null,
  replyChain: { body: string; media: MediaItem[] }[]
): Promise<PublishResult> {
  // Threads accepts text-only posts (unlike IG), so empty media is fine.
  // The publisher handles all media combinations internally.
  // Documents are LinkedIn-only; drop them so the kinds line up.
  const threadsMedia = media.filter((m) => m.kind !== 'document') as {
    uploadId: string;
    kind: 'image' | 'video';
  }[];
  const threadsReplies = replyChain.map((r) => ({
    body: r.body,
    media: r.media.filter((m) => m.kind !== 'document') as {
      uploadId: string;
      kind: 'image' | 'video';
    }[],
  }));
  const result = await threadsPub.publishThread({
    account,
    head: { body, media: threadsMedia },
    replies: threadsReplies,
    topicTag,
    buildPublicMediaUrl,
  });

  // Surface partial-chain failures via the same partial mechanism we
  // use elsewhere. The head post counts as success; failed mid-chain
  // replies are reported as a warning in the runner's response.
  return {
    externalPostId: result.headPostId,
    externalPostUrl: result.permalink ?? `https://www.threads.net/post/${result.headPostId}`,
    // Optional diagnostic fields — runner surfaces these to the UI.
    threadsPublishedCount: result.publishedPostIds.length,
    threadsTotalCount: replyChain.length + 1,
    threadsPartialReason: result.firstFailureMessage,
  };
}

async function igPostImage(
  igUserId: string,
  accessToken: string,
  caption: string,
  imageUrl: string,
  locationId: string | null,
  collaborators: string[]
): Promise<PublishResult> {
  const createParams = new URLSearchParams({
    image_url: imageUrl,
    caption,
    access_token: accessToken,
  });
  if (locationId) createParams.set('location_id', locationId);
  const { containerId, droppedCollaborators } = await createIgContainerWithCollabRetry(
    igUserId, accessToken, createParams, collaborators, 'IG image container create'
  );
  await waitForContainer(containerId, accessToken, IG_CONTAINER_MAX_POLLS_IMAGE);
  const result = await igPublishContainer(igUserId, accessToken, containerId);
  return { ...result, droppedCollaborators };
}

async function igPostReel(
  igUserId: string,
  accessToken: string,
  caption: string,
  videoUrl: string,
  locationId: string | null,
  collaborators: string[],
  coverUrl: string | null
): Promise<PublishResult> {
  const createParams = new URLSearchParams({
    media_type: 'REELS',
    video_url: videoUrl,
    caption,
    access_token: accessToken,
  });
  if (locationId) createParams.set('location_id', locationId);
  if (coverUrl) createParams.set('cover_url', coverUrl);
  const { containerId, droppedCollaborators } = await createIgContainerWithCollabRetry(
    igUserId, accessToken, createParams, collaborators, 'IG reel container create'
  );
  // Reels take longer to process — use the higher poll cap.
  await waitForContainer(containerId, accessToken, IG_CONTAINER_MAX_POLLS_VIDEO);
  const result = await igPublishContainer(igUserId, accessToken, containerId);
  return { ...result, droppedCollaborators };
}

async function igPostCarousel(
  igUserId: string,
  accessToken: string,
  caption: string,
  media: MediaItem[],
  locationId: string | null,
  collaborators: string[]
): Promise<PublishResult> {
  // Step 1: One child container per item with is_carousel_item=true.
  const childIds: string[] = [];
  for (const m of media) {
    const url = buildPublicMediaUrl(m.uploadId);
    const childParams = new URLSearchParams({
      is_carousel_item: 'true',
      access_token: accessToken,
    });
    if (m.kind === 'image') childParams.set('image_url', url);
    else childParams.set('video_url', url);

    const childResp = await fetch(`${GRAPH_BASE}/${igUserId}/media`, {
      method: 'POST',
      body: childParams,
    });
    const childId = await readContainerId(childResp, 'IG carousel child create');
    // Children need to finish processing before the parent is built.
    // Images finish fast; videos may take longer.
    await waitForContainer(
      childId,
      accessToken,
      m.kind === 'video' ? IG_CONTAINER_MAX_POLLS_VIDEO : IG_CONTAINER_MAX_POLLS_IMAGE
    );
    childIds.push(childId);
  }

  // Step 2: parent CAROUSEL container — location is set on the PARENT,
  // not on the child containers (IG carousel children inherit the
  // parent's metadata).
  const parentParams = new URLSearchParams({
    media_type: 'CAROUSEL',
    children: childIds.join(','),
    caption,
    access_token: accessToken,
  });
  if (locationId) parentParams.set('location_id', locationId);
  // Collaborators live on the parent (CAROUSEL container), not on the
  // child containers — children inherit the parent's metadata. Routed
  // through the retry helper so a bad username won't kill the whole
  // post.
  const { containerId: parentId, droppedCollaborators } = await createIgContainerWithCollabRetry(
    igUserId, accessToken, parentParams, collaborators, 'IG carousel parent create'
  );
  await waitForContainer(parentId, accessToken, IG_CONTAINER_MAX_POLLS_IMAGE);

  // Step 3: publish parent
  const result = await igPublishContainer(igUserId, accessToken, parentId);
  return { ...result, droppedCollaborators };
}

// ─── IG helpers ─────────────────────────────────────────────────────────

async function readContainerId(resp: Response, context: string): Promise<string> {
  const data = (await resp.json()) as {
    id?: string;
    error?: { message?: string; code?: number; error_subcode?: number };
  };
  if (!resp.ok || data.error || !data.id) {
    throw new PublishError(
      data.error?.message ?? `${context} failed (${resp.status})`,
      String(data.error?.error_subcode ?? data.error?.code ?? resp.status)
    );
  }
  return data.id;
}

/**
 * Create an IG media container, retrying without `collaborators` if
 * Meta rejects them. Returns { containerId, droppedCollaborators }.
 *
 * `droppedCollaborators` is true when we retried; the caller can use
 * that to surface a soft warning to the user post-publish.
 */
async function createIgContainerWithCollabRetry(
  igUserId: string,
  accessToken: string,
  params: URLSearchParams,
  collaborators: string[],
  context: string
): Promise<{ containerId: string; droppedCollaborators: boolean }> {
  // No collaborators → straight-through, no retry path needed.
  if (collaborators.length === 0) {
    const resp = await fetch(`${GRAPH_BASE}/${igUserId}/media`, {
      method: 'POST',
      body: params,
    });
    return { containerId: await readContainerId(resp, context), droppedCollaborators: false };
  }

  // First attempt — with collaborators.
  params.set('collaborators', JSON.stringify(collaborators));
  const firstResp = await fetch(`${GRAPH_BASE}/${igUserId}/media`, {
    method: 'POST',
    body: params,
  });

  if (firstResp.ok) {
    // Success — but readContainerId still inspects the body, so use it.
    // If the body says "ok but errored" we'll fall through to retry.
    try {
      const containerId = await readContainerId(firstResp.clone(), context);
      return { containerId, droppedCollaborators: false };
    } catch {
      // Fall through to retry-without
    }
  }

  // Whenever we sent collaborators AND the call failed, retry without.
  // We're aggressive on purpose: Meta's error messages around
  // collaborator rejection are inconsistent, and the cost of a wrong
  // retry (extra ~300ms latency on real failures) is much lower than
  // the cost of failing a publish over a bad username.
  let firstError = '';
  try {
    const data = (await firstResp.json()) as {
      error?: { message?: string; code?: number; error_subcode?: number };
    };
    firstError = data.error?.message ?? `(${firstResp.status})`;
  } catch {
    firstError = `(${firstResp.status})`;
  }
  console.warn(
    `[organic/publish] IG container create with collaborators failed (${firstError}). Retrying without collaborators...`
  );

  params.delete('collaborators');
  const retryResp = await fetch(`${GRAPH_BASE}/${igUserId}/media`, {
    method: 'POST',
    body: params,
  });
  if (!retryResp.ok) {
    // Retry without collabs ALSO failed — the original problem wasn't
    // collaborator-related. Surface the retry error since it's the most
    // informative (no collabs in the way).
    const data = (await retryResp.json()) as {
      error?: { message?: string; code?: number; error_subcode?: number };
    };
    throw new PublishError(
      data.error?.message ?? `${context} failed twice (${retryResp.status})`,
      String(data.error?.error_subcode ?? data.error?.code ?? retryResp.status)
    );
  }
  const containerId = await readContainerId(retryResp, `${context} (retry without collaborators)`);
  return { containerId, droppedCollaborators: true };
}

async function waitForContainer(
  containerId: string,
  accessToken: string,
  maxPolls: number
): Promise<void> {
  for (let i = 0; i < maxPolls; i++) {
    await sleep(IG_CONTAINER_POLL_INTERVAL_MS);
    const resp = await fetch(
      `${GRAPH_BASE}/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(accessToken)}`
    );
    const data = (await resp.json()) as {
      status_code?: string;
      status?: string;
      error?: { message?: string };
    };
    if (data.error) {
      throw new PublishError(
        data.error.message ?? 'IG status poll failed',
        'ig_status_poll_failed'
      );
    }
    if (data.status_code === 'FINISHED') return;
    if (data.status_code === 'ERROR' || data.status_code === 'EXPIRED') {
      throw new PublishError(
        `IG container ${data.status_code}: ${data.status ?? ''}`,
        'ig_container_failed'
      );
    }
  }
  throw new PublishError(
    'IG container did not finish in time. Try again, or check the media URL.',
    'ig_container_timeout'
  );
}

async function igPublishContainer(
  igUserId: string,
  accessToken: string,
  containerId: string
): Promise<PublishResult> {
  const params = new URLSearchParams({
    creation_id: containerId,
    access_token: accessToken,
  });
  const resp = await fetch(`${GRAPH_BASE}/${igUserId}/media_publish`, {
    method: 'POST',
    body: params,
  });
  const data = (await resp.json()) as {
    id?: string;
    error?: { message?: string; code?: number; error_subcode?: number };
  };
  if (!resp.ok || data.error || !data.id) {
    throw new PublishError(
      data.error?.message ?? `IG publish failed (${resp.status})`,
      String(data.error?.error_subcode ?? data.error?.code ?? resp.status)
    );
  }
  const mediaId = data.id;

  // Best-effort permalink fetch
  let permalink: string | null = null;
  try {
    const linkResp = await fetch(
      `${GRAPH_BASE}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(accessToken)}`
    );
    const linkData = (await linkResp.json()) as { permalink?: string };
    permalink = linkData.permalink ?? null;
  } catch { /* non-fatal */ }

  return { externalPostId: mediaId, externalPostUrl: permalink };
}

// =====================================================================
// Helpers
// =====================================================================

export function buildPublicMediaUrl(uploadId: string): string {
  const token = makeUploadPublicToken(uploadId);
  return `${env.FRONTEND_URL}/api/uploads/${uploadId}/public?token=${encodeURIComponent(token)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
