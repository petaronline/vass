-- ============================================================
-- Vass — Patch 2.5b: Audit existing ads
-- ============================================================
--
-- The audit feature scans existing ads in Meta to detect creative
-- enhancement settings (and multi-advertiser opt-in) that violate the
-- user's Vass defaults. Findings are persisted so the user can review,
-- select, and fix them in batches.
--
-- Two tables:
--   audit_runs       — one row per scan. Tracks scope + progress.
--   audit_findings   — one row per ad that violates defaults (or was scanned
--                      and came up clean, depending on store_clean flag).
--
-- Lifecycle of an audit:
--   1. POST /audits      → creates audit_runs row, status='pending'
--   2. Worker scans      → status='scanning', writes findings as it goes
--   3. Scan complete     → status='scanned', findings ready for review
--   4. POST /fix         → fix_status='queued' on selected findings,
--                          fix worker mutates AdCreatives in Meta
--   5. Finding fix done  → fix_status='fixed' (or 'failed')
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_runs (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ad_account_id      UUID NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,

    -- Scope captured at run time (so we can show "scanned 3 ad sets in
    -- Campaign Foo" even after the user moves on)
    meta_campaign_id   TEXT NOT NULL,
    meta_campaign_name TEXT,
    target_ad_set_ids  TEXT[] NOT NULL,
    active_only        BOOLEAN NOT NULL DEFAULT true,

    status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'scanning', 'scanned', 'failed')),
    error_message      TEXT,

    -- Progress counters (populated as the scan runs)
    ads_total          INTEGER NOT NULL DEFAULT 0,
    ads_scanned        INTEGER NOT NULL DEFAULT 0,
    findings_count     INTEGER NOT NULL DEFAULT 0,

    started_at         TIMESTAMPTZ,
    completed_at       TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_runs_user_idx
    ON audit_runs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_runs_account_idx
    ON audit_runs (ad_account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_findings (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    audit_run_id       UUID NOT NULL REFERENCES audit_runs(id) ON DELETE CASCADE,

    -- The ad itself (snapshotted from Meta at scan time)
    meta_ad_id         TEXT NOT NULL,
    meta_ad_name       TEXT,
    meta_ad_status     TEXT,            -- ACTIVE, PAUSED, etc.
    meta_ad_set_id     TEXT,
    meta_creative_id   TEXT NOT NULL,

    -- The actual snapshot of the ad's creative_features_spec + multi-ad setting
    -- as found at scan time. Stored as JSONB for diffing later.
    found_features     JSONB NOT NULL DEFAULT '{}'::jsonb,
    found_multi_ad     TEXT,            -- 'OPT_IN' | 'OPT_OUT' | NULL

    -- The list of keys that violate this account's resolved defaults.
    -- E.g. ['translate_text', 'image_brightness_and_contrast'] means these
    -- features are OPT_IN on Meta but Vass defaults say they should be OPT_OUT.
    -- Also includes 'multi_advertiser_ads' if that's wrong.
    violations         TEXT[] NOT NULL DEFAULT '{}',

    -- Fix flow state machine
    fix_status         TEXT NOT NULL DEFAULT 'pending'
                       CHECK (fix_status IN ('pending', 'queued', 'fixing', 'fixed', 'failed', 'skipped')),
    fix_error          TEXT,
    fix_started_at     TIMESTAMPTZ,
    fix_completed_at   TIMESTAMPTZ,

    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_findings_run_idx
    ON audit_findings (audit_run_id);
CREATE INDEX IF NOT EXISTS audit_findings_fix_status_idx
    ON audit_findings (fix_status)
    WHERE fix_status IN ('queued', 'fixing');

COMMENT ON TABLE audit_runs IS 'One row per audit scan. Tracks scope + progress.';
COMMENT ON TABLE audit_findings IS 'One row per ad with policy violations found during an audit scan.';
COMMENT ON COLUMN audit_findings.violations IS 'Array of keys that violate this account''s defaults. E.g. ["translate_text", "multi_advertiser_ads"].';
