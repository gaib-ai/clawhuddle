import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Slot 1 must keep the container name and directory from before instances
 * existed: those are the containers already running in production. The limit
 * is the only thing stopping a member from filling the host with containers,
 * so its precedence (member > org > platform) is pinned too.
 */

const ORG = '515e3d1b-9c8c-41d7-9223-96d800df90f8';
const USER = '7cf153b9-3c38-4531-bc8a-cc2434c91e42';
const MEMBER = 'member-1';
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawhuddle-store-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'db.sqlite');

  const { getDb } = await import('../db/index.js');
  const { applyMigrations } = await import('../db/apply-migrations.js');
  const db = getDb();
  applyMigrations(db, () => {});
  db.prepare('INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)').run(ORG, 'Org', 'org');
  db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(USER, 'tools@example.com');
  db.prepare("INSERT INTO org_members (id, org_id, user_id, role) VALUES (?, ?, ?, 'member')").run(MEMBER, ORG, USER);
});

afterAll(async () => {
  const { closeDb } = await import('../db/index.js');
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(async () => {
  delete process.env.MAX_GATEWAYS_PER_USER;
  const { getDb } = await import('../db/index.js');
  getDb().prepare('DELETE FROM gateways').run();
  getDb().prepare('UPDATE org_members SET max_gateways = NULL').run();
  getDb().prepare('UPDATE organizations SET max_gateways_per_user = NULL').run();
});

describe('naming', () => {
  it('keeps the legacy container name and directory for slot 1', async () => {
    const { getContainerName, getGatewayDir } = await import('./gateway-store.js');
    expect(getContainerName(ORG, USER)).toBe('clawhuddle-gw-515e3d1b-7cf153b9');
    expect(getContainerName(ORG, USER, 1)).toBe('clawhuddle-gw-515e3d1b-7cf153b9');
    process.env.DATA_DIR = '/data';
    expect(getGatewayDir({ org_id: ORG, user_id: USER, slot: 1 })).toBe(`/data/gateways/${ORG}/${USER}`);
  });

  it('suffixes later slots on both', async () => {
    const { getContainerName, getGatewayDir } = await import('./gateway-store.js');
    expect(getContainerName(ORG, USER, 2)).toBe('clawhuddle-gw-515e3d1b-7cf153b9-2');
    expect(getContainerName(ORG, USER, 12).length).toBeLessThan(63);
    process.env.DATA_DIR = '/data';
    expect(getGatewayDir({ org_id: ORG, user_id: USER, slot: 2 })).toBe(`/data/gateways/${ORG}/${USER}-2`);
  });
});

describe('effective limit', () => {
  it('defaults to one instance', async () => {
    const { effectiveGatewayLimit } = await import('./gateway-store.js');
    expect(effectiveGatewayLimit(ORG, MEMBER)).toEqual({ limit: 1, current: 0 });
  });

  it('is overridden by the env var, then the org, then the member', async () => {
    const { effectiveGatewayLimit } = await import('./gateway-store.js');
    const { getDb } = await import('../db/index.js');
    process.env.MAX_GATEWAYS_PER_USER = '3';
    expect(effectiveGatewayLimit(ORG, MEMBER).limit).toBe(3);
    getDb().prepare('UPDATE organizations SET max_gateways_per_user = 2 WHERE id = ?').run(ORG);
    expect(effectiveGatewayLimit(ORG, MEMBER).limit).toBe(2);
    getDb().prepare('UPDATE org_members SET max_gateways = 5 WHERE id = ?').run(MEMBER);
    expect(effectiveGatewayLimit(ORG, MEMBER).limit).toBe(5);
    getDb().prepare('UPDATE org_members SET max_gateways = NULL WHERE id = ?').run(MEMBER);
    expect(effectiveGatewayLimit(ORG, MEMBER).limit).toBe(2);
  });
});

describe('createGatewayRow', () => {
  it('fills the lowest free slot and refuses past the limit', async () => {
    const { createGatewayRow, deleteGatewayRow, GatewayLimitError } = await import('./gateway-store.js');
    const { getDb } = await import('../db/index.js');
    getDb().prepare('UPDATE org_members SET max_gateways = 2 WHERE id = ?').run(MEMBER);

    const first = createGatewayRow(ORG, MEMBER);
    const second = createGatewayRow(ORG, MEMBER, { label: 'research' });
    expect([first.slot, second.slot]).toEqual([1, 2]);
    expect(second.label).toBe('research');
    expect(first.subdomain).not.toBe(second.subdomain);
    expect(first.status).toBe('provisioning');

    let err: unknown;
    try {
      createGatewayRow(ORG, MEMBER);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GatewayLimitError);
    expect(err).toMatchObject({ code: 'gateway_limit', limit: 2, current: 2 });

    deleteGatewayRow(first.id);
    expect(createGatewayRow(ORG, MEMBER).slot).toBe(1);
  });

  it('mirrors only slot 1 onto org_members', async () => {
    const { createGatewayRow, deleteGatewayRow, setGatewayState } = await import('./gateway-store.js');
    const { getDb } = await import('../db/index.js');
    const db = getDb();
    db.prepare('UPDATE org_members SET max_gateways = 2 WHERE id = ?').run(MEMBER);
    const legacy = () =>
      db.prepare('SELECT gateway_port, gateway_status, gateway_token, gateway_subdomain FROM org_members WHERE id = ?').get(MEMBER);

    const first = createGatewayRow(ORG, MEMBER);
    expect(legacy()).toEqual({ gateway_port: 6100, gateway_status: 'provisioning', gateway_token: first.token, gateway_subdomain: first.subdomain });

    const second = createGatewayRow(ORG, MEMBER);
    setGatewayState(second.id, { status: 'running' });
    expect(legacy()).toMatchObject({ gateway_status: 'provisioning', gateway_token: first.token });

    setGatewayState(first.id, { status: 'running' });
    expect(legacy()).toMatchObject({ gateway_status: 'running' });

    deleteGatewayRow(first.id);
    expect(legacy()).toEqual({ gateway_port: null, gateway_status: null, gateway_token: null, gateway_subdomain: null });
  });
});
