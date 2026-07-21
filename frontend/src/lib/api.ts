/**
 * Frontend API client.
 *
 * All requests go through /api/* (proxied to the backend by next.config.js).
 * Cookies are sent automatically thanks to `credentials: 'include'`.
 */

export class ApiError extends Error {
  status: number;
  /** Raw `detail` payload from the backend, if any (e.g. Zod flatten output). */
  detail?: unknown;
  constructor(message: string, status: number, detail?: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
    this.name = 'ApiError';
  }
}

/**
 * Turn a backend error body into a specific, human-readable message. When the
 * body carries a Zod `flatten()` `detail`, append the first field-level reason
 * so the user sees "Invalid launch spec — copy.linkUrl: linkUrl must start
 * with https://" instead of the bare "Invalid launch spec".
 */
function composeErrorMessage(parsed: any, status: number): string {
  const base = parsed?.error ?? `Request failed with status ${status}`;
  const detail = parsed?.detail;
  const fieldErrors = detail?.fieldErrors as
    | Record<string, string[]>
    | undefined;
  const formErrors = detail?.formErrors as string[] | undefined;
  const parts: string[] = [];
  if (fieldErrors) {
    for (const [field, msgs] of Object.entries(fieldErrors)) {
      if (msgs && msgs.length) parts.push(`${field}: ${msgs[0]}`);
    }
  }
  if (formErrors && formErrors.length) parts.push(...formErrors);
  return parts.length ? `${base} — ${parts.join('; ')}` : base;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    credentials: 'include',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });

  // Read body, even on errors, so we can surface useful messages
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON — leave parsed as null
  }

  if (!res.ok) {
    throw new ApiError(composeErrorMessage(parsed, res.status), res.status, parsed?.detail);
  }

  return parsed as T;
}

