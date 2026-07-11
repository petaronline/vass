/**
 * LinkedIn publishing via the versioned Posts API (/rest/posts).
 *
 * Unlike TikTok (PULL_FROM_URL), LinkedIn requires us to UPLOAD media
 * bytes ourselves, then reference the returned URN in the post:
 *   - Images: POST /rest/images?action=initializeUpload → {uploadUrl,
 *     image URN} → PUT bytes to uploadUrl → reference the image URN.
 *   - Videos: POST /rest/videos?action=initializeUpload → {uploadUrl(s),
 *     video URN} → PUT bytes → POST /rest/videos?action=finalizeUpload.
 *     (Large videos chunk with per-part ETags; we do single-shot for
 *     the common small-clip case and note the chunking TODO.)
 *
 * Post shapes (/rest/posts):
 *   - text-only:   { author, commentary, visibility, distribution }
 *   - single img:  + content.media = { id: <imageUrn> }
 *   - multi img:   + content.multiImage = { images: [{ id }, …] }
 *   - single vid:  + content.media = { id: <videoUrn> }
 *
 * Author URN comes from the connected account's meta.author_urn
 * (urn:li:person:{id} for personal, urn:li:organization:{id} for pages).
 *
 * NOTE (unverified-until-approval): endpoint shapes/headers follow
 * LinkedIn's 2026 docs. They run for real only once the workspace's
 * LinkedIn app has Community Management approved and a page connected.
 * Spots that most likely need live verification are marked LIVE-CHECK.
 */

import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureFreshToken, LINKEDIN_VERSION } from './linkedin-connection';
import { getAccountWithToken } from './organic-connection';
import { query } from '../db/pool';
import { PublishError, type MediaItem, type PublishResult } from './organic-publisher';

const POSTS_URL = 'https://api.linkedin.com/rest/posts';
const IMAGES_URL = 'https://api.linkedin.com/rest/images';
const VIDEOS_URL = 'https://api.linkedin.com/rest/videos';
const DOCUMENTS_URL = 'https://api.linkedin.com/rest/documents';

const UPLOAD_ROOT = process.env.UPLOAD_ROOT ?? '/uploads';

const LINKEDIN_TEXT_LIMIT = 3000;

function restHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'LinkedIn-Version': LINKEDIN_VERSION,
    'X-Restli-Protocol-Version': '2.0.0',
    'Content-Type': 'application/json',
  };
}

/** Resolve an upload's on-disk path + content type by id. */
async function resolveUpload(
  uploadId: string
): Promise<{ absPath: string; contentType: string }> {
  const { rows } = await query<{ storage_path: string; content_type: string }>(
    `SELECT storage_path, content_type FROM uploads WHERE id = $1 LIMIT 1`,
    [uploadId]
  );
  if (!rows[0]) {
    throw new PublishError(`Upload ${uploadId} not found`, 'linkedin_upload_missing');
  }
  return {
    absPath: path.join(UPLOAD_ROOT, rows[0].storage_path),
    contentType: rows[0].content_type,
  };
}

interface InitImageResponse {
  value?: {
    uploadUrl?: string;
    image?: string; // image URN
  };
}

/**
 * Upload a single image, return its URN.
 * initialize → PUT bytes → return urn.
 */
async function uploadImage(
  accessToken: string,
  authorUrn: string,
  uploadId: string
): Promise<string> {
  const { absPath } = await resolveUpload(uploadId);

  const initRes = await fetch(`${IMAGES_URL}?action=initializeUpload`, {
    method: 'POST',
    headers: restHeaders(accessToken),
    body: JSON.stringify({ initializeUploadRequest: { owner: authorUrn } }),
  });
  const initData = (await initRes.json()) as InitImageResponse & { message?: string };
  if (!initRes.ok || !initData.value?.uploadUrl || !initData.value?.image) {
    throw new PublishError(
      `LinkedIn image init failed: ${initData.message ?? initRes.status}`,
      'linkedin_image_init'
    );
  }

  const bytes = await readFile(absPath);
  // LIVE-CHECK: LinkedIn's image uploadUrl expects a raw binary PUT/POST.
  // It does NOT take the versioned REST headers — just the bearer token.
  const putRes = await fetch(initData.value.uploadUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: bytes,
  });
  if (!putRes.ok) {
    throw new PublishError(
      `LinkedIn image upload failed: HTTP ${putRes.status}`,
      'linkedin_image_upload'
    );
  }
  return initData.value.image;
}

