/**
 * Meta Graph API wrapper.
 *
 * Only what we need for Phase 1:
 *   - Generate OAuth URL (Facebook Login)
 *   - Exchange code for short-lived token
 *   - Exchange short-lived token for long-lived (~60 day) token
 *   - Fetch authenticated user info
 *   - List ad accounts the user has access to
 *
 * Future phases will add: campaign creation, creative upload, ad creation, etc.
 */

const GRAPH_API_VERSION = 'v25.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const OAUTH_BASE = `https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth`;

/**
 * Permissions we ask for during OAuth.
 * Anything beyond these requires Meta App Review (which we avoid by adding
 * authorized users as Testers/Admins of the Meta App).
 */
export const REQUIRED_SCOPES = [
  'ads_management',
  'ads_read',
  'business_management',
];

export interface MetaUser {
  id: string;
  name: string;
  email?: string;
}

export interface MetaAdAccount {
  id: string;               // "act_1234567890"
  account_id: string;       // "1234567890"
  name: string;
  currency: string;
  timezone_name: string;
  account_status: number;
  business?: { id: string; name: string };
}

export interface MetaPage {
  id: string;
  name: string;
  picture?: {
    data?: {
      url: string;
      width?: number;
      height?: number;
      is_silhouette?: boolean;
    };
  };
}

/** Single Page chosen to "represent" an ad account in the UI. */
export interface AdAccountRepresentativePage {
  pageId: string;
  pictureUrl: string | null;
}

export class MetaApiError extends Error {
  status: number;
  code?: number;
  type?: string;
  fbtraceId?: string;
  errorSubcode?: number;
  errorUserTitle?: string;
  errorUserMsg?: string;

  constructor(message: string, status: number, raw?: any) {
    // Build a more informative message: pull error_user_msg if available
    // (Meta's human-readable explanation), else fall back to the bare message.
    const userMsg = raw?.error_user_msg;
    const subcode = raw?.error_subcode;
    let fullMessage = message;
    if (userMsg && userMsg !== message) {
      fullMessage = `${message} — ${userMsg}`;
    }
    if (subcode) {
      fullMessage += ` [subcode=${subcode}]`;
    }
    super(fullMessage);
    this.name = 'MetaApiError';
    this.status = status;
    this.code = raw?.code;
    this.type = raw?.type;
    this.fbtraceId = raw?.fbtrace_id;
    this.errorSubcode = raw?.error_subcode;
    this.errorUserTitle = raw?.error_user_title;
    this.errorUserMsg = raw?.error_user_msg;
  }
}

async function metaFetch<T>(
  url: string,
  params?: Record<string, string>
): Promise<T> {
  const u = new URL(url);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      u.searchParams.set(k, v);
    }
  }
  const res = await fetch(u.toString());
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new MetaApiError(`Non-JSON response from Meta (${res.status}): ${text.slice(0, 200)}`, res.status);
  }
  if (!res.ok || data?.error) {
    const err = data?.error ?? {};
    throw new MetaApiError(
      err.message ?? `Meta API error (${res.status})`,
      res.status,
      err
    );
  }
  return data as T;
}

/**
 * Build the URL that takes the user to Facebook for OAuth.
 */
export function buildOAuthUrl(opts: {
  appId: string;
  redirectUri: string;
  state: string;
  scopes?: string[];
  /**
   * When true, sends `auth_type=reauthorize` which forces Facebook to
   * re-show the permissions dialog (Page picker, granular permissions)
   * even if the user has previously granted access. Use this for "Add
   * more Pages" flows where the user already connected but wants to
   * grant access to additional Pages.
   */
  reauthorize?: boolean;
}): string {
  const url = new URL(OAUTH_BASE);
  url.searchParams.set('client_id', opts.appId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('state', opts.state);
  url.searchParams.set('scope', (opts.scopes ?? REQUIRED_SCOPES).join(','));
  url.searchParams.set('response_type', 'code');
  if (opts.reauthorize) {
    url.searchParams.set('auth_type', 'reauthorize');
  }
  return url.toString();
}

/**
 * Exchange an OAuth authorization code for a short-lived access token.
 * Short-lived tokens last about 1-2 hours.
 */
export async function exchangeCodeForToken(opts: {
  appId: string;
  appSecret: string;
  redirectUri: string;
  code: string;
}): Promise<{ accessToken: string; expiresIn: number }> {
  const data = await metaFetch<{ access_token: string; token_type: string; expires_in: number }>(
    `${GRAPH_BASE}/oauth/access_token`,
    {
      client_id: opts.appId,
      client_secret: opts.appSecret,
      redirect_uri: opts.redirectUri,
      code: opts.code,
    }
  );
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in ?? 3600,
  };
}

/**
 * Exchange a short-lived token for a long-lived (~60 day) token.
 * Always do this immediately after OAuth so we don't have a 1-hour token in storage.
 */
export async function exchangeForLongLivedToken(opts: {
  appId: string;
  appSecret: string;
  shortLivedToken: string;
}): Promise<{ accessToken: string; expiresIn: number }> {
  const data = await metaFetch<{ access_token: string; token_type: string; expires_in: number }>(
    `${GRAPH_BASE}/oauth/access_token`,
    {
      grant_type: 'fb_exchange_token',
      client_id: opts.appId,
      client_secret: opts.appSecret,
      fb_exchange_token: opts.shortLivedToken,
    }
  );
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in ?? 5_184_000, // 60 days default
  };
}

/**
 * Fetch the authenticated user's profile (id, name).
 */
export async function fetchMe(accessToken: string): Promise<MetaUser> {
  return metaFetch<MetaUser>(`${GRAPH_BASE}/me`, {
    access_token: accessToken,
    fields: 'id,name,email',
  });
}

/**
 * List ad accounts the authenticated user has access to.
 * Paginates automatically (Meta returns up to 25 per page).
 */
export async function listAdAccounts(accessToken: string): Promise<MetaAdAccount[]> {
  const results: MetaAdAccount[] = [];
  let url: string | null =
    `${GRAPH_BASE}/me/adaccounts?fields=id,account_id,name,currency,timezone_name,account_status,business&limit=100&access_token=${encodeURIComponent(accessToken)}`;

  let pageCount = 0;
  while (url && pageCount < 20) {
    // Safety: max 20 pages = 2000 accounts. If someone has more, we'll log.
    const page: { data: MetaAdAccount[]; paging?: { next?: string } } = await metaFetch(url);
    results.push(...page.data);
    url = page.paging?.next ?? null;
    pageCount++;
  }
  if (pageCount === 20 && url) {
    console.warn('[meta] listAdAccounts hit safety cap at 20 pages');
  }
  return results;
}

/**
 * Verify a token still works (used as a "ping" before showing it as connected).
 */