export const api = {
  get: <T = unknown>(path: string, signal?: AbortSignal) =>
    request<T>(path, { method: 'GET', signal }),
  post: <T = unknown>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body }),
  put: <T = unknown>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body }),
  patch: <T = unknown>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body }),
  delete: <T = unknown>(path: string) => request<T>(path, { method: 'DELETE' }),
  /**
   * Multipart upload. `file` is appended as field name "file" to match the
   * backend multer config. Returns the parsed JSON body.
   *
   * Uses XMLHttpRequest under the hood so we can expose upload progress.
   * The optional `onProgress` callback fires with a 0–1 fraction.
   */
  upload: async <T = unknown>(
    path: string,
    file: File,
    onProgress?: (fraction: number) => void
  ): Promise<T> => {
    const form = new FormData();
    form.append('file', file);
    return new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api${path}`);
      xhr.withCredentials = true;

      if (onProgress) {
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            onProgress(e.loaded / e.total);
          }
        });
      }

      xhr.addEventListener('load', () => {
        let parsed: any = null;
        try {
          parsed = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        } catch {
          /* swallow */
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(parsed as T);
        } else {
          reject(
            new ApiError(parsed?.error ?? `Upload failed (${xhr.status})`, xhr.status)
          );
        }
      });
      xhr.addEventListener('error', () => {
        reject(new ApiError('Network error during upload', 0));
      });
      xhr.addEventListener('abort', () => {
        reject(new ApiError('Upload aborted', 0));
      });

      xhr.send(form);
    });
  },
};

// ---- Typed API surface ----
export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member' | 'viewer';
  avatarUrl: string | null;
  /**
   * Optional Spotify track / playlist URL the user set as their "launch jam".
   * Rendered on the dashboard via Spotify's public embed iframe.
   * `null` when not set.
   */
  spotifyTrackUrl: string | null;
}

/** Editable subset of the current user. PATCH /auth/me. */
export interface UpdateMeInput {
  spotifyTrackUrl?: string | null;
}

export const auth = {
  login: (email: string, password: string) =>
    api.post<{ user: CurrentUser }>('/auth/login', { email, password }),
  logout: () => api.post<{ ok: true }>('/auth/logout'),
  me: () => api.get<{ user: CurrentUser }>('/auth/me'),
  updateMe: (input: UpdateMeInput) =>
    api.patch<{ ok: true }>('/auth/me', input),
};

// ---- Meta settings ----
export interface MetaSettings {
  hasCredentials: boolean;
  appId: string | null;
  connected: boolean;
  connectedUserName: string | null;
  connectedUserId: string | null;
  connectedAt: string | null;
  tokenExpiresAt: string | null;
  tokenExpired: boolean;
}

export const metaSettings = {
  get: () => api.get<MetaSettings>('/settings/meta'),
  saveCredentials: (appId: string, appSecret: string) =>
    api.post<{ ok: true }>('/settings/meta/credentials', { appId, appSecret }),
  getOAuthUrl: () => api.get<{ url: string }>('/settings/meta/oauth-url'),
  disconnect: () => api.post<{ ok: true }>('/settings/meta/disconnect'),
};

// ---- Ad accounts ----
export interface AdAccount {
  id: string;
  metaAccountId: string;
  name: string;
  currency: string | null;
  timezoneName: string | null;
  businessId: string | null;
  status: string;
  isEnabled: boolean;
  lastSyncedAt: string | null;
  pageId: string | null;
  pictureUrl: string | null;
  instagramUserId: string | null;
  brandId: string | null;
}

export const adAccounts = {
  list: (all = false) =>
    api.get<{ accounts: AdAccount[] }>(`/ad-accounts${all ? '?all=true' : ''}`),
  sync: () =>
    api.post<{ ok: true; added: number; updated: number; disappeared: number; total: number }>(
      '/ad-accounts/sync'
    ),
  setEnabled: (id: string, isEnabled: boolean) =>
    api.patch<{ account: AdAccount }>(`/ad-accounts/${id}`, { isEnabled }),
  /** Assign (or clear) the brand for an ad account. null = un-group. */
  setBrand: (id: string, brandId: string | null) =>
    api.patch<{ account: AdAccount }>(`/ad-accounts/${id}`, { brandId }),
};

// ---- Launch defaults ----
// Keys here must match the backend's launch-defaults.ts list exactly.
// These are Meta's official creative_features_spec keys.
// NOTE: `standard_enhancements` was removed (deprecated by Meta — error
// subcode 3858504). To disable Standard Enhancements as a whole, opt out
// of every individual feature below.
export const ENHANCEMENT_KEYS = [
  // Image
  'adapt_to_placement',
  'image_animation',
  'image_background_gen',
  'image_templates',
  'image_touchups',
  'show_summary',
  // Text
  'text_optimizations',
  'text_translation',
  'text_overlay_translation',
  'description_automation',
  // CTA / link
  'generate_cta',
  'site_extensions',
  'profile_extension',
  // Other
  'music_generation',
  'inline_comment',
] as const;

export type EnhancementKey = (typeof ENHANCEMENT_KEYS)[number];

/** Human-readable labels for each enhancement key, used in the settings UI */
export const ENHANCEMENT_LABELS: Record<
  EnhancementKey,
  { label: string; group: 'Image' | 'Text' | 'CTA & links' | 'Other' }
> = {
  adapt_to_placement:       { label: 'Image touch-ups (auto-crop)',        group: 'Image' },
  image_animation:          { label: 'Animate static images',              group: 'Image' },
  image_background_gen:     { label: 'AI background extension',            group: 'Image' },
  image_templates:          { label: 'Apply image templates',              group: 'Image' },
  image_touchups:           { label: 'Image enhancements',                 group: 'Image' },
  show_summary:             { label: 'Add summary overlay',                group: 'Image' },
  text_optimizations:       { label: 'Rewrite primary text',               group: 'Text' },
  text_translation:         { label: 'Translate text',                     group: 'Text' },
  text_overlay_translation: { label: 'Translate text in images',           group: 'Text' },
  description_automation:   { label: 'Auto-fill description',              group: 'Text' },
  generate_cta:             { label: 'Modify CTA button',                  group: 'CTA & links' },
  site_extensions:          { label: 'Add site links',                     group: 'CTA & links' },
  profile_extension:        { label: 'Add profile links',                  group: 'CTA & links' },
  music_generation:         { label: 'Add background music',               group: 'Other' },
  inline_comment:           { label: 'Show "relevant comments" overlay',   group: 'Other' },
};

export interface LaunchDefaultsConfig {
  disable_enhancements: boolean;
  granular_overrides: Partial<Record<EnhancementKey, boolean>>;
  disable_multi_advertiser_ads: boolean;
  show_active_only_default: boolean;
}

export interface LaunchDefaultsGlobalResponse {
  config: LaunchDefaultsConfig;
  effective: Record<EnhancementKey, boolean>;
}

export interface LaunchDefaultsAccountResponse {
  hasOverride: boolean;
  config: LaunchDefaultsConfig;
  source: 'account' | 'global' | 'builtin';
  effective: Record<EnhancementKey, boolean>;
}

export const launchDefaults = {
  getGlobal: () => api.get<LaunchDefaultsGlobalResponse>('/settings/launch-defaults'),
  setGlobal: (config: LaunchDefaultsConfig) =>
    api.put<LaunchDefaultsGlobalResponse>('/settings/launch-defaults', config),
  getAccount: (id: string) =>
    api.get<LaunchDefaultsAccountResponse>(`/ad-accounts/${id}/launch-defaults`),
  setAccount: (id: string, config: LaunchDefaultsConfig) =>
    api.put<LaunchDefaultsAccountResponse>(`/ad-accounts/${id}/launch-defaults`, config),
  clearAccount: (id: string) =>
    api.delete<LaunchDefaultsAccountResponse>(`/ad-accounts/${id}/launch-defaults`),
};

// ---- Uploads ----
export type AspectBucket = '1_1' | '4_5' | '9_16' | 'other';

export interface Upload {
  id: string;
  filename: string;
  storagePath: string;
  contentType: string;
  sizeBytes: number;
  kind: 'image' | 'video' | 'document';
  metaImageHash: string | null;
  metaVideoId: string | null;
  metaUploadedAt: string | null;
  /** Pixel width (3.2+, null for old uploads or unreadable files). */
  widthPx: number | null;
  /** Pixel height. */
  heightPx: number | null;
  /** Coarse aspect classification used for placement-aware grouping. */
  aspectBucket: AspectBucket | null;
  createdAt: string;
}

export const uploads = {
  upload: (file: File, onProgress?: (fraction: number) => void) =>
    api.upload<{ upload: Upload }>('/uploads', file, onProgress),
  list: () => api.get<{ uploads: Upload[] }>('/uploads'),
  get: (id: string) => api.get<{ upload: Upload }>(`/uploads/${id}`),
  delete: (id: string) => api.delete<{ ok: true }>(`/uploads/${id}`),
  /** URL to <img src=...> for previews; backend streams the bytes through. */
  fileUrl: (id: string) => `/api/uploads/${id}/file`,
};

// ---- Meta exploration ----
export interface MetaCampaign {
  id: string;
  name: string;
  status: string;
  effective_status: string;
  objective: string;
}
export interface MetaAdSet {
  id: string;
  name: string;
  status: string;
  effective_status: string;
  daily_budget?: string;
  lifetime_budget?: string;
  campaign_id: string;
}
export interface MetaPixel {
  id: string;
  name: string;
}

export type CampaignObjective =
  | 'OUTCOME_AWARENESS'
  | 'OUTCOME_TRAFFIC'
  | 'OUTCOME_ENGAGEMENT'
  | 'OUTCOME_LEADS'
  | 'OUTCOME_APP_PROMOTION'
  | 'OUTCOME_SALES';

export interface CreateAdSetSpec {
  metaCampaignId: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED';
  budgetMode: 'daily' | 'lifetime';
  budgetAmountMinorUnits: number;
  startTime?: string;
  endTime?: string;
  optimizationGoal: string;
  billingEvent?: string;
  bidStrategy?: string;
  countries: string[];
  ageMin: number;
  ageMax: number;
  gender: 'all' | 'male' | 'female';
  placementsAuto: boolean;
  publisherPlatforms?: Array<'facebook' | 'instagram' | 'messenger' | 'audience_network'>;
  pixelId?: string;
  customEventType?: string;
  pageId?: string;
  cboEnabled?: boolean;
}

export interface CreateCampaignSpec {
  name: string;
  objective: CampaignObjective;
  status: 'ACTIVE' | 'PAUSED';
  cboEnabled: boolean;
  budgetMode?: 'daily' | 'lifetime';
  budgetAmountMinorUnits?: number;
  bidStrategy?: string;
}

export const metaExplore = {
  listCampaigns: (adAccountId: string, activeOnly: boolean = true) =>
    api.get<{ campaigns: MetaCampaign[] }>(
      `/meta/ad-accounts/${adAccountId}/campaigns?activeOnly=${activeOnly}`
    ),
  listAdSets: (metaCampaignId: string, activeOnly: boolean = true) =>
    api.get<{ adSets: MetaAdSet[] }>(
      `/meta/campaigns/${metaCampaignId}/ad-sets?activeOnly=${activeOnly}`
    ),
  // ---- Patch 3.3 — ad set creation support ----
  listPixels: (adAccountId: string) =>
    api.get<{ pixels: MetaPixel[] }>(`/meta/ad-accounts/${adAccountId}/pixels`),
  listPixelEvents: (pixelId: string) =>
    api.get<{ events: string[] }>(`/meta/pixels/${pixelId}/events`),
  getCampaignObjective: (metaCampaignId: string) =>
    api.get<{ objective: string | null; cboEnabled: boolean }>(
      `/meta/campaigns/${metaCampaignId}/objective`
    ),
  createAdSet: (adAccountId: string, spec: CreateAdSetSpec) =>
    api.post<{ id: string }>(`/meta/ad-accounts/${adAccountId}/ad-sets`, spec),
  // ---- Patch 3.4 — campaign creation ----
  createCampaign: (adAccountId: string, spec: CreateCampaignSpec) =>
    api.post<{ id: string }>(`/meta/ad-accounts/${adAccountId}/campaigns`, spec),
};

// Optimization goal labels — mirror of OPTIMIZATION_GOAL_LABELS on the backend
export const OPTIMIZATION_GOAL_LABELS: Record<string, string> = {
  REACH: 'Reach',
  IMPRESSIONS: 'Impressions',
  AD_RECALL_LIFT: 'Ad recall lift',
  THRUPLAY: 'ThruPlay (video views)',
  LINK_CLICKS: 'Link clicks',
  LANDING_PAGE_VIEWS: 'Landing page views',
  QUALITY_CALL: 'Quality calls',
  POST_ENGAGEMENT: 'Post engagement',
  CONVERSATIONS: 'Messaging conversations',
  REPLIES: 'Replies',
  PAGE_LIKES: 'Page likes',
  EVENT_RESPONSES: 'Event responses',
  LEAD_GENERATION: 'Leads (instant form)',
  QUALITY_LEAD: 'Quality leads',
  OFFSITE_CONVERSIONS: 'Conversions (pixel)',
  APP_INSTALLS: 'App installs',
  VALUE: 'Value (max purchase value)',
};

/**
 * Standard Meta custom_event_type enum values that promoted_object accepts.
 *
 * IMPORTANT: This is NOT the same as the event names a pixel has fired.
 * Pixel `/stats` returns label-cased names like "Purchase" / "AddToCart",
 * but the AdCreative API's `custom_event_type` field requires the
 * UPPER_SNAKE_CASE enum values listed below. Sending "Purchase" fails with
 * subcode 1815161.
 *
 * If Meta adds new event types, append to this list.
 */
export const CUSTOM_EVENT_TYPES: Array<{ value: string; label: string }> = [
  { value: 'PURCHASE',                          label: 'Purchase' },
  { value: 'LEAD',                              label: 'Lead' },
  { value: 'COMPLETE_REGISTRATION',             label: 'Complete registration' },
  { value: 'CONTENT_VIEW',                      label: 'Content view' },
  { value: 'ADD_TO_CART',                       label: 'Add to cart' },
  { value: 'ADD_TO_WISHLIST',                   label: 'Add to wishlist' },
  { value: 'INITIATED_CHECKOUT',                label: 'Initiated checkout' },
  { value: 'ADD_PAYMENT_INFO',                  label: 'Add payment info' },
  { value: 'SEARCH',                            label: 'Search' },
  { value: 'SUBSCRIBE',                         label: 'Subscribe' },
  { value: 'START_TRIAL',                       label: 'Start trial' },
  { value: 'SUBMIT_APPLICATION',                label: 'Submit application' },
  { value: 'SCHEDULE',                          label: 'Schedule' },
  { value: 'CONTACT',                           label: 'Contact' },
  { value: 'CUSTOMIZE_PRODUCT',                 label: 'Customize product' },
  { value: 'DONATE',                            label: 'Donate' },
  { value: 'FIND_LOCATION',                     label: 'Find location' },
  { value: 'SERVICE_BOOKING_REQUEST',           label: 'Service booking request' },
  { value: 'MESSAGING_CONVERSATION_STARTED_7D', label: 'Messaging conversation started (7d)' },
  { value: 'TUTORIAL_COMPLETION',               label: 'Tutorial completion' },
  { value: 'LEVEL_ACHIEVED',                    label: 'Level achieved' },
  { value: 'ACHIEVEMENT_UNLOCKED',              label: 'Achievement unlocked' },
  { value: 'SPENT_CREDITS',                     label: 'Spent credits' },
  { value: 'LISTING_INTERACTION',               label: 'Listing interaction' },
  { value: 'RATE',                              label: 'Rate' },
  { value: 'D2_RETENTION',                      label: 'Day-2 retention' },
  { value: 'D7_RETENTION',                      label: 'Day-7 retention' },
  { value: 'AD_IMPRESSION',                     label: 'Ad impression' },
  { value: 'OTHER',                             label: 'Other' },
];

// Goals → which goals need pixel/event vs page
export const GOALS_REQUIRING_PIXEL = new Set(['OFFSITE_CONVERSIONS', 'VALUE']);
export const GOALS_REQUIRING_PAGE = new Set([
  'PAGE_LIKES',
  'EVENT_RESPONSES',
  'CONVERSATIONS',
  'REPLIES',
]);

// Objective → allowed optimization goals (mirror of backend constant).
// Each objective only allows a narrow set; IMPRESSIONS/REACH are AWARENESS-only.
export const OPTIMIZATION_GOALS_BY_OBJECTIVE: Record<CampaignObjective, string[]> = {
  OUTCOME_AWARENESS: ['REACH', 'IMPRESSIONS', 'AD_RECALL_LIFT', 'THRUPLAY'],
  OUTCOME_TRAFFIC: ['LINK_CLICKS', 'LANDING_PAGE_VIEWS', 'QUALITY_CALL'],
  OUTCOME_ENGAGEMENT: [
    'POST_ENGAGEMENT',
    'THRUPLAY',
    'CONVERSATIONS',
    'REPLIES',
    'PAGE_LIKES',
    'EVENT_RESPONSES',
  ],
  OUTCOME_LEADS: [
    'LEAD_GENERATION',
    'QUALITY_LEAD',
    'CONVERSATIONS',
    'OFFSITE_CONVERSIONS',
    'LINK_CLICKS',
  ],
  OUTCOME_APP_PROMOTION: [
    'APP_INSTALLS',
    'OFFSITE_CONVERSIONS',
    'LINK_CLICKS',
    'VALUE',
  ],
  OUTCOME_SALES: [
    'OFFSITE_CONVERSIONS',
    'VALUE',
    'LINK_CLICKS',
    'LANDING_PAGE_VIEWS',
  ],
};

// ---- Launches ----
export type DesiredAdStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED';
export type BatchStatus = 'pending' | 'running' | 'completed' | 'failed' | 'partial';
export type AdLaunchStatus = 'pending' | 'launching' | 'success' | 'failed';

export interface LaunchCopySpec {
  message: string;
  headline?: string;
  description?: string;
  linkUrl: string;
  callToActionType?: string;
  /**
   * UTM-style URL params Meta appends to the destination at click time.
   * Stored as a separate `url_tags` field on the ad creative — does NOT
   * modify linkUrl. Empty / omitted = no tracking params sent.
   * Example: "utm_source=fb&utm_medium=cpc&utm_campaign={{ad.name}}".
   */
  urlTags?: string;
}

export interface LaunchSpec {
  adAccountId: string;
  batchName?: string;
  desiredAdStatus: DesiredAdStatus;
  /** One or many — each (creative × ad-set) produces an ad. */
  adSets: Array<{ adSetId: string; adSetName: string }>;
  /** One or many — each creative becomes 1 ad per ad-set. Total = M × N. */
  creatives: Array<{
    /**
     * One or more upload UUIDs in this creative group. Multiple uploads
     * = a multi-placement creative (Patch 3.2). Auto-grouped by filename
     * stem and bucket, adjustable in the UI before launch.
     */
    uploadIds: string[];
    creativeName: string;
    /** Optional per-creative override of any base copy field. */
    copyOverride?: Partial<LaunchCopySpec>;
  }>;
  /** Base copy applied to all ads (unless overridden per creative). */
  copy: LaunchCopySpec;
  /**
   * Ad name template with placeholders. Supported: {creative_name},
   * {ad_set_name}, {account_name}, {date}, {date_short}, {batch_name}, {index}.
   * If empty, defaults to "{creative_name} · {ad_set_name}".
   */
  adNameTemplate?: string;
}

/**
 * Default ad name template — kept in sync with backend's DEFAULT_AD_NAME_TEMPLATE.
 */
export const DEFAULT_AD_NAME_TEMPLATE = '{creative_name} · {ad_set_name}';

/** All placeholders supported by ad name templates. Used to render hint pills in UI. */
export const AD_NAME_PLACEHOLDERS = [
  { token: '{creative_name}', label: 'Creative name' },
  { token: '{ad_set_name}', label: 'Ad set name' },
  { token: '{account_name}', label: 'Account name' },
  { token: '{date}', label: 'Date (YYYY-MM-DD)' },
  { token: '{date_short}', label: 'Date (MM/DD)' },
  { token: '{batch_name}', label: 'Batch name' },
  { token: '{index}', label: 'Ad index in batch' },
] as const;

export interface LaunchBatchSummary {
  id: string;
  name: string | null;
  status: BatchStatus;
  desiredAdStatus: DesiredAdStatus;
  totalAdsPlanned: number;
  totalAdsLaunched: number;
  totalAdsFailed: number;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  adAccountId: string;
  adAccountName: string | null;
}

export interface AdLaunchSummary {
  id: string;
  batchId: string;
  adSetId: string;
  adName: string;
  status: AdLaunchStatus;
  errorMessage: string | null;
  metaAdId: string | null;
  metaCreativeId: string | null;
  attempts: number;
  uploadId: string | null;
  launchedAt: string | null;
  updatedAt: string;
}

export const launches = {
  create: (spec: LaunchSpec) =>
    api.post<{ batchId: string; planned: number }>('/launches', spec),
  list: () => api.get<{ batches: LaunchBatchSummary[] }>('/launches'),
  get: (id: string) =>
    api.get<{ batch: LaunchBatchSummary; adLaunches: AdLaunchSummary[] }>(`/launches/${id}`),
  retryFailed: (id: string) =>
    api.post<{ ok: true; retried: number }>(`/launches/${id}/retry-failed`),
  /**
   * Clear launch history. Members: only their own settled batches. Admins:
   * everyone's. In-flight (pending / running) batches are never deleted.
   * Doesn't touch live Meta ads — only Vass's local records.
   */
  clearAll: () => api.delete<{ ok: true; deleted: number }>('/launches'),
};

export interface AdLaunchDetail {
  id: string;
  adName: string;
  status: string;
  errorMessage: string | null;
  creativeName: string | null;
  objective: string | null;
  copy: {
    message: string;
    headline: string;
    description: string;
    linkUrl: string;
    callToActionType: string;
    /** UTM-style URL params Meta appends to the destination at click time. */
    urlTags: string;
  };
}

export interface AdLaunchRetryOverrides {
  copy?: Partial<AdLaunchDetail['copy']>;
  creativeName?: string;
}

export const adLaunches = {
  get: (id: string) => api.get<AdLaunchDetail>(`/ad-launches/${id}`),
  retry: (id: string, overrides?: AdLaunchRetryOverrides) =>
    api.post<{ ok: true }>(`/ad-launches/${id}/retry`, overrides ?? {}),
};

/**
 * Full list of CTAs accepted by Meta's Marketing API at ad-creative time.
 * Sourced from Meta's `call_to_action[type]` validation error message.
 * Organized by frequency — most common first.
 *
 * NOTE: not every CTA works with every campaign objective. Meta rejects
 * incompatible combinations at launch time. Vass surfaces those errors
 * inline so users can fix the CTA per-ad.
 */
export const META_CTAS: Array<{ value: string; label: string }> = [
  // Most common
  { value: 'LEARN_MORE',         label: 'Learn more' },
  { value: 'SHOP_NOW',           label: 'Shop now' },
  { value: 'SIGN_UP',            label: 'Sign up' },
  { value: 'GET_QUOTE',          label: 'Get quote' },
  { value: 'CONTACT_US',         label: 'Contact us' },
  { value: 'SUBSCRIBE',          label: 'Subscribe' },
  { value: 'APPLY_NOW',          label: 'Apply now' },
  { value: 'BOOK_NOW',           label: 'Book now' },
  { value: 'DOWNLOAD',           label: 'Download' },
  { value: 'SEE_MORE',           label: 'See more' },
  { value: 'BUY_NOW',            label: 'Buy now' },
  { value: 'GET_OFFER',          label: 'Get offer' },
  { value: 'SEND_MESSAGE',       label: 'Send message' },
  { value: 'WHATSAPP_MESSAGE',   label: 'WhatsApp message' },
  { value: 'INSTAGRAM_MESSAGE',  label: 'Instagram message' },
  { value: 'CALL_NOW',           label: 'Call now' },
  // Lead-gen flavors
  { value: 'GET_A_QUOTE',        label: 'Get a quote' },
  { value: 'ASK_FOR_MORE_INFO',  label: 'Ask for more info' },
  { value: 'REQUEST_TIME',       label: 'Request time' },
  { value: 'MAKE_AN_APPOINTMENT',label: 'Make an appointment' },
  { value: 'BOOK_A_CONSULTATION',label: 'Book a consultation' },
  { value: 'REGISTER_NOW',       label: 'Register now' },
  { value: 'INTERESTED',         label: 'Interested' },
  { value: 'INQUIRE_NOW',        label: 'Inquire now' },
  // E-commerce
  { value: 'ORDER_NOW',          label: 'Order now' },
  { value: 'ADD_TO_CART',        label: 'Add to cart' },
  { value: 'PURCHASE_GIFT_CARDS',label: 'Purchase gift cards' },
  { value: 'VIEW_PRODUCT',       label: 'View product' },
  { value: 'BUY_TICKETS',        label: 'Buy tickets' },
  { value: 'GET_SHOWTIMES',      label: 'Get showtimes' },
  { value: 'GET_EVENT_TICKETS',  label: 'Get event tickets' },
  // Engagement
  { value: 'LIKE_PAGE',          label: 'Like page' },
  { value: 'FOLLOW_PAGE',        label: 'Follow page' },
  { value: 'MESSAGE_PAGE',       label: 'Message page' },
  { value: 'SAVE',               label: 'Save' },
  { value: 'WATCH_MORE',         label: 'Watch more' },
  { value: 'WATCH_VIDEO',        label: 'Watch video' },
  { value: 'LISTEN_NOW',         label: 'Listen now' },
  { value: 'LISTEN_MUSIC',       label: 'Listen music' },
  // Travel
  { value: 'BOOK_TRAVEL',        label: 'Book travel' },
  { value: 'GET_DIRECTIONS',     label: 'Get directions' },
  { value: 'CHECK_AVAILABILITY', label: 'Check availability' },
  // Donation
  { value: 'DONATE',             label: 'Donate' },
  { value: 'DONATE_NOW',         label: 'Donate now' },
  { value: 'RAISE_MONEY',        label: 'Raise money' },
  // App
  { value: 'INSTALL_APP',        label: 'Install app' },
  { value: 'USE_APP',            label: 'Use app' },
  { value: 'INSTALL_MOBILE_APP', label: 'Install mobile app' },
  { value: 'PLAY_GAME',          label: 'Play game' },
  // Misc
  { value: 'OPEN_LINK',          label: 'Open link' },
  { value: 'NO_BUTTON',          label: 'No button' },
];

/** Default CTA when none is set. Safest universal value across most objectives. */
export const DEFAULT_META_CTA = 'LEARN_MORE';

/**
 * Per-objective allowed CTAs. Mirrors the backend's CTAS_BY_OBJECTIVE.
 * Keep in sync with ad-set-constants.ts. First entry is the recommended default.
 *
 * These are filters for the dropdown — Meta has the final say at launch time.
 * If a CTA doesn't appear here for a given objective, it likely fails with
 * subcode 1346001 ("ad creative invalid for objective").
 */
export const CTAS_BY_OBJECTIVE: Record<CampaignObjective, string[]> = {
  OUTCOME_AWARENESS: [
    'LEARN_MORE', 'SEE_MORE', 'WATCH_MORE', 'WATCH_VIDEO',
    'LISTEN_NOW', 'LISTEN_MUSIC', 'NO_BUTTON',
  ],
  OUTCOME_TRAFFIC: [
    'LEARN_MORE', 'SHOP_NOW', 'SEE_MORE', 'DOWNLOAD',
    'GET_DIRECTIONS', 'BOOK_NOW', 'BOOK_TRAVEL', 'CHECK_AVAILABILITY',
    'WATCH_MORE', 'WATCH_VIDEO', 'LISTEN_NOW', 'OPEN_LINK',
    'GET_OFFER', 'GET_SHOWTIMES', 'GET_EVENT_TICKETS', 'BUY_TICKETS',
    'VIEW_PRODUCT',
  ],
  OUTCOME_ENGAGEMENT: [
    'LEARN_MORE', 'LIKE_PAGE', 'FOLLOW_PAGE', 'MESSAGE_PAGE',
    'SEND_MESSAGE', 'WHATSAPP_MESSAGE', 'INSTAGRAM_MESSAGE',
    'WATCH_VIDEO', 'WATCH_MORE', 'SAVE', 'NO_BUTTON',
  ],
  OUTCOME_LEADS: [
    'LEARN_MORE', 'SIGN_UP', 'SUBSCRIBE', 'GET_QUOTE', 'GET_A_QUOTE',
    'CONTACT_US', 'APPLY_NOW', 'BOOK_NOW', 'BOOK_A_CONSULTATION',
    'MAKE_AN_APPOINTMENT', 'REGISTER_NOW', 'REQUEST_TIME', 'DOWNLOAD',
    'INQUIRE_NOW', 'INTERESTED', 'ASK_FOR_MORE_INFO',
    'SEND_MESSAGE', 'WHATSAPP_MESSAGE', 'INSTAGRAM_MESSAGE', 'CALL_NOW',
  ],
  OUTCOME_APP_PROMOTION: [
    'INSTALL_APP', 'INSTALL_MOBILE_APP', 'USE_APP', 'PLAY_GAME',
    'DOWNLOAD', 'LEARN_MORE',
  ],
  OUTCOME_SALES: [
    'SHOP_NOW', 'BUY_NOW', 'ORDER_NOW', 'ADD_TO_CART', 'SUBSCRIBE',
    'GET_OFFER', 'BOOK_NOW', 'LEARN_MORE', 'SEE_MORE', 'VIEW_PRODUCT',
    'GET_QUOTE', 'GET_A_QUOTE', 'CONTACT_US',
    'SEND_MESSAGE', 'WHATSAPP_MESSAGE', 'INSTAGRAM_MESSAGE', 'CALL_NOW',
  ],
};

/**
 * Filter META_CTAS to only those allowed for a given objective. Pass `null`
 * (unknown objective, no campaign picked yet) to get the full list.
 */
export function ctasForObjective(
  objective: string | null | undefined
): Array<{ value: string; label: string }> {
  if (!objective) return META_CTAS;
  const allowed = CTAS_BY_OBJECTIVE[objective as CampaignObjective];
  if (!allowed) return META_CTAS;
  const allowedSet = new Set(allowed);
  // Preserve the META_CTAS display order but filter to the allowed set.
  return META_CTAS.filter((c) => allowedSet.has(c.value));
}

/**
 * The recommended default CTA for an objective. Falls back to LEARN_MORE when
 * the objective is unknown or has no entries.
 */
export function defaultCtaForObjective(
  objective: string | null | undefined
): string {
  if (!objective) return DEFAULT_META_CTA;
  const allowed = CTAS_BY_OBJECTIVE[objective as CampaignObjective];
  if (!allowed || allowed.length === 0) return DEFAULT_META_CTA;
  return allowed[0];
}

// ============================================================
// Audits (Patch 2.5b)
// ============================================================

export type AuditStatus = 'pending' | 'scanning' | 'scanned' | 'failed';
export type FixStatus =
  | 'pending'
  | 'queued'
  | 'fixing'
  | 'pending_publish'
  | 'fixed'
  | 'failed'
  | 'skipped';

export interface AuditRun {
  id: string;
  adAccountId: string;
  metaAdAccountId?: string | null;
  metaCampaignId: string;
  metaCampaignName: string | null;
  targetAdSetIds: string[];
  activeOnly: boolean;
  status: AuditStatus;
  errorMessage: string | null;
  adsTotal: number;
  adsScanned: number;
  findingsCount: number;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface AuditFinding {
  id: string;
  auditRunId: string;
  metaAdId: string;
  metaAdName: string | null;
  metaAdStatus: string | null;
  metaAdSetId: string | null;
  metaCreativeId: string;
  foundFeatures: Record<string, { enroll_status?: 'OPT_IN' | 'OPT_OUT' }>;
  foundMultiAd: 'OPT_IN' | 'OPT_OUT' | null;
  violations: string[];
  fixStatus: FixStatus;
  fixError: string | null;
  fixStartedAt: string | null;
  fixCompletedAt: string | null;
  /**
   * When fix_status='fixed', the new AdCreative ID that replaced the
   * original. The ad ID stayed the same; the underlying creative ID
   * changed because Meta disallows in-place enhancement edits.
   */
  newCreativeId: string | null;
  createdAt: string;
}

export interface AuditCreateSpec {
  adAccountId: string;
  metaCampaignId: string;
  metaCampaignName?: string;
  targetAdSetIds: string[];
  activeOnly: boolean;
}

/** Hard cap on ads per audit. Keep in sync with backend MAX_ADS_PER_AUDIT. */
export const MAX_ADS_PER_AUDIT = 2000;

export const audits = {
  list: () => api.get<{ runs: AuditRun[] }>('/audits'),
  create: (spec: AuditCreateSpec) =>
    api.post<{ runId: string }>('/audits', spec),
  get: (id: string) =>
    api.get<{ run: AuditRun; findings: AuditFinding[] }>(`/audits/${id}`),
  /**
   * Queue selected findings for fix.
   *
   * For per-finding granular control, pass `findings` with optional
   * `violationKeys` arrays (subset of each finding's violations).
   *
   * For "fix everything" mode, pass `findingIds` instead — all violations
   * recorded on each finding will be fixed.
   */
  fix: (
    id: string,
    selection:
      | { findingIds: string[] }
      | { findings: Array<{ id: string; violationKeys?: string[] }> }
  ) => api.post<{ queued: number }>(`/audits/${id}/fix`, selection),
  rescan: (id: string) =>
    api.post<{ rescanQueued: boolean }>(`/audits/${id}/rescan`, {}),
};

// ============================================================
// Comment Guard — rule-matched auto-hide moderation for ad comments
// ============================================================

export interface CommentRules {
  links?: boolean;
  phone?: boolean;
  profanity?: boolean;
  keywords?: string[];
}

export type CommentGuardStatus =
  | 'pending'
  | 'scanning'
  | 'active'
  | 'paused'
  | 'failed';

/**
 * A Page the signed-in user administers, from GET /comment-guards/pages.
 *
 * Sourced from Meta's /me/accounts, not from a local table — so there is no
 * local row id, only Meta's own Page id. (Before the organic split this came
 * from organic_connected_accounts and carried that row's `id` too.)
 */
export interface ConnectedPage {
  pageId: string;
  name: string | null;
}

export interface CommentGuard {
  id: string;
  adAccountId: string;
  metaCampaignId: string;
  metaCampaignName: string | null;
  targetAdSetIds: string[];
  targetPageIds: string[];
  activeOnly: boolean;
  rules: CommentRules;
  sweepIntervalMinutes: number;
  status: CommentGuardStatus;
  errorMessage: string | null;
  adsTotal: number;
  targetsTotal: number;
  commentsHidden: number;
  lastScannedAt: string | null;
  lastSweptAt: string | null;
  createdAt: string;
}

export interface CommentGuardTarget {
  id: string;
  metaAdId: string;
  metaAdName: string | null;
  metaAdStatus: string | null;
  metaAdSetId: string | null;
  pageId: string | null;
  postId: string | null;
  pageConnected: boolean;
  commentsHidden: number;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export interface CommentGuardAction {
  id: string;
  commentId: string;
  matchedRule: 'links' | 'phone' | 'profanity' | 'keyword';
  matchedDetail: string | null;
  commentMessage: string | null;
  authorName: string | null;
  permalinkUrl: string | null;
  hiddenAt: string;
  unhiddenAt: string | null;
}

export interface CommentGuardCreateSpec {
  adAccountId: string;
  metaCampaignId: string;
  metaCampaignName?: string;
  targetAdSetIds: string[];
  targetPageIds: string[];
  activeOnly: boolean;
  rules: CommentRules;
  sweepIntervalMinutes: number;
}

/** Allowed sweep intervals in minutes. Keep in sync with backend. */
export const COMMENT_GUARD_INTERVALS = [5, 15, 30, 60] as const;

export const commentGuards = {
  listPages: () => api.get<{ pages: ConnectedPage[] }>('/comment-guards/pages'),
  list: () => api.get<{ guards: CommentGuard[] }>('/comment-guards'),
  create: (spec: CommentGuardCreateSpec) =>
    api.post<{ guardId: string }>('/comment-guards', spec),
  get: (id: string) =>
    api.get<{
      guard: CommentGuard;
      targets: CommentGuardTarget[];
      actions: CommentGuardAction[];
    }>(`/comment-guards/${id}`),
  update: (
    id: string,
    patch: {
      rules?: CommentRules;
      sweepIntervalMinutes?: number;
      status?: 'active' | 'paused';
    }
  ) => api.patch<{ guard: CommentGuard }>(`/comment-guards/${id}`, patch),
  sweep: (id: string) =>
    api.post<{ sweepQueued: boolean }>(`/comment-guards/${id}/sweep`, {}),
  unhide: (id: string, actionId: string) =>
    api.post<{ unhidden: boolean }>(`/comment-guards/${id}/unhide`, { actionId }),
  remove: (id: string) =>
    api.delete<{ deleted: boolean }>(`/comment-guards/${id}`),
};

// ============================================================
// Sheet imports (Patch 4)
// ============================================================

/**
 * Vass fields that can be mapped to a sheet column. Ad set is NOT here —
 * Vass detects ad-set groupings from section-divider rows in the sheet,
 * not from a column.
 */
export type VassField =
  | 'creative'
  | 'mediaFormat'
  | 'primaryText'
  | 'headline'
  | 'description'
  | 'cta'
  | 'linkUrl'
  | 'adName';

export interface SheetRow {
  rowIndex: number;
  /** Derived server-side from section-divider rows; not mapped from a column. */
  adSetName: string;
  creative: string | null;
  primaryText: string | null;
  headline: string | null;
  description: string | null;
  cta: string | null;
  linkUrl: string | null;
  adName: string | null;
  mediaFormat: 'image' | 'video' | null;
}

export interface ParsedSheet {
  campaignLabel: string | null;
  rows: SheetRow[];
  warnings: string[];
}

export interface TabHeaderInfo {
  headerRowIdx: number;
  headers: string[];
  /** Per-column auto-detected field (null when unrecognized). */
  autoMap: Array<VassField | null>;
  /** True iff the required adSetName field was detected. */
  autoComplete: boolean;
  campaignLabel: string | null;
  approxDataRows: number;
  /** First ~15 raw rows for the user-facing preview grid. */
  preview: string[][];
}

export interface InspectedSource {
  tabs: string[];
  defaultTab: string;
  tabHeaders: Record<string, TabHeaderInfo>;
}

export interface ResolvedCreative {
  index: number;
  ok: boolean;
  uploadId?: string;
  kind?: 'image' | 'video' | 'document';
  widthPx?: number | null;
  heightPx?: number | null;
  aspectBucket?: string | null;
  error?: string;
}

/** Human labels for Vass fields. */
export const VASS_FIELD_LABELS: Record<VassField, string> = {
  creative: 'Creative',
  mediaFormat: 'Media format',
  primaryText: 'Primary text',
  headline: 'Headline',
  description: 'Description',
  cta: 'CTA',
  linkUrl: 'Link URL',
  adName: 'Ad name',
};

/** All Vass fields in the order we show them in the mapping UI. */
export const VASS_FIELDS_ORDERED: Array<{ key: VassField; required: boolean }> = [
  { key: 'creative',    required: false },
  { key: 'mediaFormat', required: false },
  { key: 'adName',      required: false },
  { key: 'primaryText', required: false },
  { key: 'headline',    required: false },
  { key: 'description', required: false },
  { key: 'cta',         required: false },
  { key: 'linkUrl',     required: false },
];

/**
 * Helpers that upload + send extra fields. The default api.upload only sends
 * a single file with no other fields, so we have a dedicated helper for the
 * multipart-with-tab-and-columnMap case.
 */
async function postFormFields<T>(
  path: string,
  fields: Record<string, string | File | undefined>
): Promise<T> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (typeof v === 'string') form.append(k, v);
    else form.append(k, v);
  }
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${path}`);
    xhr.withCredentials = true;
    xhr.addEventListener('load', () => {
      let parsed: any = null;
      try { parsed = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch { /* swallow */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(parsed as T);
      else reject(new ApiError(parsed?.error ?? `Request failed (${xhr.status})`, xhr.status));
    });
    xhr.addEventListener('error', () => reject(new ApiError('Network error', 0)));
    xhr.send(form);
  });
}

