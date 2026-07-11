-- =====================================================================
-- Patch 4.38.0 — Ad accounts can belong to a brand (Group).
--
-- Until now `brands` only grouped organic profiles
-- (organic_connected_accounts.brand_id). To make a brand represent a
-- whole *client* — their organic profiles AND their ad account(s) —
-- we add the same nullable brand_id to ad_accounts.
--
-- An ad account belongs to zero or one brand. ON DELETE SET NULL so
-- deleting a brand un-groups its ad accounts (doesn't delete them).
-- =====================================================================

ALTER TABLE ad_accounts
    ADD COLUMN brand_id UUID REFERENCES brands(id) ON DELETE SET NULL;

CREATE INDEX idx_ad_accounts_brand ON ad_accounts(brand_id);

COMMENT ON COLUMN ad_accounts.brand_id IS
    'Optional brand (Group) this ad account belongs to. Mirrors '
    'organic_connected_accounts.brand_id so a brand can represent a '
    'whole client across paid + organic.';
