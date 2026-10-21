-- When mergeOpenClawConfig first checked this member's gateway for the pre-2026-10-21
-- wide-open Slack default. NULL = not checked yet (the next config merge locks it
-- down if it still matches); set = the Slack block is the member's from then on.
ALTER TABLE org_members ADD COLUMN slack_access_migrated_at TEXT;
