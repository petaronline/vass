-- 040_fix_target_status_constraint.sql
-- Repair target_status_check on organic_post_targets.
--
-- Why this exists:
--   027 rewrote this constraint to add 'deleted' but accidentally omitted
--   'scheduled' (introduced in 020). Two failure modes resulted:
--
--     a) Boxes that had scheduled targets: 027 FAILED outright
--        ("check constraint target_status_check is violated by some row"),
--        which blocked every later migration behind it. Those boxes kept
--        020's constraint, which has no 'deleted' — so the meta-sync
--        tombstone pass errored on every deleted post.
--
--     b) Boxes where 027 DID apply: 'scheduled' became illegal, so
--        scheduling a post could fail.
--
--   027 has been corrected in place for case (a) (the runner tracks by
--   filename, so boxes that already applied it skip it and are unaffected).
--   This migration exists for case (b) — it re-asserts the correct union on
--   boxes where the broken 027 already ran.
--
-- Idempotent: safe to run anywhere, including right after the fixed 027.

ALTER TABLE organic_post_targets
    DROP CONSTRAINT IF EXISTS target_status_check;

ALTER TABLE organic_post_targets
    ADD CONSTRAINT target_status_check
    CHECK (status IN ('pending','scheduled','publishing','published','failed','skipped','deleted'));
