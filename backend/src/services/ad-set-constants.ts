/**
 * Meta campaign objective → optimization goal mapping.
 *
 * Meta enforces which optimization goals are valid for each campaign objective.
 * For example, an OUTCOME_SALES campaign allows OFFSITE_CONVERSIONS but not
 * REACH; an OUTCOME_AWARENESS campaign allows REACH but not LEAD_GENERATION.
 *
 * This file encodes those rules so the ad-set form can show only valid options.
 * Source: Meta Marketing API docs. Last verified: Nov 2024 (ODAX objectives).
 *
 * If Meta adds a new optimization goal you want to expose, add it here.
 * If a goal doesn't appear in any objective's list, the dropdown won't include it.
 */

/** Top-level Meta campaign objectives (ODAX naming, post-2022). */
export type CampaignObjective =
  | 'OUTCOME_AWARENESS'
  | 'OUTCOME_TRAFFIC'
  | 'OUTCOME_ENGAGEMENT'
  | 'OUTCOME_LEADS'
  | 'OUTCOME_APP_PROMOTION'
  | 'OUTCOME_SALES';

/**
 * Which optimization goals are allowed per objective.
 *
 * IMPORTANT: This map enforces Meta's actual rules — not a permissive
 * superset. Sending an invalid goal returns a confusing 400 from Meta.
 * Notably:
 *   - IMPRESSIONS, REACH, AD_RECALL_LIFT are AWARENESS-only
 *   - VALUE requires a value-eligible pixel (SALES/APP_PROMOTION only)
 *   - LEAD_GENERATION is for instant-form leads (LEADS objective)
 *
 * The first goal in each array is the recommended default.
 */
