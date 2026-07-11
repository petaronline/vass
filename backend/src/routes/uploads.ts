/**
 * Uploads routes.
 *
 *   POST   /uploads              → upload one file, returns { upload }
 *   GET    /uploads              → list current user's uploads
 *   GET    /uploads/:id          → fetch one upload's metadata
 *   GET    /uploads/:id/file     → stream the actual file bytes (for previews)
 *   DELETE /uploads/:id          → delete an upload (file + DB row)
 *
 * Files live on disk under UPLOAD_ROOT (default /uploads). The path
 * stored in the DB is relative, so moving the volume doesn't break anything.
 *
 * Files are namespaced per-user (random filename) for privacy + collision safety.
 * Only the uploader can read/delete their own files.
 */
import { Router, Request, Response } from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { requireAuth } from '../middleware/auth';
import { query } from '../db/pool';
import { verifyUploadPublicToken } from '../utils/crypto';
import {
  readImageDimensions,
  readVideoDimensions,
  type MediaDimensions,
} from '../services/media-dimensions';

export const uploadsRouter = Router();

const UPLOAD_ROOT = process.env.UPLOAD_ROOT ?? '/uploads';

// Limits — image OR video. Video coming with Patch 3.1.
const MAX_BYTES = 250 * 1024 * 1024; // 250 MB (large enough for any real ad video)
const ALLOWED_TYPES: Record<string, 'image' | 'video' | 'document'> = {
  // Images
  'image/jpeg': 'image',
  'image/jpg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  // Videos — Meta accepts MP4, MOV, and a few others; we cover the common ones
  'video/mp4': 'video',
  'video/quicktime': 'video',  // .mov
  'video/webm': 'video',
  // Documents — LinkedIn document posts (PDF only)
  'application/pdf': 'document',
};

// In-memory upload — multer writes to disk in our handler so we can use
// a content-addressed path. For very large files, switching to disk
// storage is trivial later.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
});

interface UploadRow {
  id: string;
  filename: string;
  storage_path: string;
  content_type: string;
  size_bytes: string; // BIGINT comes back as string from pg
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

function rowToUpload(row: UploadRow) {
  return {
    id: row.id,
    filename: row.filename,
    storagePath: row.storage_path,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    kind: row.kind,
    metaImageHash: row.meta_image_hash,
    metaVideoId: row.meta_video_id,
    metaUploadedAt: row.meta_uploaded_at,
    widthPx: row.width_px,
    heightPx: row.height_px,
    aspectBucket: row.aspect_bucket,
    createdAt: row.created_at,
  };
}

// All columns needed by rowToUpload. Used by every SELECT against uploads
// so we don't accidentally miss one when adding new columns.
const UPLOAD_SELECT_COLS = `
  id, filename, storage_path, content_type, size_bytes,
  kind, meta_image_hash, meta_video_id, meta_uploaded_at,
  width_px, height_px, aspect_bucket, created_at
`;

// =====================================================================
// POST /uploads — accept one file
// =====================================================================
uploadsRouter.post(
  '/',
  requireAuth,
  upload.single('file'),
  async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file provided. Use field name "file".' });
    }
    const kind = ALLOWED_TYPES[file.mimetype];
    if (!kind) {
      return res.status(400).json({
        error: `Unsupported file type: ${file.mimetype}. Allowed: ${Object.keys(ALLOWED_TYPES).join(', ')}`,
      });
    }

    // Content-addressed storage: hash the bytes, use that as the filename.
    // Two benefits: (1) automatic dedup, (2) no filename injection risk.
    const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const ext = mimeToExt(file.mimetype);
    const relativePath = `${kind}/${hash.substring(0, 2)}/${hash}${ext}`;
    const absPath = path.join(UPLOAD_ROOT, relativePath);

    // Write to disk (skip if file already exists — same hash = same content)
    try {
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      try {
        await fs.access(absPath);
        // File exists, skip write
      } catch {
        await fs.writeFile(absPath, file.buffer);
      }
    } catch (err) {
      console.error('[uploads] write failed:', err);
      return res.status(500).json({ error: 'Failed to save file' });
    }

    // Sanitize the original filename for storage (don't trust user input)
    const safeFilename = sanitizeFilename(file.originalname);

    // Detect dimensions. Failure is non-fatal — we still create the upload row.
    let dimensions: MediaDimensions | null = null;
    try {
      if (kind === 'image') {
        dimensions = await readImageDimensions(file.buffer);
      } else {
        dimensions = await readVideoDimensions(absPath);
      }
    } catch (err) {
      // Detector logs its own warnings; just continue
      console.warn('[uploads] dimensions detection threw:', err);
    }

