/**
 * organic-insights.ts — fetch post-level metrics from each network.
 *
 * One fetcher per platform behind a common shape. Live today: Facebook,
 * Instagram (needs instagram_manage_insights), Threads (needs
 * threads_manage_insights). Stubbed (return `unavailable`): TikTok (pending
 * content-posting audit) and LinkedIn profiles (no member-post analytics API);
 * LinkedIn org/page analytics await the Community Management API approval.
 *
 * The runner/route layer is responsible for deciding WHICH targets to fetch
 * (recent vs stored) and for persisting snapshots — this module only knows how
 * to turn (account, externalPostId) into a metric set.
 */
import { getAccountWithToken, OrganicAccountWithToken } from './organic-connection';

const GRAPH_API_VERSION = 'v25.0';
const FB_GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const THREADS_GRAPH_BASE = 'https://graph.threads.net/v1.0';

/** Normalised metric set. NULL = network doesn't expose that metric. */
export interface InsightMetrics {
  impressions: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  clicks: number | null;
  saves: number | null;
  videoViews: number | null;
  engagement: number | null;
  extra: Record<string, unknown>;
}

export type InsightResult =
  | { ok: true; metrics: InsightMetrics }
  | { ok: false; reason: string; unavailable?: boolean; perPostSkip?: boolean };

function emptyMetrics(): InsightMetrics {
  return {
    impressions: null, reach: null, likes: null, comments: null,
    shares: null, clicks: null, saves: null, videoViews: null,
    engagement: null, extra: {},
  };
}

// ── Facebook ───────────────────────────────────────────────────────────────
// Page post insights via /{post-id}/insights with a metric list, plus the
// like/comment/share summary off the post node itself.
async function fetchFacebook(
  account: OrganicAccountWithToken,
  postId: string
): Promise<InsightResult> {
  const token = account.accessToken;
  const m = emptyMetrics();

  // 1) Engagement summary from the post node. Request fields resiliently:
  // some post types reject `shares` (or summary edges), and a combined request
  // would then error out entirely, losing likes+comments too. So we read the
  // summary counts, and if that errors, fall back to a minimal request.
  try {
    const url =
      `${FB_GRAPH_BASE}/${postId}?` +
      new URLSearchParams({
        fields: 'shares,comments.summary(true),likes.summary(true)',
        access_token: token,
      }).toString();
    const r = await fetch(url);
    const d = (await r.json()) as {
      shares?: { count?: number };
      comments?: { summary?: { total_count?: number } };
      likes?: { summary?: { total_count?: number } };
      error?: { message?: string; code?: number };
    };
    if (d.error) {
      // Retry without `shares` (the field most likely to be rejected).
      const url2 =
        `${FB_GRAPH_BASE}/${postId}?` +
        new URLSearchParams({
          fields: 'comments.summary(true),likes.summary(true)',
          access_token: token,
        }).toString();
      const r2 = await fetch(url2);
      const d2 = (await r2.json()) as {
        comments?: { summary?: { total_count?: number } };
        likes?: { summary?: { total_count?: number } };
        error?: { message?: string; code?: number };
      };
      if (d2.error) {
        const msg = d2.error.message ?? 'FB post fetch failed';
        const skip = d2.error.code === 100 && /does not exist|cannot be loaded/i.test(msg);
        return { ok: false, reason: msg, perPostSkip: skip } as InsightResult;
      }
      m.likes = d2.likes?.summary?.total_count ?? null;
      m.comments = d2.comments?.summary?.total_count ?? null;
    } else {
      m.likes = d.likes?.summary?.total_count ?? null;
      m.comments = d.comments?.summary?.total_count ?? null;
      m.shares = d.shares?.count ?? null;
    }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'FB post fetch error' };
  }

  // 2) Insight metrics. As of Nov 15 2025, post_impressions /
  // post_impressions_unique / post_clicks return "(#100) invalid metric" —
  // Meta replaced them with the `views` family (post_media_view). We request
  // the current metric and tolerate an empty/error insights response, since
  // the like/comment/share counts from the node above are the core numbers.
  try {
    const metrics = ['post_media_view'].join(',');
    const url =
      `${FB_GRAPH_BASE}/${postId}/insights?` +
      new URLSearchParams({ metric: metrics, access_token: token }).toString();
    const r = await fetch(url);
    const d = (await r.json()) as {
      data?: { name: string; values?: { value?: number }[] }[];
      error?: { message?: string };
    };
    if (!d.error && Array.isArray(d.data)) {
      for (const row of d.data) {
        const v = row.values?.[0]?.value ?? null;
        if (row.name === 'post_media_view') { m.impressions = v; m.videoViews = v; }
      }
    }
    // Insights can be empty (new post, or metric unavailable) — not fatal.
  } catch {
    // Keep the engagement summary; insights are best-effort.
  }

  m.engagement =
    (m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0);
  return { ok: true, metrics: m };
}

