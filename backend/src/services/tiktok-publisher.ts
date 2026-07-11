/**
 * TikTok publishing via the Content Posting API (Direct Post).
 *
 * Flow:
 *   1. ensureFreshToken — refresh the ~24h access token if needed.
 *   2. creator_info/query — REQUIRED by TikTok before every post; also
 *      gives us the allowed privacy levels + interaction toggles for
 *      this creator. (The UX requirement to SHOW the creator's
 *      name/avatar is satisfied in the composer before this runs.)
 *   3. video/init (or content/init for photos) with a PULL_FROM_URL
 *      source — TikTok fetches the media from our public upload URL,
 *      so we don't implement chunked binary upload.
 *
 * Media source: PULL_FROM_URL. The URL's domain must be added as a
 * verified URL-prefix in the TikTok developer portal (part of app
 * setup / audit). Same public-URL mechanism FB/IG already use.
 *
 * Visibility: until the workspace's TikTok app passes audit, TikTok
 * forces SELF_ONLY regardless of what we request. We pass the user's
 * chosen privacy level; TikTok clamps it pre-audit.
 *
 * Disclosure: TikTok requires commercial-content disclosure flags when
 * the post promotes a brand. We pass them through from the composer.
 */

import { ensureFreshToken } from './tiktok-connection';
import { buildPublicMediaUrl, PublishError, type MediaItem, type PublishResult } from './organic-publisher';

const POST_BASE = 'https://open.tiktokapis.com/v2/post/publish';

export type TikTokPrivacy =
  | 'PUBLIC_TO_EVERYONE'
  | 'MUTUAL_FOLLOW_FRIENDS'
  | 'FOLLOWER_OF_CREATOR'
  | 'SELF_ONLY';

export interface TikTokDisclosure {
  /** Master toggle: post promotes a third-party brand or the creator's own. */
  commercialContent: boolean;
  /** "Your brand" — promoting the creator's own business. */
  yourBrand: boolean;
  /** "Branded content" — promoting a third party (paid partnership). */
  brandedContent: boolean;
}

export interface TikTokPublishOptions {
  privacy: TikTokPrivacy;
  disclosure: TikTokDisclosure;
  /** Interaction toggles. */
  disableComment?: boolean;
  disableDuet?: boolean;
  disableStitch?: boolean;
}

export interface TikTokCreatorInfoResult {
  creatorUsername: string | null;
  creatorNickname: string | null;
  creatorAvatarUrl: string | null;
  privacyOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoSeconds: number | null;
}

async function tiktokFetch<T>(
  url: string,
  accessToken: string,
  body: Record<string, unknown>
): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { error?: { code?: string; message?: string } } & T;
  const code = data.error?.code;
  if (!res.ok || (code && code !== 'ok')) {
    throw new PublishError(
      `TikTok API error: ${data.error?.message ?? code ?? res.status}`,
      `tiktok_${code ?? 'http_' + res.status}`
    );
  }
  return data;
}

/**
 * Query creator info — REQUIRED before posting. Returns the allowed
 * privacy levels + interaction availability for this creator, plus
 * profile fields for the mandatory creator-display UX.
 */
export async function queryCreatorInfo(
  userId: string,
  accountId: string
): Promise<TikTokCreatorInfoResult> {
  const accessToken = await ensureFreshToken(userId, accountId);
  const data = await tiktokFetch<{
    data?: {
      creator_username?: string;
      creator_nickname?: string;
      creator_avatar_url?: string;
      privacy_level_options?: string[];
      comment_disabled?: boolean;
      duet_disabled?: boolean;
      stitch_disabled?: boolean;
      max_video_post_duration_sec?: number;
    };
  }>(`${POST_BASE}/creator_info/query/`, accessToken, {});
  const d = data.data ?? {};
  return {
    creatorUsername: d.creator_username ?? null,
    creatorNickname: d.creator_nickname ?? null,
    creatorAvatarUrl: d.creator_avatar_url ?? null,
    privacyOptions: d.privacy_level_options ?? [],
    commentDisabled: !!d.comment_disabled,
    duetDisabled: !!d.duet_disabled,
    stitchDisabled: !!d.stitch_disabled,
    maxVideoSeconds: d.max_video_post_duration_sec ?? null,
  };
}