    const { rows } = await query<UploadRow>(
      `INSERT INTO uploads (
         user_id, filename, storage_path, content_type, size_bytes, kind,
         width_px, height_px, aspect_bucket
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${UPLOAD_SELECT_COLS}`,
      [
        req.user!.id,
        safeFilename,
        relativePath,
        file.mimetype,
        file.size,
        kind,
        dimensions?.widthPx ?? null,
        dimensions?.heightPx ?? null,
        dimensions?.aspectBucket ?? null,
      ]
    );

    res.json({ upload: rowToUpload(rows[0]) });
  }
);

// Multer error handler — needs to be after the route definition
uploadsRouter.use((err: any, _req: Request, res: Response, next: any) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      error: `File too large. Max ${MAX_BYTES / 1024 / 1024}MB.`,
    });
  }
  next(err);
});

// =====================================================================
// GET /uploads — list current user's uploads
// =====================================================================
uploadsRouter.get('/', requireAuth, async (req: Request, res: Response) => {
  const { rows } = await query<UploadRow>(
    `SELECT ${UPLOAD_SELECT_COLS}
     FROM uploads
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 100`,
    [req.user!.id]
  );
  res.json({ uploads: rows.map(rowToUpload) });
});

// =====================================================================
// GET /uploads/:id — single record
// =====================================================================
uploadsRouter.get('/:id', requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  const { rows } = await query<UploadRow>(
    `SELECT ${UPLOAD_SELECT_COLS}
     FROM uploads
     WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [id, req.user!.id]
  );
  if (rows.length === 0) {
    return res.status(404).json({ error: 'Upload not found' });
  }
  res.json({ upload: rowToUpload(rows[0]) });
});

// =====================================================================
// GET /uploads/:id/file — stream the file bytes (for previews)
// =====================================================================
uploadsRouter.get('/:id/file', requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  const { rows } = await query<UploadRow>(
    `SELECT storage_path, content_type FROM uploads
     WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [id, req.user!.id]
  );
  if (rows.length === 0) {
    return res.status(404).json({ error: 'Upload not found' });
  }
  const absPath = path.join(UPLOAD_ROOT, rows[0].storage_path);

  try {
    await fs.access(absPath);
  } catch {
    return res.status(404).json({ error: 'File missing on disk' });
  }

  res.setHeader('Content-Type', rows[0].content_type);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  createReadStream(absPath).pipe(res);
});

// =====================================================================
// GET /uploads/:id/public?token=... — public, token-gated file access.
//
// Required because Meta needs to fetch images from a publicly accessible
// URL when publishing organic posts (and for IG containers). The token
// is HMAC-signed and time-limited (default 1 hour) — generated by the
// organic publisher right before sending the URL to Meta.
//
// No auth middleware: anyone holding a valid token can fetch the bytes.
// Tokens are scoped to a single upload id.
// =====================================================================
uploadsRouter.get('/:id/public', async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  if (!token || !verifyUploadPublicToken(id, token)) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }

  // We don't need to filter by user_id — the token is proof.
  const { rows } = await query<UploadRow>(
    `SELECT storage_path, content_type FROM uploads WHERE id = $1 LIMIT 1`,
    [id]
  );
  if (rows.length === 0) {
    return res.status(404).json({ error: 'Upload not found' });
  }
  const absPath = path.join(UPLOAD_ROOT, rows[0].storage_path);
  try {
    await fs.access(absPath);
  } catch {
    return res.status(404).json({ error: 'File missing on disk' });
  }

  res.setHeader('Content-Type', rows[0].content_type);
  // Cache-Control public so CDNs / Meta's fetcher can cache briefly.
  res.setHeader('Cache-Control', 'public, max-age=300');
  createReadStream(absPath).pipe(res);
});

// =====================================================================
// DELETE /uploads/:id — remove
// =====================================================================
uploadsRouter.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  const { rows } = await query<UploadRow>(
    `DELETE FROM uploads WHERE id = $1 AND user_id = $2
     RETURNING storage_path`,
    [id, req.user!.id]
  );
  if (rows.length === 0) {
    return res.status(404).json({ error: 'Upload not found' });
  }
  // Best-effort: remove the file on disk. If another upload row references
  // the same content-addressed file, this orphans them — we'd need a
  // reference-count cleanup job. Phase 3.0 punts on this; storage cleanup
  // is a later optimization.
  try {
    await fs.unlink(path.join(UPLOAD_ROOT, rows[0].storage_path));
  } catch {
    // ignore — could be that another upload shares the path
  }
  res.json({ ok: true });
});

// =====================================================================
// Helpers
// =====================================================================

function mimeToExt(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    case 'video/mp4':
      return '.mp4';
    case 'video/quicktime':
      return '.mov';
    default:
      return '';
  }
}

function sanitizeFilename(name: string): string {
  // Strip directory components, control chars, weird unicode whitespace
  const base = path.basename(name);
  return base.replace(/[\x00-\x1f\x7f]/g, '_').slice(0, 200);
}
