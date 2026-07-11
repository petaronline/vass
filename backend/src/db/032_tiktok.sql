-- =====================================================================
-- Patch 4.43.0 — TikTok publishing, layer 1 (foundation).
--
-- Adds TikTok as an organic platform. TikTok differs from the existing
-- platforms in one structural way: its access tokens are short-lived
-- (~24h) and MUST be refreshed using a separate refresh token (valid
-- ~365 days). The other platforms either don't expire meaningfully
-- (FB page tokens) or are the user's problem (Threads 60-day). So we
-- add a dedicated encrypted refresh-token column.
-- =====================================================================

-- 1. Allow 'tiktok' as a platform value.
ALTER TABLE organic_connected_accounts
    DROP CONSTRAINT IF EXISTS platform_check;
ALTER TABLE organic_connected_accounts
    ADD CONSTRAINT platform_check
    CHECK (platform IN ('facebook_page', 'instagram', 'threads', 'tiktok'));

-- 2. Encrypted refresh token (AES-256-GCM, same scheme as access token).
--    Null for non-TikTok platforms.
ALTER TABLE organic_connected_accounts
    ADD COLUMN IF NOT EXISTS refresh_token_encrypted TEXT;

-- 3. When the refresh token itself expires (≈365 days). After this the
--    user must re-authorize. Null for platforms that don't use refresh.
ALTER TABLE organic_connected_accounts
    ADD COLUMN IF NOT EXISTS refresh_token_expires_at TIMESTAMPTZ;

COMMENT ON COLUMN organic_connected_accounts.refresh_token_encrypted IS
    'TikTok only: encrypted OAuth refresh token, used to mint a new '
    'short-lived access token when token_expires_at passes.';
COMMENT ON COLUMN organic_connected_accounts.refresh_token_expires_at IS
    'TikTok only: when the refresh token expires (~365d). Past this, '
    'the user must re-authorize from scratch.';
