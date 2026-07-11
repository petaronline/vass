-- =====================================================================
-- Patch 4.23 — Brands grouping for connected social profiles.
--
-- Each Vass user can create their own "brands" — labeled containers
-- that group connected social accounts (FB Pages, IG, eventually Threads
-- and TikTok). Per-user: brands aren't shared across the team.
--
-- An account that isn't assigned to a brand sits in the "Unassigned"
-- bucket in the UI (= brand_id IS NULL).
--
-- Each brand has a color (hex code) so the UI can render a dot/pill in
-- the brand picker, calendar, and elsewhere later.
-- =====================================================================

CREATE TABLE brands (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    -- Hex color like "#0F766E". Used in the UI to render a dot/pill.
    color       TEXT NOT NULL DEFAULT '#6366F1',
    -- Optional display order (lower = higher in the list). 0 by default.
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT brand_color_format CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
    CONSTRAINT brand_name_not_empty CHECK (length(trim(name)) > 0)
);

-- A user can't have two brands with the same name.
CREATE UNIQUE INDEX brands_user_name_unique ON brands (user_id, lower(name));
CREATE INDEX idx_brands_user ON brands(user_id);

CREATE TRIGGER brands_updated_at
    BEFORE UPDATE ON brands
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE brands IS
    'Per-user groupings of connected social accounts. Each brand has a name + color.';

-- ---------------------------------------------------------------------
-- Add nullable brand_id to organic_connected_accounts.
-- NULL = "Unassigned" bucket. ON DELETE SET NULL so deleting a brand
-- doesn't cascade-delete the connected accounts — they just drop back
-- into Unassigned.
-- ---------------------------------------------------------------------
ALTER TABLE organic_connected_accounts
    ADD COLUMN brand_id UUID REFERENCES brands(id) ON DELETE SET NULL;

CREATE INDEX idx_organic_accounts_brand ON organic_connected_accounts(brand_id);

COMMENT ON COLUMN organic_connected_accounts.brand_id IS
    'Optional brand grouping. NULL = Unassigned bucket.';
