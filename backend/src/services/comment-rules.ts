/**
 * Comment Guard — rule engine.
 *
 * Pure functions (no I/O) so they're trivially unit-testable. Given a comment's
 * text and a guard's rule config, decide whether the comment should be hidden
 * and why.
 *
 * Rules (all opt-in via CommentRules):
 *   - links     : comment contains a URL / web address
 *   - phone     : comment contains a phone-number-like string (common spam)
 *   - profanity : comment contains a word from the built-in profanity list
 *   - keywords  : comment contains any user-supplied keyword (word-boundary,
 *                 case-insensitive)
 *
 * Matching order is fixed (links → phone → profanity → keyword) so the logged
 * `matched_rule` is deterministic when several would match.
 */

export interface CommentRules {
  links?: boolean;
  phone?: boolean;
  profanity?: boolean;
  keywords?: string[];
}

export type MatchedRule = 'links' | 'phone' | 'profanity' | 'keyword';

export interface RuleMatch {
  rule: MatchedRule;
  /** The concrete thing that matched — the keyword, the URL, the profane word. */
  detail: string;
}

/** The defaults a brand-new guard ships with: links + phone + profanity ON. */
export const DEFAULT_RULES: CommentRules = {
  links: true,
  phone: true,
  profanity: true,
  keywords: [],
};

// A URL / domain. Matches http(s)://…, www.…, and bare domains like "foo.com/bar".
// Deliberately broad — link-spam is the #1 thing advertisers want gone.
const LINK_RE =
  /\b((https?:\/\/|www\.)[^\s]+|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:com|net|org|io|co|xyz|info|biz|ru|link|live|shop|store|online|site|app|me|tv|to|cc|ly|gg|vip|win|bet)\b(?:\/[^\s]*)?)/i;

// Phone-number-ish: 7+ digits allowing spaces, dashes, dots, parens, and a
// leading +. Catches "+1 (555) 123-4567", "0044 7911 123456", "555.123.4567".
const PHONE_RE = /(?:\+?\d[\d\s().-]{6,}\d)/;

// Small built-in profanity list. Intentionally conservative — the goal is
// obvious slurs/abuse, not aggressive censorship (false positives can be
// reviewed + unhidden). Extend as needed; kept lowercase, matched on word
// boundaries so "assist" won't trip "ass".
const PROFANITY = [
  'fuck',
  'shit',
  'bitch',
  'bastard',
  'asshole',
  'dick',
  'cunt',
  'slut',
  'whore',
  'nigger',
  'faggot',
  'retard',
  'scam',
  'scammer',
  'fraud',
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build a case-insensitive, unicode-aware word-boundary matcher for a term. */
function wordRe(term: string): RegExp {
  // \b doesn't play well with unicode/emoji, so we anchor on non-word chars
  // or string edges around the term.
  const t = escapeRegExp(term.trim());
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])(${t})(?:[^\\p{L}\\p{N}]|$)`, 'iu');
}

/**
 * Evaluate one comment against the rules. Returns the first matching rule, or
 * null if nothing matched. An empty / missing message never matches.
 */
export function matchComment(
  message: string | null | undefined,
  rules: CommentRules
): RuleMatch | null {
  const text = (message ?? '').trim();
  if (!text) return null;

  if (rules.links) {
    const m = text.match(LINK_RE);
    if (m) return { rule: 'links', detail: m[0].slice(0, 200) };
  }

  if (rules.phone) {
    const m = text.match(PHONE_RE);
    if (m) return { rule: 'phone', detail: m[0].trim().slice(0, 60) };
  }

  if (rules.profanity) {
    for (const word of PROFANITY) {
      if (wordRe(word).test(text)) {
        return { rule: 'profanity', detail: word };
      }
    }
  }

  if (rules.keywords && rules.keywords.length > 0) {
    for (const kw of rules.keywords) {
      const term = kw.trim();
      if (!term) continue;
      if (wordRe(term).test(text)) {
        return { rule: 'keyword', detail: term.slice(0, 100) };
      }
    }
  }

  return null;
}

/**
 * Normalize / validate a rules object coming from the API. Drops unknown keys,
 * coerces types, trims + de-dupes + caps keywords. Never throws.
 */
export function normalizeRules(input: unknown): CommentRules {
  const raw = (input ?? {}) as Record<string, unknown>;
  const keywords = Array.isArray(raw.keywords)
    ? Array.from(
        new Set(
          raw.keywords
            .filter((k): k is string => typeof k === 'string')
            .map((k) => k.trim().toLowerCase())
            .filter((k) => k.length > 0 && k.length <= 100)
        )
      ).slice(0, 200)
    : [];

  return {
    links: raw.links === undefined ? DEFAULT_RULES.links : !!raw.links,
    phone: raw.phone === undefined ? DEFAULT_RULES.phone : !!raw.phone,
    profanity: raw.profanity === undefined ? DEFAULT_RULES.profanity : !!raw.profanity,
    keywords,
  };
}

/** True if at least one rule is active — a guard with no active rules is useless. */
export function hasAnyRule(rules: CommentRules): boolean {
  return !!(
    rules.links ||
    rules.phone ||
    rules.profanity ||
    (rules.keywords && rules.keywords.length > 0)
  );
}
