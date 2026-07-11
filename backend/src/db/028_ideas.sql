-- =====================================================================
-- Patch 4.37.1 — Ideas + folders.
--
-- Notion-style scratch space for content ideas. Brand-scoped. Each
-- idea optionally lives inside a folder. Folders are also brand-scoped.
-- Ideas can be "turned into" posts (composer prefilled), at which
-- point the idea is deleted by the client on successful save.
-- =====================================================================

CREATE TABLE organic_idea_folders (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    brand_id    UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,

    name        TEXT NOT NULL,
    -- Preset hex string (we render with inline style + a swatch).
    -- NULL = neutral / no color.
    color       TEXT,
    -- Optional emoji (single grapheme, but we don't enforce length —
    -- multi-codepoint emoji can be 4+ bytes).
    emoji       TEXT,

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_organic_idea_folders_brand ON organic_idea_folders(brand_id);
CREATE INDEX idx_organic_idea_folders_user  ON organic_idea_folders(user_id);

CREATE TRIGGER organic_idea_folders_updated_at
    BEFORE UPDATE ON organic_idea_folders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE organic_ideas (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    brand_id    UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,

    -- Optional folder. NULL = unfiled / Inbox.
    folder_id   UUID REFERENCES organic_idea_folders(id) ON DELETE SET NULL,

    -- All content is optional. The idea exists from the moment it's
    -- created; the user fills it in over time.
    title       TEXT,
    body        TEXT NOT NULL DEFAULT '',

    -- Single media field. References uploads.id. NULL = no media.
    upload_id   UUID REFERENCES uploads(id) ON DELETE SET NULL,
    -- 'image' | 'video' | NULL. Cached so we don't need to JOIN uploads
    -- for the list view.
    media_kind  TEXT,
    CONSTRAINT idea_media_kind_check CHECK (media_kind IS NULL OR media_kind IN ('image','video')),

    -- A single reference URL (no OG preview for now — we just render
    -- it as a link).
    link_url    TEXT,

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_organic_ideas_brand   ON organic_ideas(brand_id);
CREATE INDEX idx_organic_ideas_user    ON organic_ideas(user_id);
CREATE INDEX idx_organic_ideas_folder  ON organic_ideas(folder_id);
CREATE INDEX idx_organic_ideas_updated ON organic_ideas(updated_at DESC);

CREATE TRIGGER organic_ideas_updated_at
    BEFORE UPDATE ON organic_ideas
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE organic_ideas IS
    'Per-brand scratch space for content ideas. Convertible to posts via the composer.';
