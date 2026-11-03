import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signApiToken } from '@clawhuddle/shared';

/**
 * Instances through the API: the limit is enforced for members and admins
 * alike, a member can only touch their own instances, and tokens are released
 * only one at a time to an admin who asks. Docker is stubbed; the container
 * names handed to it are what prove slot naming.
 */

const docker = vi.hoisted(() => ({
  created: [] as string[],
  /** Container names handed to `restart`. */
  restarted: [] as string[],
  /** Every `exec` Cmd, in order. */
  execs: [] as string[][],
  /** What `openclaw devices list --json` prints inside the stub container. */
  devicesJson: '{"pending":[],"paired":[]}',
  /** stdout for `sh -c <script>` execs, picked by a substring of the script. */
  shOutputs: {} as Record<string, string>,
}));
vi.mock('dockerode', () => {
  // A docker exec stream without a TTY is framed: type byte, 3 zero bytes,
  // big-endian length, payload. The service must demux it.
  const frame = (type: number, text: string) => {
    const body = Buffer.from(text, 'utf-8');
    const head = Buffer.alloc(8);
    head[0] = type;
    head.writeUInt32BE(body.length, 4);
    return Buffer.concat([head, body]);
  };
  class Container {
    constructor(public name: string) {}
    async stop() {}
    async remove() {}
    async start() {}
    async restart() { docker.restarted.push(this.name); }
    async inspect() {
      return { State: { Running: true }, NetworkSettings: { Ports: {} } };
    }
    async exec(opts: { Cmd: string[] }) {
      docker.execs.push(opts.Cmd);
      const isList = opts.Cmd.slice(0, 3).join(' ') === 'openclaw devices list';
      const sh = opts.Cmd[0] === 'sh'
        ? Object.entries(docker.shOutputs).find(([k]) => opts.Cmd[2]?.includes(k))?.[1]
        : undefined;
      const chunks = isList
        ? [frame(2, 'warn: something on stderr\n'), frame(1, docker.devicesJson.slice(0, 10)), frame(1, docker.devicesJson.slice(10))]
        : sh !== undefined ? [frame(1, sh)] : [];
      return {
        start: async () => ({
          resume() {},
          on(event: string, cb: (chunk?: Buffer) => void) {
            if (event === 'data') for (const c of chunks) cb(c);
            if (event === 'end') setTimeout(cb, 0);
          },
        }),
        inspect: async () => ({ ExitCode: 0 }),
      };
    }
  }
  class Docker {
    getNetwork() { return { inspect: async () => ({}) }; }
    async createNetwork() {}
    getContainer(name: string) { return new Container(name); }
    async createContainer(cfg: { name: string }) { docker.created.push(cfg.name); return new Container(cfg.name); }
    async listContainers() { return []; }
  }
  return { default: Docker };
});

const SECRET = 'test-secret-'.padEnd(48, 'x');
const ORG = 'org-1';
const OWNER = { id: 'user-owner', email: 'owner@example.com' };
const ADMIN = { id: 'user-admin', email: 'admin@example.com' };
const MEMBER = { id: 'user-member', email: 'member@example.com' };
const OTHER = { id: 'user-other', email: 'other@example.com' };
const om = (u: { id: string }) => `om-${u.id}`;

let tmpDir: string;
let app: FastifyInstance;

