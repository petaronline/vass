/**
 * Aspect detection + ad-pairing for the Bulk Launch tool.
 *
 * Approach (Patch 4.21+):
 *   - **Aspect is decided by the file's actual width/height**, NOT its
 *     filename. We probe each file client-side (HTMLImageElement for
 *     images, HTMLVideoElement for videos) before adding it to the page.
 *   - **Pairing** still happens by filename stem — but the stem is first
 *     stripped of aspect tags, resolution tokens, and orientation words
 *     so name variations of the same creative still group together.
 *
 * Buckets we recognise:
 *
 *   ratio ≤ 0.65        →  vertical    (9:16 stories/reels; true 9:16 = 0.5625)
 *   0.65 < ratio ≤ 0.9  →  portrait    (4:5 feed; true 4:5 = 0.8)
 *   0.9  < ratio ≤ 1.1  →  square      (1:1)
 *   ratio > 1.1         →  landscape   (16:9, 3:2, etc. — Meta still
 *                                       accepts them, just shown in Feed
 *                                       and a few right-column slots)
 *
 * Pairing key strategy: an ad is a bundle of media variants of the same
 * creative concept. We try to surface that grouping for free. Two files
 * sharing the same stripped stem AND landing in DIFFERENT buckets → one
 * ad with both formats. Two files in the SAME bucket with the same stem
 * → two separate ads (we never silently overwrite).
 */

/** The aspect bucket a file lands in after dimension probing. */
export type Aspect = 'vertical' | 'portrait' | 'square' | 'landscape';

/** Human label for a bucket. Used everywhere we display the badge. */
export const ASPECT_LABEL: Record<Aspect, string> = {
  vertical:  '9:16',
  portrait:  '4:5',
  square:    '1:1',
  landscape: '16:9',
};

/** Classify a width/height into one of the four buckets. */
export function classifyAspect(width: number, height: number): Aspect {
  if (width <= 0 || height <= 0) return 'square'; // can't happen in practice, defensive
  const r = width / height;
  if (r <= 0.65) return 'vertical';
  if (r <= 0.9)  return 'portrait';
  if (r <= 1.1)  return 'square';
  return 'landscape';
}

// =====================================================================
// Dimension probing
// =====================================================================

/**
 * Read the intrinsic pixel dimensions of an image or video file
 * client-side. Uses a temporary blob URL that we revoke right after
 * reading.
 *
 * Throws if the browser can't decode the file (corrupt, unsupported,
 * etc.) — callers should treat that as "still allow upload, mark aspect
 * unknown".
 */
export async function probeDimensions(
  file: File
): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(file);
  try {
    if (file.type.startsWith('image/')) {
      return await probeImage(url);
    }
    if (file.type.startsWith('video/')) {
      return await probeVideo(url);
    }
    throw new Error(`Unsupported file type: ${file.type}`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function probeImage(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('Image decode failed'));
    img.src = url;
  });
}

function probeVideo(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () => resolve({ width: v.videoWidth, height: v.videoHeight });
    v.onerror = () => reject(new Error('Video metadata read failed'));
    v.src = url;
  });
}

// =====================================================================
// Pair-key extraction (filename → grouping key)
// =====================================================================

/**
 * Tokens we strip from filenames before using the stem as a pair key.
 * Order matters: longer / more specific patterns first so the shorter
 * ones don't half-match.
 *
 * Tag patterns (case-insensitive), each must be surrounded by a
 * separator or be at start/end of the stem:
 *   - aspect tags:        4x5 4-5 5x4 5-4 9x16 9-16 16x9 16-9 1x1 1-1
 *   - resolution tokens:  WxH  (e.g. 1080x1920), bare 1080p / 2160p / 4k
 *   - orientation words:  vertical horizontal portrait landscape square
 *                         story stories reel reels feed feeds
 */
const STRIP_PATTERNS: RegExp[] = [
  // Resolution like 1080x1920 / 1920X1080
  /(?:^|[\s._\-])\d{3,4}[xX×]\d{3,4}(?=$|[\s._\-])/g,
  // Bare resolution suffixes: 720p, 1080p, 2160p, 4k
  /(?:^|[\s._\-])(?:720p|1080p|2160p|4k)(?=$|[\s._\-])/gi,
  // Aspect labels: 4x5, 5x4, 9x16, 16x9, 1x1 (and with - separator)
  /(?:^|[\s._\-])(?:1[x\-]1|4[x\-]5|5[x\-]4|9[x\-]16|16[x\-]9)(?=$|[\s._\-])/gi,
  // Orientation / placement words
  /(?:^|[\s._\-])(?:vertical|horizontal|portrait|landscape|square|stories|story|reels|reel|feeds|feed)(?=$|[\s._\-])/gi,
];