export async function verifyToken(accessToken: string): Promise<boolean> {
  try {
    await fetchMe(accessToken);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch the list of Pages that can be promoted via a given ad account.
 *
 * Returns the Pages in the order Meta gave them (no obvious "primary" concept).
 * Uses `?fields=id,name,picture{url}` to get everything in one round-trip.
 *
 * Returns an empty array on failure (never throws) — Page info is enhancement,
 * not core; if Meta returns 4xx for one account we still want the others to work.
 */
export async function listAdAccountPromotablePages(
  accessToken: string,
  metaAdAccountId: string
): Promise<MetaPage[]> {
  // metaAdAccountId is like "act_1234567890"
  const url = `${GRAPH_BASE}/${encodeURIComponent(
    metaAdAccountId
  )}/promote_pages?fields=id,name,picture.type(large){url,width,height,is_silhouette}&limit=25`;
  try {
    const page: { data: MetaPage[] } = await metaFetch(url, {
      access_token: accessToken,
    });
    return page.data ?? [];
  } catch (err) {
    console.warn(
      `[meta] listAdAccountPromotablePages failed for ${metaAdAccountId}:`,
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

/**
 * Pick a representative Page to show next to an ad account in the UI.
 *
 * Current heuristic: first Page returned by Meta. This works for the 80%
 * case (single-Page brand accounts). For multi-Page agency accounts, the
 * choice is arbitrary but stable — the UI can later let users pick
 * a different one if needed.
 *
 * Returns null if the account has no promotable Pages or all calls failed.
 * `pictureUrl` is null if the Page is a silhouette / has no profile photo.
 */
export async function fetchRepresentativePageLegacy_unused(
  accessToken: string,
  metaAdAccountId: string
): Promise<AdAccountRepresentativePage | null> {
  // Kept here as documentation; the actual implementation is below,
  // using the much more reliable fetchAccountIdentity flow.
  const pages = await listAdAccountPromotablePages(accessToken, metaAdAccountId);
  if (pages.length === 0) return null;
  const primary = pages[0];
  const pic = primary.picture?.data;
  const pictureUrl = pic && !pic.is_silhouette ? pic.url : null;
  return { pageId: primary.id, pictureUrl };
}

// =====================================================================
// PHASE 3 — Ad launching
// =====================================================================
//
// Sequence to create one ad:
//   1. listCampaigns(token, accountId)       — populate campaign picker
//   2. listAdSets(token, campaignId)         — populate ad set picker
//   3. uploadImage(token, accountId, bytes)  — get back an image hash
//   4. createAdCreative(...)                 — combines image + copy + page
//   5. createAd(token, accountId, ...)       — the actual ad
//
// All of these use the same metaFetch helper above for error handling.
// =====================================================================

export interface MetaCampaign {
  id: string;
  name: string;
  status: string;             // 'ACTIVE' | 'PAUSED' | 'DELETED' | 'ARCHIVED'
  effective_status: string;
  objective: string;
}

export interface MetaAdSet {
  id: string;
  name: string;
  status: string;
  effective_status: string;
  daily_budget?: string;      // in cents, as a string (Meta quirk)
  lifetime_budget?: string;
  campaign_id: string;
}

/**
 * List campaigns in an ad account.
 *
 * @param activeOnly  When true (default), only returns campaigns currently
 *                    serving (effective_status='ACTIVE'). When false, returns
 *                    everything except DELETED/ARCHIVED (so PAUSED, IN_PROCESS,
 *                    WITH_ISSUES etc still show up).
 */
export async function listCampaigns(
  accessToken: string,
  metaAdAccountId: string,
  activeOnly: boolean = true
): Promise<MetaCampaign[]> {
  const fields = 'id,name,status,effective_status,objective';
  const filter = activeOnly
    ? [{ field: 'effective_status', operator: 'IN', value: ['ACTIVE'] }]
    : [{ field: 'effective_status', operator: 'NOT_IN', value: ['DELETED', 'ARCHIVED'] }];
  const url =
    `${GRAPH_BASE}/${encodeURIComponent(metaAdAccountId)}/campaigns` +
    `?fields=${fields}&limit=100` +
    `&filtering=${encodeURIComponent(JSON.stringify(filter))}`;
  const results: MetaCampaign[] = [];
  let nextUrl: string | null = url;
  let pageCount = 0;

  while (nextUrl && pageCount < 20) {
    const page: { data: MetaCampaign[]; paging?: { next?: string } } = await metaFetch(nextUrl, {
      access_token: accessToken,
    });
    results.push(...page.data);
    nextUrl = page.paging?.next ?? null;
    pageCount++;
  }
  return results;
}

/**
 * List ad sets in a campaign.
 *
 * @param activeOnly  Same semantics as listCampaigns: when true (default),
 *                    only currently-serving ad sets. When false, everything
 *                    except DELETED/ARCHIVED.
 */
export async function listAdSets(
  accessToken: string,
  metaCampaignId: string,
  activeOnly: boolean = true
): Promise<MetaAdSet[]> {
  const fields = 'id,name,status,effective_status,daily_budget,lifetime_budget,campaign_id';
  const filter = activeOnly
    ? [{ field: 'effective_status', operator: 'IN', value: ['ACTIVE'] }]
    : [{ field: 'effective_status', operator: 'NOT_IN', value: ['DELETED', 'ARCHIVED'] }];
  const url =
    `${GRAPH_BASE}/${encodeURIComponent(metaCampaignId)}/adsets` +
    `?fields=${fields}&limit=100` +
    `&filtering=${encodeURIComponent(JSON.stringify(filter))}`;
  const results: MetaAdSet[] = [];
  let nextUrl: string | null = url;
  let pageCount = 0;

  while (nextUrl && pageCount < 20) {
    const page: { data: MetaAdSet[]; paging?: { next?: string } } = await metaFetch(nextUrl, {
      access_token: accessToken,
    });
    results.push(...page.data);
    nextUrl = page.paging?.next ?? null;
    pageCount++;
  }
  return results;
}

// =====================================================================
// Ad set creation (Patch 3.3)
// =====================================================================
// Lets users create new ad sets inline from the launch builder without
// hopping over to Meta Ads Manager. We expose a deliberately small but
// complete-for-90%-of-cases surface:
//   - Name, Status (PAUSED/ACTIVE)
//   - Budget: daily OR lifetime, plus optional start/end times
//   - Optimization goal (depends on campaign objective)
//   - Targeting: countries, age min/max, genders
//   - Placements: auto vs manual (FB/IG/Messenger/AN)
//   - Promoted object: pixel + standard event (for conversion objectives)
//                      or page (for engagement / messages)
//
// Power-user fields (interest targeting, dayparting, custom audiences,
// lookalikes, brand safety, etc.) are intentionally NOT exposed in v1.
// Users who need them open the new ad set in Meta after creation.
// =====================================================================

// ----- Read helpers -----

export interface MetaPixel {
  id: string;
  name: string;
}

/**
 * List ad pixels available for the given ad account.
 * Used by the ad set form's promoted-object dropdown.
 */
export async function listPixelsForAccount(
  accessToken: string,
  metaAdAccountId: string
): Promise<MetaPixel[]> {
  const url =
    `${GRAPH_BASE}/${encodeURIComponent(metaAdAccountId)}/adspixels` +
    `?fields=id,name&limit=100`;
  const data: { data?: MetaPixel[] } = await metaFetch(url, {
    access_token: accessToken,
  });
  return data.data ?? [];
}

/**
 * List the standard + custom conversion events tracked on a given pixel.
 *
 * Meta returns this through `/{pixel_id}/stats?aggregation=event` — gives
 * us each event_name the pixel has seen. We dedupe to unique names and
 * sort alphabetically.
 *
 * Returns ['Purchase', 'AddToCart', ...]
 */
export async function listPixelEvents(
  accessToken: string,
  pixelId: string
): Promise<string[]> {
  const url =
    `${GRAPH_BASE}/${encodeURIComponent(pixelId)}/stats` +
    `?aggregation=event&fields=event,count&limit=100`;
  try {
    const data: { data?: Array<{ event?: string }> } = await metaFetch(url, {
      access_token: accessToken,
    });
    const names = (data.data ?? [])
      .map((d) => d.event)
      .filter((e): e is string => !!e);
    return Array.from(new Set(names)).sort();
  } catch (err) {
    // Pixel with no events yet returns empty; pixel without analytics access
    // returns an error. Don't fail the form — just return an empty list.
    console.warn(
      `[meta] listPixelEvents failed for ${pixelId}:`,
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

/**
 * Fetch the objective + CBO state of a campaign.
 *
 * CBO (Campaign Budget Optimization) means the budget lives on the
 * campaign, not the ad set. When detected, ad set creation MUST NOT
 * send a daily_budget/lifetime_budget — Meta rejects with subcode 4834009.
 *
 * Detection: if the campaign has `daily_budget` or `lifetime_budget` set,
 * CBO is on. ('budget_remaining' is always set so we can't use that.)
 */
export async function getCampaignObjective(
  accessToken: string,
  metaCampaignId: string
): Promise<{ objective: string | null; cboEnabled: boolean }> {
  const url =
    `${GRAPH_BASE}/${encodeURIComponent(metaCampaignId)}` +
    `?fields=objective,daily_budget,lifetime_budget`;
  const data: {
    objective?: string;
    daily_budget?: string;
    lifetime_budget?: string;
  } = await metaFetch(url, { access_token: accessToken });

  const dailyBudget = data.daily_budget ? parseInt(data.daily_budget, 10) : 0;
  const lifetimeBudget = data.lifetime_budget ? parseInt(data.lifetime_budget, 10) : 0;
  return {
    objective: data.objective ?? null,
    cboEnabled: dailyBudget > 0 || lifetimeBudget > 0,
  };
}

/**
 * Resolve an ad set's parent campaign objective in a single Graph call.
 * Used by the Edit & retry modal to filter the CTA dropdown to values that
 * Meta will accept for this ad set's objective.
 *
 * Returns `null` if the ad set was deleted or the field isn't populated.
 */
export async function getAdSetCampaignObjective(
  accessToken: string,
  metaAdSetId: string
): Promise<string | null> {
  const url =
    `${GRAPH_BASE}/${encodeURIComponent(metaAdSetId)}` +
    `?fields=campaign{objective}`;
  try {
    const data: { campaign?: { objective?: string } } = await metaFetch(url, {
      access_token: accessToken,
    });
    return data.campaign?.objective ?? null;
  } catch {
    return null;
  }
}

// ----- Create ad set -----

export type AdSetStatus = 'ACTIVE' | 'PAUSED';
export type BudgetMode = 'daily' | 'lifetime';
export type Gender = 'all' | 'male' | 'female';

export interface CreateAdSetInput {
  /** The Meta ad account ID (e.g. "act_123456789"). */
  metaAdAccountId: string;
  /** The Meta campaign ID this ad set will live under. */
  metaCampaignId: string;

  name: string;
  status: AdSetStatus;

  // Budget — exactly one of dailyBudget / lifetimeBudget must be set
  budgetMode: BudgetMode;
  /** Cents in the account's currency (Meta expects minor units as a string). */
  budgetAmountMinorUnits: number;

  // Schedule
  /** ISO 8601 string. If omitted, Meta defaults to "now". */
  startTime?: string;
  /** ISO 8601 string. REQUIRED for lifetime budgets. */
  endTime?: string;

  // Optimization
  /** e.g. 'OFFSITE_CONVERSIONS', 'LINK_CLICKS', 'LEAD_GENERATION'. */
  optimizationGoal: string;
  /** e.g. 'IMPRESSIONS'. If omitted, Meta picks a default for the optimization_goal. */
  billingEvent?: string;
  /** Bid strategy. Default 'LOWEST_COST_WITHOUT_CAP' (no manual bid). */
  bidStrategy?: string;

  // Targeting
  countries: string[]; // ISO country codes, e.g. ['US', 'CA']
  ageMin: number;      // 13..65 (Meta's allowed range)
  ageMax: number;      // 13..65
  gender: Gender;

  // Placements
  /** Automatic placements (Advantage+) or manual. */
  placementsAuto: boolean;
  /**
   * Only used when placementsAuto=false. The publisher platforms to include.
   * Subset of ['facebook', 'instagram', 'messenger', 'audience_network'].
   * Each platform Meta accepts has its own set of positions; we send a sensible
   * default set per platform (e.g. all main FB feeds, IG feed + stories + reels).
   */
  publisherPlatforms?: string[];

  // Promoted object — depends on campaign objective
  /** Pixel ID — required for conversion-objective campaigns. */
  pixelId?: string;
  /** e.g. 'Purchase'. Required when pixelId is set. */
  customEventType?: string;
  /** Page ID — required for some non-conversion objectives. */
  pageId?: string;
  /**
   * If the parent campaign has Campaign Budget Optimization on, the budget
   * lives at the campaign level and we MUST NOT send daily/lifetime budget
   * on the ad set. Setting this skips the budget fields.
   */
  cboEnabled?: boolean;
}

export interface CreateAdSetResult {
  id: string;
}

/**
 * Create a new ad set on Meta.
 *
 * The bulk of the complexity here is mapping our normalized input into Meta's
 * sometimes-quirky shape. Notably:
 *   - daily_budget and lifetime_budget are strings, not numbers (minor units)
 *   - targeting is a nested object with `geo_locations`, `age_min`, etc.
 *   - publisher_platforms requires per-platform `*_positions` lists
 *   - promoted_object structure depends on the campaign objective
 */
export async function createAdSet(
  accessToken: string,
  input: CreateAdSetInput
): Promise<CreateAdSetResult> {
  // ---- Targeting ----
  const targeting: Record<string, any> = {
    geo_locations: { countries: input.countries },
    age_min: input.ageMin,
    age_max: input.ageMax,
  };
  if (input.gender === 'male') targeting.genders = [1];
  else if (input.gender === 'female') targeting.genders = [2];
  // Meta expects publisher_platforms + position lists for manual placements.
  // When automatic, we omit them and Meta uses Advantage+ placements.
  if (!input.placementsAuto && input.publisherPlatforms && input.publisherPlatforms.length > 0) {
    targeting.publisher_platforms = input.publisherPlatforms;
    if (input.publisherPlatforms.includes('facebook')) {
      // FB positions. Note: `video_feeds` was deprecated in Graph API v18+ and
      // returns error 2490562 if included. Don't send it.
      targeting.facebook_positions = ['feed', 'story', 'search'];
    }
    if (input.publisherPlatforms.includes('instagram')) {
      targeting.instagram_positions = ['stream', 'story', 'reels', 'explore'];
    }
    if (input.publisherPlatforms.includes('messenger')) {
      targeting.messenger_positions = ['messenger_home', 'story'];
    }
    if (input.publisherPlatforms.includes('audience_network')) {
      targeting.audience_network_positions = ['classic', 'rewarded_video'];
    }
  }

  // ---- Promoted object ----
  let promotedObject: Record<string, any> | undefined;
  if (input.pixelId && input.customEventType) {
    promotedObject = {
      pixel_id: input.pixelId,
      custom_event_type: input.customEventType,
    };
  } else if (input.pageId) {
    promotedObject = { page_id: input.pageId };
  }

  // ---- Body ----
  const body: Record<string, any> = {
    name: input.name,
    campaign_id: input.metaCampaignId,
    status: input.status,
    optimization_goal: input.optimizationGoal,
    bid_strategy: input.bidStrategy ?? 'LOWEST_COST_WITHOUT_CAP',
    targeting,
  };

  if (input.cboEnabled) {
    // CBO: budget lives on the campaign, skip budget on ad set.
  } else if (input.budgetMode === 'daily') {
    body.daily_budget = String(input.budgetAmountMinorUnits);
  } else {
    body.lifetime_budget = String(input.budgetAmountMinorUnits);
  }
  if (input.startTime) body.start_time = input.startTime;
  if (input.endTime) body.end_time = input.endTime;
  if (input.billingEvent) body.billing_event = input.billingEvent;
  if (promotedObject) body.promoted_object = promotedObject;

  // ---- POST ----
  const url = `${GRAPH_BASE}/${encodeURIComponent(input.metaAdAccountId)}/adsets`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: accessToken }),
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* swallow */ }

  if (!res.ok) {
    throw new MetaApiError(
      data?.error?.message ?? `Create ad set failed (${res.status})`,
      res.status,
      data?.error
    );
  }
  if (!data?.id) {
    throw new MetaApiError('Meta returned no ad set ID', 500, data);
  }
  return { id: String(data.id) };
}

// =====================================================================
// Campaign creation (Patch 3.4)
// =====================================================================
// Smaller than ad set creation — just name, objective, status, and an
// optional CBO budget. Vass only handles AUCTION buying type and never
// sets special_ad_categories (commercial campaigns only; legally-restricted
// categories like Housing/Employment/Credit go through Meta UI).
//
// CBO semantics:
//   - cboEnabled=false (ABO) → no budget on campaign; ad sets carry their own
//   - cboEnabled=true       → budget MUST be set; ad sets share it via
//                             campaign-level optimization
// =====================================================================

export interface CreateCampaignInput {
  metaAdAccountId: string; // "act_..."
  name: string;
  /** ODAX objective: OUTCOME_SALES, OUTCOME_LEADS, etc. */
  objective: string;
  status: 'ACTIVE' | 'PAUSED';
  /** True → set daily/lifetime budget on the campaign (CBO). */
  cboEnabled: boolean;
  /** Required when cboEnabled. */
  budgetMode?: 'daily' | 'lifetime';
  /** Required when cboEnabled. Minor units (cents). */
  budgetAmountMinorUnits?: number;
  /** Bid strategy — only meaningful when CBO is on. Default LOWEST_COST_WITHOUT_CAP. */
  bidStrategy?: string;
}

export async function createCampaign(
  accessToken: string,
  input: CreateCampaignInput
): Promise<{ id: string }> {
  const body: Record<string, any> = {
    name: input.name,
    objective: input.objective,
    status: input.status,
    // Meta REQUIRES this field even when empty. Without it, the create
    // call fails. We hardcode [] — Vass is for normal commercial campaigns,
    // not Housing/Employment/Credit/Social Issues which need this set.
    special_ad_categories: [],
    // We only support AUCTION (the normal type). RESERVED would need
    // a separate flow + special account permissions.
    buying_type: 'AUCTION',
    // Meta REQUIRES this boolean to be explicit when no campaign-level budget
    // is set (i.e. ABO mode). Omitting it returns subcode 4834011:
    //   "You must specify True or False in the field
    //    is_adset_budget_sharing_enabled if you are not using campaign budget."
    // Vass doesn't expose budget-sharing as an option — false keeps ad sets
    // fully independent (the simple ABO default users expect).
    is_adset_budget_sharing_enabled: false,
  };

  if (input.cboEnabled) {
    if (!input.budgetMode || !input.budgetAmountMinorUnits) {
      throw new MetaApiError(
        'CBO campaigns require budgetMode + budgetAmountMinorUnits',
        400
      );
    }
    if (input.budgetMode === 'daily') {
      body.daily_budget = String(input.budgetAmountMinorUnits);
    } else {
      body.lifetime_budget = String(input.budgetAmountMinorUnits);
    }
    // Bid strategy only matters when CBO is on
    body.bid_strategy = input.bidStrategy ?? 'LOWEST_COST_WITHOUT_CAP';
  }

  const url = `${GRAPH_BASE}/${encodeURIComponent(input.metaAdAccountId)}/campaigns`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: accessToken }),
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* swallow */ }

  if (!res.ok) {
    throw new MetaApiError(
      data?.error?.message ?? `Create campaign failed (${res.status})`,
      res.status,
      data?.error
    );
  }
  if (!data?.id) {
    throw new MetaApiError('Meta returned no campaign ID', 500, data);
  }
  return { id: String(data.id) };
}

// =====================================================================
// Audit-related read endpoints
// =====================================================================
// For Patch 2.5b (audit existing ads). We need to fetch ads in a given
// ad set, then fetch each ad's creative to inspect the
// `degrees_of_freedom_spec.creative_features_spec` and
// `contextual_multi_ads.enroll_status`.
//
// Meta supports batched ?ids= fetches up to ~50 at a time, which is a
// big speed win vs one call per ad. We use that for creatives.
// =====================================================================

export interface MetaAdSummary {
  id: string;
  name: string;
  status: string;
  effective_status: string;
  adset_id: string;
  creative?: { id: string };
}

/**
 * List ads inside a specific ad set.
 *
 * Optionally filter to currently-serving ads (effective_status='ACTIVE').
 * Returns up to ~20 paginated pages of 100 ads each as a safety net; this
 * is plenty for any realistic audit (2000 ads is our hard cap).
 */
export async function listAdsInAdSet(
  accessToken: string,
  metaAdSetId: string,
  activeOnly: boolean = true
): Promise<MetaAdSummary[]> {
  const fields = 'id,name,status,effective_status,adset_id,creative{id}';
  const filter = activeOnly
    ? [{ field: 'effective_status', operator: 'IN', value: ['ACTIVE'] }]
    : [{ field: 'effective_status', operator: 'NOT_IN', value: ['DELETED', 'ARCHIVED'] }];
  const url =
    `${GRAPH_BASE}/${encodeURIComponent(metaAdSetId)}/ads` +
    `?fields=${fields}&limit=100` +
    `&filtering=${encodeURIComponent(JSON.stringify(filter))}`;

  const results: MetaAdSummary[] = [];
  let nextUrl: string | null = url;
  let pageCount = 0;
  while (nextUrl && pageCount < 20) {
    const page: { data: MetaAdSummary[]; paging?: { next?: string } } = await metaFetch(
      nextUrl,
      { access_token: accessToken }
    );
    results.push(...page.data);
    nextUrl = page.paging?.next ?? null;
    pageCount++;
  }
  return results;
}

/**
 * Read enhancement + multi-ad info from existing AdCreatives, by ID.
 *
 * Batched: up to 50 IDs per call (Meta's documented limit on ?ids=).
 * Returns a Map keyed by creative ID.
 *
 * Fields fetched:
 *   - id
 *   - degrees_of_freedom_spec — contains creative_features_spec with each
 *     enhancement's enroll_status
 *   - contextual_multi_ads — separate top-level field for multi-advertiser opt-in
 */
export interface MetaAdCreativeDetail {
  id: string;
  degrees_of_freedom_spec?: {
    creative_features_spec?: Record<
      string,
      { enroll_status?: 'OPT_IN' | 'OPT_OUT' }
    >;
  };
  contextual_multi_ads?: { enroll_status?: 'OPT_IN' | 'OPT_OUT' };
}

export async function getAdCreativeDetails(
  accessToken: string,
  creativeIds: string[]
): Promise<Map<string, MetaAdCreativeDetail>> {
  if (creativeIds.length === 0) return new Map();
  const result = new Map<string, MetaAdCreativeDetail>();
  const BATCH = 50;
  for (let i = 0; i < creativeIds.length; i += BATCH) {
    const batch = creativeIds.slice(i, i + BATCH);
    const url =
      `${GRAPH_BASE}/` +
      `?ids=${encodeURIComponent(batch.join(','))}` +
      `&fields=id,degrees_of_freedom_spec,contextual_multi_ads`;
    const data: Record<string, MetaAdCreativeDetail> = await metaFetch(url, {
      access_token: accessToken,
    });
    // Meta returns an object keyed by id when using ?ids=
    for (const [id, detail] of Object.entries(data ?? {})) {
      if (detail && typeof detail === 'object') {
        result.set(id, detail);
      }
    }
  }
  return result;
}

// =====================================================================
// Comment moderation (Comment Guard)
// =====================================================================
// Meta has NO API to disable comments on an ad. What IS permitted is hiding
// individual comments on the ad's underlying Page post. These helpers read a
// creative's post id, page through a post's comments, and hide/unhide one.
//
// Hiding requires a PAGE-scoped token (pages_manage_engagement) for the Page
// that owns the post — NOT the user/ads token used by the rest of this file.

export interface MetaCreativePostRef {
  id: string;
  /** "{pageid}_{postid}" — the live post backing the ad. Preferred. */
  effective_object_story_id?: string;
  /** Set when the creative was built from an existing organic post. */
  object_story_id?: string;
}

/**
 * Batch-read the underlying post id for a set of creatives (ads/user token).
 * Returns a Map keyed by creative id.
 */
export async function getCreativePostRefs(
  accessToken: string,
  creativeIds: string[]
): Promise<Map<string, MetaCreativePostRef>> {
  if (creativeIds.length === 0) return new Map();
  const result = new Map<string, MetaCreativePostRef>();
  const BATCH = 50;
  for (let i = 0; i < creativeIds.length; i += BATCH) {
    const batch = creativeIds.slice(i, i + BATCH);
    const url =
      `${GRAPH_BASE}/` +
      `?ids=${encodeURIComponent(batch.join(','))}` +
      `&fields=id,effective_object_story_id,object_story_id`;
    const data: Record<string, MetaCreativePostRef> = await metaFetch(url, {
      access_token: accessToken,
    });
    for (const [id, ref] of Object.entries(data ?? {})) {
      if (ref && typeof ref === 'object') result.set(id, ref);
    }
  }
  return result;
}

export interface MetaComment {
  id: string;
  message?: string;
  created_time?: string;
  is_hidden?: boolean;
  permalink_url?: string;
  from?: { id?: string; name?: string };
}

/**
 * List comments on a post, newest-first, paginating up to `maxPages`.
 *
 * Pass `sinceUnix` (seconds) to only return comments created after that time.
 * Because Meta's `since` support on the comments edge is unreliable, we page
 * newest-first, stop once we cross the watermark, then filter client-side —
 * robust regardless of API quirks. Requires the owning Page's token.
 */
export async function listPostComments(
  pageToken: string,
  postId: string,
  sinceUnix?: number,
  maxPages = 10
): Promise<MetaComment[]> {
  const fields = 'id,message,created_time,is_hidden,permalink_url,from{id,name}';
  let nextUrl: string | null =
    `${GRAPH_BASE}/${encodeURIComponent(postId)}/comments` +
    `?fields=${fields}&filter=stream&order=reverse_chronological&limit=100`;
  const out: MetaComment[] = [];
  let pages = 0;
  const toSec = (t?: string) => (t ? Math.floor(new Date(t).getTime() / 1000) : 0);

  while (nextUrl && pages < maxPages) {
    const page: { data: MetaComment[]; paging?: { next?: string } } =
      await metaFetch(nextUrl, { access_token: pageToken });
    const batch = page.data ?? [];
    out.push(...batch);
    // Newest-first: once the oldest in this page is past the watermark, stop.
    if (sinceUnix && batch.length > 0) {
      const oldest = toSec(batch[batch.length - 1].created_time);
      if (oldest && oldest <= sinceUnix) break;
    }
    nextUrl = page.paging?.next ?? null;
    pages++;
  }

  return sinceUnix ? out.filter((c) => toSec(c.created_time) > sinceUnix) : out;
}

/** Hide or unhide a single comment. Requires the owning Page's token. */
export async function setCommentHidden(
  pageToken: string,
  commentId: string,
  hidden: boolean
): Promise<void> {
  const url = `${GRAPH_BASE}/${encodeURIComponent(commentId)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_hidden: hidden, access_token: pageToken }),
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* swallow */ }
  if (!res.ok || data?.error) {
    throw new MetaApiError(
      data?.error?.message ?? `Set comment is_hidden failed (${res.status})`,
      res.status,
      data?.error
    );
  }
}

/**
 * PATCH an existing AdCreative to set its creative_features_spec and/or
 * contextual_multi_ads. Used by the audit-fix worker.
 *
 * IMPORTANT: this is a targeted update — we only touch the fields we manage
 * (the enhancement spec + multi-ad opt-out). Everything else on the
 * creative (image, copy, page id, etc) is left alone.
 *
 * Meta's API behavior: POSTing to /{ad-creative-id} updates the fields you
 * include. Other fields are preserved.
 */
export interface UpdateAdCreativeInput {
  creativeId: string;
  /** Full creative_features_spec to set. Replaces existing spec entirely. */
  creativeFeaturesSpec?: Record<string, { enroll_status: 'OPT_IN' | 'OPT_OUT' }>;
  /** Multi-advertiser opt status. Pass 'OPT_OUT' to disable, 'OPT_IN' to enable. */
  multiAdvertiser?: 'OPT_IN' | 'OPT_OUT';
}

export async function updateAdCreative(
  accessToken: string,
  input: UpdateAdCreativeInput
): Promise<void> {
  const url = `${GRAPH_BASE}/${encodeURIComponent(input.creativeId)}`;
  const body: Record<string, any> = {};

  if (input.creativeFeaturesSpec) {
    body.degrees_of_freedom_spec = {
      creative_features_spec: input.creativeFeaturesSpec,
    };
  }
  if (input.multiAdvertiser) {
    body.contextual_multi_ads = { enroll_status: input.multiAdvertiser };
  }

  if (Object.keys(body).length === 0) {
    // Nothing to update — no-op (don't waste an API call)
    return;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: accessToken }),
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* swallow */ }

  if (!res.ok) {
    throw new MetaApiError(
      data?.error?.message ?? `Update AdCreative failed (${res.status})`,
      res.status,
      data?.error
    );
  }
}

// =====================================================================
// Full creative read for duplicate-and-replace (Patch 2.5e)
// =====================================================================
// Meta blocks PATCHing creative_features_spec on existing creatives
// (error subcode 1815573). To "fix" an ad's enhancement settings we have
// to create a NEW creative cloned from the source and re-point the ad at it.
//
// To clone faithfully we need every field that defines the creative:
//   - object_story_spec        (single image/video creatives)
//   - asset_feed_spec          (multi-placement / multi-asset creatives)
//   - degrees_of_freedom_spec  (current enhancement settings)
//   - contextual_multi_ads     (multi-advertiser setting)
//   - account_id, name, url_tags, etc.
//
// We only clone creatives we recognize the shape of. Anything weird
// (lead-gen specs, DPA catalog ads, etc.) we refuse rather than risk
// botching the swap.
// =====================================================================

export interface MetaAdCreativeFull {
  id: string;
  name?: string;
  account_id?: string;
  object_story_spec?: any;
  asset_feed_spec?: any;
  url_tags?: string;
  degrees_of_freedom_spec?: any;
  contextual_multi_ads?: { enroll_status?: 'OPT_IN' | 'OPT_OUT' };
}

export async function getFullAdCreative(
  accessToken: string,
  creativeId: string
): Promise<MetaAdCreativeFull> {
  const fields = [
    'id',
    'name',
    'account_id',
    'object_story_spec',
    'asset_feed_spec',
    'url_tags',
    'degrees_of_freedom_spec',
    'contextual_multi_ads',
  ].join(',');
  const url = `${GRAPH_BASE}/${encodeURIComponent(creativeId)}?fields=${fields}`;
  const data: MetaAdCreativeFull = await metaFetch(url, { access_token: accessToken });
  return data;
}

/**
 * Allowlist of creative_features_spec keys we're willing to send to Meta
 * when creating a replacement creative. MUST match the keys in
 * launch-defaults.ts's ENHANCEMENT_KEYS (we duplicate the list here rather
 * than importing to keep this file free of cross-service deps).
 *
 * Notably EXCLUDED:
 *   - `standard_enhancements` — deprecated by Meta (subcode 3858504); rejected on create
 *   - Keys with nested `customizations` sub-objects (`product_extensions`)
 *   - New keys Meta has introduced that we haven't reviewed yet
 *     (`pac_relaxation`, `show_destination_blurbs`, `reveal_details_over_time`, etc.)
 *
 * If Meta adds a new enhancement and we want to support it, add the key here
 * AND to ENHANCEMENT_KEYS in launch-defaults.ts.
 */
const ENHANCEMENT_KEYS_FOR_REPLACE: readonly string[] = [
  'adapt_to_placement',
  'image_animation',
  'image_background_gen',
  'image_templates',
  'image_touchups',
  'show_summary',
  'text_optimizations',
  'text_translation',
  'text_overlay_translation',
  'description_automation',
  'generate_cta',
  'site_extensions',
  'profile_extension',
  'music_generation',
  'inline_comment',
  // Also supported keys we don't actively configure but won't drop if found
  'video_auto_crop',
];

/**
 * Create a NEW AdCreative cloned from a source creative, but with the
 * named enhancement keys flipped to OPT_OUT (and optionally multi_advertiser
 * flipped to OPT_OUT).
 *
 * Returns the new creative ID.
 *
 * Strategy:
 *   1. Inspect the source's object_story_spec / asset_feed_spec — we only
 *      proceed for shapes we know how to clone safely.
 *   2. Build a fresh creative_features_spec: start from source's existing
 *      enhancement settings, override the targeted keys to OPT_OUT.
 *   3. POST /act_X/adcreatives with the cloned object_story_spec or
 *      asset_feed_spec, the new spec, plus contextual_multi_ads as needed.
 *
 * Throws MetaApiError (or a clear Error) if the source creative uses a shape
 * we don't support, so the worker can mark the finding as failed with a
 * useful message rather than producing broken creatives.
 */
export interface CreateReplacementCreativeInput {
  /** Source creative we're cloning. Pre-fetched via getFullAdCreative. */
  source: MetaAdCreativeFull;
  /** The ad account this lives under, e.g. "act_123". Required by adcreatives POST. */
  metaAdAccountId: string;
  /** Enhancement keys to set to OPT_OUT in the new creative. Subset of all keys. */
  enhancementKeysToOptOut: string[];
  /** Whether to set contextual_multi_ads to OPT_OUT (true) or leave as-is. */
  optOutMultiAdvertiser: boolean;
  /** Optional override for the new creative's name (defaults to source name + " (Vass fix)"). */
  newName?: string;
}

export async function createReplacementAdCreative(
  accessToken: string,
  input: CreateReplacementCreativeInput
): Promise<{ creativeId: string }> {
  const { source } = input;

  // ---- Decide which shape we're dealing with ----
  // Meta creatives are either:
  //   (a) "simple" — has object_story_spec, no asset_feed_spec
  //   (b) "asset feed" — has asset_feed_spec (with or without object_story_spec)
  //   (c) Something else — refuse to touch
  const hasOSS = !!source.object_story_spec;
  const hasAFS = !!source.asset_feed_spec;
  if (!hasOSS && !hasAFS) {
    throw new MetaApiError(
      `Source creative ${source.id} has neither object_story_spec nor asset_feed_spec — cannot clone safely`,
      400
    );
  }

  // ---- Build new creative_features_spec ----
  //
  // CRITICAL: We cannot blindly echo the source's existing spec back to Meta.
  // The source may contain:
  //   1. `standard_enhancements` — DEPRECATED (subcode 3858504). Meta now
  //      rejects creates that include this. We must drop it.
  //   2. Keys we don't recognize (e.g. `pac_relaxation`,
  //      `show_destination_blurbs`, `reveal_details_over_time`) — these are
  //      either new Meta features post-dating our allowlist or experimental
  //      ones we shouldn't be making decisions about.
  //   3. Keys with nested `customizations` sub-objects (e.g. `product_extensions`)
  //      — re-sending these may cause failures.
  //
  // Strategy: only include keys that are in our official ENHANCEMENT_KEYS
  // allowlist (from launch-defaults.ts) AND have a clean enroll_status string.
  // Anything else is dropped. This is the same allowlist we use when CREATING
  // brand-new creatives, so the spec we send is guaranteed valid.
  //
  // For our OPT_OUT targets, force OPT_OUT (whether the key was previously
  // present or not).
  const sourceSpec: Record<string, { enroll_status?: 'OPT_IN' | 'OPT_OUT' }> =
    source.degrees_of_freedom_spec?.creative_features_spec ?? {};
  const newSpec: Record<string, { enroll_status: 'OPT_IN' | 'OPT_OUT' }> = {};

  // Allowlist of keys we'll send to Meta — pulled from the same const used
  // for fresh-creative creation, kept in sync.
  const KNOWN_KEYS = new Set<string>(ENHANCEMENT_KEYS_FOR_REPLACE);

  for (const [k, v] of Object.entries(sourceSpec)) {
    if (!KNOWN_KEYS.has(k)) continue; // drop deprecated/unknown/nested keys
    if (v?.enroll_status === 'OPT_IN' || v?.enroll_status === 'OPT_OUT') {
      newSpec[k] = { enroll_status: v.enroll_status };
    }
  }
  for (const key of input.enhancementKeysToOptOut) {
    if (!KNOWN_KEYS.has(key)) {
      // The user shouldn't be able to select an unknown key from the UI, but
      // be defensive: skip it rather than send something Meta will reject.
      continue;
    }
    newSpec[key] = { enroll_status: 'OPT_OUT' };
  }

  // ---- Build the POST body ----
  // We send EVERYTHING the source had, except we override the spec + multi-ad.
  // Meta needs at minimum: name, an object_story_spec OR asset_feed_spec,
  // and the spec/multi-ad fields if we're setting them.
  const body: Record<string, any> = {
    name: input.newName ?? `${source.name ?? 'creative'} (Vass fix)`,
  };

  // Clone object_story_spec verbatim. This includes page_id, instagram_user_id,
  // link_data / video_data / template_data, etc. Meta accepts the full nested
  // structure on POST.
  if (hasOSS) {
    body.object_story_spec = source.object_story_spec;
  }

  // Clone asset_feed_spec verbatim. Includes images[], videos[], bodies[],
  // titles[], descriptions[], link_urls[], call_to_action_types[],
  // asset_customization_rules[], ad_formats[], etc.
  if (hasAFS) {
    body.asset_feed_spec = source.asset_feed_spec;
  }

  // url_tags is the dynamic UTM params Meta appends to clicks. Preserve.
  if (source.url_tags) {
    body.url_tags = source.url_tags;
  }

  // Set the new enhancement spec
  body.degrees_of_freedom_spec = { creative_features_spec: newSpec };

  // Multi-advertiser: set OPT_OUT if requested, otherwise preserve source value
  if (input.optOutMultiAdvertiser) {
    body.contextual_multi_ads = { enroll_status: 'OPT_OUT' };
  } else if (source.contextual_multi_ads?.enroll_status) {
    body.contextual_multi_ads = {
      enroll_status: source.contextual_multi_ads.enroll_status,
    };
  }

  // ---- POST it ----
  const url = `${GRAPH_BASE}/${encodeURIComponent(input.metaAdAccountId)}/adcreatives`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: accessToken }),
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* swallow */ }

  if (!res.ok) {
    throw new MetaApiError(
      data?.error?.message ?? `Create replacement creative failed (${res.status})`,
      res.status,
      data?.error
    );
  }
  if (!data?.id) {
    throw new MetaApiError(
      'Meta returned no creative ID for the replacement',
      500,
      data
    );
  }
  return { creativeId: String(data.id) };
}

/**
 * Re-point an existing Ad to a different AdCreative.
 *
 * Meta supports this via `POST /{ad-id}` with body `creative: { creative_id }`.
 * The ad ID is preserved; only the underlying creative reference changes.
 *
 * Be aware: doing this may reset Meta's learning phase for the ad. That's
 * intrinsic to swapping creatives — same thing happens if you do it in
 * Ads Manager.
 */
export async function attachCreativeToAd(
  accessToken: string,
  adId: string,
  newCreativeId: string
): Promise<void> {
  const url = `${GRAPH_BASE}/${encodeURIComponent(adId)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      creative: { creative_id: newCreativeId },
      access_token: accessToken,
    }),
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* swallow */ }

  if (!res.ok) {
    throw new MetaApiError(
      data?.error?.message ?? `Re-point ad to new creative failed (${res.status})`,
      res.status,
      data?.error
    );
  }
}
// Meta's adimages endpoint:
//   POST /{ad-account-id}/adimages
//   Body: multipart with field name = arbitrary (we'll use 'image').
//         Content-Disposition: form-data; name="image"; filename="..."
//   Response: { images: { "<arbitrary-name>": { hash: "...", url: "..." } } }
//
// The returned `hash` is the canonical identifier Meta uses everywhere
// else (AdCreative.image_hash). We store + reuse it.
// =====================================================================

