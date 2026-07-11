-- =====================================================================
-- Patch 4.34 — Threads integration.
--
-- Adds:
--   1. app_settings rows for the Threads Meta App (separate from FB/IG
--      since Meta requires a different app registration for Threads).
--   2. Topic tag + reply chain columns on organic_posts. Topic tag is
--      Threads-only (max 50 chars enforced by API, not by us). Reply
--      chain stores just the text bodies of replies 2..N; reply media
--      lives in organic_post_media with reply_index.
--   3. reply_index column on organic_post_media so media can belong
--      either to the main post (reply_index=0) or to one of the up-to-4
--      reply posts (reply_index 1..4). Single source of truth for media
--      across the whole thread.
--
-- 'threads' was already a permitted value in the organic_accounts
-- platform_check from migration 016 — no schema change there. Same
-- for oauth_states.platform — already accepts 'threads'.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Seed the Threads app-settings keys. value=plaintext (app id,
--    redirect uri); encrypted_value=AES-256-GCM (app secret).
--    Admins fill these in via Settings → Workspace API Keys.
-- ---------------------------------------------------------------------
INSERT INTO app_settings (key) VALUES
    ('threads.app_id'),
    ('threads.app_secret'),       -- encrypted_value
    ('threads.redirect_uri')      -- optional override; falls back to /api/organic/threads/callback
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------
-- 2. organic_posts columns for Threads-specific data.
-- ---------------------------------------------------------------------
ALTER TABLE organic_posts
    ADD COLUMN topic_tag    TEXT,
    ADD COLUMN reply_chain  JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN organic_posts.topic_tag IS
    'Threads topic_tag — single string, max 50 chars, no periods/ampersands/whitespace. '
    'Ignored by FB/IG. Applies only to the head post of a reply chain.';

COMMENT ON COLUMN organic_posts.reply_chain IS
    'Threads-only reply chain. JSON array of up to 4 entries (head post is in body+media), '
    'each: { body: string }. Reply media lives in organic_post_media with reply_index 1..4.';

-- Sanity guard so a malformed UPDATE can''t silently break the publisher.
ALTER TABLE organic_posts
    ADD CONSTRAINT reply_chain_is_array CHECK (jsonb_typeof(reply_chain) = 'array');

-- ---------------------------------------------------------------------
-- 3. organic_post_media reply_index — 0 = head post, 1..4 = reply 1..4.
-- ---------------------------------------------------------------------
ALTER TABLE organic_post_media
    ADD COLUMN reply_index SMALLINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN organic_post_media.reply_index IS
    'Position in a Threads reply chain. 0 = main post media, 1..4 = reply N media. '
    'Always 0 for FB/IG posts.';

ALTER TABLE organic_post_media
    ADD CONSTRAINT reply_index_range CHECK (reply_index BETWEEN 0 AND 4);