export const sheetImports = {
  inspectUrl: (sheetUrl: string) =>
    api.post<InspectedSource>('/sheet-imports/inspect', { sheetUrl }),
  inspectFile: (file: File) =>
    postFormFields<InspectedSource>('/sheet-imports/inspect', { file }),

  parseUrl: (
    sheetUrl: string,
    tab?: string,
    columnMap?: Partial<Record<number, VassField>>,
    headerRowIdx?: number
  ) =>
    api.post<ParsedSheet>('/sheet-imports/parse', {
      sheetUrl,
      tab,
      columnMap,
      headerRowIdx,
    }),
  parseFile: (
    file: File,
    tab?: string,
    columnMap?: Partial<Record<number, VassField>>,
    headerRowIdx?: number
  ) =>
    postFormFields<ParsedSheet>('/sheet-imports/parse', {
      file,
      tab,
      columnMap: columnMap ? JSON.stringify(columnMap) : undefined,
      headerRowIdx: headerRowIdx !== undefined ? String(headerRowIdx) : undefined,
    }),

  resolveCreatives: (creatives: string[]) =>
    api.post<{ results: ResolvedCreative[] }>('/sheet-imports/resolve-creatives', { creatives }),
};

// =====================================================================
// Branding — workspace logo upload (admin only)
// =====================================================================

