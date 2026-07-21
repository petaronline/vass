-- 041_notifications.sql
-- In-app notifications for the top-bar bell.
--
-- Events recorded here:
--   launch.completed / launch.failed  — a launch batch reached a terminal state
--   comment_guard.hidden              — Comment Guard hid comments in a sweep
--   meta.token_expiring               — a connected account's token expires soon
--   sync.error                        — an account failed during the hourly sync
--
-- dedupe_key exists so recurring conditions don't spam the bell: writers pass a
-- stable key (e.g. "launch:<batchId>" or "syncerr:<accountId>:<date>") and the
-- partial unique index below turns a repeat insert into a no-op.

CREATE TABLE IF NOT EXISTS notifications (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- dotted event name, e.g. 'launch.completed'
    type         TEXT NOT NULL,
    -- info | success | warning | error  (drives the dot color in the UI)
    severity     TEXT NOT NULL DEFAULT 'info',
    title        TEXT NOT NULL,
    body         TEXT,
    -- optional in-app link, e.g. '/launches/<id>'
    link         TEXT,
    metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
    dedupe_key   TEXT,
    read_at      TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user
    ON notifications (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_unread
    ON notifications (user_id) WHERE read_at IS NULL;

-- Repeat writes with the same key collapse into one notification.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe
    ON notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
