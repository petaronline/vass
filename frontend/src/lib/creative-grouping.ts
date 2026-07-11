/**
 * Auto-grouping for placement-aware creatives (Patch 3.2).
 *
 * Given a list of uploads, pair files whose filename stems match (after
 * stripping ratio-suffix conventions). Each group of 1+ uploads becomes
 * one ad with placements determined by its assets' aspect buckets.
 *
 * Example:
 *   ad_1_4_5.jpg   →  stem "ad_1", bucket 4_5
 *   ad_1_9_16.jpg  →  stem "ad_1", bucket 9_16  →  GROUPED with above
 *   ad_2_4_5.jpg   →  stem "ad_2", bucket 4_5   →  alone
 *   ad_3_9_16.jpg  →  stem "ad_3", bucket 9_16  →  alone
 *   IMG_1234.jpg   →  stem "IMG_1234" (no suffix to strip)  →  alone
 *
 * Recognized ratio suffixes (case-insensitive, trailing on filename minus
 * extension):
 *   _1_1, _4_5, _9_16, _1x1, _4x5, _9x16,
 *   _square, _portrait, _story, _reel, _vertical, _horizontal
 */
import type { Upload, AspectBucket } from './api';

const RATIO_SUFFIX_RX =
  /[_-](1[_x]?1|4[_x]?5|9[_x]?16|square|portrait|story|reel|reels|vertical|horizontal)$/i;

/**
 * Strip a trailing ratio suffix from a filename stem (already without ext).
 * Returns the stripped stem; if nothing matched, returns the input unchanged.
 */
export function stripRatioSuffix(stemWithoutExt: string): string {
  const m = stemWithoutExt.match(RATIO_SUFFIX_RX);
  if (!m) return stemWithoutExt;
  return stemWithoutExt.slice(0, m.index).replace(/[_-]+$/, '');
}

/** Get the "groupable stem" for an upload — filename minus extension, minus ratio suffix. */
export function uploadStem(upload: Upload): string {
  const noExt = upload.filename.replace(/\.[^.]+$/, '');
  return stripRatioSuffix(noExt) || noExt;
}

export interface CreativeGroup {
  /** Stable client-side ID for React keys + drag-drop. */
  id: string;
  /** Suggested display name for the creative (derived from stem). */
  name: string;
  /** Uploads in this group (1+). */
  uploads: Upload[];
}

/**
 * Auto-group uploads by stem + bucket conflict.
 *
 * Rules:
 *   - Same stem → same group, UNLESS adding would conflict with an existing
 *     bucket already in the group (e.g. you already have a 4:5, you can't
 *     add another 4:5 — Meta only takes one asset per placement).
 *   - When conflict, the second file with the same bucket starts a new group.
 *   - "other" bucket and no-bucket assets go into their own groups (they
 *     don't pair predictably).
 */
export function autoGroupUploads(uploads: Upload[]): CreativeGroup[] {
  const groupsByStem = new Map<string, CreativeGroup[]>();
  let groupIdCounter = 0;

  for (const u of uploads) {
    const stem = uploadStem(u);
    const bucket = u.aspectBucket;

    // Non-paireable: 'other' or null bucket → standalone group, never matched
    if (bucket === null || bucket === 'other') {
      const g: CreativeGroup = {
        id: `g_${++groupIdCounter}`,
        name: stem,
        uploads: [u],
      };
      const existing = groupsByStem.get(stem) ?? [];
      existing.push(g);
      groupsByStem.set(stem, existing);
      continue;
    }

    // Try to find an existing group with this stem that doesn't already
    // have something in this bucket.
    const candidates = groupsByStem.get(stem) ?? [];
    let placed = false;
    for (const g of candidates) {
      const bucketAlreadyUsed = g.uploads.some(
        (existing) => existing.aspectBucket === bucket
      );
      if (!bucketAlreadyUsed) {
        g.uploads.push(u);
        placed = true;
        break;
      }
    }
    if (!placed) {
      const g: CreativeGroup = {
        id: `g_${++groupIdCounter}`,
        name: stem,
        uploads: [u],
      };
      candidates.push(g);
      groupsByStem.set(stem, candidates);
    }
  }

  // Flatten back into an ordered array (preserve upload order roughly)
  const all: CreativeGroup[] = [];
  for (const arr of groupsByStem.values()) {
    for (const g of arr) all.push(g);
  }
  return all;
}

/**
 * Compute the placements a creative group will target.
 * Returns a human-friendly short label like "Feed + Stories/Reels".
 */
export function summarizePlacements(group: CreativeGroup): string {
  const buckets = new Set(group.uploads.map((u) => u.aspectBucket));
  const hasFeed = buckets.has('1_1') || buckets.has('4_5');
  const hasStory = buckets.has('9_16');
  const hasOther = buckets.has('other') || buckets.has(null as unknown as AspectBucket);

  if (hasFeed && hasStory) return 'Feed + Stories/Reels';
  if (hasFeed) return 'Feed (auto-cropped for Stories/Reels)';
  if (hasStory) return 'Stories/Reels only';
  if (hasOther) return 'Custom — placements may need review';
  return '—';
}

/** A short text badge for an aspect bucket. */
export function aspectBadge(bucket: AspectBucket | null): string {
  switch (bucket) {
    case '1_1': return '1:1';
    case '4_5': return '4:5';
    case '9_16': return '9:16';
    case 'other': return 'other';
    case null:
    default:
      return '?';
  }
}
