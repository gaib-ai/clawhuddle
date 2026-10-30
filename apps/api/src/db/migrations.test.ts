import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * migrate.ts re-runs every migration file on every boot. The move to gateway
 * instances backfills rows from org_members and member_channels, so this pins
 * that a database from before the change ends up with exactly one slot-1 row
 * per gateway, that the copy is one-shot (a row the user later removed must
 * not come back on the next boot), and that the mirror keeps org_members in
 * step.
 */

const ORG = 'org-1';
const WITH_CHANNELS = 'm-channels';
const NO_SUBDOMAIN = 'm-nosub';
const NO_TOKEN = 'm-notoken';
let tmpDir: string;

const here = path.dirname(fileURLToPath(import.meta.url));

/** The schema as it was before instances existed: base schema + migrations up to 017. */
function applyLegacy(db: import('better-sqlite3').Database): void {
  db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf-8'));
  for (const file of fs.readdirSync(path.join(here, 'migrations')).sort()) {
    if (file >= '018-') break;
    try {
      db.exec(fs.readFileSync(path.join(here, 'migrations', file), 'utf-8'));
    } catch {
      // folded into schema.sql already
    }
  }
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawhuddle-migrations-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'db.sqlite');

  const { getDb } = await import('./index.js');
  const db = getDb();
  applyLegacy(db);

  db.prepare('INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)').run(ORG, 'Org', 'org');
  for (const [member, user, port, token, subdomain] of [
    [WITH_CHANNELS, 'u-channels', 6100, 'tok-channels', 'claw-aaaa0001'],
    [NO_SUBDOMAIN, 'u-nosub', 6100, 'tok-nosub', null],
    [NO_TOKEN, 'u-notoken', 6100, null, 'claw-aaaa0003'],
  ] as const) {
    db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(user, `${user}@example.com`);
    db.prepare(
      "INSERT INTO org_members (id, org_id, user_id, role, gateway_port, gateway_status, gateway_token, gateway_subdomain, slack_access_migrated_at) VALUES (?, ?, ?, 'member', ?, 'running', ?, ?, '2026-10-21')",
    ).run(member, ORG, user, port, token, subdomain);
  }
  db.prepare("INSERT INTO member_channels (member_id, channel, bot_token) VALUES (?, 'telegram', 'tg-token')").run(WITH_CHANNELS);
  db.prepare("INSERT INTO member_channels (member_id, channel, bot_token, app_token) VALUES (?, 'slack', 'xoxb', 'xapp')").run(WITH_CHANNELS);
  db.prepare("INSERT INTO port_forwards (id, org_id, member_id, subdomain, port) VALUES ('pf-1', ?, ?, 'webhook', 8080)").run(ORG, WITH_CHANNELS);

  const { applyMigrations } = await import('./apply-migrations.js');
  for (let i = 0; i < 3; i++) applyMigrations(db, () => {});
});

afterAll(async () => {
  const { closeDb } = await import('./index.js');
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('gateway instance backfill', () => {
  it('creates one slot-1 row per deployed member, however many times it runs', async () => {
    const { getDb } = await import('./index.js');
    const rows = getDb().prepare('SELECT * FROM gateways ORDER BY member_id').all() as any[];
    expect(rows.map((r) => [r.id, r.member_id, r.slot])).toEqual([
      [`gw-${WITH_CHANNELS}`, WITH_CHANNELS, 1],
      [`gw-${NO_SUBDOMAIN}`, NO_SUBDOMAIN, 1],
    ]);
    expect(rows[0]).toMatchObject({ org_id: ORG, status: 'running', port: 6100, token: 'tok-channels', subdomain: 'claw-aaaa0001', slack_access_migrated_at: '2026-10-21', primary_provider: null });
  });

  it('gives a row without a subdomain a gateway-style one', async () => {
    const { getDb } = await import('./index.js');
    const row = getDb().prepare('SELECT subdomain FROM gateways WHERE member_id = ?').get(NO_SUBDOMAIN) as { subdomain: string };
    expect(row.subdomain).toMatch(/^claw-[0-9a-f]{8}$/);
  });

  it('skips a member whose gateway never got a token', async () => {
    const { getDb } = await import('./index.js');
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM gateways WHERE member_id = ?').get(NO_TOKEN)).toEqual({ n: 0 });
  });

  it('moves channel tokens to the slot-1 instance', async () => {
    const { getDb } = await import('./index.js');
    const rows = getDb().prepare('SELECT channel, bot_token, app_token FROM gateway_channels ORDER BY channel').all();
    expect(rows).toEqual([
      { channel: 'slack', bot_token: 'xoxb', app_token: 'xapp' },
      { channel: 'telegram', bot_token: 'tg-token', app_token: null },
    ]);
  });

  it('points existing port forwards at the slot-1 instance', async () => {
    const { getDb } = await import('./index.js');
    expect(getDb().prepare('SELECT gateway_id FROM port_forwards WHERE id = ?').get('pf-1')).toEqual({ gateway_id: `gw-${WITH_CHANNELS}` });
  });

  it('records that the backfill ran', async () => {
    const { getDb } = await import('./index.js');
    expect(getDb().prepare('SELECT name FROM migration_marks').all()).toEqual([{ name: '020-gateways' }]);
  });

  it('does not resurrect a channel or an instance the user removed', async () => {
    const { getDb } = await import('./index.js');
    const { deleteGatewayRow } = await import('../services/gateway-store.js');
    const { applyMigrations } = await import('./apply-migrations.js');
    const db = getDb();

    db.prepare("DELETE FROM gateway_channels WHERE gateway_id = ? AND channel = 'telegram'").run(`gw-${WITH_CHANNELS}`);
    deleteGatewayRow(`gw-${NO_SUBDOMAIN}`);
    applyMigrations(db, () => {});

    expect(db.prepare('SELECT channel FROM gateway_channels').all()).toEqual([{ channel: 'slack' }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM gateways WHERE member_id = ?').get(NO_SUBDOMAIN)).toEqual({ n: 0 });
    // the mirror cleared the legacy columns, so an older build sees no gateway either
    expect(db.prepare('SELECT gateway_port, gateway_status, gateway_token, gateway_subdomain FROM org_members WHERE id = ?').get(NO_SUBDOMAIN))
      .toEqual({ gateway_port: null, gateway_status: null, gateway_token: null, gateway_subdomain: null });
  });
});