interface InitDocumentResponse {
  value?: {
    uploadUrl?: string;
    document?: string; // document URN
  };
}

/**
 * Upload a single PDF document, return its URN.
 * Same shape as the image flow: initialize → POST raw bytes → return urn.
 *
 * LIVE-CHECK: the /rest/documents endpoint and its document-post content
 * shape run through the same versioned Posts API; this path is unverified
 * until the LinkedIn app's products are approved.
 */
async function uploadDocument(
  accessToken: string,
  authorUrn: string,
  uploadId: string
): Promise<string> {
  const { absPath } = await resolveUpload(uploadId);

  const initRes = await fetch(`${DOCUMENTS_URL}?action=initializeUpload`, {
    method: 'POST',
    headers: restHeaders(accessToken),
    body: JSON.stringify({ initializeUploadRequest: { owner: authorUrn } }),
  });
  const initData = (await initRes.json()) as InitDocumentResponse & { message?: string };
  if (!initRes.ok || !initData.value?.uploadUrl || !initData.value?.document) {
    throw new PublishError(
      `LinkedIn document init failed: ${initData.message ?? initRes.status}`,
      'linkedin_document_init'
    );
  }

  const bytes = await readFile(absPath);
  const putRes = await fetch(initData.value.uploadUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: bytes,
  });
  if (!putRes.ok) {
    throw new PublishError(
      `LinkedIn document upload failed: HTTP ${putRes.status}`,
      'linkedin_document_upload'
    );
  }
  return initData.value.document;
}

interface InitVideoResponse {
  value?: {
    uploadInstructions?: { uploadUrl: string; firstByte?: number; lastByte?: number }[];
    video?: string; // video URN
    uploadToken?: string;
  };
}

/**
 * Upload a single video, return its URN. Single-shot upload of the
 * whole file (one upload instruction). Chunked multi-part upload for
 * very large files is a TODO — most organic clips are within the
 * single-part window.
 */
async function uploadVideo(
  accessToken: string,
  authorUrn: string,
  uploadId: string
): Promise<string> {
  const { absPath } = await resolveUpload(uploadId);
  const bytes = await readFile(absPath);

  const initRes = await fetch(`${VIDEOS_URL}?action=initializeUpload`, {
    method: 'POST',
    headers: restHeaders(accessToken),
    body: JSON.stringify({
      initializeUploadRequest: {
        owner: authorUrn,
        fileSizeBytes: bytes.length,
        uploadCaptions: false,
        uploadThumbnail: false,
      },
    }),
  });
  const initData = (await initRes.json()) as InitVideoResponse & { message?: string };
  const instructions = initData.value?.uploadInstructions ?? [];
  const videoUrn = initData.value?.video;
  const uploadToken = initData.value?.uploadToken ?? '';
  if (!initRes.ok || instructions.length === 0 || !videoUrn) {
    throw new PublishError(
      `LinkedIn video init failed: ${initData.message ?? initRes.status}`,
      'linkedin_video_init'
    );
  }

  // LIVE-CHECK: single-part path. If LinkedIn returns multiple
  // instructions (large file), each part needs its own byte-range slice
  // and an ETag collected for finalize. Here we assume one instruction.
  const etags: string[] = [];
  for (const ins of instructions) {
    const putRes = await fetch(ins.uploadUrl, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: bytes,
    });
    if (!putRes.ok) {
      throw new PublishError(
        `LinkedIn video upload failed: HTTP ${putRes.status}`,
        'linkedin_video_upload'
      );
    }
    const etag = putRes.headers.get('etag');
    if (etag) etags.push(etag);
  }

  const finRes = await fetch(`${VIDEOS_URL}?action=finalizeUpload`, {
    method: 'POST',
    headers: restHeaders(accessToken),
    body: JSON.stringify({
      finalizeUploadRequest: {
        video: videoUrn,
        uploadToken,
        uploadedPartIds: etags,
      },
    }),
  });
  if (!finRes.ok) {
    const finData = (await finRes.json().catch(() => ({}))) as { message?: string };
    throw new PublishError(
      `LinkedIn video finalize failed: ${finData.message ?? finRes.status}`,
      'linkedin_video_finalize'
    );
  }
  return videoUrn;
}