// ── Instagram ────────────────────────────────────────────────────────────────
// Media insights via /{media-id}/insights. Needs instagram_manage_insights.
async function fetchInstagram(
  account: OrganicAccountWithToken,
  mediaId: string
): Promise<InsightResult> {
  const token = account.accessToken;
  const m = emptyMetrics();
  try {
    // Like/comment counts live on the media node.
    const nodeUrl =
      `${FB_GRAPH_BASE}/${mediaId}?` +
      new URLSearchParams({
        fields: 'like_count,comments_count',
        access_token: token,
      }).toString();
    const nr = await fetch(nodeUrl);
    const nd = (await nr.json()) as {
      like_count?: number; comments_count?: number; error?: { message?: string; code?: number };
    };
    if (nd.error) {
      const msg = nd.error.message ?? 'IG media fetch failed';
      // "does not exist / cannot be loaded" = this specific media is gone or
      // not visible (deleted, stale synced id, story expired). That's a
      // per-POST problem, not a network/scope failure — flag it so the caller
      // skips this post instead of blanking all of Instagram.
      const code = nd.error.code;
      const isMissingObject = code === 100 && /does not exist|cannot be loaded/i.test(msg);
      return { ok: false, reason: msg, unavailable: isMissingObject ? false : undefined, perPostSkip: isMissingObject } as InsightResult;
    }
    m.likes = nd.like_count ?? null;
    m.comments = nd.comments_count ?? null;

    // As of Graph API v22 (Apr 2025), `impressions` and `video_views` are
    // deprecated for IG media — replaced by a single `views` metric. Valid
    // media metrics now: views, reach, saved, shares (+ likes/comments which
    // we already read off the node above). Requesting a deprecated metric
    // makes the WHOLE insights call error, which is why IG showed blank.
    const metrics = ['views', 'reach', 'saved', 'shares'].join(',');
    const insUrl =
      `${FB_GRAPH_BASE}/${mediaId}/insights?` +
      new URLSearchParams({ metric: metrics, access_token: token }).toString();
    const ir = await fetch(insUrl);
    const id = (await ir.json()) as {
      data?: { name: string; values?: { value?: number }[] }[];
      error?: { message?: string };
    };
    if (!id.error && Array.isArray(id.data)) {
      for (const row of id.data) {
        const v = row.values?.[0]?.value ?? null;
        // `views` is the current catch-all reach/impressions metric.
        if (row.name === 'views') { m.impressions = v; m.videoViews = v; }
        else if (row.name === 'reach') m.reach = v;
        else if (row.name === 'saved') m.saves = v;
        else if (row.name === 'shares') m.shares = v;
      }
    }
    m.engagement = (m.likes ?? 0) + (m.comments ?? 0) + (m.saves ?? 0) + (m.shares ?? 0);
    return { ok: true, metrics: m };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'IG fetch error' };
  }
}

// ── Threads ──────────────────────────────────────────────────────────────────
// Threads media insights. Needs threads_manage_insights.
async function fetchThreads(
  account: OrganicAccountWithToken,
  mediaId: string
): Promise<InsightResult> {
  const token = account.accessToken;
  const m = emptyMetrics();
  try {
    const metrics = ['views', 'likes', 'replies', 'reposts', 'quotes'].join(',');
    const url =
      `${THREADS_GRAPH_BASE}/${mediaId}/insights?` +
      new URLSearchParams({ metric: metrics, access_token: token }).toString();
    const r = await fetch(url);
    const d = (await r.json()) as {
      data?: { name: string; values?: { value?: number }[] }[];
      error?: { message?: string };
    };
    if (d.error) return { ok: false, reason: d.error.message ?? 'Threads insights failed' };
    if (Array.isArray(d.data)) {
      let reposts = 0;
      let quotes = 0;
      for (const row of d.data) {
        const v = row.values?.[0]?.value ?? 0;
        if (row.name === 'views') m.impressions = v;
        else if (row.name === 'likes') m.likes = v;
        else if (row.name === 'replies') m.comments = v;
        else if (row.name === 'reposts') reposts = v;
        else if (row.name === 'quotes') quotes = v;
      }
      m.shares = reposts + quotes;
      m.extra = { reposts, quotes };
    }
    m.engagement = (m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0);
    return { ok: true, metrics: m };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'Threads fetch error' };
  }
}

/**
 * Fetch metrics for one published target. The caller passes the platform,
 * the account id, and the external post id we stored at publish time.
 */
export async function fetchInsightsForTarget(args: {
  userId: string;
  accountId: string;
  platform: string;
  externalPostId: string;
}): Promise<InsightResult> {
  const { userId, accountId, platform, externalPostId } = args;

  if (platform === 'tiktok') {
    return { ok: false, unavailable: true, reason: 'TikTok analytics require the app to pass content-posting audit.' };
  }
  if (platform === 'linkedin') {
    return { ok: false, unavailable: true, reason: 'LinkedIn does not expose analytics for personal profile posts.' };
  }
  if (platform === 'linkedin_org') {
    return { ok: false, unavailable: true, reason: 'LinkedIn Page analytics require Community Management API approval.' };
  }

  const account = await getAccountWithToken(userId, accountId);
  if (!account) return { ok: false, reason: 'Account not found or disconnected.' };

  if (platform === 'facebook_page' || platform === 'facebook') {
    return fetchFacebook(account, externalPostId);
  }
  if (platform === 'instagram') {
    return fetchInstagram(account, externalPostId);
  }
  if (platform === 'threads') {
    return fetchThreads(account, externalPostId);
  }
  return { ok: false, unavailable: true, reason: `Analytics not supported for ${platform}.` };
}
