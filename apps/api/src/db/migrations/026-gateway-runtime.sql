-- Which agent software an instance runs: 'openclaw' (every instance before
-- 2026-11-28) or 'hermes'. Set at creation, never changed.
ALTER TABLE gateways ADD COLUMN runtime TEXT NOT NULL DEFAULT 'openclaw';
