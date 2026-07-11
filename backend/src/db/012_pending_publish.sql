-- ============================================================
-- Vass — Patch 2.5g: pending_publish status for audit findings
-- ============================================================
--
-- When Vass swaps a creative on an existing ad, Meta puts the ad into
-- "Unpublished edits" state. The new creative is wired up via API but
-- the live serving ad still uses the old one until someone clicks
-- "Publish" in Meta Ads Manager UI.
--
-- We introduce a `pending_publish` state to represent this: the API
-- swap worked, but the change isn't live yet. After the user publishes
-- in Meta UI and runs a re-scan, we either mark the finding as `fixed`
-- (if violations are gone) or back to `pending` (if Meta auto-enrolled
-- new enhancements or the publish didn't take).
-- ============================================================

ALTER TABLE audit_findings
    DROP CONSTRAINT IF EXISTS audit_findings_fix_status_check;

ALTER TABLE audit_findings
    ADD CONSTRAINT audit_findings_fix_status_check
    CHECK (fix_status IN (
        'pending',
        'queued',
        'fixing',
        'pending_publish',
        'fixed',
        'failed',
        'skipped'
    ));

COMMENT ON COLUMN audit_findings.fix_status IS
    'pending → queued → fixing → pending_publish (creative swapped on Meta but not yet published in Ads Manager UI) → fixed (re-scan confirms violations gone). Or fixing → failed. Re-scan can flip pending_publish back to pending if Meta auto-re-enrolled enhancements.';