const as = async (user: { id: string }) => ({
  authorization: `Bearer ${(await signApiToken(user.id, 'user', SECRET, 3600)).token}`,
});

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawhuddle-gateways-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'db.sqlite');
  process.env.DATA_DIR = path.join(tmpDir, 'data');
  process.env.API_AUTH_SECRET = SECRET;
  process.env.DOMAIN = 'app.example.com';
  process.env.GATEWAY_DOMAIN = 'example.com';
  delete process.env.MAX_GATEWAYS_PER_USER;

  const { getDb } = await import('../../db/index.js');
  const { applyMigrations } = await import('../../db/apply-migrations.js');
  const db = getDb();
  applyMigrations(db, () => {});
  db.prepare('INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)').run(ORG, 'Org', 'org');
  for (const [u, role] of [[OWNER, 'owner'], [ADMIN, 'admin'], [MEMBER, 'member'], [OTHER, 'member']] as const) {
    db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(u.id, u.email);
    db.prepare('INSERT INTO org_members (id, org_id, user_id, role) VALUES (?, ?, ?, ?)').run(om(u), ORG, u.id, role);
  }
  // deploy refuses an instance with no provider key at all
  db.prepare("INSERT INTO api_keys (id, provider, key_value, org_id, credential_type) VALUES ('k1', 'google', ?, ?, 'api_key')")
    .run(Buffer.from('AIza-test').toString('base64'), ORG);

  const { authRoutes } = await import('../auth.js');
  const { orgRoutes } = await import('../orgs.js');
  const { orgPlugin } = await import('../../middleware/auth.js');
  const { orgMemberRoutes } = await import('./members.js');
  const { orgGatewayRoutes } = await import('./gateways.js');
  const { orgApiKeyRoutes } = await import('./api-keys.js');
  app = Fastify();
  await app.register(authRoutes);
  await app.register(orgRoutes);
  await app.register(async (instance) => {
    await instance.register(orgPlugin);
    await instance.register(orgMemberRoutes);
    await instance.register(orgGatewayRoutes);
    await instance.register(orgApiKeyRoutes);
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  const { closeDb } = await import('../../db/index.js');
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const createOwn = async (user: { id: string }, body: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: `/api/orgs/${ORG}/me/gateways`, headers: await as(user), payload: body });
const createFor = async (by: { id: string }, target: { id: string }) =>
  app.inject({ method: 'POST', url: `/api/orgs/${ORG}/gateways/members/${om(target)}`, headers: await as(by), payload: {} });
const mine = async (user: { id: string }) =>
  (await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/me/gateways`, headers: await as(user) })).json();

describe('creating instances', () => {
  it('deploys the first instance under the legacy container name', async () => {
    const res = await createOwn(MEMBER, { label: 'main' });
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({ slot: 1, label: 'main', status: 'deploying', member_id: om(MEMBER) });
    expect(res.json().data).not.toHaveProperty('token');
    expect(docker.created).toEqual(['clawhuddle-gw-org-1-user-mem']);
    expect(fs.existsSync(path.join(tmpDir, 'data', 'gateways', ORG, MEMBER.id, 'openclaw.json'))).toBe(true);
  });

  it('refuses a second one at the default limit', async () => {
    const res = await createOwn(MEMBER);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'gateway_limit', limit: 1, current: 1 });
  });

  it('allows it once an admin raises the org limit, with a suffixed name and directory', async () => {
    const raise = await app.inject({
      method: 'PATCH', url: `/api/orgs/${ORG}`, headers: await as(OWNER), payload: { max_gateways_per_user: 2 },
    });
    expect(raise.statusCode).toBe(200);
    expect(raise.json().data.max_gateways_per_user).toBe(2);

    const res = await createOwn(MEMBER);
    expect(res.statusCode).toBe(201);
    expect(res.json().data.slot).toBe(2);
    expect(docker.created.at(-1)).toBe('clawhuddle-gw-org-1-user-mem-2');
    expect(fs.existsSync(path.join(tmpDir, 'data', 'gateways', ORG, `${MEMBER.id}-2`, 'openclaw.json'))).toBe(true);
    expect(await mine(MEMBER)).toMatchObject({ limit: 2, current: 2 });
  });

  it('lets a per-member override lower the limit again', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/orgs/${ORG}/members/${om(MEMBER)}`, headers: await as(ADMIN), payload: { max_gateways: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.max_gateways).toBe(1);
    expect((await createOwn(MEMBER)).statusCode).toBe(403);
    expect(await mine(MEMBER)).toMatchObject({ limit: 1, current: 2 });
  });

  it('rejects a nonsense limit', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/orgs/${ORG}/members/${om(MEMBER)}`, headers: await as(ADMIN), payload: { max_gateways: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect((await app.inject({
      method: 'PATCH', url: `/api/orgs/${ORG}`, headers: await as(OWNER), payload: { max_gateways_per_user: 'many' },
    })).statusCode).toBe(400);
  });

  it('holds admins to the same limit when deploying for a member', async () => {
    expect((await createFor(ADMIN, OTHER)).statusCode).toBe(201);
    expect((await createFor(ADMIN, OTHER)).statusCode).toBe(201);
    const res = await createFor(ADMIN, OTHER);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('gateway_limit');
  });
});

describe('who may touch an instance', () => {
  it("keeps a member off another member's instance", async () => {
    const theirs = (await mine(OTHER)).data[0].id;
    for (const [method, suffix] of [['POST', '/stop'], ['GET', '/status'], ['DELETE', ''], ['GET', '/channels']] as const) {
      const res = await app.inject({ method, url: `/api/orgs/${ORG}/gateways/${theirs}${suffix}`, headers: await as(MEMBER) });
      expect(res.statusCode, `${method} ${suffix}`).toBe(403);
    }
    expect((await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/gateways/${theirs}/access`, headers: await as(MEMBER) })).statusCode).toBe(403);
  });

  it('404s an unknown instance before anything else', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/gateways/nope/status`, headers: await as(OWNER) });
    expect(res.statusCode).toBe(404);
  });

  it('lets an admin act on a member instance, and the member see its status', async () => {
    const theirs = (await mine(OTHER)).data[0].id;
    const stop = await app.inject({ method: 'POST', url: `/api/orgs/${ORG}/gateways/${theirs}/stop`, headers: await as(ADMIN) });
    expect(stop.statusCode).toBe(200);
    expect(stop.json().data.status).toBe('stopped');
    const status = await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/gateways/${theirs}/status`, headers: await as(OTHER) });
    expect(status.json().data.status).toBe('running'); // the stub container reports healthy
  });

  it('restarts an instance in place without recreating its container', async () => {
    const theirs = (await mine(OTHER)).data[0].id;
    const before = docker.created.length;
    const res = await app.inject({ method: 'POST', url: `/api/orgs/${ORG}/gateways/${theirs}/restart`, headers: await as(OTHER) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('deploying');
    expect(docker.restarted).toEqual(['clawhuddle-gw-org-1-user-oth']);
    expect(docker.created.length).toBe(before);
    const denied = await app.inject({ method: 'POST', url: `/api/orgs/${ORG}/gateways/${theirs}/restart`, headers: await as(MEMBER) });
    expect(denied.statusCode).toBe(403);
  });

  it("releases an owner's token only to an owner", async () => {
    expect((await createFor(OWNER, OWNER)).statusCode).toBe(201);
    expect((await createFor(OWNER, ADMIN)).statusCode).toBe(201);
    const ownersInstance = (await mine(OWNER)).data[0];
    const adminsInstance = (await mine(ADMIN)).data[0];

    const byAdmin = await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/gateways/${ownersInstance.id}/access`, headers: await as(ADMIN) });
    expect(byAdmin.statusCode).toBe(403);

    const byOwner = await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/gateways/${adminsInstance.id}/access`, headers: await as(OWNER) });
    expect(byOwner.statusCode).toBe(200);
    expect(byOwner.json().data).toEqual({ gateway_token: adminsInstance.token, gateway_subdomain: adminsInstance.subdomain, gateway_port: 6100 });
    expect(byOwner.headers['cache-control']).toBe('no-store');
  });

  it('lists every instance for admins without tokens', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/gateways`, headers: await as(ADMIN) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(6);
    for (const g of res.json().data) {
      expect(g).not.toHaveProperty('token');
      expect(g.email).toBeDefined();
    }
    expect((await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/gateways`, headers: await as(MEMBER) })).statusCode).toBe(403);
  });

  it('attaches instances to the members list, tokens stripped', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/members`, headers: await as(MEMBER) });
    const member = res.json().data.find((m: any) => m.id === om(MEMBER));
    expect(member.gateway_count).toBe(2);
    expect(member.effective_max_gateways).toBe(1);
    expect(member.gateways.map((g: any) => g.slot)).toEqual([1, 2]);
    expect(member.gateways[0]).not.toHaveProperty('token');
  });
});

describe('instance settings and channels', () => {
  it('renames an instance and pins its provider', async () => {
    const second = (await mine(MEMBER)).data[1];
    const res = await app.inject({
      method: 'PATCH', url: `/api/orgs/${ORG}/gateways/${second.id}`, headers: await as(MEMBER),
      payload: { label: 'research', primary_provider: 'google' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ label: 'research', primary_provider: 'google' });
    const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'data', 'gateways', ORG, `${MEMBER.id}-2`, 'openclaw.json'), 'utf-8'));
    expect(config.agents.defaults.model.primary).toMatch(/^google\//);

    const bad = await app.inject({
      method: 'PATCH', url: `/api/orgs/${ORG}/gateways/${second.id}`, headers: await as(MEMBER), payload: { primary_provider: 'nope' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('pins a model by name, which replaces the provider pin', async () => {
    const second = (await mine(MEMBER)).data[1];
    const res = await app.inject({
      method: 'PATCH', url: `/api/orgs/${ORG}/gateways/${second.id}`, headers: await as(MEMBER),
      payload: { primary_model: 'google/gemini-4-argon' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ primary_model: 'google/gemini-4-argon', primary_provider: null });
    const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'data', 'gateways', ORG, `${MEMBER.id}-2`, 'openclaw.json'), 'utf-8'));
    expect(config.agents.defaults.model.primary).toBe('google/gemini-4-argon');

    const bad = await app.inject({
      method: 'PATCH', url: `/api/orgs/${ORG}/gateways/${second.id}`, headers: await as(MEMBER), payload: { primary_model: 'google/nope' },
    });
    expect(bad.statusCode).toBe(400);

    const cleared = await app.inject({
      method: 'PATCH', url: `/api/orgs/${ORG}/gateways/${second.id}`, headers: await as(MEMBER), payload: { primary_model: null },
    });
    expect(cleared.json().data.primary_model).toBeNull();
  });

  it('keeps bot tokens per instance', async () => {
    const [first, second] = (await mine(MEMBER)).data;
    const put = (id: string, channel: string, body: Record<string, unknown>) =>
      as(MEMBER).then((headers) => app.inject({ method: 'PUT', url: `/api/orgs/${ORG}/gateways/${id}/channels/${channel}`, headers, payload: body }));

    expect((await put(second.id, 'slack', { bot_token: 'xoxb' })).statusCode).toBe(400); // needs app_token
    expect((await put(second.id, 'slack', { bot_token: 'xoxb-2', app_token: 'xapp-2' })).statusCode).toBe(200);

    const onFirst = await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/gateways/${first.id}/channels`, headers: await as(MEMBER) });
    expect(onFirst.json().data).toEqual([]);
    const onSecond = await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/gateways/${second.id}/channels`, headers: await as(MEMBER) });
    expect(onSecond.json().data).toMatchObject([{ channel: 'slack', configured: true }]);
    const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'data', 'gateways', ORG, `${MEMBER.id}-2`, 'openclaw.json'), 'utf-8'));
    expect(config.channels.slack.botToken).toBe('xoxb-2');

    const del = await app.inject({ method: 'DELETE', url: `/api/orgs/${ORG}/gateways/${second.id}/channels/slack`, headers: await as(MEMBER) });
    expect(del.statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/orgs/${ORG}/gateways/${second.id}/channels/slack`, headers: await as(MEMBER) })).statusCode).toBe(404);
  });
});

