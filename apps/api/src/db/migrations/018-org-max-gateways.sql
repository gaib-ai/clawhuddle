-- Org-level cap on gateway instances per member. NULL = platform default
-- (MAX_GATEWAYS_PER_USER env var, else 1). org_members.max_gateways overrides it.
ALTER TABLE organizations ADD COLUMN max_gateways_per_user INTEGER;
