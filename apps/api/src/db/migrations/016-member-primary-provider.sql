-- Per-member primary provider override. NULL = follow the org default
-- (organizations.primary_provider); set = pin this provider for the member's gateway.
ALTER TABLE org_members ADD COLUMN primary_provider TEXT;