describe('removing an instance', () => {
  it('takes the row and the workspace with it, and frees the slot', async () => {
    const second = (await mine(MEMBER)).data[1];
    const res = await app.inject({ method: 'DELETE', url: `/api/orgs/${ORG}/gateways/${second.id}`, headers: await as(MEMBER) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ id: second.id, slot: 2, removed: true });
    expect(fs.existsSync(path.join(tmpDir, 'data', 'gateways', ORG, `${MEMBER.id}-2`))).toBe(false);
    expect(await mine(MEMBER)).toMatchObject({ current: 1 });
    expect((await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/gateways/${second.id}/status`, headers: await as(MEMBER) })).statusCode).toBe(404);
  });

  it('removes a member along with every instance they own', async () => {
    const before = (await mine(OTHER)).data;
    expect(before).toHaveLength(2);
    const res = await app.inject({ method: 'DELETE', url: `/api/orgs/${ORG}/members/${om(OTHER)}`, headers: await as(OWNER) });
    expect(res.statusCode).toBe(200);
    const { getDb } = await import('../../db/index.js');
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM gateways WHERE member_id = ?').get(om(OTHER))).toEqual({ n: 0 });
    expect(fs.existsSync(path.join(tmpDir, 'data', 'gateways', ORG, OTHER.id))).toBe(false);
  });
});

describe('device pairing', () => {
  const PENDING = {
    requestId: '0f6f2c1e-6a3e-4d4c-9b1c-0f3f2b9d1a11',
    deviceId: 'dev-1',
    publicKey: 'SHOULD-NOT-LEAK',
    displayName: 'Chrome on Mac',
    platform: 'MacIntel',
    deviceFamily: 'Mac',
    clientId: 'openclaw-control-ui',
    clientMode: 'webchat',
    browserOrigin: 'https://claw-abc.example.com',
    role: 'operator',
    roles: ['operator'],
    scopes: ['operator.read', 'operator.write'],
    remoteIp: '203.0.113.9',
    ts: 1760000000000,
  };
  let membersInstance: string;

  beforeAll(async () => {
    const { getDb } = await import('../../db/index.js');
    getDb().prepare("UPDATE gateways SET status = 'running'").run();
    // OTHER was removed from the org above; bring them back as a plain member
    getDb().prepare('INSERT INTO org_members (id, org_id, user_id, role) VALUES (?, ?, ?, ?)').run(om(OTHER), ORG, OTHER.id, 'member');
    membersInstance = (await mine(MEMBER)).data[0].id;
    docker.devicesJson = JSON.stringify({ pending: [PENDING], paired: [] });
  });

  it('shows a member the devices waiting on their own instance, public key stripped', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/gateways/${membersInstance}/devices`, headers: await as(MEMBER) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    expect(res.json().data[0]).toMatchObject({ requestId: PENDING.requestId, displayName: 'Chrome on Mac', remoteIp: '203.0.113.9', scopes: ['operator.read', 'operator.write'] });
    expect(res.json().data[0]).not.toHaveProperty('publicKey');
  });

  it("keeps a member off another member's device requests", async () => {
    const res = await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/gateways/${membersInstance}/devices`, headers: await as(OTHER) });
    expect(res.statusCode).toBe(403);
  });

  it('collects my requests across my instances, tagged with the instance but not its token', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/me/device-requests`, headers: await as(MEMBER) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.errors).toEqual([]);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].gateway).toMatchObject({ id: membersInstance, slot: 1 });
    expect(body.data[0].gateway).not.toHaveProperty('token');
  });

  it('lets admins see every request in the org with the member, and nobody else', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/device-requests`, headers: await as(ADMIN) });
    expect(res.statusCode).toBe(200);
    const forMember = res.json().data.find((r: any) => r.gateway.id === membersInstance);
    expect(forMember.gateway.email).toBe(MEMBER.email);
    expect(forMember.gateway).not.toHaveProperty('token');
    // every running instance was asked once
    const asked = docker.execs.filter((c) => c[2] === 'list').length;
    expect(asked).toBeGreaterThanOrEqual(res.json().data.length);

    const denied = await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/device-requests`, headers: await as(MEMBER) });
    expect(denied.statusCode).toBe(403);
  });

  it('approves and rejects by request id inside the container, and logs nothing else through', async () => {
    docker.execs.length = 0;
    const ok = await app.inject({ method: 'POST', url: `/api/orgs/${ORG}/gateways/${membersInstance}/devices/${PENDING.requestId}/approve`, headers: await as(MEMBER) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toEqual({ requestId: PENDING.requestId, approved: true });
    expect(docker.execs).toEqual([['openclaw', 'devices', 'approve', PENDING.requestId, '--json']]);

    const byAdmin = await app.inject({ method: 'POST', url: `/api/orgs/${ORG}/gateways/${membersInstance}/devices/${PENDING.requestId}/reject`, headers: await as(ADMIN) });
    expect(byAdmin.statusCode).toBe(200);
    expect(docker.execs[1]).toEqual(['openclaw', 'devices', 'reject', PENDING.requestId, '--json']);

    const bad = await app.inject({ method: 'POST', url: `/api/orgs/${ORG}/gateways/${membersInstance}/devices/${encodeURIComponent('x; rm -rf /')}/approve`, headers: await as(MEMBER) });
    expect(bad.statusCode).toBe(400);
    expect(docker.execs).toHaveLength(2);
  });

  it('reports an instance that cannot be read instead of failing the list', async () => {
    docker.devicesJson = 'not json at all';
    const res = await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/me/device-requests`, headers: await as(MEMBER) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);
    expect(res.json().errors).toEqual([{ gateway_id: membersInstance, message: expect.stringContaining('JSON') }]);
    docker.devicesJson = '{"pending":[],"paired":[]}';
  });

  it('has nothing to show for a stopped instance', async () => {
    const { getDb } = await import('../../db/index.js');
    getDb().prepare("UPDATE gateways SET status = 'stopped' WHERE id = ?").run(membersInstance);
    const res = await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/gateways/${membersInstance}/devices`, headers: await as(MEMBER) });
    expect(res.json().data).toEqual([]);
    const approve = await app.inject({ method: 'POST', url: `/api/orgs/${ORG}/gateways/${membersInstance}/devices/${PENDING.requestId}/approve`, headers: await as(MEMBER) });
    expect(approve.statusCode).toBe(400);
    getDb().prepare("UPDATE gateways SET status = 'running' WHERE id = ?").run(membersInstance);
  });
});