export const OPTIMIZATION_GOALS_BY_OBJECTIVE: Record<CampaignObjective, string[]> = {
  OUTCOME_AWARENESS: [
    'REACH',
    'IMPRESSIONS',
    'AD_RECALL_LIFT',
    'THRUPLAY',
  ],
  OUTCOME_TRAFFIC: [
    'LINK_CLICKS',
    'LANDING_PAGE_VIEWS',
    'QUALITY_CALL',
  ],
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

/**
 * Human-readable labels for optimization goals.
 * Matches the labels Meta Ads Manager uses in the UI.
 */
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
 * Which billing events Meta allows for each optimization goal.
 * Meta returns errors if you pick an invalid combo. Default is the first
 * entry; users won't typically need to override.
 */
export const BILLING_EVENTS_BY_GOAL: Record<string, string[]> = {
  REACH: ['IMPRESSIONS'],
  IMPRESSIONS: ['IMPRESSIONS'],
  AD_RECALL_LIFT: ['IMPRESSIONS'],
  THRUPLAY: ['IMPRESSIONS', 'THRUPLAY'],
  LINK_CLICKS: ['IMPRESSIONS', 'LINK_CLICKS'],
  LANDING_PAGE_VIEWS: ['IMPRESSIONS'],
  QUALITY_CALL: ['IMPRESSIONS'],
  POST_ENGAGEMENT: ['IMPRESSIONS', 'POST_ENGAGEMENT'],
  CONVERSATIONS: ['IMPRESSIONS'],
  REPLIES: ['IMPRESSIONS'],
  PAGE_LIKES: ['IMPRESSIONS'],
  EVENT_RESPONSES: ['IMPRESSIONS'],
  LEAD_GENERATION: ['IMPRESSIONS'],
  QUALITY_LEAD: ['IMPRESSIONS'],
  OFFSITE_CONVERSIONS: ['IMPRESSIONS'],
  APP_INSTALLS: ['IMPRESSIONS', 'APP_INSTALLS'],
  VALUE: ['IMPRESSIONS'],
};

/** Which optimization goals require a pixel + custom_event_type promoted_object. */
export const GOALS_REQUIRING_PIXEL = new Set([
  'OFFSITE_CONVERSIONS',
  'VALUE',
]);

/** Which optimization goals require a page_id promoted_object. */
export const GOALS_REQUIRING_PAGE = new Set([
  'PAGE_LIKES',
  'EVENT_RESPONSES',
  'CONVERSATIONS',
  'REPLIES',
]);

/**
 * Which call-to-action types are commonly accepted for each ODAX objective.
 *
 * Meta does NOT publish a single authoritative table for this — the validation
 * runs server-side at ad-creative create time and surfaces with subcode 1346001
 * when a CTA is incompatible with the chosen objective + ad set destination
 * type. The lists here are the safe / commonly-accepted CTAs per objective,
 * sourced from Meta Marketing API docs and the error messages they return.
 *
 * The first value in each array is the recommended default for that objective.
 *
 * If a user picks an unlisted CTA, Vass will let them — Meta has the final say
 * at launch time. These lists are filters / hints, not a hard whitelist.
 */
export const CTAS_BY_OBJECTIVE: Record<CampaignObjective, string[]> = {
  OUTCOME_AWARENESS: [
    'LEARN_MORE',
    'SEE_MORE',
    'WATCH_MORE',
    'WATCH_VIDEO',
    'LISTEN_NOW',
    'LISTEN_MUSIC',
    'NO_BUTTON',
  ],
  OUTCOME_TRAFFIC: [
    'LEARN_MORE',
    'SHOP_NOW',
    'SEE_MORE',
    'DOWNLOAD',
    'GET_DIRECTIONS',
    'BOOK_NOW',
    'BOOK_TRAVEL',
    'CHECK_AVAILABILITY',
    'WATCH_MORE',
    'WATCH_VIDEO',
    'LISTEN_NOW',
    'OPEN_LINK',
    'GET_OFFER',
    'GET_SHOWTIMES',
    'GET_EVENT_TICKETS',
    'BUY_TICKETS',
    'VIEW_PRODUCT',
  ],
  OUTCOME_ENGAGEMENT: [
    'LEARN_MORE',
    'LIKE_PAGE',
    'FOLLOW_PAGE',
    'MESSAGE_PAGE',
    'SEND_MESSAGE',
    'WHATSAPP_MESSAGE',
    'INSTAGRAM_MESSAGE',
    'WATCH_VIDEO',
    'WATCH_MORE',
    'SAVE',
    'NO_BUTTON',
  ],
  OUTCOME_LEADS: [
    'LEARN_MORE',
    'SIGN_UP',
    'SUBSCRIBE',
    'GET_QUOTE',
    'GET_A_QUOTE',
    'CONTACT_US',
    'APPLY_NOW',
    'BOOK_NOW',
    'BOOK_A_CONSULTATION',
    'MAKE_AN_APPOINTMENT',
    'REGISTER_NOW',
    'REQUEST_TIME',
    'DOWNLOAD',
    'INQUIRE_NOW',
    'INTERESTED',
    'ASK_FOR_MORE_INFO',
    'SEND_MESSAGE',
    'WHATSAPP_MESSAGE',
    'INSTAGRAM_MESSAGE',
    'CALL_NOW',
  ],
  OUTCOME_APP_PROMOTION: [
    'INSTALL_APP',
    'INSTALL_MOBILE_APP',
    'USE_APP',
    'PLAY_GAME',
    'DOWNLOAD',
    'LEARN_MORE',
  ],
  OUTCOME_SALES: [
    'SHOP_NOW',
    'BUY_NOW',
    'ORDER_NOW',
    'ADD_TO_CART',
    'SUBSCRIBE',
    'GET_OFFER',
    'BOOK_NOW',
    'LEARN_MORE',
    'SEE_MORE',
    'VIEW_PRODUCT',
    'GET_QUOTE',
    'GET_A_QUOTE',
    'CONTACT_US',
    'SEND_MESSAGE',
    'WHATSAPP_MESSAGE',
    'INSTAGRAM_MESSAGE',
    'CALL_NOW',
  ],
};
