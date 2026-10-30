-- Per-member override of organizations.max_gateways_per_user. NULL = follow the org.
ALTER TABLE org_members ADD COLUMN max_gateways INTEGER;