describe('secret-store status (Notion)', () => {
  // MEMBER still owns slot 1 here; OTHER was removed above.
  const stateFile = () => path.join(tmpDir, 'data', 'gateways', ORG, MEMBER.id, '.clawhuddle-secrets.json');
  // The org-wide list has every instance left by the tests above; look at MEMBER's slot 1.
  const orgStatus = async () => {
    const data = (await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/api-keys/secret-status`, headers: await as(ADMIN) })).json().data;
    return [data.find((e: any) => e.email === MEMBER.email && e.slot === 1)];
  };
  const myStatus = async () =>
    (await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/me/api-keys/secret-status`, headers: await as(MEMBER) })).json().data;

  it('reports no key until the org adds one', async () => {
    const data = await orgStatus();
    expect(data[0]).toMatchObject({ gateway_id: (await mine(MEMBER)).data[0].id, slot: 1, email: MEMBER.email, secrets: { notion: 'none' } });
    expect(data[0]).not.toHaveProperty('token');
  });

  it('is pending once a key exists and the store has not been written', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/orgs/${ORG}/api-keys`, headers: await as(ADMIN),
      payload: { provider: 'notion', key: 'ntn_test_token', credentialType: 'api_key' },
    });
    expect(res.statusCode).toBe(201);
    expect((await orgStatus())[0].secrets.notion).toBe('pending');
    expect((await myStatus())[0].secrets.notion).toBe('pending');
  });

  it('is injected when the recorded fingerprint matches the key, pending when it does not', async () => {
    const crypto = await import('node:crypto');
    const fp = crypto.createHash('sha256').update('ntn_test_token').digest('hex').slice(0, 16);
    fs.writeFileSync(stateFile(), JSON.stringify({ NOTION_API_TOKEN: { fingerprint: fp } }));
    expect((await orgStatus())[0].secrets.notion).toBe('injected');
    fs.writeFileSync(stateFile(), JSON.stringify({ NOTION_API_TOKEN: { fingerprint: 'stale' } }));
    expect((await orgStatus())[0].secrets.notion).toBe('pending');
  });

  it("marks a member's own entry as theirs whatever the org key", async () => {
    fs.writeFileSync(stateFile(), JSON.stringify({ NOTION_API_TOKEN: { fingerprint: null } }));
    expect((await orgStatus())[0].secrets.notion).toBe('member');
  });

  it('keeps the org-wide list to admins', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/api-keys/secret-status`, headers: await as(MEMBER) });
    expect(res.statusCode).toBe(403);
  });
});