/** Strip path + extension to get the bare filename stem. */
function stripPathExt(name: string): string {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  const base = slash >= 0 ? name.slice(slash + 1) : name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Return a normalised pair key for a filename. Aspect/resolution tokens
 * are stripped, leftover separators collapsed, result lowercased.
 *
 *   "mug_v1_4x5_1080x1920.mp4"    →  "mug_v1"
 *   "MugV1_Vertical.mp4"          →  "mugv1"
 *   "mug_v1.mp4"                  →  "mug_v1"
 *   "abstract_clip.mp4"           →  "abstract_clip"
 *
 * Files with no recognisable tokens just return their stem lowercased.
 */
export function pairKeyFromFilename(filename: string): string {
  let s = stripPathExt(filename);
  // Strip every matching pattern. We run each pattern's replace twice
  // because adjacent matches share a separator — the first pass eats one,
  // the second the other. Loop until stable.
  for (let i = 0; i < 3; i++) {
    let changed = false;
    for (const re of STRIP_PATTERNS) {
      const before = s;
      s = s.replace(re, '');
      if (s !== before) changed = true;
    }
    if (!changed) break;
  }
  return s
    .replace(/[\s._\-]{2,}/g, '_')
    .replace(/^[\s._\-]+|[\s._\-]+$/g, '')
    .toLowerCase() || stripPathExt(filename).toLowerCase();
}

// =====================================================================
// Ad model + pairing
// =====================================================================

/**
 * One ad in Bulk Launch. Up to one media slot per aspect bucket. Most
 * ads have just `vertical` + `portrait` (the typical 9:16 + 4:5 combo);
 * `square` and `landscape` slots exist so files in those buckets aren't
 * lost — Meta still accepts them for Feed / right-column placements.
 */
export interface PairedAd {
  id: string;
  /** Inferred "concept name" — used as the default ad name. */
  pairKey: string;
  /** Per-bucket upload IDs. null means no file for that bucket on this ad. */
  slots: Record<Aspect, string | null>;
  /** All filenames currently associated with this ad — for display. */
  files: string[];
}

/** A media file the user dropped, with its detected aspect + pair key. */
export interface ProbedFile {
  uploadId: string;
  filename: string;
  width: number;
  height: number;
  aspect: Aspect;
  pairKey: string;
}

/** A file that didn't auto-pair into an ad. */
export interface UnpairedFile {
  uploadId: string;
  filename: string;
  width: number;
  height: number;
  aspect: Aspect;
  pairKey: string;
}

export interface PairingResult {
  ads: PairedAd[];
  unpaired: UnpairedFile[];
}

/**
 * Group probed files into PairedAds.
 *
 * Rule: bucket files by pairKey. Within a bucket, take ONE file per
 * aspect into an ad. If the same bucket has multiple files in the same
 * aspect (e.g. two vertical clips both named "mug_v1"), they fan out
 * into separate ads with `_1`, `_2` suffixes — we never silently drop.
 *
 * With dimension-based aspect (and no filename hints needed), the
 * common case is just "mug_v1.mp4" at 1080×1920 + "mug_v1.mp4" at
 * 1080×1350" → same pairKey, different aspects → one ad with both
 * formats. Works whether the user tags the filename or not.
 */
export function pairProbedFiles(files: ProbedFile[]): PairingResult {
  // pairKey → list of files in that group
  const buckets = new Map<string, ProbedFile[]>();
  for (const f of files) {
    const list = buckets.get(f.pairKey) ?? [];
    list.push(f);
    buckets.set(f.pairKey, list);
  }

  const ads: PairedAd[] = [];
  let counter = 0;

  for (const [pairKey, group] of buckets) {
    // For each aspect, line up the files. The longest list dictates how
    // many ads come out of this bucket.
    const byAspect: Record<Aspect, ProbedFile[]> = {
      vertical: [],
      portrait: [],
      square: [],
      landscape: [],
    };
    for (const f of group) byAspect[f.aspect].push(f);

    const adsHere = Math.max(
      byAspect.vertical.length,
      byAspect.portrait.length,
      byAspect.square.length,
      byAspect.landscape.length
    );

    for (let i = 0; i < adsHere; i++) {
      const slots: Record<Aspect, string | null> = {
        vertical:  byAspect.vertical[i]?.uploadId  ?? null,
        portrait:  byAspect.portrait[i]?.uploadId  ?? null,
        square:    byAspect.square[i]?.uploadId    ?? null,
        landscape: byAspect.landscape[i]?.uploadId ?? null,
      };
      const files = (Object.values(byAspect) as ProbedFile[][])
        .map((arr) => arr[i]?.filename)
        .filter(Boolean) as string[];
      const suffix = adsHere > 1 ? `_${i + 1}` : '';
      ads.push({
        id: `ad_${counter++}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        pairKey: pairKey + suffix,
        slots,
        files,
      });
    }
  }

  // Bulk Launch never strands files in the unpaired bin anymore — every
  // file goes into some ad (its own, if nothing else matches). The
  // unpaired list stays in the result shape for forward-compat / manual
  // re-shuffles initiated by the UI.
  return { ads, unpaired: [] };
}
