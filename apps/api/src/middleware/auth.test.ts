import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signApiToken, verifyApiToken } from '@clawhuddle/shared';

/**
 * The API used to trust a client-supplied x-user-id header, and the members
 * list handed every member every colleague's gateway token. These pin the fix:
 * only tokens signed with API_AUTH_SECRET authenticate, and gateway tokens only
 * go back to their owner.
 */

const SECRET = 'test-secret-'.padEnd(48, 'x');
const ORG = 'org-1';
const ADMIN = { id: 'user-admin', email: 'admin@example.com', token: 'gw-token-admin' };
const MEMBER = { id: 'user-member', email: 'member@example.com', token: 'gw-token-member' };

let tmpDir: string;
let app: FastifyInstance;

const userToken = async (userId: string) => (await signApiToken(userId, 'user', SECRET, 3600)).token;
const internalToken = async () => (await signApiToken('web', 'internal', SECRET, 60)).token;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawhuddle-auth-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'db.sqlite');
  process.env.API_AUTH_SECRET = SECRET;

  const { getDb } = await import('../db/index.js');
  const db = getDb();
  const here = path.dirname(fileURLToPath(import.meta.url));
  db.exec(fs.readFileSync(path.join(here, '../db/schema.sql'), 'utf-8'));
  db.prepare('INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)').run(ORG, 'Org', 'org');
  for (const [u, role] of [[ADMIN, 'owner'], [MEMBER, 'member']] as const) {
    db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(u.id, u.email);
    db.prepare(
      'INSERT INTO org_members (id, org_id, user_id, role, gateway_token) VALUES (?, ?, ?, ?, ?)',
    ).run(`om-${u.id}`, ORG, u.id, role, u.token);
  }

  const { authRoutes } = await import('../routes/auth.js');
  const { orgPlugin } = await import('./auth.js');
  const { orgMemberRoutes } = await import('../routes/org/members.js');
  app = Fastify();
  await app.register(authRoutes);
  await app.register(async (instance) => {
    await instance.register(orgPlugin);
    await instance.register(orgMemberRoutes);
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  const { closeDb } = await import('../db/index.js');
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('API tokens', () => {
  it('round-trips a signed token', async () => {
    const claims = await verifyApiToken(await userToken(MEMBER.id), 'user', SECRET);
    expect(claims?.sub).toBe(MEMBER.id);
  });

  it('rejects a token signed with another secret', async () => {
    const { token } = await signApiToken(MEMBER.id, 'user', 'other-secret-'.padEnd(48, 'y'), 3600);
    expect(await verifyApiToken(token, 'user', SECRET)).toBeNull();
  });

  it('rejects a token whose claims were edited', async () => {
    const [h, , s] = (await userToken(MEMBER.id)).split('.');
    const forged = Buffer.from(JSON.stringify({ sub: ADMIN.id, aud: 'user', iat: 0, exp: 9999999999 })).toString('base64url');
    expect(await verifyApiToken(`${h}.${forged}.${s}`, 'user', SECRET)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const { token } = await signApiToken(MEMBER.id, 'user', SECRET, -1);
    expect(await verifyApiToken(token, 'user', SECRET)).toBeNull();
  });

  it('rejects a token for the other audience', async () => {
    expect(await verifyApiToken(await internalToken(), 'user', SECRET)).toBeNull();
    expect(await verifyApiToken(await userToken(MEMBER.id), 'internal', SECRET)).toBeNull();
  });

  it('refuses short secrets', async () => {
    await expect(signApiToken(MEMBER.id, 'user', 'short', 3600)).rejects.toThrow(/API_AUTH_SECRET/);
  });
});

describe('user authentication', () => {
  it('ignores x-user-id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { 'x-user-id': ADMIN.id } });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a signed user token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer(await userToken(ADMIN.id)) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.id).toBe(ADMIN.id);
  });

  it('protects org routes the same way', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/orgs/${ORG}/members`,
      headers: { 'x-user-id': ADMIN.id },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('internal routes', () => {
  const login = (headers: Record<string, string>) =>
    app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { email: ADMIN.email } });

  it('refuses /api/auth/login without the internal token', async () => {
    expect((await login({})).statusCode).toBe(401);
    expect((await login(bearer(await userToken(MEMBER.id)))).statusCode).toBe(401);
  });

  it('serves /api/auth/login to the web server', async () => {
    const res = await login(bearer(await internalToken()));
    expect(res.statusCode).toBe(200);
    expect(res.json().data.id).toBe(ADMIN.id);
  });

  it('refuses /api/auth/check-access without the internal token', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/auth/check-access?email=${ADMIN.email}` });
    expect(res.statusCode).toBe(401);
  });
});

describe('members list', () => {
  const tokensSeenBy = async (userId: string) => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/orgs/${ORG}/members`,
      headers: bearer(await userToken(userId)),
    });
    expect(res.statusCode).toBe(200);
    return Object.fromEntries(
      (res.json().data as { user_id: string; gateway_token: string | null }[]).map((m) => [m.user_id, m.gateway_token]),
    );
  };

  it("hides other members' gateway tokens from a member", async () => {
    expect(await tokensSeenBy(MEMBER.id)).toEqual({ [MEMBER.id]: MEMBER.token, [ADMIN.id]: null });
  });

  it("hides members' gateway tokens from an owner too", async () => {
    expect(await tokensSeenBy(ADMIN.id)).toEqual({ [ADMIN.id]: ADMIN.token, [MEMBER.id]: null });
  });

  it("hides the target's gateway token when an owner updates a member", async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/orgs/${ORG}/members/om-${MEMBER.id}`,
      headers: bearer(await userToken(ADMIN.id)),
      payload: { role: 'member' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.gateway_token).toBeNull();
  });
});
