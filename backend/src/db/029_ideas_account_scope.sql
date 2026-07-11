-- =====================================================================
-- Patch 4.37.5 — Ideas can be tied to either a brand OR a profile.
--
-- Until now organic_ideas.brand_id was NOT NULL. With the new
-- profile-level scope picker, the user can now have a profile (not a
-- brand) as active context — and that profile may even be ungrouped
-- (brand_id IS NULL on the account). In that case there's no brand
-- to attach the idea to.
--
-- New shape:
--   - brand_id is now NULLABLE
--   - account_id (FK to organic_connected_accounts) is added, NULLABLE
--   - An idea must have at least one of (brand_id, account_id) set
--     (enforced via CHECK)
--
-- When the user creates an idea while a profile is selected, we set
-- account_id = that profile, and brand_id = the profile's parent
-- brand (or NULL if ungrouped). That way the Ideas page filtered to
-- a brand still surfaces all the profile-tied ideas under it without
-- a special-case query.
-- =====================================================================

-- Make brand_id nullable. Existing rows are unaffected.
ALTER TABLE organic_ideas
    ALTER COLUMN brand_id DROP NOT NULL;

-- Add the profile FK. ON DELETE SET NULL because losing the profile
-- shouldn't destroy the idea — we still want it under its brand.
ALTER TABLE organic_ideas
    ADD COLUMN account_id UUID
        REFERENCES organic_connected_accounts(id) ON DELETE SET NULL;

CREATE INDEX idx_organic_ideas_account ON organic_ideas(account_id);

-- At least one of (brand_id, account_id) must be set. The check name
-- is explicit so future migrations can drop/replace it cleanly.
ALTER TABLE organic_ideas
    ADD CONSTRAINT idea_must_have_scope
        CHECK (brand_id IS NOT NULL OR account_id IS NOT NULL);

COMMENT ON COLUMN organic_ideas.account_id IS
    'When set, this idea is tied to a specific profile (FB page, IG, Threads). '
    'Independent of brand_id — both can be set (profile-tied idea in a brand) '
    'or just account_id (ungrouped profile idea) or just brand_id (brand-level idea).';
