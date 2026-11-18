CREATE TABLE IF NOT EXISTS usage_snapshots (
    org_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    taken_at TEXT NOT NULL,
    data TEXT NOT NULL
);