export interface BrandingResp {
  /** A `data:image/png;base64,...` or `data:image/svg+xml;base64,...`
      string ready to drop into an <img src="...">. Null = no override,
      use the built-in <VassLogo /> mark. */
  logoDataUrl: string | null;
}

export const branding = {
  /** Public — works without auth (login page needs it). */
  get: () => api.get<BrandingResp>('/branding'),

  /** Admin only. Send the full data URL. */
  putLogo: (dataUrl: string) =>
    api.put<{ ok: true; sizeBytes: number }>('/branding/logo', { dataUrl }),

  /** Admin only. Reset to the default Vass mark. */
  deleteLogo: () => api.delete<{ ok: true }>('/branding/logo'),
};

// =====================================================================
// Team management — admin only
// =====================================================================

export interface TeamUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member' | 'viewer';
  avatarUrl: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface CreateTeamUserInput {
  email: string;
  name: string;
  role: 'admin' | 'member' | 'viewer';
  password: string;
}

export const team = {
  list: () => api.get<{ users: TeamUser[] }>('/team'),
  create: (input: CreateTeamUserInput) => api.post<{ user: TeamUser }>('/team', input),
  setRole: (id: string, role: 'admin' | 'member' | 'viewer') =>
    api.patch<{ user: TeamUser }>(`/team/${id}/role`, { role }),
  remove: (id: string) => api.delete<{ ok: true }>(`/team/${id}`),
};

