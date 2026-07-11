-- ============================================================
-- Vass — Patch 2.5e: duplicate-and-replace audit fix
-- ============================================================
--
-- Meta does not allow PATCHing creative_features_spec on an existing
-- AdCreative (error 1815573 — only name/status/adlabels are mutable).
-- To "fix" an ad's enhancement settings we must:
--   1. Create a NEW AdCreative cloning the source's fields, with the
--      targeted enhancement keys flipped to OPT_OUT
--   2. Update the Ad to point at the new creative
--
-- We persist the new creative ID so the UI can show what happened
-- (and so users can audit "this ad's creative was swapped on this date").
-- ============================================================

ALTER TABLE audit_findings
    ADD COLUMN IF NOT EXISTS new_creative_id TEXT;

COMMENT ON COLUMN audit_findings.new_creative_id IS
    'When fix_status=fixed via duplicate-and-replace, the new AdCreative ID that replaced meta_creative_id. NULL means either not fixed or fixed via the legacy in-place PATCH path (which Meta has since disabled).';
