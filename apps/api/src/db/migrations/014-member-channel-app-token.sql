-- Slack (and other socket-mode channels) need a second token alongside bot_token.
-- For Slack: bot_token = xoxb-… , app_token = xapp-… (app-level token for Socket Mode / DMs).
ALTER TABLE member_channels ADD COLUMN app_token TEXT;