// =====================================================================
// Organic publishing — connected accounts (Patch 4.22)
// =====================================================================

export type OrganicPlatform = 'facebook_page' | 'instagram' | 'threads' | 'tiktok' | 'linkedin';

export interface OrganicAccount {
  id: string;
  userId: string;
  platform: OrganicPlatform;
  externalId: string;
  brandId: string | null;
  tokenExpiresAt: string | null;
  scopes: string[];
  /** Platform-specific display data. */
  meta: {
    name?: string;
    username?: string;
    picture_url?: string | null;
    category?: string | null;
    followers_count?: number | null;
    linked_page_name?: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

export const organicAccounts = {
  list: () => api.get<{ accounts: OrganicAccount[] }>('/organic/accounts'),
  getOAuthUrl: (platform: OrganicPlatform) =>
    api.get<{ url: string }>(`/organic/accounts/oauth-url?platform=${platform}`),
  disconnect: (id: string) =>
    api.delete<{ ok: true }>(`/organic/accounts/${id}`),
  /** Threads uses its own OAuth endpoint (separate Meta App). */
  getThreadsOAuthUrl: () =>
    api.get<{ url: string }>(`/organic/threads/oauth-url`),
  /** TikTok uses its own OAuth endpoint (TikTok Login Kit). */
  getTikTokOAuthUrl: () =>
    api.get<{ url: string }>(`/organic/tiktok/oauth-url`),
  /** TikTok creator info — name/avatar + allowed privacy levels. Used
   *  by the composer to satisfy TikTok's mandatory pre-post UX. */
  getTikTokCreatorInfo: (accountId: string) =>
    api.get<{
      creatorUsername: string | null;
      creatorNickname: string | null;
      creatorAvatarUrl: string | null;
      privacyOptions: string[];
      commentDisabled: boolean;
      duetDisabled: boolean;
      stitchDisabled: boolean;
      maxVideoSeconds: number | null;
    }>(`/organic/tiktok/creator-info/${accountId}`),
  /** Quick-check whether an IG account is linked to a Threads profile. */
  threadsAutoLinkCheck: (igAccountId: string) =>
    api.get<{ threadsUserId: string | null; hasLinkedThreads: boolean }>(
      `/organic/threads/auto-link/${igAccountId}`
    ),
  /** LinkedIn uses its own OAuth endpoint. One authorization can connect
   *  the member's profile plus any company pages they administer. */
  getLinkedInOAuthUrl: () =>
    api.get<{ url: string }>(`/organic/linkedin/oauth-url`),
  /** LinkedIn company pages — separate Community Management app. */
  getLinkedInOrgOAuthUrl: () =>
    api.get<{ url: string }>(`/organic/linkedin-org/oauth-url`),
};

// =====================================================================
// Workspace Threads App credentials (Patch 4.34)
// =====================================================================

export interface ThreadsAppStatus {
  appId: string | null;
  hasSecret: boolean;
  redirectUri: string;
  hasCredentials: boolean;
}

export interface ThreadsAppInput {
  appId?: string;
  appSecret?: string;
  redirectUri?: string;
}

export const threadsApp = {
  get: () => api.get<ThreadsAppStatus>('/settings/threads-app'),
  save: (input: ThreadsAppInput) =>
    api.post<{ ok: true }>('/settings/threads-app', input),
};

export interface TikTokAppStatus {
  clientKey: string | null;
  hasSecret: boolean;
  redirectUri: string;
  hasCredentials: boolean;
}
export interface TikTokAppInput {
  clientKey?: string;
  clientSecret?: string;
  redirectUri?: string;
}
export const tiktokApp = {
  get: () => api.get<TikTokAppStatus>('/settings/tiktok-app'),
  save: (input: TikTokAppInput) =>
    api.post<{ ok: true }>('/settings/tiktok-app', input),
};

// =====================================================================
// Workspace LinkedIn App credentials (Patch 4.45.0)
// =====================================================================

export interface LinkedInAppStatus {
  clientId: string | null;
  hasSecret: boolean;
  redirectUri: string;
  hasCredentials: boolean;
}
export interface LinkedInAppInput {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}
export const linkedinApp = {
  get: () => api.get<LinkedInAppStatus>('/settings/linkedin-app'),
  save: (input: LinkedInAppInput) =>
    api.post<{ ok: true }>('/settings/linkedin-app', input),
};
/** Second LinkedIn app — Community Management API (company pages). Must be
 *  a separate developer app from the profile app per LinkedIn's rules. */
export const linkedinOrgApp = {
  get: () => api.get<LinkedInAppStatus>('/settings/linkedin-org-app'),
  save: (input: LinkedInAppInput) =>
    api.post<{ ok: true }>('/settings/linkedin-org-app', input),
};

// =====================================================================
// Brands — per-user groupings for organic social accounts (Patch 4.23)
// =====================================================================

export interface Brand {
  id: string;
  userId: string;
  name: string;
  color: string;
  sortOrder: number;
  /** First connected profile's picture URL for sidebar thumbnails.
      Null when the brand has no profiles. */
  thumbnailUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBrandInput {
  name: string;
  color?: string;
}

export interface UpdateBrandInput {
  name?: string;
  color?: string;
  sortOrder?: number;
}

export const brands = {
  list: () => api.get<{ brands: Brand[] }>('/brands'),
  create: (input: CreateBrandInput) =>
    api.post<{ brand: Brand }>('/brands', input),
  update: (id: string, input: UpdateBrandInput) =>
    api.patch<{ brand: Brand }>(`/brands/${id}`, input),
  delete: (id: string) => api.delete<{ ok: true }>(`/brands/${id}`),
  assignAccount: (accountId: string, brandId: string | null) =>
    api.post<{ ok: true }>('/brands/assign-account', { accountId, brandId }),
};

// =====================================================================
// Organic posts — Publisher (Patch 4.25, extended in 4.29 for scheduling)
// =====================================================================

export type OrganicPostStatus = 'draft' | 'scheduled' | 'publishing' | 'published' | 'partial' | 'failed' | 'cancelled';
export type OrganicTargetStatus = 'pending' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'skipped';

export interface OrganicPostTargetInput {
  accountId: string;
  bodyOverride?: string | null;
  /** Per-network media override. When set, replaces the shared media for
   *  this target only. */
  mediaItems?: OrganicPostMediaItem[];
  /** Per-target LinkedIn document title (when this target's media is a PDF). */
  documentTitle?: string | null;
}

export interface OrganicPostMediaItem {
  uploadId: string;
  kind: 'image' | 'video' | 'document';
}

export interface PublishPostInput {
  body: string;
  /** @deprecated use mediaItems instead. Single legacy image upload id. */
  uploadId?: string | null;
  /** Ordered media. All-image (1-10) OR single video. Empty = text-only. */
  mediaItems?: OrganicPostMediaItem[];
  brandId?: string | null;
  /** ISO 8601 datetime. When set + future, post is scheduled. */
  scheduledFor?: string | null;
  /** Optional first comment, posted after the main post succeeds. */
  firstComment?: string | null;
  /** IG collaborators — up to 3 usernames. Silently dropped for FB
   *  targets since Meta doesn't expose collab invites for Pages. */
  collaborators?: string[] | null;
  /** Optional cover image for video posts (Reels). Upload ID of an
   *  image. IG applies via cover_url at container creation; FB applies
   *  post-publish (best-effort, swallowed on failure). */
  coverUploadId?: string | null;
  /** Threads-only: topic tag on the head post. Max 50 chars, no
   *  periods/ampersands/whitespace. Silently dropped by FB/IG. */
  topicTag?: string | null;
  /** LinkedIn-only: title for a PDF document post (max 100 chars).
   *  Required when a document is attached. */
  documentTitle?: string | null;
  /** Threads-only: up to 4 reply posts. Each entry has its own body
   *  (max 500 chars) and (optional) media. FB/IG drop the chain
   *  silently. */
  replyChain?: { body: string; mediaItems?: OrganicPostMediaItem[] }[];
  targets: OrganicPostTargetInput[];
  /** Patch 4.37.0: when true, the server saves with status='draft',
   *  skips schedule/publish, allows empty targets and empty body. */
  asDraft?: boolean;
}

export interface PublishPostResult {
  postId: string;
  status: OrganicPostStatus;
  /** Present on publish-now path. */
  succeeded?: number;
  failed?: number;
  /** Present on scheduled path. */
  scheduledFor?: string;
}

export interface OrganicPostSummary {
  id: string;
  brandId: string | null;
  body: string;
  uploadId: string | null;
  status: OrganicPostStatus;
  scheduledFor: string | null;
  publishedAt: string | null;
  createdAt: string;
  targetsTotal: number;
  targetsPublished: number;
  targetsFailed: number;
  platforms: OrganicPlatform[];
  /** Threads only — surfaces on the Pipeline card. */
  topicTag: string | null;
  /** Threads only — 0 = no reply chain; head + N replies = N. */
  replyChainLength: number;
}

export interface OrganicPostTarget {
  id: string;
  accountId: string;
  platform: OrganicPlatform;
  bodyOverride: string | null;
  status: OrganicTargetStatus;
  externalPostId: string | null;
  externalPostUrl: string | null;
  errorMessage: string | null;
  errorCode: string | null;
  publishedAt: string | null;
  account: {
    name: string | null;
    username: string | null;
    pictureUrl: string | null;
  };
}

export interface OrganicPostMediaRow {
  id: string;
  uploadId: string;
  kind: 'image' | 'video' | 'document';
  sortOrder: number;
  replyIndex: number;
  contentType: string | null;
  widthPx: number | null;
  heightPx: number | null;
}

export interface OrganicPostDetail {
  post: {
    id: string;
    brandId: string | null;
    body: string;
    uploadId: string | null;
    status: OrganicPostStatus;
    scheduledFor: string | null;
    publishedAt: string | null;
    createdAt: string;
    firstComment: string | null;
    collaborators: string[];
    coverUploadId: string | null;
    topicTag: string | null;
    documentTitle: string | null;
    replyChain: { body: string }[];
  };
  media: OrganicPostMediaRow[];
  targets: OrganicPostTarget[];
}

export const organicPosts = {
  publish: (input: PublishPostInput) =>
    api.post<PublishPostResult>('/organic/posts', input),
  /** Patch 4.37.0: update an existing draft in place. Patch 4.41.0:
   *  also edits a SCHEDULED post in place (asDraft=false + scheduledFor),
   *  re-queuing its publish job. Returns the resulting status and, for
   *  scheduled edits, the (re-queued) scheduledFor. */
  update: (id: string, input: PublishPostInput) =>
    api.patch<{ postId: string; status: 'draft' | 'scheduled'; scheduledFor?: string | null }>(
      `/organic/posts/${id}`,
      input
    ),
  /** Patch 4.37.0: delete a draft. Server enforces status='draft'. */
  delete: (id: string) =>
    api.delete<{ ok: true }>(`/organic/posts/${id}`),
  list: () => api.get<{ posts: OrganicPostSummary[] }>('/organic/posts'),
  get: (id: string) => api.get<OrganicPostDetail>(`/organic/posts/${id}`),
  cancelSchedule: (id: string) =>
    api.delete<{ ok: true }>(`/organic/posts/${id}/schedule`),
  reschedule: (id: string, scheduledFor: string) =>
    api.patch<{ ok: true; scheduledFor: string }>(`/organic/posts/${id}/schedule`, { scheduledFor }),
};

// =====================================================================
// Drafts (Patch 4.37.0)
// =====================================================================

export interface OrganicDraft {
  id: string;
  brandId: string | null;
  body: string;
  topicTag: string | null;
  documentTitle: string | null;
  mediaUploadId: string | null;
  mediaKind: 'image' | 'video' | 'document' | null;
  platforms: OrganicPlatform[];
  /** Patch 4.37.0.1: account IDs this draft targets. Empty when the
   *  user saved without selecting any targets. */
  accountIds: string[];
  targetCount: number;
  createdAt: string;
  updatedAt: string;
}

export const organicDrafts = {
  /** Brand-scoped list of drafts. Pass brandId=null/undefined to list
   *  all of the user's drafts regardless of brand. Optionally filter
   *  to drafts that target at least one of the provided accountIds. */
  list: (brandId?: string | null, accountIds?: string[]) => {
    const qs = new URLSearchParams();
    if (brandId) qs.set('brandId', brandId);
    if (accountIds && accountIds.length > 0) {
      qs.set('accountIds', accountIds.join(','));
    }
    const suffix = qs.toString();
    return api.get<{ drafts: OrganicDraft[] }>(
      `/organic/drafts${suffix ? `?${suffix}` : ''}`
    );
  },
};

// =====================================================================
// Organic analytics (Patch 4.57)
// =====================================================================

export interface InsightMetricSet {
  impressions: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  clicks: number | null;
  saves: number | null;
  video_views: number | null;
  engagement: number | null;
  extra: Record<string, unknown>;
}

export interface AnalyticsPost {
  targetId: string;
  postId: string;
  accountId: string;
  platform: OrganicPlatform;
  publishedAt: string | null;
  body: string;
  metrics: InsightMetricSet;
}

export interface AnalyticsTotals {
  impressions: number;
  reach: number;
  likes: number;
  comments: number;
  shares: number;
  clicks: number;
  saves: number;
  videoViews: number;
  engagement: number;
}

export interface AnalyticsResponse {
  from: string;
  to: string;
  platform: string;
  postCount: number;
  totals: AnalyticsTotals;
  posts: AnalyticsPost[];
  /** Per-platform availability — false means a scope add or approval is needed. */
  availability: Record<string, { available: boolean; reason?: string }>;
}

export const organicAnalytics = {
  /** Aggregate analytics across a brand + account filter for a date range.
   *  Pass from/to as ISO date strings (default: last 7 days). Optional
   *  platform filter ('facebook_page'|'instagram'|'threads'|...). refresh=true
   *  forces a re-pull of even older posts. */
  get: (opts?: {
    brandId?: string | null;
    accountIds?: string[];
    from?: string;
    to?: string;
    platform?: string | null;
    refresh?: boolean;
  }) => {
    const qs = new URLSearchParams();
    if (opts?.brandId) qs.set('brandId', opts.brandId);
    if (opts?.accountIds && opts.accountIds.length > 0) {
      qs.set('accountIds', opts.accountIds.join(','));
    }
    if (opts?.from) qs.set('from', opts.from);
    if (opts?.to) qs.set('to', opts.to);
    if (opts?.platform && opts.platform !== 'all') qs.set('platform', opts.platform);
    if (opts?.refresh) qs.set('refresh', '1');
    const suffix = qs.toString();
    return api.get<AnalyticsResponse>(
      `/organic/analytics${suffix ? `?${suffix}` : ''}`
    );
  },
};

// =====================================================================
// Unified calendar (Patch 4.35)
//
// Returns Vass-tracked posts + posts pulled from Meta/Threads APIs by
// the hourly sync, merged and deduplicated. Used by the Pipeline view.
// =====================================================================

export type CalendarPostStatus =
  | 'scheduled'
  | 'publishing'
  | 'published'
  | 'partial'
  | 'failed'
  | 'cancelled';

export interface CalendarPost {
  /** Stable id within (source) — different ID spaces between 'vass'
   *  and 'synced'. The combination (source, id) is globally unique. */
  id: string;
  source: 'vass' | 'synced';
  status: CalendarPostStatus;
  brandId: string | null;
  body: string | null;
  /** ISO timestamp — scheduled_for for future Vass posts, published_at
   *  or posted_at for past. Calendar groups/sorts by this. */
  timestamp: string;
  /** For thumbnails. Either a Meta CDN URL ('https://...') OR
   *  'vass-upload:<uploadId>' which the client renders via uploads.fileUrl. */
  mediaUrl: string | null;
  mediaType: string | null;
  platforms: OrganicPlatform[];
  accountIds: string[];
  /** Click-through. Only present for 'published' posts. */
  permalink: string | null;
  topicTag: string | null;
  replyChainLength: number;
}

export interface LoadOlderInput {
  accountIds: string[];
  untilDate: string; // ISO
}

export const organicCalendar = {
  /** Get the merged + deduped calendar for a date range. */
  get: (params: {
    from: string;
    to: string;
    brandId?: string | null;
    accountIds?: string[];
    /** Which status buckets to include. Defaults to both on the server. */
    statuses?: Array<'scheduled' | 'published'>;
  }) => {
    const qs = new URLSearchParams({ from: params.from, to: params.to });
    if (params.brandId) qs.set('brandId', params.brandId);
    if (params.accountIds && params.accountIds.length > 0) {
      qs.set('accountIds', params.accountIds.join(','));
    }
    if (params.statuses && params.statuses.length > 0) {
      qs.set('statuses', params.statuses.join(','));
    }
    return api.get<{ posts: CalendarPost[] }>(`/organic/calendar?${qs.toString()}`);
  },
  /** Enqueue an on-demand backfill of older history (beyond the rolling
   *  90-day cron window). Returns once jobs are queued; the client should
   *  re-fetch the calendar after a few seconds. */
  loadOlder: (input: LoadOlderInput) =>
    api.post<{ ok: true; queued: number }>('/organic/calendar/load-older', input),
  /** Force a synchronous sync for a single account. Returns when complete.
   *  Used by the Pipeline's manual refresh button — gated to one account
   *  at a time because a sync can take 5–30 seconds against Meta. */
  refresh: (input: { accountId: string }) =>
    api.post<{ ok: boolean; fetched: number; upserted: number; pagesWalked: number; error: string | null }>(
      '/organic/calendar/refresh',
      input
    ),
};

// (Place search client removed in 4.32.5 — /pages/search now requires
//  Page Public Metadata Access app-review feature, which we don't have.)

// =====================================================================
// Brand hashtags (Patch 4.29)
// =====================================================================

export interface BrandHashtag {
  id: string;
  brandId: string;
  tag: string;
  sortOrder: number;
  createdAt: string;
}

export const brandHashtags = {
  list: (brandId: string) =>
    api.get<{ hashtags: BrandHashtag[] }>(`/brands/${brandId}/hashtags`),
  replace: (brandId: string, tags: string[]) =>
    api.put<{ hashtags: BrandHashtag[] }>(`/brands/${brandId}/hashtags`, { tags }),
};

// =====================================================================
// Ideas + folders (Patch 4.37.1)
// =====================================================================

export interface OrganicIdeaFolder {
  id: string;
  brandId: string;
  name: string;
  color: string | null;
  emoji: string | null;
  ideaCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrganicIdea {
  id: string;
  brandId: string | null;
  accountId: string | null;
  folderId: string | null;
  title: string | null;
  body: string;
  uploadId: string | null;
  mediaKind: 'image' | 'video' | 'document' | null;
  linkUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IdeaCreateInput {
  /** Either brandId or accountId (or both) is required. When accountId
   *  is provided without brandId, the server auto-fills brandId from
   *  the account's parent brand. */
  brandId?: string | null;
  accountId?: string | null;
  folderId?: string | null;
  title?: string | null;
  body?: string;
  uploadId?: string | null;
  mediaKind?: 'image' | 'video' | 'document' | null;
  linkUrl?: string | null;
}

/** All fields optional. Only keys that appear in the payload are
 *  applied; missing keys leave the existing value untouched. To clear
 *  a field, pass `null` explicitly. */
export type IdeaUpdateInput = Partial<IdeaCreateInput>;

export interface FolderCreateInput {
  brandId: string;
  name: string;
  color?: string | null;
  emoji?: string | null;
}
export interface FolderUpdateInput {
  name?: string;
  color?: string | null;
  emoji?: string | null;
}

export const organicIdeaFolders = {
  list: (brandId?: string | null) => {
    const qs = brandId ? `?brandId=${encodeURIComponent(brandId)}` : '';
    return api.get<{ folders: OrganicIdeaFolder[] }>(`/organic/idea-folders${qs}`);
  },
  create: (input: FolderCreateInput) =>
    api.post<{ folder: OrganicIdeaFolder }>('/organic/idea-folders', input),
  update: (id: string, input: FolderUpdateInput) =>
    api.patch<{ folder: OrganicIdeaFolder }>(`/organic/idea-folders/${id}`, input),
  delete: (id: string) =>
    api.delete<{ ok: true }>(`/organic/idea-folders/${id}`),
};

/** List filter accepts arrays of brandIds and/or accountIds. When both
 *  are provided, the API returns the UNION (ideas matching any). Brand
 *  scope includes profile-tied ideas whose account belongs to the brand. */
export interface IdeasListFilter {
  brandIds?: string[];
  accountIds?: string[];
  folderId?: string | null;
}

export const organicIdeas = {
  /** Pass folderId='__unfiled__' to list only ideas with no folder. */
  list: (filter: IdeasListFilter = {}) => {
    const qs = new URLSearchParams();
    if (filter.brandIds && filter.brandIds.length) {
      qs.set('brandIds', filter.brandIds.join(','));
    }
    if (filter.accountIds && filter.accountIds.length) {
      qs.set('accountIds', filter.accountIds.join(','));
    }
    if (filter.folderId) qs.set('folderId', filter.folderId);
    const suffix = qs.toString();
    return api.get<{ ideas: OrganicIdea[] }>(
      `/organic/ideas${suffix ? `?${suffix}` : ''}`
    );
  },
  create: (input: IdeaCreateInput) =>
    api.post<{ idea: OrganicIdea }>('/organic/ideas', input),
  update: (id: string, input: IdeaUpdateInput) =>
    api.patch<{ idea: OrganicIdea }>(`/organic/ideas/${id}`, input),
  delete: (id: string) =>
    api.delete<{ ok: true }>(`/organic/ideas/${id}`),
};

// ============================================================
// Notifications — top-bar bell
// ============================================================

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error';

export interface AppNotification {
  id: string;
  type: string;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  link: string | null;
  metadata: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export const notifications = {
  list: () =>
    api.get<{ notifications: AppNotification[]; unreadCount: number }>('/notifications'),
  /** Mark specific ids read, or all when omitted. */
  markRead: (ids?: string[]) =>
    api.post<{ updated: number }>('/notifications/read', ids ? { ids } : {}),
  clearAll: () => api.delete<{ deleted: number }>('/notifications'),
};
