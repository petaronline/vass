-- =====================================================================
-- Patch 4.32 — Collaborators (IG-only, with placeholder for future
-- platforms).
--
-- IG accepts up to 3 collaborator usernames on the media container. FB
-- does not currently expose collaborator invites via the Graph API, so
-- the publisher silently drops collaborators for FB targets.
--
-- We store the list as TEXT[] (Postgres array) — simpler than a join
-- table for ≤3 string values per post.
-- =====================================================================

ALTER TABLE organic_posts
    ADD COLUMN collaborators TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

COMMENT ON COLUMN organic_posts.collaborators IS
    'Collaborator usernames to invite. IG only — up to 3.';
