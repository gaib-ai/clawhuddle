import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signApiToken } from '@clawhuddle/shared';

/**
 * Org admin features any signed-up user can reach (anyone may create an org and
 * own it). Port-forward input is written into a file Traefik watches, so it must
 * not be able to inject routing; and admins must not be able to mint owners.
 */

const SECRET = 'test-secret-'.padEnd(48, 'x');
const ORG = 'org-1';
const OWNER = { id: 'user-owner', email: 'owner@example.com' };
const ADMIN = { id: 'user-admin', email: 'admin@example.com' };
const MEMBER = { id: 'user-member', email: 'member@example.com' };
const INVITEE = { id: 'user-invitee', email: 'invitee@example.com' };

let tmpDir: string;
let app: FastifyInstance;

const as = async (user: { id: string }) => ({
  authorization: `Bearer ${(await signApiToken(user.id, 'user', SECRET, 3600)).token}`,
});
const traefikDir = () => path.join(tmpDir, 'data', 'traefik-dynamic');

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawhuddle-guards-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'db.sqlite');
  process.env.DATA_DIR = path.join(tmpDir, 'data');
  process.env.API_AUTH_SECRET = SECRET;
  // App on app.example.com, gateways and forwards under example.com
  process.env.DOMAIN = 'app.example.com';
  process.env.GATEWAY_DOMAIN = 'example.com';

  const { getDb } = await import('../../db/index.js');
  const db = getDb();
  const here = path.dirname(fileURLToPath(import.meta.url));
  db.exec(fs.readFileSync(path.join(here, '../../db/schema.sql'), 'utf-8'));
  db.exec(fs.readFileSync(path.join(here, '../../db/migrations/015-port-forwards.sql'), 'utf-8'));
  db.prepare('INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)').run(ORG, 'Org', 'org');
  db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(INVITEE.id, INVITEE.email);
  for (const [u, role] of [[OWNER, 'owner'], [ADMIN, 'admin'], [MEMBER, 'member']] as const) {
    db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(u.id, u.email);
    db.prepare('INSERT INTO org_members (id, org_id, user_id, role) VALUES (?, ?, ?, ?)').run(
      `om-${u.id}`, ORG, u.id, role,
    );
  }

  const { authRoutes } = await import('../auth.js');
  const { orgPlugin } = await import('../../middleware/auth.js');
  const { orgMemberRoutes } = await import('./members.js');
  const { orgPortForwardRoutes } = await import('./port-forwards.js');
  app = Fastify();
  await app.register(authRoutes);
  await app.register(async (instance) => {
    await instance.register(orgPlugin);
    await instance.register(orgMemberRoutes);
    await instance.register(orgPortForwardRoutes);
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  const { closeDb } = await import('../../db/index.js');
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('port forwards', () => {
  const create = async (body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/orgs/${ORG}/port-forwards`,
      headers: await as(ADMIN),
      payload: { memberId: `om-${ADMIN.id}`, port: 8080, ...body },
    });

  it('writes a config Traefik reads as exactly one router and service', async () => {
    const res = await create({ subdomain: 'webhook', description: 'Webhook receiver' });
    expect(res.statusCode).toBe(201);
    const { id } = res.json().data;

    const file = fs.readFileSync(path.join(traefikDir(), `pf-${id}.yml`), 'utf-8');
    const config = JSON.parse(file.replace(/^#.*\n/, ''));
    expect(Object.keys(config)).toEqual(['http']);
    expect(config.http.routers).toEqual({
      [`pf-${id}`]: { rule: 'Host(`webhook.example.com`)', entryPoints: ['web'], service: `pf-${id}` },
    });
    expect(Object.keys(config.http.services)).toEqual([`pf-${id}`]);
    expect(file).not.toContain('Webhook receiver');
  });

  it('rejects a description that could break out of its line', async () => {
    const injected = 'x)\ntcp:\n  routers:\n    pwn:\n      rule: HostSNI(`*`)';
    const res = await create({ subdomain: 'pwn', description: injected });
    expect(res.statusCode).toBe(400);
    expect(fs.readdirSync(traefikDir()).some((f) => fs.readFileSync(path.join(traefikDir(), f), 'utf-8').includes('HostSNI'))).toBe(false);
  });

  it("refuses the app's own hostname", async () => {
    expect((await create({ subdomain: 'app' })).statusCode).toBe(400);
  });

  it('refuses the claw- prefix gateways use', async () => {
    expect((await create({ subdomain: 'claw-1234abcd' })).statusCode).toBe(400);
  });
});

describe('member roles', () => {
  const invite = async (by: { id: string }, role: string) =>
    app.inject({
      method: 'POST',
      url: `/api/orgs/${ORG}/members/invite`,
      headers: await as(by),
      payload: { email: `new-${role}-${by.id}@example.com`, role },
    });
  const update = async (by: { id: string }, payload: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: `/api/orgs/${ORG}/members/om-${MEMBER.id}`,
      headers: await as(by),
      payload,
    });

  it('stops an admin inviting an owner', async () => {
    expect((await invite(ADMIN, 'owner')).statusCode).toBe(403);
  });

  it('lets an owner invite an owner', async () => {
    expect((await invite(OWNER, 'owner')).statusCode).toBe(201);
  });

  it('lets an admin invite admins and members', async () => {
    expect((await invite(ADMIN, 'admin')).statusCode).toBe(201);
    expect((await invite(ADMIN, 'member')).statusCode).toBe(201);
  });

  it('rejects unknown roles on invite and update', async () => {
    expect((await invite(OWNER, 'superadmin')).statusCode).toBe(400);
    expect((await update(OWNER, { role: 'superadmin' })).statusCode).toBe(400);
  });

  it('rejects unknown statuses', async () => {
    expect((await update(ADMIN, { status: 'banned' })).statusCode).toBe(400);
    expect((await update(ADMIN, { status: 'disabled' })).statusCode).toBe(200);
  });
});

describe('accepting invitations', () => {
  // Rows written straight to the DB stand in for invitations sent before the
  // invite endpoint validated roles.
  const pendingInvite = async (invitedBy: { id: string }, role: string) => {
    const { getDb } = await import('../../db/index.js');
    const token = `tok-${invitedBy.id}-${role}`;
    getDb()
      .prepare(
        "INSERT INTO invitations (id, org_id, email, role, token, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+1 day'))",
      )
      .run(`inv-${token}`, ORG, INVITEE.email, role, token, invitedBy.id);
    return token;
  };
  const accept = async (token: string) =>
    app.inject({ method: 'POST', url: '/api/invitations/accept', headers: await as(INVITEE), payload: { token } });

  it("refuses an owner invitation an admin sent before roles were validated", async () => {
    const res = await accept(await pendingInvite(ADMIN, 'owner'));
    expect(res.statusCode).toBe(403);
  });

  it('refuses an invitation with an unknown role', async () => {
    expect((await accept(await pendingInvite(OWNER, 'superadmin'))).statusCode).toBe(403);
  });

  it('refuses an invitation from someone who is no longer an admin', async () => {
    expect((await accept(await pendingInvite(MEMBER, 'member'))).statusCode).toBe(403);
  });

  it("honours an owner's owner invitation", async () => {
    const res = await accept(await pendingInvite(OWNER, 'owner'));
    expect(res.statusCode).toBe(200);
    const { getDb } = await import('../../db/index.js');
    const row = getDb()
      .prepare('SELECT role FROM org_members WHERE org_id = ? AND user_id = ?')
      .get(ORG, INVITEE.id) as { role: string };
    expect(row.role).toBe('owner');
  });
});
