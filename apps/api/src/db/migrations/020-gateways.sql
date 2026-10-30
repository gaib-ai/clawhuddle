-- One row per OpenClaw container. A member may own several, numbered by slot:
-- slot 1 keeps the legacy container name clawhuddle-gw-<org8>-<user8> and data
-- dir <orgId>/<userId>; slot N>=2 gets a "-N" suffix on both. org_members'
-- gateway_* columns are mirrored from the slot-1 row (gateway-store.ts) so an
-- older build still finds the first instance; new code must not read them.
--
-- migrate.ts re-runs every file on every boot, so each statement here must be
-- a no-op the second time. The backfills are guarded by migration_marks rather
-- than relying on INSERT OR IGNORE alone, or a gateway/channel the user later
-- deleted would come back on the next boot.
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
    slack_access_migrated_at TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(member_id, slot)
);
CREATE INDEX IF NOT EXISTS idx_gateways_org ON gateways(org_id);

-- Channel bot tokens are per instance: a Slack Socket Mode app or a Telegram
-- bot can only be consumed by one container.
CREATE TABLE IF NOT EXISTS gateway_channels (
    gateway_id TEXT NOT NULL REFERENCES gateways(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    bot_token TEXT NOT NULL,
    app_token TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (gateway_id, channel)
);

-- Slot-1 row for every member that already has a gateway. Rows without a token
-- were never deployable and are skipped rather than failing the boot.
INSERT OR IGNORE INTO gateways
    (id, org_id, member_id, slot, status, port, token, subdomain, slack_access_migrated_at, created_at)
SELECT 'gw-' || om.id, om.org_id, om.id, 1, om.gateway_status, om.gateway_port, om.gateway_token,
       COALESCE(om.gateway_subdomain, 'claw-' || lower(hex(randomblob(4)))),
       om.slack_access_migrated_at, om.joined_at
FROM org_members om
WHERE om.gateway_port IS NOT NULL AND om.gateway_token IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM migration_marks WHERE name = '020-gateways');

INSERT OR IGNORE INTO gateway_channels (gateway_id, channel, bot_token, app_token, created_at, updated_at)
SELECT g.id, mc.channel, mc.bot_token, mc.app_token, mc.created_at, mc.updated_at
FROM member_channels mc
JOIN gateways g ON g.member_id = mc.member_id AND g.slot = 1
WHERE NOT EXISTS (SELECT 1 FROM migration_marks WHERE name = '020-gateways');

INSERT OR IGNORE INTO migration_marks (name) VALUES ('020-gateways');
