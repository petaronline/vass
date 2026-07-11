/**
 * Media dimensions reader + ratio classifier.
 *
 * Given uploaded file bytes, returns:
 *   - width × height in pixels
 *   - a ratio bucket: '1_1' | '4_5' | '9_16' | 'other'
 *
 * Strategy:
 *   - Images:  sharp() — fast pure-Node, no shell-out
 *   - Videos:  ffprobe — shell out, parse JSON output
 *
 * Failures degrade gracefully: returns null instead of throwing. Callers
 * decide whether to persist the dimensions or proceed without.
 */
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import sharp from 'sharp';

export type AspectBucket = '1_1' | '4_5' | '9_16' | 'other';

export interface MediaDimensions {
  widthPx: number;
  heightPx: number;
  aspectBucket: AspectBucket;
}

/**
 * Classify an aspect ratio into a placement bucket.
 *
 * Buckets:
 *   - 1_1   for squares: 0.95–1.05 (covers slight encoder rounding)
 *   - 4_5   for portrait Feed assets: 0.78–0.82 (4/5 = 0.80)
 *   - 9_16  for vertical Story/Reel: 0.55–0.58 (9/16 = 0.5625)
 *   - other for anything else (16:9 landscape, banners, etc.)
 *
 * Range tolerances chosen empirically — designers sometimes export 1080×1350
 * (exactly 4:5) but Photoshop "Save for Web" often produces 1080×1349 or
 * similar slight off-by-ones. The wider tolerance catches those.
 */
export function classifyAspectRatio(widthPx: number, heightPx: number): AspectBucket {
  if (widthPx <= 0 || heightPx <= 0) return 'other';
  const ratio = widthPx / heightPx;

  if (ratio >= 0.95 && ratio <= 1.05) return '1_1';
  if (ratio >= 0.78 && ratio <= 0.82) return '4_5';
  if (ratio >= 0.55 && ratio <= 0.58) return '9_16';
  return 'other';
}

/**
 * Read dimensions from image bytes using sharp.
 * Returns null if sharp can't parse the file.
 */
export async function readImageDimensions(bytes: Buffer): Promise<MediaDimensions | null> {
  try {
    const meta = await sharp(bytes).metadata();
    if (!meta.width || !meta.height) return null;
    return {
      widthPx: meta.width,
      heightPx: meta.height,
      aspectBucket: classifyAspectRatio(meta.width, meta.height),
    };
  } catch (err) {
    console.warn('[dimensions] sharp failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Read dimensions from a video file path using ffprobe.
 *
 * We use a file path (not bytes) because ffprobe expects to seek the input.
 * For our upload flow we already wrote bytes to disk before calling this,
 * so we just pass the absolute path.
 *
 * Returns null if ffprobe isn't installed or can't parse the file.
 */
export async function readVideoDimensions(absolutePath: string): Promise<MediaDimensions | null> {
  // Validate the file exists & is readable before shelling out
  try {
    await fs.access(absolutePath);
  } catch {
    return null;
  }

  return new Promise<MediaDimensions | null>((resolve) => {
    // -v error : suppress non-error chatter
    // -select_streams v:0 : first video stream only
    // -show_entries stream=width,height : just what we need
    // -of json : JSON output
    const args = [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'json',
      absolutePath,
    ];

    let stdout = '';
    let stderr = '';
    let resolved = false;

    const proc = spawn('ffprobe', args);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      console.warn('[dimensions] ffprobe spawn failed:', err.message);
      resolve(null);
    });

    proc.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      if (code !== 0) {
        console.warn(`[dimensions] ffprobe exited ${code}: ${stderr.trim()}`);
        return resolve(null);
      }
      try {
        const data = JSON.parse(stdout);
        const stream = data?.streams?.[0];
        const w = stream?.width;
        const h = stream?.height;
        if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) {
          resolve({
            widthPx: w,
            heightPx: h,
            aspectBucket: classifyAspectRatio(w, h),
          });
        } else {
          resolve(null);
        }
      } catch (err) {
        console.warn('[dimensions] ffprobe parse failed:', err instanceof Error ? err.message : err);
        resolve(null);
      }
    });

    // Backstop timeout — ffprobe should be quick (~100ms for small files)
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      proc.kill('SIGKILL');
      console.warn('[dimensions] ffprobe timeout');
      resolve(null);
    }, 10_000);
  });
}
