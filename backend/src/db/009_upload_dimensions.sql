-- ============================================================
-- Vass — Patch 3.2: Media dimensions + aspect bucket
-- ============================================================
--
-- Adds width/height columns to uploads so the frontend can show ratio
-- badges and auto-group assets for multi-placement creatives.
--
-- aspect_bucket is a coarse classification:
--   1_1   — square (0.95–1.05 ratio)
--   4_5   — portrait Feed (0.78–0.82)
--   9_16  — vertical Story/Reel (0.55–0.58)
--   other — anything else (banners, 16:9 landscape, etc.)
--
-- All three columns are nullable: existing rows have no dimensions
-- on record. New uploads after this patch land with values populated.
-- Backfilling old rows is possible but not done here (worker doesn't
-- need them for already-launched ads).
-- ============================================================

ALTER TABLE uploads
    ADD COLUMN IF NOT EXISTS width_px      INTEGER,
    ADD COLUMN IF NOT EXISTS height_px     INTEGER,
    ADD COLUMN IF NOT EXISTS aspect_bucket TEXT;

ALTER TABLE uploads
    DROP CONSTRAINT IF EXISTS uploads_aspect_bucket_check;

ALTER TABLE uploads
    ADD CONSTRAINT uploads_aspect_bucket_check
    CHECK (aspect_bucket IS NULL OR aspect_bucket IN ('1_1', '4_5', '9_16', 'other'));

COMMENT ON COLUMN uploads.width_px IS 'Pixel width detected on upload (sharp for images, ffprobe for video). NULL for old rows or unreadable files.';
COMMENT ON COLUMN uploads.height_px IS 'Pixel height detected on upload.';
COMMENT ON COLUMN uploads.aspect_bucket IS 'Coarse aspect classification: 1_1 / 4_5 / 9_16 / other. Used for placement-aware grouping in launch UI.';