describe('gog OAuth client (Google Workspace)', () => {
  const CLIENT = JSON.stringify({
    installed: { client_id: '123456789012-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-test', redirect_uris: ['http://localhost'] },
  });
  const dir = () => path.join(tmpDir, 'data', 'gateways', ORG, MEMBER.id);
  const gogState = async () => {
    const data = (await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/api-keys/secret-status`, headers: await as(ADMIN) })).json().data;
    return data.find((e: any) => e.email === MEMBER.email && e.slot === 1).secrets['google-workspace'];
  };
  const envOf = (d: string) => fs.readFileSync(path.join(d, 'env'), 'utf-8');

  it('only takes a real client JSON, and shows it by client id', async () => {
    const bad = await app.inject({
      method: 'POST', url: `/api/orgs/${ORG}/api-keys`, headers: await as(ADMIN),
      payload: { provider: 'google-workspace', key: '{"access_token":"x"}', credentialType: 'api_key' },
    });
    expect(bad.statusCode).toBe(400);
    expect(await gogState()).toBe('none');

    const ok = await app.inject({
      method: 'POST', url: `/api/orgs/${ORG}/api-keys`, headers: await as(ADMIN),
      payload: { provider: 'google-workspace', key: CLIENT, credentialType: 'api_key' },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().data.key_masked).toBe('client 123456789012-…');
    expect(JSON.stringify(ok.json())).not.toContain('GOCSPX');
  });

  it('is not a personal key a member can set', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/orgs/${ORG}/me/api-keys`, headers: await as(MEMBER),
      payload: { provider: 'google-workspace', key: CLIENT, credentialType: 'api_key' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('waits for a reboot on a running instance that has no keyring env yet', async () => {
    expect(fs.existsSync(path.join(dir(), 'env'))).toBe(false);
    expect(await gogState()).toBe('restart');
  });

  it('writes the keyring env before the instance boots, then installs the client once it is up', async () => {
    const gw = (await mine(MEMBER)).data[0];
    const res = await app.inject({ method: 'POST', url: `/api/orgs/${ORG}/gateways/${gw.id}/restart`, headers: await as(MEMBER) });
    expect(res.statusCode).toBe(200);
    const env = envOf(dir());
    expect(env).toMatch(/^GOG_KEYRING_BACKEND=file$/m);
    expect(env).toMatch(/^GOG_KEYRING_PASSWORD=[0-9a-f]{48}$/m);
    expect(fs.statSync(path.join(dir(), 'env')).mode & 0o777).toBe(0o600);
    expect(await gogState()).toBe('pending');

    const { ensureGatewaySecrets } = await import('../../services/gateway.js');
    const { getGatewayRow } = await import('../../services/gateway-store.js');
    docker.execs.length = 0;
    await ensureGatewaySecrets(getGatewayRow(ORG, gw.id));
    const set = docker.execs.find((c) => c[0] === 'sh' && c[2]?.includes('gog auth credentials set'));
    expect(set).toEqual(['sh', '-c', expect.stringContaining('. /root/.openclaw/env'), '/root/.openclaw/.clawhuddle-gog-client.tmp.json']);
    expect(docker.execs.flat().join(' ')).not.toContain('GOCSPX');
    expect(fs.existsSync(path.join(dir(), '.clawhuddle-gog-client.tmp.json'))).toBe(false);
    expect(await gogState()).toBe('injected');

    // Nothing to do the second time; the password is never regenerated.
    docker.execs.length = 0;
    await ensureGatewaySecrets(getGatewayRow(ORG, gw.id));
    expect(docker.execs.some((c) => c[0] === 'sh')).toBe(false);
    await app.inject({ method: 'POST', url: `/api/orgs/${ORG}/gateways/${gw.id}/restart`, headers: await as(MEMBER) });
    expect(envOf(dir())).toBe(env);
  });

  it("leaves a member's own gog client alone", async () => {
    fs.rmSync(path.join(dir(), '.clawhuddle-gog.json'));
    fs.rmSync(path.join(dir(), 'env'));
    fs.mkdirSync(path.join(dir(), 'gog', 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir(), 'gog', 'data', 'credentials.json'), '{"client_id":"theirs"}');
    expect(await gogState()).toBe('member');

    const gw = (await mine(MEMBER)).data[0];
    await app.inject({ method: 'POST', url: `/api/orgs/${ORG}/gateways/${gw.id}/restart`, headers: await as(MEMBER) });
    expect(fs.existsSync(path.join(dir(), 'env'))).toBe(false);
    const { ensureGatewaySecrets } = await import('../../services/gateway.js');
    const { getGatewayRow } = await import('../../services/gateway-store.js');
    docker.execs.length = 0;
    await ensureGatewaySecrets(getGatewayRow(ORG, gw.id));
    expect(docker.execs.some((c) => c[0] === 'sh')).toBe(false);
  });

  it("appends to an env file the member already has, keeping their lines", async () => {
    const { ensureGogEnv } = await import('../../services/gateway.js');
    const ownerDir = path.join(tmpDir, 'data', 'gateways', ORG, OWNER.id);
    fs.mkdirSync(ownerDir, { recursive: true });
    fs.writeFileSync(path.join(ownerDir, 'env'), 'PM2_HOME=/root/.openclaw/pm2\nGOG_KEYRING_BACKEND=file');
    ensureGogEnv({ org_id: ORG, user_id: OWNER.id, slot: 1 });
    const lines = envOf(ownerDir).trimEnd().split('\n');
    expect(lines[0]).toBe('PM2_HOME=/root/.openclaw/pm2');
    expect(lines[1]).toBe('GOG_KEYRING_BACKEND=file');
    expect(lines[2]).toMatch(/^GOG_KEYRING_PASSWORD=[0-9a-f]{48}$/);
    expect(lines).toHaveLength(3);
  });
});

describe('Google sign-in from the Home card', () => {
  const dir = () => path.join(tmpDir, 'data', 'gateways', ORG, MEMBER.id);
  let gwId: string;
  let startScript = '';
  const call = async (user: { id: string }, method: 'GET' | 'POST' | 'DELETE', suffix: string, payload?: object) =>
    app.inject({ method, url: `/api/orgs/${ORG}/gateways/${gwId}/google${suffix}`, headers: await as(user), ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    gwId = (await mine(MEMBER)).data[0].id;
    const { setGatewayState } = await import('../../services/gateway-store.js');
    setGatewayState(gwId, { status: 'running' });
    docker.shOutputs = {
      'gog auth list': JSON.stringify({ accounts: [{ email: 'member@example.com', subject: '1', services: ['gmail', 'drive'], scopes: ['x'] }] }),
      'gog auth add': 'Google sign-in requires a Google Account\n{"auth_url":"https://accounts.google.com/o/oauth2/auth?client_id=x&state=y","state_reused":false}',
      'gog auth remove': '',
    };
  });

  it("refuses a sign-in while the member's own gog setup has no keyring password", async () => {
    // Left by the previous block: credentials.json of the member's own, no env file.
    expect((await call(MEMBER, 'GET', '')).json().data).toEqual({ readiness: 'keyring', accounts: [] });
    expect((await call(MEMBER, 'POST', '/start', { email: 'member@example.com' })).statusCode).toBe(400);
  });

  it('lists the connected accounts, to admins too, without scopes or tokens', async () => {
    fs.writeFileSync(path.join(dir(), 'env'), 'GOG_KEYRING_BACKEND=file\nGOG_KEYRING_PASSWORD=abc\n', { mode: 0o600 });
    const res = await call(MEMBER, 'GET', '');
    expect(res.json().data).toEqual({ readiness: 'ready', accounts: [{ email: 'member@example.com', services: ['gmail', 'drive'] }] });
    expect((await call(ADMIN, 'GET', '')).statusCode).toBe(200);
  });

  it("keeps everyone else from connecting or removing an account on someone's instance", async () => {
    expect((await call(ADMIN, 'POST', '/start', { email: 'admin@example.com' })).statusCode).toBe(403);
    expect((await call(OWNER, 'POST', '/finish', { email: 'owner@example.com', url: 'http://127.0.0.1:1/oauth2/callback?code=c&state=s' })).statusCode).toBe(403);
    expect((await call(ADMIN, 'DELETE', '/accounts/member%40example.com')).statusCode).toBe(403);
  });

  it('starts the sign-in with the email as its own argument and returns the Google link', async () => {
    expect((await call(MEMBER, 'POST', '/start', { email: 'x; rm -rf /' })).statusCode).toBe(400);
    docker.execs.length = 0;
    const res = await call(MEMBER, 'POST', '/start', { email: 'member@example.com' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.authUrl).toMatch(/^https:\/\/accounts\.google\.com\//);
    const cmd = docker.execs.find((c) => c[2]?.includes('--step=1'))!;
    expect(cmd.slice(3)).toEqual(['member@example.com', 'gmail,calendar,drive,docs,sheets,slides']);
    startScript = cmd[2];
    expect(cmd[2]).toContain('. /root/.openclaw/env');
  });

  it('finishes only with the loopback address Google redirected to, passed through a file', async () => {
    for (const url of ['https://evil.example/?code=c&state=s', 'http://127.0.0.1:4242/oauth2/callback', 'not a url']) {
      expect((await call(MEMBER, 'POST', '/finish', { email: 'member@example.com', url })).statusCode).toBe(400);
    }
    docker.execs.length = 0;
    const url = 'http://127.0.0.1:42279/oauth2/callback?state=s123&code=4%2Fsecret-code&scope=email';
    const res = await call(MEMBER, 'POST', '/finish', { email: 'member@example.com', url });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.readiness).toBe('ready');
    const cmd = docker.execs.find((c) => c[2]?.includes('--step=2'))!;
    expect(cmd.slice(3)).toEqual(['member@example.com', 'gmail,calendar,drive,docs,sheets,slides', '/root/.openclaw/.clawhuddle-google-redirect.tmp']);
    // Step 2 must repeat step 1's flags, or gog refuses it as a state mismatch.
    const flags = (c: string) => c.replace(/--step=\d|--auth-url "\$\(cat "\$2"\)"/g, '').replace(/\s+/g, ' ').trim();
    expect(flags(cmd[2])).toBe(flags(startScript));
    expect(docker.execs.flat().join(' ')).not.toContain('secret-code');
    expect(fs.existsSync(path.join(dir(), '.clawhuddle-google-redirect.tmp'))).toBe(false);
  });

  it('disconnects an account', async () => {
    docker.execs.length = 0;
    const res = await call(MEMBER, 'DELETE', '/accounts/member%40example.com');
    expect(res.statusCode).toBe(200);
    expect(docker.execs.find((c) => c[2]?.includes('gog auth remove'))!.slice(3)).toEqual(['member@example.com']);
  });

  it('says what is missing instead of failing on an instance without a client', async () => {
    fs.rmSync(path.join(dir(), 'gog'), { recursive: true });
    expect((await call(MEMBER, 'GET', '')).json().data.readiness).toBe('pending'); // org client + env: being installed
    fs.rmSync(path.join(dir(), 'env'));
    expect((await call(MEMBER, 'GET', '')).json().data.readiness).toBe('restart');
  });
});

