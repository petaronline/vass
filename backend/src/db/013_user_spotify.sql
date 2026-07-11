-- =====================================================================
-- Add per-user Spotify track URL.
--
-- Lightweight vibe feature: users can paste a Spotify track / playlist URL
-- and the dashboard renders Spotify's public embed iframe for that URL.
-- No OAuth, no Premium requirement — the user updates the URL whenever
-- their launch jam changes.
-- =====================================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS spotify_track_url TEXT;
