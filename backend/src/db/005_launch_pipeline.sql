-- ============================================================
-- Vass — Phase 3.0: Launch pipeline (bulk launching)
-- ============================================================
-- We already have launch_batches + ad_launches from Phase 0.
-- This migration extends them for the queue-based pipeline:
--
--   - Track attempts per ad (so we know if it's been retried)
--   - Store the link to the local creative file we uploaded
--   - Track the BullMQ job id so we can correlate worker output
--   - Add a `meta_image_hash` field (Meta's identifier for an uploaded image)
--
-- We also add an `uploads` table for tracking files users have uploaded
-- to Vass before launching. Files live on disk in /uploads volume;
-- this table is just the metadata + reference.
-- ============================================================

-- ------------------------------------------------------------
-- Uploads — files users have uploaded to Vass
-- These get associated with launches when the launch runs.
-- ------------------------------------------------------------
CREATE TABLE uploads (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename        TEXT NOT NULL,            -- the original filename user uploaded
    storage_path    TEXT NOT NULL,            -- where it lives on disk (relative to /uploads volume)
    content_type    TEXT NOT NULL,            -- 'image/jpeg', 'video/mp4', etc.
    size_bytes      BIGINT NOT NULL,
    kind            TEXT NOT NULL,            -- 'image' | 'video'
    -- Once we've sent this to Meta, store the IDs so we can reuse
    meta_image_hash TEXT,                     -- for images: Meta's hash identifier
    meta_video_id   TEXT,                     -- for videos: Meta's video ID
    meta_uploaded_at TIMESTAMPTZ,             -- when we sent it to Meta
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uploads_kind_check CHECK (kind IN ('image','video'))
);

CREATE INDEX idx_uploads_user ON uploads(user_id);
CREATE INDEX idx_uploads_created ON uploads(created_at DESC);

-- ------------------------------------------------------------
-- Extend ad_launches
-- ------------------------------------------------------------
ALTER TABLE ad_launches
    -- How many times has the worker tried this ad? (for retry tracking)
    ADD COLUMN IF NOT EXISTS attempts        INTEGER NOT NULL DEFAULT 0,
    -- BullMQ job id, so we can look up the job in Redis if needed
    ADD COLUMN IF NOT EXISTS job_id          TEXT,
    -- Foreign key to the upload that backs this ad (if any)
    ADD COLUMN IF NOT EXISTS upload_id       UUID REFERENCES uploads(id) ON DELETE SET NULL,
    -- Last update timestamp so polling UI can show progress
    ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_ad_launches_batch_status ON ad_launches(batch_id, status);
CREATE INDEX IF NOT EXISTS idx_ad_launches_updated ON ad_launches(updated_at DESC);

-- Trigger to keep updated_at fresh
CREATE TRIGGER ad_launches_updated_at BEFORE UPDATE ON ad_launches
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ------------------------------------------------------------
-- Extend launch_batches
-- ------------------------------------------------------------
ALTER TABLE launch_batches
    -- 'DRAFT' | 'ACTIVE' — the desired status of created ads
    ADD COLUMN IF NOT EXISTS desired_ad_status  TEXT NOT NULL DEFAULT 'DRAFT',
    -- Updated as ads finish (for live progress UI)
    ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE launch_batches
    DROP CONSTRAINT IF EXISTS launch_batches_desired_ad_status_check;

ALTER TABLE launch_batches
    ADD CONSTRAINT launch_batches_desired_ad_status_check
    CHECK (desired_ad_status IN ('DRAFT','ACTIVE','PAUSED'));

CREATE TRIGGER launch_batches_updated_at BEFORE UPDATE ON launch_batches
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
