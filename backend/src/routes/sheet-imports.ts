/**
 * Sheet-import routes (Patch 4).
 *
 *   POST /sheet-imports/inspect           — list tabs + auto-detected headers
 *   POST /sheet-imports/parse             — final parse with tab + optional column map
 *   POST /sheet-imports/resolve-creatives — for each row, attempt to download Creative URL
 *
 * For both inspect and parse:
 *   - multipart/form-data with field 'file' → use uploaded buffer
 *   - JSON with { sheetUrl }                → fetch the URL (Google / OneDrive / SharePoint)
 *
 * The parse endpoint also accepts { tab, columnMap } in addition to the source.
 * When uploading + parsing in one go, embed JSON-stringified `tab` + `columnMap`
 * as form fields alongside the file.
 */
import { Router, Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import * as sheetParser from '../services/sheet-parser';
import { createUploadFromUrl } from '../services/upload-service';

export const sheetImportsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

/**
 * Build a sheet-parser Source from the request.
 * Throws a user-facing error with a status code suggestion if invalid.
 */
function sourceFromRequest(req: Request): { source: sheetParser.Source } {
  if (req.file) {
    return { source: { kind: 'buffer', data: req.file.buffer } };
  }
  const body = req.body ?? {};
  const sheetUrl = typeof body.sheetUrl === 'string' ? body.sheetUrl.trim() : '';
  if (!sheetUrl) {
    throw new Error('Provide a sheetUrl (JSON) or upload a file (form field "file")');
  }
  // Light validation — let the parser handle the actual format checks
  if (!/^https?:\/\//i.test(sheetUrl)) {
    throw new Error('URL must start with http:// or https://');
  }
  return { source: { kind: 'url', url: sheetUrl } };
}

// ============================================================
// POST /sheet-imports/inspect
// Returns tab list + per-tab header info. Cheap; no row materialization.
// ============================================================
sheetImportsRouter.post(
  '/inspect',
  requireAuth,
  upload.single('file'),
  async (req: Request, res: Response) => {
    try {
      const { source } = sourceFromRequest(req);
      const info = await sheetParser.inspectSource(source);
      res.json(info);
    } catch (err) {
      console.error('[sheet-imports/inspect] failed:', err);
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to inspect sheet',
      });
    }
  }
);

// ============================================================
// POST /sheet-imports/parse
// Final parse. Accepts optional `tab` and `columnMap`.
// ============================================================
const parseExtraSchema = z.object({
  tab: z.string().optional(),
  /** User's override for which row holds the column headers (0-based). */
  headerRowIdx: z.number().int().min(0).optional(),
  /**
   * Object map of column index (string keys, since JSON) → Vass field name.
   * Ad set is intentionally absent — Vass detects ad-set boundaries from
   * section-divider rows, not from a column.
   */
  columnMap: z
    .record(
      z.enum([
        'creative',
        'mediaFormat',
        'primaryText',
        'headline',
        'description',
        'cta',
        'linkUrl',
        'adName',
      ])
    )
    .optional(),
});

sheetImportsRouter.post(
  '/parse',
  requireAuth,
  upload.single('file'),
  async (req: Request, res: Response) => {
    try {
      const { source } = sourceFromRequest(req);

      // When uploading a file, multer puts the other text fields directly on
      // req.body as strings. Parse them.
      let tab: string | undefined;
      let columnMap: sheetParser.UserColumnMap | undefined;
      let headerRowIdx: number | undefined;

      if (req.file) {
        // Multipart: text fields are strings, may include JSON
        const rawTab = req.body?.tab;
        if (typeof rawTab === 'string' && rawTab.trim()) tab = rawTab.trim();
        const rawHeader = req.body?.headerRowIdx;
        if (rawHeader !== undefined && rawHeader !== '') {
          const n = Number(rawHeader);
          if (Number.isInteger(n) && n >= 0) headerRowIdx = n;
        }
        const rawMap = req.body?.columnMap;
        if (typeof rawMap === 'string' && rawMap.trim()) {
          try {
            const parsed = JSON.parse(rawMap);
            const validated = parseExtraSchema.shape.columnMap.safeParse(parsed);
            if (validated.success) {
              columnMap = {};
              for (const [k, v] of Object.entries(validated.data ?? {})) {
                columnMap[Number(k)] = v as keyof sheetParser.SheetRow & string as any;
              }
            }
          } catch { /* invalid JSON — ignore */ }
        }
      } else {
        const extra = parseExtraSchema.safeParse(req.body);
        if (extra.success) {
          tab = extra.data.tab;
          headerRowIdx = extra.data.headerRowIdx;
          if (extra.data.columnMap) {
            columnMap = {};
            for (const [k, v] of Object.entries(extra.data.columnMap)) {
              columnMap[Number(k)] = v as any;
            }
          }
        }
      }

      const result = await sheetParser.parseSource(source, tab, columnMap, headerRowIdx);
      res.json(result);
    } catch (err) {
      console.error('[sheet-imports/parse] failed:', err);
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to parse sheet',
      });
    }
  }
);

// ============================================================
// POST /sheet-imports/resolve-creatives
// ============================================================
const resolveSchema = z.object({
  creatives: z.array(z.string()).max(500),
});

interface ResolvedRow {
  index: number;
  ok: boolean;
  uploadId?: string;
  kind?: 'image' | 'video';
  widthPx?: number | null;
  heightPx?: number | null;
  aspectBucket?: string | null;
  error?: string;
}

sheetImportsRouter.post(
  '/resolve-creatives',
  requireAuth,
  async (req: Request, res: Response) => {
    const parsed = resolveSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request' });
    }
    const results: ResolvedRow[] = [];
    for (let i = 0; i < parsed.data.creatives.length; i++) {
      const raw = parsed.data.creatives[i].trim();
      if (!raw) {
        results.push({ index: i, ok: false, error: 'Empty cell' });
        continue;
      }
      if (!/^https?:\/\//i.test(raw)) {
        results.push({ index: i, ok: false, error: 'Not a fetchable URL — upload manually' });
        continue;
      }
      const { upload, error } = await createUploadFromUrl(req.user!.id, raw);
      if (!upload) {
        results.push({ index: i, ok: false, error: error ?? 'Download failed' });
        continue;
      }
      results.push({
        index: i,
        ok: true,
        uploadId: upload.id,
        kind: upload.kind as 'image' | 'video',
        widthPx: upload.widthPx,
        heightPx: upload.heightPx,
        aspectBucket: upload.aspectBucket,
      });
    }
    res.json({ results });
  }
);

// Multer error handler — catches LIMIT_FILE_SIZE etc. and returns clean JSON
sheetImportsRouter.use((err: any, _req: Request, res: Response, next: any) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File too large (max 25MB for spreadsheets)' });
  }
  if (err?.message) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});
