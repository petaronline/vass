/**
 * createUploadFromBuffer — saves a binary buffer to /uploads (content-addressed)
 * and inserts a row in the `uploads` table, returning the upload metadata.
 *
 * Extracted from POST /uploads route in Patch 4 so the sheet-import flow can
 * register uploads programmatically when it downloads creatives by URL.
 *
 * The upload route still owns parsing the multipart form and validating MIME;
 * this helper takes the resolved buffer + content-type + original filename.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { query } from '../db/pool';
import {
  readImageDimensions,
  readVideoDimensions,
  type MediaDimensions,
} from './media-dimensions';

const UPLOAD_ROOT = process.env.UPLOAD_ROOT ?? '/uploads';

interface UploadRow {
  id: string;
  filename: string;
  storage_path: string;
  content_type: string;
  size_bytes: string;
  kind: 'image' | 'video' | 'document';
  meta_image_hash: string | null;
  meta_video_id: string | null;
  meta_uploaded_at: Date | null;
  width_px: number | null;
  height_px: number | null;
  aspect_bucket: string | null;
  created_at: Date;
  [k: string]: unknown;
}

const SELECT_COLS = `
  id, filename, storage_path, content_type, size_bytes,
  kind, meta_image_hash, meta_video_id, meta_uploaded_at,
  width_px, height_px, aspect_bucket, created_at
`;

export interface CreateUploadInput {
  userId: string;
  buffer: Buffer;
  contentType: string;
  /** e.g. 'image' | 'video'. Caller decides based on mimetype. */
  kind: 'image' | 'video' | 'document';
  /** Display filename. Will be sanitized. */
  originalFilename: string;
}

export interface CreatedUpload {
  id: string;
  filename: string;
  storagePath: string;
  contentType: string;
  sizeBytes: number;
  kind: 'image' | 'video' | 'document';
  metaImageHash: string | null;
  metaVideoId: string | null;
  widthPx: number | null;
  heightPx: number | null;
  aspectBucket: string | null;
}

export async function createUploadFromBuffer(
  input: CreateUploadInput
): Promise<CreatedUpload> {
  // Content-addressed storage: hash the bytes, use that as the filename.
  const hash = crypto.createHash('sha256').update(input.buffer).digest('hex');
  const ext = mimeToExt(input.contentType);
  const relativePath = `${input.kind}/${hash.substring(0, 2)}/${hash}${ext}`;
  const absPath = path.join(UPLOAD_ROOT, relativePath);

  // Write to disk (skip if file already exists — same hash = same content)
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  try {
    await fs.access(absPath);
    // File exists, skip write
  } catch {
    await fs.writeFile(absPath, input.buffer);
  }

  const safeFilename = sanitizeFilename(input.originalFilename);

  // Detect dimensions. Non-fatal.
  let dimensions: MediaDimensions | null = null;
  try {
    if (input.kind === 'image') {
      dimensions = await readImageDimensions(input.buffer);
    } else {
      dimensions = await readVideoDimensions(absPath);
    }
  } catch (err) {
    console.warn('[upload-service] dimensions detection threw:', err);
  }

  const { rows } = await query<UploadRow>(
    `INSERT INTO uploads (
       user_id, filename, storage_path, content_type, size_bytes, kind,
       width_px, height_px, aspect_bucket
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${SELECT_COLS}`,
    [
      input.userId,
      safeFilename,
      relativePath,
      input.contentType,
      input.buffer.length,
      input.kind,
      dimensions?.widthPx ?? null,
      dimensions?.heightPx ?? null,
      dimensions?.aspectBucket ?? null,
    ]
  );
  const r = rows[0];
  return {
    id: r.id,
    filename: r.filename,
    storagePath: r.storage_path,
    contentType: r.content_type,
    sizeBytes: Number(r.size_bytes),
    kind: r.kind,
    metaImageHash: r.meta_image_hash,
    metaVideoId: r.meta_video_id,
    widthPx: r.width_px,
    heightPx: r.height_px,
    aspectBucket: r.aspect_bucket,
  };
}

/**
 * Download a creative from an HTTPS URL and create an upload row from it.
 * Used by the sheet-import flow when a row's Creative column holds a URL.
 *
 * Returns null if:
 *   - URL is not http(s)
 *   - response is not 2xx
 *   - content-type is not a supported image or video type
 *   - response is larger than the upload size limit
 *
 * The non-null path returns a fully-formed upload (registered in DB + on disk).
 */
const ALLOWED_TYPES: Record<string, 'image' | 'video'> = {
  'image/jpeg': 'image',
  'image/jpg':  'image',
  'image/png':  'image',
  'image/webp': 'image',
  'image/gif':  'image',
  'video/mp4':  'video',
  'video/quicktime': 'video',
  'video/webm': 'video',
};
const MAX_BYTES = 250 * 1024 * 1024;

export async function createUploadFromUrl(
  userId: string,
  url: string
): Promise<{ upload: CreatedUpload | null; error: string | null }> {
  if (!/^https?:\/\//i.test(url)) {
    return { upload: null, error: 'Not a fetchable URL' };
  }
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) {
      return { upload: null, error: `HTTP ${res.status}` };
    }
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const kind = ALLOWED_TYPES[contentType];
    if (!kind) {
      return {
        upload: null,
        error: `Unsupported content-type "${contentType || 'unknown'}". Need image (jpeg/png/webp/gif) or video (mp4/mov/webm).`,
      };
    }
    const contentLengthHeader = res.headers.get('content-length');
    if (contentLengthHeader && Number(contentLengthHeader) > MAX_BYTES) {
      return { upload: null, error: `File too large (max ${MAX_BYTES / 1024 / 1024}MB)` };
    }
    const arrayBuf = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    if (buffer.length > MAX_BYTES) {
      return { upload: null, error: `File too large (max ${MAX_BYTES / 1024 / 1024}MB)` };
    }

    // Best-effort filename from URL
    const filename = filenameFromUrl(url, contentType);

    const upload = await createUploadFromBuffer({
      userId,
      buffer,
      contentType,
      kind,
      originalFilename: filename,
    });
    return { upload, error: null };
  } catch (err) {
    return {
      upload: null,
      error: err instanceof Error ? err.message : 'Download failed',
    };
  }
}

function filenameFromUrl(url: string, contentType: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() ?? 'creative';
    // Strip query, keep extension if any
    return last || `creative${mimeToExt(contentType)}`;
  } catch {
    return `creative${mimeToExt(contentType)}`;
  }
}

function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg':  '.jpg',
    'image/png':  '.png',
    'image/webp': '.webp',
    'image/gif':  '.gif',
    'video/mp4':  '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
  };
  return map[mime] ?? '';
}

function sanitizeFilename(name: string): string {
  // Strip any path components — only keep the basename
  const base = path.basename(name);
  // Replace anything weird; preserve dots for extensions
  return base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200) || 'upload';
}
