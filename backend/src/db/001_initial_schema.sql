-- ============================================================
-- Vass — Initial Database Schema
-- Postgres 16+
-- ============================================================
-- Design philosophy:
--   - Every table has id (uuid), created_at, updated_at
--   - Soft deletes via deleted_at where it matters (users, templates)
--   - Audit log captures every meaningful action for debugging + accountability
--   - Foreign keys are explicit; we lean on the DB to enforce integrity
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

-- ------------------------------------------------------------
-- Users — your team members
-- ------------------------------------------------------------
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           CITEXT UNIQUE NOT NULL,            -- case-insensitive email
    name            TEXT NOT NULL,
    password_hash   TEXT NOT NULL,                     -- bcrypt
    role            TEXT NOT NULL DEFAULT 'member',    -- 'admin' | 'member' | 'viewer'
    avatar_url      TEXT,
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ,
    CONSTRAINT role_check CHECK (role IN ('admin', 'member', 'viewer'))
);

CREATE INDEX idx_users_email ON users(email) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_role ON users(role) WHERE deleted_at IS NULL;

-- ------------------------------------------------------------
-- Sessions — server-side session store
-- ------------------------------------------------------------
CREATE TABLE sessions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL UNIQUE,              -- we store hash, not raw token
    expires_at      TIMESTAMPTZ NOT NULL,
    ip_address      INET,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_token ON sessions(token_hash);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- ------------------------------------------------------------
-- Ad Accounts — the Meta ad accounts available to launch into
-- We sync these from Meta on startup; users can pick from this list
-- ------------------------------------------------------------
CREATE TABLE ad_accounts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    meta_account_id TEXT UNIQUE NOT NULL,              -- "act_1234567890"
    name            TEXT NOT NULL,
    currency        TEXT,                              -- "USD", "EUR"
    timezone_name   TEXT,                              -- "America/Los_Angeles"
    business_id     TEXT,
    status          TEXT NOT NULL DEFAULT 'active',    -- 'active' | 'disabled'
    last_synced_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ad_accounts_status ON ad_accounts(status);

-- ------------------------------------------------------------
-- Copy Templates — saved primary text + headline + description sets
-- ------------------------------------------------------------
CREATE TABLE copy_templates (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            TEXT NOT NULL,
    primary_text    TEXT,
    headline        TEXT,
    description     TEXT,
    call_to_action  TEXT,                              -- e.g., "SHOP_NOW", "LEARN_MORE"
    tags            TEXT[],                            -- ["summer-sale", "evergreen"]
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    times_used      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

CREATE INDEX idx_templates_name ON copy_templates(name) WHERE deleted_at IS NULL;
CREATE INDEX idx_templates_tags ON copy_templates USING GIN(tags) WHERE deleted_at IS NULL;
CREATE INDEX idx_templates_created_by ON copy_templates(created_by) WHERE deleted_at IS NULL;

-- ------------------------------------------------------------
-- Launch Batches — every bulk launch operation
-- One batch can produce many individual ads
-- ------------------------------------------------------------
CREATE TABLE launch_batches (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id             UUID NOT NULL REFERENCES users(id),
    ad_account_id       UUID NOT NULL REFERENCES ad_accounts(id),
    name                TEXT,                              -- e.g., "Summer Sale Week 1"
    source              TEXT NOT NULL,                     -- 'manual' | 'sheets' | 'api'
    target_ad_set_ids   TEXT[] NOT NULL,                   -- Meta ad set IDs
    total_ads_planned   INTEGER NOT NULL DEFAULT 0,
    total_ads_launched  INTEGER NOT NULL DEFAULT 0,
    total_ads_failed    INTEGER NOT NULL DEFAULT 0,
    status              TEXT NOT NULL DEFAULT 'pending',   -- 'pending'|'running'|'completed'|'failed'|'partial'
    config              JSONB NOT NULL DEFAULT '{}',       -- enhancements off, URL params, etc.
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT status_check CHECK (status IN ('pending','running','completed','failed','partial'))
);

CREATE INDEX idx_batches_user ON launch_batches(user_id);
CREATE INDEX idx_batches_account ON launch_batches(ad_account_id);
CREATE INDEX idx_batches_status ON launch_batches(status);
CREATE INDEX idx_batches_created ON launch_batches(created_at DESC);

-- ------------------------------------------------------------
-- Individual Ad Launches — every ad inside a batch
-- ------------------------------------------------------------
CREATE TABLE ad_launches (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    batch_id            UUID NOT NULL REFERENCES launch_batches(id) ON DELETE CASCADE,
    ad_set_id           TEXT NOT NULL,                     -- Meta ad set ID
    ad_name             TEXT NOT NULL,
    creative_url        TEXT,                              -- where the image/video came from
    meta_ad_id          TEXT,                              -- populated on success
    meta_creative_id    TEXT,
    status              TEXT NOT NULL DEFAULT 'pending',   -- 'pending'|'launching'|'success'|'failed'
    error_message       TEXT,                              -- if status='failed'
    payload             JSONB NOT NULL DEFAULT '{}',       -- the full request we sent to Meta
    response            JSONB,                             -- Meta's response
    launched_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT launch_status_check CHECK (status IN ('pending','launching','success','failed'))
);

CREATE INDEX idx_launches_batch ON ad_launches(batch_id);
CREATE INDEX idx_launches_status ON ad_launches(status);
CREATE INDEX idx_launches_meta_ad ON ad_launches(meta_ad_id);

-- ------------------------------------------------------------
-- Audit Log — every meaningful action for debugging + accountability
-- ------------------------------------------------------------
CREATE TABLE audit_log (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    action          TEXT NOT NULL,                     -- 'user.login', 'batch.launched', 'template.created'
    resource_type   TEXT,                              -- 'user', 'batch', 'template'
    resource_id     UUID,
    metadata        JSONB NOT NULL DEFAULT '{}',
    ip_address      INET,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_user ON audit_log(user_id);
CREATE INDEX idx_audit_action ON audit_log(action);
CREATE INDEX idx_audit_resource ON audit_log(resource_type, resource_id);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);

-- ------------------------------------------------------------
-- Auto-update `updated_at` trigger
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER ad_accounts_updated_at BEFORE UPDATE ON ad_accounts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER copy_templates_updated_at BEFORE UPDATE ON copy_templates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
