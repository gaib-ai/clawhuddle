import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locking down the pre-2026-10-21 wide-open Slack default is a one-time
 * migration. A member who opens Slack again afterwards — even to exactly that
 * old default — must keep it across later config syncs and redeploys.
 */

const ORG = 'org-1';
const USER = 'user-1';
const MEMBER = 'member-1';
let tmpDir: string;

const configPath = () => path.join(tmpDir, 'data', 'gateways', ORG, USER, 'openclaw.json');
const legacyOpenSlack = {
  enabled: true,
  mode: 'socket',
  botToken: 'xoxb-test',
  appToken: 'xapp-test',
  groupPolicy: 'open',
  allowBots: true,
  dmPolicy: 'open',
  allowFrom: ['*'],
};
const readConfig = () => JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
const writeSlack = (slack: Record<string, unknown>) => {
  const config = readConfig();
  config.channels = { ...config.channels, slack };
  fs.writeFileSync(configPath(), JSON.stringify(config));
};

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawhuddle-slack-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'db.sqlite');
  process.env.DATA_DIR = path.join(tmpDir, 'data');

  const { getDb } = await import('../db/index.js');
  const db = getDb();
  const dbDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../db');
  db.exec(fs.readFileSync(path.join(dbDir, 'schema.sql'), 'utf-8'));
  // Same as migrate.ts: migrations already folded into schema.sql fail and are skipped
  for (const file of fs.readdirSync(path.join(dbDir, 'migrations')).sort()) {
    try {
      db.exec(fs.readFileSync(path.join(dbDir, 'migrations', file), 'utf-8'));
    } catch {
      // already applied
    }
  }
  db.prepare('INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)').run(ORG, 'Org', 'org');
  db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(USER, 'member@example.com');
  db.prepare(
    "INSERT INTO org_members (id, org_id, user_id, role, gateway_port, gateway_status, gateway_token, gateway_subdomain) VALUES (?, ?, ?, 'member', 6100, 'stopped', 'gw-token', 'claw-test')",
  ).run(MEMBER, ORG, USER);

  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify({ channels: { slack: legacyOpenSlack } }));
});

afterAll(async () => {
  const { closeDb } = await import('../db/index.js');
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('legacy-open Slack lockdown', () => {
  it('locks down the old default on the first sync and records that it ran', async () => {
    const { syncAuthProfilesForUser } = await import('./gateway.js');
    syncAuthProfilesForUser(ORG, USER);

    expect(readConfig().channels.slack).toMatchObject({ dmPolicy: 'pairing', groupPolicy: 'allowlist', allowBots: false });
    const { getDb } = await import('../db/index.js');
    const row = getDb().prepare('SELECT slack_access_migrated_at FROM org_members WHERE id = ?').get(MEMBER) as {
      slack_access_migrated_at: string | null;
    };
    expect(row.slack_access_migrated_at).not.toBeNull();
  });

  it('leaves Slack the member opened again alone on later syncs', async () => {
    writeSlack(legacyOpenSlack);
    const { syncAuthProfilesForUser } = await import('./gateway.js');
    syncAuthProfilesForUser(ORG, USER);

    expect(readConfig().channels.slack).toMatchObject({ dmPolicy: 'open', allowFrom: ['*'], groupPolicy: 'open', allowBots: true });
  });
});
