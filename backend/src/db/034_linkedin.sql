-- =====================================================================
-- Patch 4.45.0 — LinkedIn publishing.
--
-- Adds LinkedIn as an organic platform. LinkedIn reuses the existing
-- connection model wholesale: OAuth 2.0 with a ~60-day access token and
-- a ~365-day refresh token — the same refresh_token_encrypted /
-- refresh_token_expires_at columns added for TikTok in migration 032.
--
-- No per-post settings columns are needed (unlike TikTok's privacy /
-- disclosure). LinkedIn posts carry only body + media, and the author
-- (person vs. organization page) is determined by which connected
-- account row the post targets — stored in that row's meta.author_urn.
-- =====================================================================

-- Allow 'linkedin' as a platform value.
ALTER TABLE organic_connected_accounts
    DROP CONSTRAINT IF EXISTS platform_check;
ALTER TABLE organic_connected_accounts
    ADD CONSTRAINT platform_check
    CHECK (platform IN ('facebook_page', 'instagram', 'threads', 'tiktok', 'linkedin'));