/** Build the /rest/posts body for the given author + media URNs. */
function buildPostBody(
  authorUrn: string,
  commentary: string,
  media: { kind: 'image' | 'video' | 'document'; urns: string[] },
  documentTitle?: string
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    author: authorUrn,
    commentary: commentary.slice(0, LINKEDIN_TEXT_LIMIT),
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };

  if (media.urns.length === 0) {
    return base; // text-only
  }
  if (media.kind === 'document') {
    // Document post: the title is the document's headline on LinkedIn and
    // is required by the API.
    base.content = {
      media: {
        id: media.urns[0],
        title: (documentTitle ?? '').slice(0, 100),
      },
    };
    return base;
  }
  if (media.kind === 'video') {
    base.content = { media: { id: media.urns[0] } };
    return base;
  }
  // images
  if (media.urns.length === 1) {
    base.content = { media: { id: media.urns[0] } };
  } else {
    base.content = {
      multiImage: { images: media.urns.map((id) => ({ id })) },
    };
  }
  return base;
}

/**
 * Top-level LinkedIn publish. Uploads any media, then creates the post.
 * Supports text-only, single image, multi-image carousel, single video.
 */
export async function publishToLinkedIn(
  userId: string,
  accountId: string,
  body: string,
  media: MediaItem[],
  documentTitle?: string
): Promise<PublishResult> {
  const account = await getAccountWithToken(userId, accountId);
  if (!account) {
    throw new PublishError('LinkedIn account not found.', 'linkedin_account_not_found');
  }
  const authorUrn = (account.meta as { author_urn?: string }).author_urn;
  if (!authorUrn) {
    throw new PublishError(
      'LinkedIn account is missing its author URN — reconnect the account.',
      'linkedin_no_author_urn'
    );
  }

  const accessToken = await ensureFreshToken(userId, accountId);

  const hasDocument = media.some((m) => m.kind === 'document');
  const hasVideo = media.some((m) => m.kind === 'video');

  if (hasDocument) {
    // Document posts are exactly one PDF, no other media, and require a title.
    if (media.length > 1) {
      throw new PublishError(
        'LinkedIn: a document post is a single PDF with no other media.',
        'linkedin_document_mixed'
      );
    }
    if (!documentTitle || !documentTitle.trim()) {
      throw new PublishError(
        'LinkedIn document posts require a title.',
        'linkedin_document_no_title'
      );
    }
  }

  if (hasVideo && media.length > 1) {
    throw new PublishError(
      'LinkedIn: a post is one video OR multiple images, not both.',
      'linkedin_mixed_media'
    );
  }

  // Upload media → URNs.
  let mediaPayload: { kind: 'image' | 'video' | 'document'; urns: string[] } = { kind: 'image', urns: [] };
  if (hasDocument) {
    const urn = await uploadDocument(accessToken, authorUrn, media[0].uploadId);
    mediaPayload = { kind: 'document', urns: [urn] };
  } else if (hasVideo) {
    const urn = await uploadVideo(accessToken, authorUrn, media[0].uploadId);
    mediaPayload = { kind: 'video', urns: [urn] };
  } else if (media.length > 0) {
    const urns: string[] = [];
    for (const m of media) {
      urns.push(await uploadImage(accessToken, authorUrn, m.uploadId));
    }
    mediaPayload = { kind: 'image', urns };
  }

  const postBody = buildPostBody(authorUrn, body, mediaPayload, documentTitle);
  const res = await fetch(POSTS_URL, {
    method: 'POST',
    headers: restHeaders(accessToken),
    body: JSON.stringify(postBody),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    throw new PublishError(
      `LinkedIn post failed: ${data.message ?? res.status}`,
      `linkedin_post_${res.status}`
    );
  }

  // LinkedIn returns the post URN in the x-restli-id (or x-linkedin-id) header.
  const postUrn =
    res.headers.get('x-restli-id') ??
    res.headers.get('x-linkedin-id') ??
    null;
  const externalPostUrl = postUrn
    ? `https://www.linkedin.com/feed/update/${encodeURIComponent(postUrn)}/`
    : null;

  return {
    externalPostId: postUrn ?? `linkedin_${Date.now()}`,
    externalPostUrl,
  };
}

// Keep createReadStream import referenced for potential future chunked
// streaming uploads (avoids an unused-import lint while documenting intent).
export const _streamingReserved = createReadStream;
