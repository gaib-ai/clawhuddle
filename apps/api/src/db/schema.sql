-- Users (authentication records, synced via NextAuth on login)
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    avatar_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME
);

-- Organizations
CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    tier TEXT NOT NULL DEFAULT 'free',
    primary_provider TEXT,
    primary_model TEXT,
    max_gateways_per_user INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Organization members (links users to orgs with roles). The gateway_* columns
-- mirror the member's slot-1 row in `gateways` and are not read by new code.
CREATE TABLE IF NOT EXISTS org_members (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organizations(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    role TEXT NOT NULL DEFAULT 'member',
    status TEXT NOT NULL DEFAULT 'active',
    gateway_port INTEGER,
    gateway_status TEXT,
    gateway_token TEXT,
    gateway_subdomain TEXT,
    primary_provider TEXT,
    slack_access_migrated_at TEXT,
    max_gateways INTEGER,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(org_id, user_id)
);

-- Gateway instances: one row per OpenClaw container (see migrations/020-gateways.sql)
CREATE TABLE IF NOT EXISTS migration_marks (
    name TEXT PRIMARY KEY,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS gateways (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organizations(id),
    member_id TEXT NOT NULL REFERENCES org_members(id) ON DELETE CASCADE,
    slot INTEGER NOT NULL,
    label TEXT,
    status TEXT,
    port INTEGER,
    token TEXT NOT NULL,
    subdomain TEXT UNIQUE NOT NULL,
    primary_provider TEXT,
    primary_model TEXT,
    slack_access_migrated_at TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(member_id, slot)
);
CREATE INDEX IF NOT EXISTS idx_gateways_org ON gateways(org_id);

CREATE TABLE IF NOT EXISTS gateway_channels (
    gateway_id TEXT NOT NULL REFERENCES gateways(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    bot_token TEXT NOT NULL,
    app_token TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (gateway_id, channel)
);

-- Invitations
CREATE TABLE IF NOT EXISTS invitations (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organizations(id),
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    token TEXT UNIQUE NOT NULL,
    invited_by TEXT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL
);

-- Skills (org-scoped, git-backed)
CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    type TEXT NOT NULL DEFAULT 'optional',
    path TEXT NOT NULL,
    git_url TEXT,
    git_path TEXT,
    org_id TEXT REFERENCES organizations(id),
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- User skill preferences (per-user toggle for optional skills)
CREATE TABLE IF NOT EXISTS user_skills (
    user_id TEXT NOT NULL REFERENCES users(id),
    skill_id TEXT NOT NULL REFERENCES skills(id),
    enabled INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, skill_id)
);

-- API keys (org-scoped, with optional per-user overrides).
-- user_id IS NULL  -> organization default
-- user_id NOT NULL -> personal override; resolution prefers user keys over org keys per-provider.
CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    key_value TEXT NOT NULL,
    is_company_default INTEGER NOT NULL DEFAULT 0,
    org_id TEXT REFERENCES organizations(id),
    user_id TEXT REFERENCES users(id),
    credential_type TEXT NOT NULL DEFAULT 'api_key',
    default_model TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Access allowlist (empty = open registration)
CREATE TABLE IF NOT EXISTS access_allowlist (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,    -- 'domain' or 'email'
    value TEXT NOT NULL,   -- e.g. 'company.com' or 'xxx@gmail.com'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(type, value)
);

-- Usage logs
CREATE TABLE IF NOT EXISTS usage_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT REFERENCES users(id),
    provider TEXT,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    org_id TEXT REFERENCES organizations(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