export interface MetaImageUploadResult {
  hash: string;
  url: string;          // CDN URL for the uploaded image (long-lived for that account)
}

export async function uploadImage(
  accessToken: string,
  metaAdAccountId: string,
  imageBytes: Buffer,
  filename: string
): Promise<MetaImageUploadResult> {
  const url = `${GRAPH_BASE}/${encodeURIComponent(metaAdAccountId)}/adimages`;

  // Use Node's built-in FormData (Node 20+)
  const form = new FormData();
  // The field name we use here becomes the key in the response.
  const blob = new Blob([imageBytes]);
  form.append('image', blob, filename);
  form.append('access_token', accessToken);

  const res = await fetch(url, {
    method: 'POST',
    body: form,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* swallow */
  }

  if (!res.ok) {
    throw new MetaApiError(
      data?.error?.message ?? `Image upload failed (${res.status})`,
      res.status,
      data?.error
    );
  }

  // Response looks like: { images: { "<filename-without-ext>": { hash, url } } }
  // Meta uses the filename (minus extension) as the key, not what we sent in `name`.
  // We just grab the first value.
  const images = data?.images;
  if (!images || typeof images !== 'object') {
    throw new MetaApiError('Image upload returned no images object', 500, data);
  }
  const firstKey = Object.keys(images)[0];
  const img = images[firstKey];
  if (!img?.hash) {
    throw new MetaApiError('Image upload returned no hash', 500, data);
  }
  return { hash: img.hash, url: img.url };
}

// =====================================================================
// Video upload to Meta
// =====================================================================
// Unlike images, video upload is ASYNC:
//   1. POST /{ad-account-id}/advideos with multipart bytes → returns video_id
//   2. Meta starts encoding the video in the background
//   3. Before using the video in a creative, poll /{video_id}?fields=status
//      until status.video_status === 'ready'
//
// For modest-sized videos (under ~30 MB), this typically completes in 10-60s.
// For larger videos, several minutes is normal.
//
// We expose this as two functions:
//   - uploadVideo  — does step 1, returns the video_id immediately
//   - waitForVideoReady — does step 3, polls until ready (or times out)
//
// The worker calls them in sequence: upload, then wait. Both are designed
// to be safe to retry (uploadVideo on a duplicate file returns a fresh id;
// the worker caches the id on the uploads row so successive retries skip
// the upload and only re-poll for readiness).
// =====================================================================

export interface MetaVideoUploadResult {
  videoId: string;
}

export async function uploadVideo(
  accessToken: string,
  metaAdAccountId: string,
  videoBytes: Buffer,
  filename: string
): Promise<MetaVideoUploadResult> {
  const url = `${GRAPH_BASE}/${encodeURIComponent(metaAdAccountId)}/advideos`;

  const form = new FormData();
  const blob = new Blob([videoBytes]);
  form.append('source', blob, filename);
  form.append('access_token', accessToken);

  const res = await fetch(url, {
    method: 'POST',
    body: form,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* swallow */
  }

  if (!res.ok) {
    throw new MetaApiError(
      data?.error?.message ?? `Video upload failed (${res.status})`,
      res.status,
      data?.error
    );
  }
  if (!data?.id) {
    throw new MetaApiError('Video upload returned no id', 500, data);
  }
  return { videoId: data.id };
}

/**
 * Poll /{video_id}?fields=status until the video is ready (or fails / times out).
 *
 * Returns when status.video_status === 'ready'. Throws if it's 'error' or
 * if we exceed the timeout.
 *
 * Default polling: every 5s, up to 10 minutes total. The worker has its
 * own job-level timeout via BullMQ, so this is a backstop.
 */
export async function waitForVideoReady(
  accessToken: string,
  videoId: string,
  opts?: { intervalMs?: number; timeoutMs?: number }
): Promise<void> {
  const intervalMs = opts?.intervalMs ?? 5_000;
  const timeoutMs = opts?.timeoutMs ?? 10 * 60_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const url = `${GRAPH_BASE}/${encodeURIComponent(videoId)}?fields=status`;
    const data: { status?: { video_status?: string; processing_phase?: any } } = await metaFetch(
      url,
      { access_token: accessToken }
    );
    const status = data?.status?.video_status;

    if (status === 'ready') return;
    if (status === 'error') {
      throw new MetaApiError(
        `Video processing failed for ${videoId}`,
        502,
        { error_user_msg: `Meta could not process the video (status=error).` }
      );
    }
    // status is typically 'processing' or 'uploaded'; keep polling
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new MetaApiError(
    `Video ${videoId} not ready after ${Math.round(timeoutMs / 1000)}s`,
    504,
    { error_user_msg: 'Meta took too long to process the video.' }
  );
}

/**
 * Fetch the URL of one of the auto-generated thumbnails for a video.
 *
 * Meta auto-extracts ~10 thumbnail frames during video processing. They're
 * available at `/{video_id}/thumbnails` after `video_status === 'ready'`.
 * We grab the one marked `is_preferred` (or fall back to the first).
 *
 * Returns null if no thumbnails are available — caller can decide whether
 * that's fatal. For ad creation it's effectively fatal (Meta requires a
 * thumbnail on video_data) so the caller usually treats null as an error.
 */
export async function getVideoThumbnailUrl(
  accessToken: string,
  videoId: string
): Promise<string | null> {
  try {
    const url = `${GRAPH_BASE}/${encodeURIComponent(videoId)}/thumbnails?fields=uri,is_preferred`;
    const data: { data?: Array<{ uri?: string; is_preferred?: boolean }> } =
      await metaFetch(url, { access_token: accessToken });
    const thumbnails = data?.data ?? [];
    if (thumbnails.length === 0) return null;
    const preferred = thumbnails.find((t) => t.is_preferred && t.uri);
    return (preferred?.uri ?? thumbnails.find((t) => t.uri)?.uri) ?? null;
  } catch (err) {
    console.warn(
      `[meta] getVideoThumbnailUrl failed for ${videoId}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

// =====================================================================
// Create AdCreative
// =====================================================================
// AdCreative is the "what" of an ad: image/video + copy + page + URL.
// It's reusable: many ads can reference the same creative.
//
// For Phase 3.0 we always create a fresh creative per launch. Reusing
// creatives across launches is a Phase 3.2+ optimization.
//
// Important: degrees_of_freedom_spec controls Meta's "creative
// enhancements" — Vass's Phase 2 feature passes OPT_OUT here.
// =====================================================================

export interface CreateAdCreativeInput {
  metaAdAccountId: string;
  name: string;                                // internal, shown in Meta UI
  pageId: string;                              // the Facebook Page the ad runs on behalf of
  /**
   * Instagram User ID (the newer field name replacing `instagram_actor_id`,
   * which was deprecated in 2025). When provided, the ad runs on Instagram
   * using that account's identity. Without it, the ad either doesn't show on
   * Instagram or uses a Page-backed Instagram identity.
   */
  instagramUserId?: string;
  /**
   * Image-based ad: image_hash from uploadImage(). Mutually exclusive with videoId.
   */
  imageHash?: string;
  /**
   * Video-based ad: video_id from uploadVideo() AFTER waitForVideoReady().
   * Mutually exclusive with imageHash.
   */
  videoId?: string;
  /**
   * Optional thumbnail hash for video ads (from uploadImage()). When omitted,
   * Meta picks one of its auto-extracted thumbnails (we typically pass
   * videoThumbnailUrl below instead — simpler).
   */
  videoThumbnailHash?: string;
  /**
   * Optional thumbnail URL for video ads. Meta requires every video_data
   * to specify image_hash OR image_url. We default to passing the URL of
   * one of Meta's auto-extracted thumbnails (fetched via getVideoThumbnailUrl).
   */
  videoThumbnailUrl?: string;
  message: string;                             // primary text
  headline?: string;
  description?: string;
  linkUrl: string;                             // destination URL
  callToActionType?: string;                   // 'SHOP_NOW', 'LEARN_MORE', etc.
  /** Pre-built creative_features_spec from launch-defaults service. */
  creativeFeaturesSpec?: Record<string, { enroll_status: 'OPT_IN' | 'OPT_OUT' }>;
  /**
   * When true, sends `contextual_multi_ads: { enroll_status: 'OPT_OUT' }` so
   * Meta does NOT show this ad in multi-advertiser placements. Since Aug 19,
   * 2024 the default is OPT_IN, so we must explicitly opt out.
   */
  multiAdvertiserOptOut?: boolean;
  /**
   * URL parameters Meta appends to the destination URL on every click. This
   * is NOT part of the link URL — Meta has a separate `url_tags` field on
   * the ad creative, and merges it server-side (with the right ? or &).
   * Common use: UTM tracking. Example: "utm_source=facebook&utm_medium=cpc&utm_campaign={{ad.name}}".
   * Supports Meta's dynamic tokens like {{campaign.name}}, {{adset.name}}, {{ad.name}}.
   */
  urlTags?: string;
}

export interface MetaAdCreativeResult {
  id: string;
}

export async function createAdCreative(
  accessToken: string,
  input: CreateAdCreativeInput
): Promise<MetaAdCreativeResult> {
  // Must have exactly one of imageHash / videoId
  if (!input.imageHash && !input.videoId) {
    throw new MetaApiError(
      'createAdCreative requires either imageHash or videoId',
      400
    );
  }
  if (input.imageHash && input.videoId) {
    throw new MetaApiError(
      'createAdCreative: imageHash and videoId are mutually exclusive',
      400
    );
  }

  const url = `${GRAPH_BASE}/${encodeURIComponent(input.metaAdAccountId)}/adcreatives`;

  // Build the object_story_spec: this is Meta's nested representation of
  // "an ad creative built around a Page post". The shape depends on whether
  // we're making an image ad (link_data) or a video ad (video_data).
  const objectStorySpec: Record<string, any> = {
    page_id: input.pageId,
  };

  if (input.imageHash) {
    objectStorySpec.link_data = {
      image_hash: input.imageHash,
      link: input.linkUrl,
      message: input.message,
      name: input.headline,           // 'name' is the headline in Meta's API
      description: input.description, // optional small text under headline
      call_to_action: input.callToActionType
        ? { type: input.callToActionType, value: { link: input.linkUrl } }
        : undefined,
    };
  } else {
    // Video ad — uses video_data instead of link_data. The link goes inside
    // the call_to_action.value, just like images. Headline is `title` here
    // (not `name`).
    //
    // Meta requires video_data to specify EITHER image_hash OR image_url
    // (the thumbnail). We prefer image_url to skip a re-upload step, but
    // fall back to image_hash if provided. If both are absent the API
    // rejects with subcode 1443226.
    if (!input.videoThumbnailHash && !input.videoThumbnailUrl) {
      throw new MetaApiError(
        'Video ad requires a thumbnail (videoThumbnailHash or videoThumbnailUrl)',
        400
      );
    }
    objectStorySpec.video_data = {
      video_id: input.videoId,
      message: input.message,
      title: input.headline,
      image_hash: input.videoThumbnailHash,
      image_url: input.videoThumbnailUrl,
      call_to_action: input.callToActionType
        ? { type: input.callToActionType, value: { link: input.linkUrl } }
        : { type: 'LEARN_MORE', value: { link: input.linkUrl } },
    };
  }

  // Attach the Instagram identity if we know it. Goes at the top level of
  // object_story_spec, next to page_id.
  if (input.instagramUserId) {
    objectStorySpec.instagram_user_id = input.instagramUserId;
  }

  const body: Record<string, any> = {
    name: input.name,
    object_story_spec: objectStorySpec,
  };

  if (input.creativeFeaturesSpec) {
    body.degrees_of_freedom_spec = {
      creative_features_spec: input.creativeFeaturesSpec,
    };
  }

  // contextual_multi_ads is a SEPARATE top-level field on the AdCreative
  // (not inside creative_features_spec). Without this, Meta defaults to
  // OPT_IN — every ad gets shown alongside other advertisers.
  if (input.multiAdvertiserOptOut) {
    body.contextual_multi_ads = { enroll_status: 'OPT_OUT' };
  }

  // url_tags — UTM-style params Meta appends to the destination URL at click
  // time. Sent as a separate field, not part of link_data.link.
  if (input.urlTags && input.urlTags.trim()) {
    body.url_tags = input.urlTags.trim();
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: accessToken }),
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* swallow */ }

  if (!res.ok) {
    throw new MetaApiError(
      data?.error?.message ?? `Create AdCreative failed (${res.status})`,
      res.status,
      data?.error
    );
  }
  if (!data?.id) {
    throw new MetaApiError('Create AdCreative returned no id', 500, data);
  }
  return { id: data.id };
}

// =====================================================================
// AdCreative with asset_feed_spec — multi-placement creatives
// =====================================================================
// When a single ad needs different assets per placement (e.g. 4:5 for
// Feed and 9:16 for Stories/Reels), Meta accepts an `asset_feed_spec`
// instead of a single object_story_spec.
//
// Shape:
//   {
//     name: "...",
//     object_story_spec: { page_id, instagram_user_id },  // identity only
//     asset_feed_spec: {
//       images: [ { hash, name: "asset_4_5" }, ... ],
//       videos: [ { video_id, name: "asset_9_16" }, ... ],
//       bodies: [ { text: "primary text" } ],
//       titles: [ { text: "headline" } ],
//       descriptions: [ { text: "..." } ],   // optional
//       link_urls: [ { website_url: "..." } ],
//       call_to_action_types: [ "LEARN_MORE" ],
//       asset_customization_rules: [
//         { customization_spec: { ... placements ... },
//           image_label: { name: "asset_4_5" } },
//         { customization_spec: { ... placements ... },
//           video_label: { name: "asset_9_16" } },
//       ]
//     }
//   }
//
// Each asset is given a `name` (free-form label), and the rules reference
// those labels to say "use this asset for these placements".
//
// Placements covered by Vass's three buckets:
//   - 4_5  → Facebook feed, Instagram feed, Marketplace, Search
//   - 1_1  → Same as 4_5 (1:1 is universally accepted in feed placements)
//   - 9_16 → Facebook story, Facebook reels, Instagram story, Instagram reels
// =====================================================================

export type PlacementBucket = '1_1' | '4_5' | '9_16';

export interface AssetFeedAsset {
  /** Which bucket this asset is for. Drives the customization rule. */
  bucket: PlacementBucket;
  /** Image: pass hash. Video: pass videoId. Exactly one must be set. */
  imageHash?: string;
  videoId?: string;
}

export interface CreateAssetFeedCreativeInput {
  metaAdAccountId: string;
  name: string;
  pageId: string;
  instagramUserId?: string;
  /** 1+ assets across at least one bucket. */
  assets: AssetFeedAsset[];
  message: string;
  headline?: string;
  description?: string;
  linkUrl: string;
  callToActionType?: string;
  creativeFeaturesSpec?: Record<string, { enroll_status: 'OPT_IN' | 'OPT_OUT' }>;
  multiAdvertiserOptOut?: boolean;
  /**
   * URL parameters Meta appends to the destination at click time (e.g. UTM
   * params). Sent as a separate top-level `url_tags` field — does NOT
   * modify the linkUrl. Empty / undefined to skip.
   */
  urlTags?: string;
}

// Mapping bucket → Meta placement customization. Vass collapses Meta's
// dozens of placement enums into three pragmatic buckets.
const FEED_PLACEMENTS = {
  facebook_positions: ['feed', 'marketplace', 'video_feeds', 'search'],
  instagram_positions: ['stream', 'explore', 'explore_home'],
  publisher_platforms: ['facebook', 'instagram'],
};
const STORY_REEL_PLACEMENTS = {
  facebook_positions: ['story', 'facebook_reels'],
  instagram_positions: ['story', 'reels'],
  publisher_platforms: ['facebook', 'instagram'],
};

function customizationForBucket(bucket: PlacementBucket): Record<string, any> {
  switch (bucket) {
    case '1_1':
    case '4_5':
      return FEED_PLACEMENTS;
    case '9_16':
      return STORY_REEL_PLACEMENTS;
  }
}

export async function createAssetFeedAdCreative(
  accessToken: string,
  input: CreateAssetFeedCreativeInput
): Promise<MetaAdCreativeResult> {
  if (input.assets.length === 0) {
    throw new MetaApiError('createAssetFeedAdCreative: assets is empty', 400);
  }

  const url = `${GRAPH_BASE}/${encodeURIComponent(input.metaAdAccountId)}/adcreatives`;

  // Build asset arrays + rules
  const images: Array<{ hash: string; adlabels: Array<{ name: string }> }> = [];
  const videos: Array<{ video_id: string; adlabels: Array<{ name: string }> }> = [];
  const rules: Array<Record<string, any>> = [];

  // De-dupe buckets: if user uploaded two 4:5 images, only the first wins
  // (Meta only allows one asset per customization spec per type).
  const seenBuckets = new Set<PlacementBucket>();
  let hasVideo = false;
  let hasImage = false;

  for (let i = 0; i < input.assets.length; i++) {
    const a = input.assets[i];
    if (seenBuckets.has(a.bucket)) continue; // first asset per bucket wins
    seenBuckets.add(a.bucket);

    const label = `vass_${a.bucket}_${i}`;
    const customization = customizationForBucket(a.bucket);

    if (a.imageHash) {
      images.push({ hash: a.imageHash, adlabels: [{ name: label }] });
      hasImage = true;
      rules.push({
        customization_spec: customization,
        image_label: { name: label },
      });
    } else if (a.videoId) {
      videos.push({ video_id: a.videoId, adlabels: [{ name: label }] });
      hasVideo = true;
      rules.push({
        customization_spec: customization,
        video_label: { name: label },
      });
    } else {
      throw new MetaApiError(
        `Asset ${i} has neither imageHash nor videoId`,
        400
      );
    }
  }

  const objectStorySpec: Record<string, any> = { page_id: input.pageId };
  if (input.instagramUserId) {
    objectStorySpec.instagram_user_id = input.instagramUserId;
  }

  // Meta requires ad_formats. Pick the right one based on which assets we have.
  // If both image AND video are present, SINGLE_VIDEO covers it (Meta uses the
  // video for video placements and falls back to the image otherwise).
  const adFormats: string[] = hasVideo ? ['SINGLE_VIDEO'] : ['SINGLE_IMAGE'];

  const assetFeedSpec: Record<string, any> = {
    ad_formats: adFormats,
    bodies: [{ text: input.message }],
    link_urls: [{ website_url: input.linkUrl }],
    call_to_action_types: [input.callToActionType || 'LEARN_MORE'],
    asset_customization_rules: rules,
  };
  if (images.length > 0) assetFeedSpec.images = images;
  if (videos.length > 0) assetFeedSpec.videos = videos;
  if (input.headline) assetFeedSpec.titles = [{ text: input.headline }];
  if (input.description) assetFeedSpec.descriptions = [{ text: input.description }];

  const body: Record<string, any> = {
    name: input.name,
    object_story_spec: objectStorySpec,
    asset_feed_spec: assetFeedSpec,
  };

  if (input.creativeFeaturesSpec) {
    // `asset_customization_rules` (manual per-placement assets) is mutually
    // exclusive with Meta's automatic placement-adaptation features. If we
    // send `adapt_to_placement` in the same creative — even as OPT_OUT — Meta
    // rejects the whole creative with subcode 1885896: "The Asset
    // Customization Rules field is not supported in asset feed." Strip the
    // conflicting placement features here; the customization rules already
    // define per-placement behavior explicitly.
    const PLACEMENT_CONFLICTING_FEATURES = ['adapt_to_placement'];
    const safeFeaturesSpec = Object.fromEntries(
      Object.entries(input.creativeFeaturesSpec).filter(
        ([key]) => !PLACEMENT_CONFLICTING_FEATURES.includes(key)
      )
    );
    if (Object.keys(safeFeaturesSpec).length > 0) {
      body.degrees_of_freedom_spec = {
        creative_features_spec: safeFeaturesSpec,
      };
    }
  }
  if (input.multiAdvertiserOptOut) {
    body.contextual_multi_ads = { enroll_status: 'OPT_OUT' };
  }
  if (input.urlTags && input.urlTags.trim()) {
    body.url_tags = input.urlTags.trim();
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: accessToken }),
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* swallow */ }

  if (!res.ok) {
    throw new MetaApiError(
      data?.error?.message ?? `Create asset-feed AdCreative failed (${res.status})`,
      res.status,
      data?.error
    );
  }
  if (!data?.id) {
    throw new MetaApiError('Create asset-feed AdCreative returned no id', 500, data);
  }
  return { id: data.id };
}

// =====================================================================
// Page + Instagram lookup from existing ads (ground truth)
// =====================================================================
// Meta's /promote_pages and /instagram_accounts endpoints are permission-
// gated — they only return Pages/IGs the API user directly admins. For
// agency-shared accounts (where you have access to the ad account but not
// to the Page or IG), these endpoints return empty.
//
// The reliable approach: read the page_id and instagram_user_id from the
// account's existing ads. Every active ad has them in its creative's
// object_story_spec. We sample the most recent ads, aggregate the values,
// and pick the most common.
//
// This works for any account that has ever launched even one ad — which
// is essentially every real account.
// =====================================================================

interface AdCreativePeek {
  creative?: {
    object_story_spec?: {
      page_id?: string;
      instagram_user_id?: string;
    };
    // Many ads (existing-post ads, catalog/DPA, asset-feed creatives) carry no
    // inline object_story_spec but DO expose the backing post id, which is
    // "{pageId}_{postId}". We parse the page id out of it as a fallback so
    // those accounts still resolve a Page + picture.
    effective_object_story_id?: string;
  };
}

export interface AdAccountIdentity {
  pageId: string | null;
  instagramUserId: string | null;
  pictureUrl: string | null; // populated separately if a Page id was found
}

export async function fetchAccountIdentity(
  accessToken: string,
  metaAdAccountId: string
): Promise<AdAccountIdentity> {
  try {
    // Sample up to 25 most recent ads. Pull the inline spec AND the backing
    // post id (effective_object_story_id) so we can resolve a Page even when
    // the ad has no inline object_story_spec.
    const url = `${GRAPH_BASE}/${encodeURIComponent(
      metaAdAccountId
    )}/ads?fields=creative%7Bobject_story_spec%7Bpage_id%2Cinstagram_user_id%7D%2Ceffective_object_story_id%7D&limit=25`;
    const data: { data?: AdCreativePeek[] } = await metaFetch(url, {
      access_token: accessToken,
    });
    const ads = data?.data ?? [];
    if (ads.length === 0) {
      return { pageId: null, instagramUserId: null, pictureUrl: null };
    }

    // Tally page_ids and instagram_user_ids across the sampled ads
    const pageCounts = new Map<string, number>();
    const igCounts = new Map<string, number>();
    for (const ad of ads) {
      const spec = ad.creative?.object_story_spec;
      // Prefer the inline page_id; fall back to the "{pageId}_{postId}" form.
      let pid = spec?.page_id ?? null;
      if (!pid) {
        const eosi = ad.creative?.effective_object_story_id;
        if (eosi && eosi.includes('_')) pid = eosi.split('_')[0];
      }
      if (pid) {
        pageCounts.set(pid, (pageCounts.get(pid) ?? 0) + 1);
      }
      if (spec?.instagram_user_id) {
        igCounts.set(spec.instagram_user_id, (igCounts.get(spec.instagram_user_id) ?? 0) + 1);
      }
    }

    // Pick the most-used value for each
    const pickMost = (m: Map<string, number>): string | null => {
      let best: string | null = null;
      let bestCount = 0;
      for (const [k, v] of m.entries()) {
        if (v > bestCount) {
          best = k;
          bestCount = v;
        }
      }
      return best;
    };
    const pageId = pickMost(pageCounts);
    const instagramUserId = pickMost(igCounts);

    // Fetch the Page picture if we found a page_id (best-effort)
    let pictureUrl: string | null = null;
    if (pageId) {
      try {
        const picUrl = `${GRAPH_BASE}/${pageId}?fields=picture.type(large)%7Burl%2Cis_silhouette%7D`;
        const picData: {
          picture?: { data?: { url?: string; is_silhouette?: boolean } };
        } = await metaFetch(picUrl, { access_token: accessToken });
        const pic = picData?.picture?.data;
        if (pic && !pic.is_silhouette && pic.url) {
          pictureUrl = pic.url;
        }
      } catch {
        // Page picture is decoration only — ignore failures silently
      }
    }

    // Fallback: if the Page had no usable picture (silhouette, unreadable, or
    // no page at all) but the account runs Instagram ads, use the IG account's
    // profile picture instead. Covers IG-only / DPA accounts that otherwise
    // show a blank avatar.
    if (!pictureUrl && instagramUserId) {
      try {
        const igUrl = `${GRAPH_BASE}/${instagramUserId}?fields=profile_picture_url`;
        const igData: { profile_picture_url?: string } = await metaFetch(igUrl, {
          access_token: accessToken,
        });
        if (igData?.profile_picture_url) {
          pictureUrl = igData.profile_picture_url;
        }
      } catch {
        // IG picture is decoration only — ignore failures silently
      }
    }

    return { pageId, instagramUserId, pictureUrl };
  } catch (err) {
    // If we can't read ads (perhaps the account is brand new with zero ads),
    // return nulls instead of throwing — the COALESCE upsert won't clobber
    // any existing values.
    console.warn(
      `[meta] fetchAccountIdentity failed for ${metaAdAccountId}:`,
      err instanceof Error ? err.message : err
    );
    return { pageId: null, instagramUserId: null, pictureUrl: null };
  }
}

// Backwards-compat: existing callers may still use the old function names.
// These now delegate to fetchAccountIdentity.

export async function fetchRepresentativePage(
  accessToken: string,
  metaAdAccountId: string
): Promise<{ pageId: string; pictureUrl: string | null } | null> {
  const id = await fetchAccountIdentity(accessToken, metaAdAccountId);
  return id.pageId ? { pageId: id.pageId, pictureUrl: id.pictureUrl } : null;
}

export async function fetchRepresentativeInstagram(
  accessToken: string,
  metaAdAccountId: string
): Promise<{ instagramUserId: string } | null> {
  const id = await fetchAccountIdentity(accessToken, metaAdAccountId);
  return id.instagramUserId ? { instagramUserId: id.instagramUserId } : null;
}

// =====================================================================
// Create Ad
// =====================================================================
// The final step. Takes an AdCreative + ad set + name + status.
//
// status options:
//   'ACTIVE'  — live and spending (subject to ad set's status too)
//   'PAUSED'  — created but not running. Meta's "Draft" concept lives here.
// =====================================================================

export interface CreateAdInput {
  metaAdAccountId: string;
  name: string;
  adSetId: string;
  creativeId: string;
  status: 'ACTIVE' | 'PAUSED';
}

export interface MetaAdResult {
  id: string;
  effective_status?: string;
}

export async function createAd(
  accessToken: string,
  input: CreateAdInput
): Promise<MetaAdResult> {
  const url = `${GRAPH_BASE}/${encodeURIComponent(input.metaAdAccountId)}/ads`;

  const body = {
    name: input.name,
    adset_id: input.adSetId,
    creative: { creative_id: input.creativeId },
    status: input.status,
    access_token: accessToken,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* swallow */ }

  if (!res.ok) {
    throw new MetaApiError(
      data?.error?.message ?? `Create Ad failed (${res.status})`,
      res.status,
      data?.error
    );
  }
  if (!data?.id) {
    throw new MetaApiError('Create Ad returned no id', 500, data);
  }
  return { id: data.id, effective_status: data.effective_status };
}

// =====================================================================
// Error classification — used by the worker to decide whether to retry
// =====================================================================

/**
 * Meta error codes that indicate transient failures worth retrying.
 *   17       — User request limit reached
 *   4        — Application request limit reached
 *   32       — Page request limit reached
 *   613      — Calls to this api have exceeded the rate limit
 *   2        — An unexpected error has occurred (5xx wrapper)
 *   1        — An unknown error occurred
 * Plus any HTTP 5xx.
 */
const TRANSIENT_META_CODES = new Set([1, 2, 4, 17, 32, 613]);

export function isTransientError(err: unknown): boolean {
  if (!(err instanceof MetaApiError)) {
    // Network errors, timeouts, etc — almost certainly transient
    return true;
  }
  if (err.status >= 500) return true;
  if (err.code !== undefined && TRANSIENT_META_CODES.has(err.code)) return true;
  return false;
}
