-- 036_per_target_media.sql
-- Per-network media customization. Until now a post had ONE set of media
-- (organic_post_media keyed by post_id + reply_index) shared by every target.
--
-- Now, when "Customize per network" is on, a target can carry its OWN media
-- (e.g. a PDF to LinkedIn while IG/FB get a carousel). We model this by
-- adding a nullable target_id to organic_post_media:
--   target_id IS NULL  -> shared/parent media (the default, unchanged behaviour)
--   target_id = <uuid> -> media belonging ONLY to that target's override
--
-- The publish runner resolves a target's media as: its own (target_id =
-- target) if any exist, else the shared rows (target_id IS NULL).

ALTER TABLE organic_post_media
  ADD COLUMN IF NOT EXISTS target_id UUID
  REFERENCES organic_post_targets(id) ON DELETE CASCADE;

-- Fast lookup of a target's own media.
CREATE INDEX IF NOT EXISTS idx_post_media_target
  ON organic_post_media (target_id)
  WHERE target_id IS NOT NULL;
