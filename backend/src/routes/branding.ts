/**
 * Branding endpoints — workspace logo override.
 *
 *   GET    /branding          → { logoDataUrl: string | null }    (public read)
 *   PUT    /branding/logo     → upload a new logo                  (admin only)
 *   DELETE /branding/logo     → reset to default                   (admin only)
 *
 * Storage: the uploaded logo is stored as a data URL string in
 * `app_settings.value` under key `branding.logo_data_url`. We keep it as a
 * data URL (rather than raw bytes) so the frontend can drop it straight
 * into an <img src="..."> without an extra fetch.
 *
 * Limits:
 *   - Format: PNG or SVG only (we sniff the data URL prefix)
 *   - Raw size: 500 KB (base64 inflates to ~670 KB, comfortably under our
 *     4 MB JSON body limit)
 *
 * Read is intentionally public: the login page needs to show the custom
 * logo before any user has authenticated. The data URL is not sensitive.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../middleware/auth';
import { getPlain, setPlain } from '../services/settings';

export const brandingRouter = Router();

const LOGO_KEY = 'branding.logo_data_url';

/** Hard cap on the RAW (decoded) logo bytes. 500 KB. */
const MAX_LOGO_BYTES = 500 * 1024;

/** Data URL must start with one of these MIME-type prefixes. */
const ALLOWED_DATA_URL_PREFIXES = [
  'data:image/png;base64,',
  'data:image/svg+xml;base64,',
];

// =====================================================================
// GET /branding — public read of current branding (logo only for now)
// =====================================================================
brandingRouter.get('/', async (_req: Request, res: Response) => {
  const logoDataUrl = await getPlain(LOGO_KEY);
  res.json({ logoDataUrl });
});

// =====================================================================
// PUT /branding/logo — admin replaces the workspace logo
// =====================================================================
const putLogoSchema = z.object({
  /** Full data URL, e.g. "data:image/png;base64,iVBOR...". */
  dataUrl: z.string().min(1).max(700_000), // ~500KB raw -> ~670KB base64 in JSON
});

brandingRouter.put(
  '/logo',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    const parsed = putLogoSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid payload',
        details: parsed.error.flatten(),
      });
    }
    const { dataUrl } = parsed.data;

    // ---- Format check ----
    const prefix = ALLOWED_DATA_URL_PREFIXES.find((p) => dataUrl.startsWith(p));
    if (!prefix) {
      return res.status(400).json({
        error: 'Only PNG or SVG logos are accepted.',
      });
    }

    // ---- Size check ----
    // Decode the base64 portion and verify the byte count.
    const base64Body = dataUrl.slice(prefix.length);
    let rawBytes: number;
    try {
      rawBytes = Buffer.from(base64Body, 'base64').length;
    } catch {
      return res.status(400).json({ error: 'Logo data is not valid base64.' });
    }
    if (rawBytes > MAX_LOGO_BYTES) {
      return res.status(413).json({
        error: `Logo is too large (${Math.round(rawBytes / 1024)} KB). Max 500 KB.`,
      });
    }
    if (rawBytes < 16) {
      return res.status(400).json({ error: 'Logo data is empty or truncated.' });
    }

    await setPlain(LOGO_KEY, dataUrl, req.user!.id);
    res.json({ ok: true, sizeBytes: rawBytes });
  }
);

// =====================================================================
// DELETE /branding/logo — admin resets to default
// =====================================================================
brandingRouter.delete(
  '/logo',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    await setPlain(LOGO_KEY, null, req.user!.id);
    res.json({ ok: true });
  }
);
