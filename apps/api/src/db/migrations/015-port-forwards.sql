-- Port forwards: admin-managed traefik routes exposing a port inside a member's
-- gateway container on a public subdomain (e.g. webhook-hung.gaib.cloud -> :8080).
CREATE TABLE IF NOT EXISTS port_forwards (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organizations(id),
    member_id TEXT NOT NULL REFERENCES org_members(id),
    subdomain TEXT UNIQUE NOT NULL,
    port INTEGER NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
