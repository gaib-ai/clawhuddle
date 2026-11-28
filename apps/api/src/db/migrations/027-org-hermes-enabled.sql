-- Org switch: members may pick Hermes Agent when creating an instance. Off by
-- default; turning it off later only blocks new Hermes instances.
ALTER TABLE organizations ADD COLUMN hermes_enabled INTEGER NOT NULL DEFAULT 0;