/** Shared disclosure → API field mapping. */
function disclosureFields(opts: TikTokPublishOptions): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (opts.disclosure.commercialContent) {
    // brand_organic_toggle = "your brand"; brand_content_toggle = "branded content"
    fields.brand_organic_toggle = opts.disclosure.yourBrand;
    fields.brand_content_toggle = opts.disclosure.brandedContent;
  }
  return fields;
}

/**
 * Direct-post a VIDEO via PULL_FROM_URL. Returns a publish_id. TikTok
 * processes asynchronously; we return the publish_id as the external id
 * (there's no immediate public post URL until processing completes and
 * the creator's privacy allows it).
 */
export async function publishVideo(
  userId: string,
  accountId: string,
  caption: string,
  videoUploadId: string,
  opts: TikTokPublishOptions
): Promise<PublishResult> {
  const accessToken = await ensureFreshToken(userId, accountId);
  const videoUrl = buildPublicMediaUrl(videoUploadId);

  const data = await tiktokFetch<{ data?: { publish_id?: string } }>(
    `${POST_BASE}/video/init/`,
    accessToken,
    {
      post_info: {
        title: caption.slice(0, 2200),
        privacy_level: opts.privacy,
        disable_comment: !!opts.disableComment,
        disable_duet: !!opts.disableDuet,
        disable_stitch: !!opts.disableStitch,
        ...disclosureFields(opts),
      },
      source_info: {
        source: 'PULL_FROM_URL',
        video_url: videoUrl,
      },
    }
  );
  const publishId = data.data?.publish_id;
  if (!publishId) throw new PublishError('TikTok did not return a publish_id', 'tiktok_no_publish_id');
  return { externalPostId: publishId, externalPostUrl: null };
}

/**
 * Direct-post a PHOTO carousel via PULL_FROM_URL. TikTok photo posts
 * split text into title (first ~90 chars) + description (the caption).
 */
export async function publishPhotos(
  userId: string,
  accountId: string,
  caption: string,
  imageUploadIds: string[],
  opts: TikTokPublishOptions
): Promise<PublishResult> {
  const accessToken = await ensureFreshToken(userId, accountId);
  const urls = imageUploadIds.map((id) => buildPublicMediaUrl(id));
  const title = caption.slice(0, 90);

  const data = await tiktokFetch<{ data?: { publish_id?: string } }>(
    `${POST_BASE}/content/init/`,
    accessToken,
    {
      post_info: {
        title,
        description: caption.slice(0, 4000),
        privacy_level: opts.privacy,
        disable_comment: !!opts.disableComment,
        ...disclosureFields(opts),
      },
      source_info: {
        source: 'PULL_FROM_URL',
        photo_cover_index: 0,
        photo_images: urls,
      },
      post_mode: 'DIRECT_POST',
      media_type: 'PHOTO',
    }
  );
  const publishId = data.data?.publish_id;
  if (!publishId) throw new PublishError('TikTok did not return a publish_id', 'tiktok_no_publish_id');
  return { externalPostId: publishId, externalPostUrl: null };
}

/**
 * Top-level TikTok publish. Routes to video vs photo. Text-only posts
 * aren't supported by TikTok (every post needs media).
 */
export async function publishToTikTok(
  userId: string,
  accountId: string,
  caption: string,
  media: MediaItem[],
  opts: TikTokPublishOptions
): Promise<PublishResult> {
  if (media.length === 0) {
    throw new PublishError('TikTok requires at least one video or image.', 'tiktok_no_media');
  }
  const hasVideo = media.some((m) => m.kind === 'video');
  if (hasVideo) {
    if (media.length > 1) {
      throw new PublishError('TikTok: a post is one video OR multiple photos.', 'tiktok_mixed');
    }
    return publishVideo(userId, accountId, caption, media[0].uploadId, opts);
  }
  return publishPhotos(userId, accountId, caption, media.map((m) => m.uploadId), opts);
}
