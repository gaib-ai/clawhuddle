import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
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
  stopped: [] as string[],
  started: [] as string[],
  /** Every `exec` Cmd, in order. */
  execs: [] as string[][],
  /** What `openclaw devices list --json` prints inside the stub container. */
  devicesJson: '{"pending":[],"paired":[]}',
  /** stdout and exit code of `clawhuddle-pending-devices`; empty means unknown. */
  pendingCheck: { stdout: '', exitCode: 0 },
  /** stdout for `sh -c <script>` execs, picked by a substring of the script. */
  shOutputs: {} as Record<string, string>,
  /** Throwaway containers (created with an Entrypoint): their config, and what running one does. */
  offline: [] as any[],
  offlineRun: (_cfg: any): number => 0,
  /** What a failed throwaway container printed. */
  offlineOutput: 'cli said no\n',
  removed: [] as string[],
  /** Image id an existing instance container reports. */
  image: undefined as string | undefined,
  /** Full config of every instance container, by name (latest wins). */
  configs: {} as Record<string, any>,
  /** The `User` each exec ran as, in step with `execs`. */
  execUsers: [] as (string | undefined)[],
  /** stdout of the Hermes image's helper, by its command (`usage`, `google-start`, …). */
  helper: {} as Record<string, string>,
  /** While set, creating an instance container waits for it (holds a redeploy mid-way). */
  gate: null as Promise<void> | null,
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
    exitCode = 0;
    constructor(public name: string, public cfg?: any) {}
    async stop() { docker.stopped.push(this.name); }
    async remove() { docker.removed.push(this.name); }
    async start() {
      docker.started.push(this.name);
      if (this.cfg?.Entrypoint) this.exitCode = docker.offlineRun(this.cfg);
    }
    async wait() { return { StatusCode: this.exitCode }; }
    async kill() {}
    async logs() { return frame(2, docker.offlineOutput); }
    async restart() { docker.restarted.push(this.name); }
    async inspect() {
      return { State: { Running: true }, NetworkSettings: { Ports: {} }, Image: docker.image };
    }
    async exec(opts: { Cmd: string[]; User?: string }) {
      docker.execs.push(opts.Cmd);
      docker.execUsers.push(opts.User);
      const helper = opts.Cmd[1] === '/opt/clawhuddle/helper.py' ? docker.helper[opts.Cmd[2]] : undefined;
      const isList = opts.Cmd.slice(0, 3).join(' ') === 'openclaw devices list';
      const isCheck = opts.Cmd[0] === 'clawhuddle-pending-devices';
      const sh = opts.Cmd[0] === 'sh'
        ? Object.entries(docker.shOutputs).find(([k]) => opts.Cmd[2]?.includes(k))?.[1]
        : undefined;
      const chunks = isList
        ? [frame(2, 'warn: something on stderr\n'), frame(1, docker.devicesJson.slice(0, 10)), frame(1, docker.devicesJson.slice(10))]
        : isCheck ? [frame(1, docker.pendingCheck.stdout)]
        : sh !== undefined ? [frame(1, sh)]
        : helper !== undefined ? [frame(1, helper)] : [];
      return {
        start: async () => ({
          resume() {},
          on(event: string, cb: (chunk?: Buffer) => void) {
            if (event === 'data') for (const c of chunks) cb(c);
            if (event === 'end') setTimeout(cb, 0);
          },
        }),
        inspect: async () => ({ ExitCode: isCheck ? docker.pendingCheck.exitCode : 0 }),
      };
    }
  }
  class Docker {
    getNetwork() { return { inspect: async () => ({ IPAM: { Config: [{ Subnet: '172.20.0.0/16' }, { Subnet: 'fd00::/64' }, { Subnet: '0.0.0.0/0' }] } }) }; }
    async createNetwork() {}
    getContainer(name: string) { return new Container(name); }
    async createContainer(cfg: { name: string; Entrypoint?: string[] }) {
      if (docker.gate && !cfg.Entrypoint) await docker.gate;
      if (cfg.Entrypoint) docker.offline.push(cfg);
      else {
        docker.created.push(cfg.name);
        docker.configs[cfg.name] = cfg;
      }
      return new Container(cfg.name, cfg);
    }
    async listContainers() { return []; }
  }
  return { default: Docker };
});

// The real "Redeploy all" run, polling every millisecond instead of every 5 s.
const redeploy = vi.hoisted(() => ({ done: Promise.resolve() as Promise<void> }));
vi.mock('../../services/redeploy-all.js', async (original) => {
  const real = await original<typeof import('../../services/redeploy-all.js')>();
  return {
    ...real,
    startRedeployAll: (orgId: string, runtime: 'openclaw' | 'hermes' | null) => {
      const started = real.startRedeployAll(orgId, runtime, { pollMs: 1 });
      redeploy.done = started.done;
      return started;
    },
  };
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
    docker.stopped.length = 0;
    docker.started.length = 0;
    const res = await app.inject({ method: 'POST', url: `/api/orgs/${ORG}/gateways/${theirs}/restart`, headers: await as(OTHER) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('deploying');
    // Stopped, auth store reconciled while it is down, started again — same container.
    expect(docker.stopped).toEqual(['clawhuddle-gw-org-1-user-oth']);
    expect(docker.started).toEqual(['clawhuddle-gw-org-1-user-oth']);
    expect(docker.created.length).toBe(before);
    const denied = await app.inject({ method: 'POST', url: `/api/orgs/${ORG}/gateways/${theirs}/restart`, headers: await as(MEMBER) });
    expect(denied.statusCode).toBe(403);
  });

  describe('a key replaced in ClawHuddle, on OpenClaw 11.x', () => {
    // 11.x keeps credentials in the state database and never re-imports
    // auth-profiles.json, so the changed key is saved with OpenClaw's own CLI
    // in a throwaway container while the instance is down.
    const dir = () => path.join(tmpDir, 'data', 'gateways', ORG, OTHER.id);
    const statePath = () => path.join(dir(), 'state', 'openclaw.sqlite');
    const setStored = (profiles: Record<string, unknown>) => {
      fs.mkdirSync(path.dirname(statePath()), { recursive: true });
      const db = new Database(statePath());
      db.exec('CREATE TABLE IF NOT EXISTS config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL)');
      db.prepare('INSERT OR REPLACE INTO config_machine_state VALUES (?, ?, 1)').run('authProfiles.store', JSON.stringify({ version: 1, profiles }));
      db.close();
    };
    const stored = () => {
      const db = new Database(statePath(), { readonly: true });
      const row = db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'authProfiles.store'").get() as { value_json: string };
      db.close();
      return JSON.parse(row.value_json).profiles;
    };
    /** What `openclaw models auth paste-api-key` does: reads the key from stdin, saves the profile. */
    const pasteApiKey = (seen: { mode?: number }) => (cfg: any): number => {
      const [, , , , command, provider, profileId, file, agent] = cfg.Entrypoint as string[];
      if (command !== 'paste-api-key') return 2;
      const hostDir = cfg.HostConfig.Binds[0].split(':')[0];
      // Like the real CLI: with several agents it wants to be told whose credentials these are.
      const entries = JSON.parse(fs.readFileSync(path.join(hostDir, 'openclaw.json'), 'utf-8')).agents?.entries ?? {};
      if (Object.keys(entries).length > 1 && !agent) return 1;
      // Like the real CLI (AUTH_PROFILE_MIGRATION_REQUIRED): no save while a
      // legacy auth-profiles.json is waiting to be imported.
      if (fs.existsSync(path.join(hostDir, 'agents', 'main', 'agent', 'auth-profiles.json'))) return 1;
      const hostFile = path.join(hostDir, path.basename(file));
      seen.mode = fs.statSync(hostFile).mode & 0o777;
      setStored({ ...stored(), [profileId]: { type: 'api_key', provider, key: fs.readFileSync(hostFile, 'utf-8') } });
      return 0;
    };
    const restart = async () => {
      const theirs = (await mine(OTHER)).data[0].id;
      docker.offline.length = 0;
      docker.started.length = 0;
      docker.removed.length = 0;
      return app.inject({ method: 'POST', url: `/api/orgs/${ORG}/gateways/${theirs}/restart`, headers: await as(OTHER) });
    };
    const leftovers = () => fs.readdirSync(dir()).filter((f) => f.startsWith('.clawhuddle-auth-'));

    afterEach(() => {
      docker.offlineRun = () => 0;
      docker.image = undefined;
      docker.offlineOutput = 'cli said no\n';
      fs.rmSync(path.join(dir(), 'state'), { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    it('saves the new key offline before the instance boots, without putting it on a command line', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      setStored({ 'google:manual': { type: 'api_key', provider: 'google', key: 'AIza-old' }, 'tokenkiosk:default': { type: 'api_key', provider: 'tokenkiosk', key: 'sk-kiosk' } });
      const seen: { mode?: number } = {};
      docker.offlineRun = pasteApiKey(seen);

      expect((await restart()).statusCode).toBe(200);

      expect(docker.offline).toHaveLength(1);
      const cfg = docker.offline[0];
      expect(cfg.name).toBe('clawhuddle-authsave-org-1-user-oth');
      expect(cfg.HostConfig.NetworkMode).toBe('none');
      expect(cfg.Entrypoint.slice(4, 7)).toEqual(['paste-api-key', 'google', 'google:manual']);
      expect(cfg.Entrypoint[8]).toBe(''); // one agent: no --agent
      expect(JSON.stringify(cfg)).not.toContain('AIza-test');
      expect(seen.mode).toBe(0o600);
      expect(stored()['google:manual'].key).toBe('AIza-test');
      expect(stored()['tokenkiosk:default'].key).toBe('sk-kiosk');
      // The throwaway ran and was removed before the instance itself started.
      expect(docker.started).toEqual(['clawhuddle-authsave-org-1-user-oth', 'clawhuddle-gw-org-1-user-oth']);
      expect(docker.removed).toContain('clawhuddle-authsave-org-1-user-oth');
      expect(leftovers()).toEqual([]);
      // auth-profiles.json was out of the CLI's way during the save and is back for Doctor.
      const agentDir = path.join(dir(), 'agents', 'main', 'agent');
      expect(fs.readFileSync(path.join(agentDir, 'auth-profiles.json'), 'utf-8')).toContain('AIza-test');
      expect(fs.readdirSync(agentDir)).not.toContain('.clawhuddle-auth-profiles.held');
    });

    it("clears a killed gateway's state lock before the save, on images that can", async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      setStored({ 'google:manual': { type: 'api_key', provider: 'google', key: 'AIza-old' } });
      docker.offlineRun = pasteApiKey({});
      expect((await restart()).statusCode).toBe(200);
      const script = docker.offline[0].Entrypoint[2] as string;
      // Skipped where the helper does not exist (2026.11.2 images), and never fatal.
      expect(script.startsWith('if command -v clawhuddle-recover-lock >/dev/null 2>&1; then clawhuddle-recover-lock; fi; ')).toBe(true);
      expect(script.indexOf('clawhuddle-recover-lock; fi;')).toBeLessThan(script.indexOf('openclaw models auth'));
    });

    it('saves with the image the instance last ran on when a redeploy moves it to a new one', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const theirs = (await mine(OTHER)).data[0].id;
      const redeploy = async () => {
        docker.offline.length = 0;
        docker.started.length = 0;
        setStored({ 'google:manual': { type: 'api_key', provider: 'google', key: 'AIza-old' } });
        return app.inject({ method: 'POST', url: `/api/orgs/${ORG}/gateways/${theirs}/redeploy`, headers: await as(OTHER) });
      };
      docker.offlineRun = pasteApiKey({});

      // The newer CLI refuses state its Doctor has not upgraded yet; the old one can still write it.
      docker.image = 'sha256:previous';
      expect((await redeploy()).statusCode).toBe(200);
      expect(docker.offline[0].Image).toBe('sha256:previous');
      expect(docker.started).toEqual(['clawhuddle-authsave-org-1-user-oth', 'clawhuddle-gw-org-1-user-oth']);
      expect(stored()['google:manual'].key).toBe('AIza-test');

      docker.image = undefined; // no container to ask
      expect((await redeploy()).statusCode).toBe(200);
      expect(docker.offline[0].Image).toBe('clawhuddle-gateway:local');
    });

    it('waits out the killed gateway\'s hold on the state, then saves', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      setStored({ 'google:manual': { type: 'api_key', provider: 'google', key: 'AIza-old' } });
      docker.offlineOutput = 'Cannot admit models.authSetApiKey: the owner heartbeat is fresh. last renewed 90 s ago. wait 0 s and retry.\n';
      const paste = pasteApiKey({});
      let runs = 0;
      docker.offlineRun = (cfg) => (++runs === 1 ? 1 : paste(cfg));

      expect((await restart()).statusCode).toBe(200);

      expect(runs).toBe(2);
      expect(stored()['google:manual'].key).toBe('AIza-test');
      expect(log.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('still owns the state');
      expect(docker.started.at(-1)).toBe('clawhuddle-gw-org-1-user-oth');
      expect(leftovers()).toEqual([]);
    });

    it('names the default agent when the member has set up more than one', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      setStored({ 'google:manual': { type: 'api_key', provider: 'google', key: 'AIza-old' } });
      const configPath = path.join(dir(), 'openclaw.json');
      const before = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(before);
      config.agents = { ...config.agents, entries: { main: { name: 'Main' }, helper: { name: 'Helper' } } };
      fs.writeFileSync(configPath, JSON.stringify(config));
      docker.offlineRun = pasteApiKey({});
      try {
        expect((await restart()).statusCode).toBe(200);
        expect(docker.offline).toHaveLength(1);
        expect(docker.offline[0].Entrypoint.slice(4, 7)).toEqual(['paste-api-key', 'google', 'google:manual']);
        expect(docker.offline[0].Entrypoint[8]).toBe('main');
        expect(stored()['google:manual'].key).toBe('AIza-test');
      } finally {
        fs.writeFileSync(configPath, before);
      }
    });

    it('runs nothing when the store already holds the key', async () => {
      setStored({ 'google:manual': { type: 'api_key', provider: 'google', key: 'AIza-test' } });
      expect((await restart()).statusCode).toBe(200);
      expect(docker.offline).toHaveLength(0);
    });

    it("leaves a member's own pointer alone", async () => {
      const own = { type: 'api_key', provider: 'google', keyRef: { source: 'store', provider: 'default', id: 'GOOGLE_API_KEY' } };
      setStored({ 'google:manual': own });
      expect((await restart()).statusCode).toBe(200);
      expect(docker.offline).toHaveLength(0);
      expect(stored()['google:manual']).toEqual(own);
    });

    it('still boots the instance when the save fails, and says so without the key', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      setStored({ 'google:manual': { type: 'api_key', provider: 'google', key: 'AIza-old' } });
      docker.offlineRun = () => 1;

      expect((await restart()).statusCode).toBe(200);

      expect(docker.started).toEqual(['clawhuddle-authsave-org-1-user-oth', 'clawhuddle-gw-org-1-user-oth']);
      expect(stored()['google:manual'].key).toBe('AIza-old');
      const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(said).toContain('could not save google:manual');
      expect(said).toContain('cli said no');
      expect(said).not.toContain('AIza-test');
      expect(leftovers()).toEqual([]);
    });
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
    expect(byOwner.json().data).toEqual({ runtime: 'openclaw', gateway_token: adminsInstance.token, gateway_subdomain: adminsInstance.subdomain, gateway_port: 6100 });
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

  describe('cheap pending check', () => {
    const list = async () => {
      docker.execs.length = 0;
      const res = await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/me/device-requests`, headers: await as(MEMBER) });
      expect(res.statusCode).toBe(200);
      return {
        requests: res.json().data.map((r: { requestId: string }) => r.requestId),
        ranCli: docker.execs.some((c) => c[0] === 'openclaw'),
      };
    };

    beforeAll(() => { docker.devicesJson = JSON.stringify({ pending: [PENDING], paired: [] }); });
    afterEach(() => { docker.pendingCheck = { stdout: '', exitCode: 0 }; });
    afterAll(() => { docker.devicesJson = '{"pending":[],"paired":[]}'; });

    it('skips the CLI when nothing is waiting', async () => {
      docker.pendingCheck = { stdout: '0\n', exitCode: 0 };
      expect(await list()).toEqual({ requests: [], ranCli: false });
    });

    it('asks the CLI once something is waiting', async () => {
      docker.pendingCheck = { stdout: '1\n', exitCode: 0 };
      expect(await list()).toEqual({ requests: [PENDING.requestId], ranCli: true });
    });

    // A request must never disappear because the check could not answer.
    it.each([
      ['an instance on an older image', { stdout: 'exec: not found\n', exitCode: 127 }],
      ['a check that fails', { stdout: '', exitCode: 1 }],
      ['output that is not a count', { stdout: 'warn: 0\n', exitCode: 0 }],
      ['no output', { stdout: '', exitCode: 0 }],
    ])('falls back to the CLI for %s', async (_case, check) => {
      docker.pendingCheck = check;
      expect(await list()).toEqual({ requests: [PENDING.requestId], ranCli: true });
    });
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


describe('maintainers', () => {
  const MAINT = { id: 'user-maint', email: 'maint@example.com' };
  const PLAIN = { id: 'user-plain', email: 'plain@example.com' };
  const req = async (by: { id: string }, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url: `/api/orgs/${ORG}${url}`, headers: await as(by), ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    const { getDb } = await import('../../db/index.js');
    const db = getDb();
    for (const u of [MAINT, PLAIN]) db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(u.id, u.email);
    db.prepare("INSERT INTO org_members (id, org_id, user_id, role) VALUES (?, ?, ?, 'member')").run(om(PLAIN), ORG, PLAIN.id);
    db.prepare("INSERT INTO org_members (id, org_id, user_id, role) VALUES (?, ?, ?, 'member')").run(om(MAINT), ORG, MAINT.id);
  });

  it('can be granted by an admin', async () => {
    const res = await req(ADMIN, 'PATCH', `/members/${om(MAINT)}`, { role: 'maintainer' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.role).toBe('maintainer');
  });

  it('sees only plain members and themselves in the members list', async () => {
    const roles = (await req(MAINT, 'GET', '/members')).json().data.map((m: any) => [m.user_id, m.role]);
    expect(roles).toContainEqual([PLAIN.id, 'member']);
    expect(roles).toContainEqual([MAINT.id, 'maintainer']);
    expect(roles.some(([, r]: string[]) => r === 'owner' || r === 'admin')).toBe(false);
  });

  it("deploys and runs a plain member's instance, and may open it", async () => {
    const created = await req(MAINT, 'POST', `/gateways/members/${om(PLAIN)}`, {});
    expect(created.statusCode).toBe(201);
    const id = created.json().data.id;
    expect((await req(MAINT, 'POST', `/gateways/${id}/stop`)).statusCode).toBe(200);
    expect((await req(MAINT, 'POST', `/gateways/${id}/redeploy`)).statusCode).toBe(200);
    expect((await req(MAINT, 'DELETE', `/gateways/${id}`)).statusCode).toBe(403);
    expect((await mine(PLAIN)).data).toHaveLength(1);
    const access = await req(MAINT, 'GET', `/gateways/${id}/access`);
    expect(access.statusCode).toBe(200);
    expect(access.json().data.gateway_token).toBe((await mine(PLAIN)).data[0].token);
  });

  it("is kept off admins' and owners' instances", async () => {
    for (const target of [ADMIN, OWNER]) {
      const theirs = (await mine(target)).data[0].id;
      for (const [method, suffix] of [['GET', '/status'], ['POST', '/stop'], ['GET', '/access'], ['GET', '/channels'], ['DELETE', '']] as const) {
        expect((await req(MAINT, method, `/gateways/${theirs}${suffix}`)).statusCode, `${target.id} ${method} ${suffix}`).toBe(403);
      }
      expect((await req(MAINT, 'POST', `/gateways/members/${om(target)}`, {})).statusCode).toBe(403);
    }
  });

  it('still runs their own instance', async () => {
    expect((await req(MAINT, 'POST', `/gateways/members/${om(MAINT)}`, {})).statusCode).toBe(201);
    const own = (await mine(MAINT)).data[0].id;
    expect((await req(MAINT, 'POST', `/gateways/${own}/stop`)).statusCode).toBe(200);
    expect((await req(MAINT, 'DELETE', `/gateways/${own}`)).statusCode).toBe(200);
    expect((await mine(MAINT)).data).toHaveLength(0);
  });

  it('cannot invite, change members, or reach the other admin routes', async () => {
    expect((await req(MAINT, 'POST', '/members/invite', { email: 'x@example.com', role: 'member' })).statusCode).toBe(403);
    expect((await req(MAINT, 'GET', '/members/invitations')).statusCode).toBe(403);
    for (const payload of [{ role: 'admin' }, { status: 'disabled' }, { max_gateways: 3 }]) {
      expect((await req(MAINT, 'PATCH', `/members/${om(PLAIN)}`, payload)).statusCode).toBe(403);
    }
    expect((await req(MAINT, 'DELETE', `/members/${om(PLAIN)}`)).statusCode).toBe(403);
    expect((await req(MAINT, 'GET', '/gateways')).statusCode).toBe(403);
    expect((await req(MAINT, 'POST', '/gateways/redeploy-all')).statusCode).toBe(403);
    expect((await req(MAINT, 'GET', '/gateways/redeploy-all')).statusCode).toBe(403);
    expect((await req(MAINT, 'GET', '/device-requests')).statusCode).toBe(403);
    expect((await req(MAINT, 'GET', '/api-keys')).statusCode).toBe(403);
  });
});


describe('Hermes instances', () => {
  const HERMIT = { id: 'user-hermit', email: 'hermit@example.com' };
  const NAME = 'clawhuddle-gw-org-1-user-her';
  const home = () => path.join(tmpDir, 'data', 'gateways', ORG, HERMIT.id);
  const managed = () => path.join(tmpDir, 'data', 'gateways', ORG, '.hermes', HERMIT.id);
  const req = async (by: { id: string }, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url: `/api/orgs/${ORG}${url}`, headers: await as(by), ...(payload ? { payload } : {}) });
  const row = async () => (await mine(HERMIT)).data[0];
  const helperCalls = () => docker.execs.filter((c) => c[1] === '/opt/clawhuddle/helper.py').map((c) => c.slice(2));

  beforeAll(async () => {
    const { getDb } = await import('../../db/index.js');
    const db = getDb();
    db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(HERMIT.id, HERMIT.email);
    db.prepare("INSERT INTO org_members (id, org_id, user_id, role) VALUES (?, ?, ?, 'member')").run(om(HERMIT), ORG, HERMIT.id);
  });

  it('are refused until the organization turns them on', async () => {
    const res = await createOwn(HERMIT, { runtime: 'hermes' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('runtime_disabled');
    expect((await createOwn(HERMIT, { runtime: 'skynet' })).statusCode).toBe(400);
    expect(await mine(HERMIT)).toMatchObject({ current: 0 });
  });

  it('are switched on by an admin, with a real boolean only', async () => {
    expect((await req(MEMBER, 'PATCH', '', { hermes_enabled: true })).statusCode).toBe(403);
    expect((await req(ADMIN, 'PATCH', '', { hermes_enabled: 'yes' })).statusCode).toBe(400);
    const res = await req(ADMIN, 'PATCH', '', { hermes_enabled: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.hermes_enabled).toBe(true);
    const orgs = (await app.inject({ method: 'GET', url: '/api/orgs', headers: await as(HERMIT) })).json().data;
    expect(orgs.find((o: any) => o.id === ORG).hermes_enabled).toBe(true);
  });

  it('deploy on the Hermes image with the home and a read-only managed layer', async () => {
    const res = await createOwn(HERMIT, { runtime: 'hermes', label: 'hermes one' });
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({ slot: 1, runtime: 'hermes', status: 'deploying', label: 'hermes one' });
    expect(docker.created.at(-1)).toBe(NAME);

    const cfg = docker.configs[NAME];
    const { token, subdomain } = await row();
    expect(cfg.Image).toBe('clawhuddle-hermes:local');
    expect(cfg.Cmd).toEqual(['gateway', 'run']);
    expect(cfg.HostConfig.Binds).toEqual([`${home()}:/opt/data`, `${managed()}:/etc/hermes:ro`]);
    expect(cfg.Env).toContain(`HERMES_DASHBOARD_BASIC_AUTH_USERNAME=${subdomain}`);
    expect(cfg.Env).toContain(`HERMES_DASHBOARD_PUBLIC_URL=https://${subdomain}.example.com`);
    // The password (the instance token) and the keys are nowhere in what Docker stores.
    const stored = JSON.stringify(cfg);
    expect(stored).not.toContain(token);
    expect(stored).not.toContain('AIza-test');
    expect(JSON.stringify(cfg.Labels)).toContain('9119');
    // One path on the instance's host is the API's sign-in helper; everything else is the dashboard.
    const open = `traefik.http.routers.${cfg.name}-open`;
    expect(cfg.Labels[`${open}.rule`]).toBe(`Host(\`${subdomain}.example.com\`) && Path(\`/_clawhuddle/open\`)`);
    expect(cfg.Labels[`${open}.service`]).toBe('api@docker');
    expect(cfg.Labels[`traefik.http.routers.${cfg.name}.service`]).toBe(cfg.name);
  });

  it('get keys and the model through the managed layer, and leave the member a seeded config', async () => {
    const env = fs.readFileSync(path.join(managed(), '.env'), 'utf-8');
    expect(env).toContain('GOOGLE_API_KEY="AIza-test"');
    expect(env).toContain('NOTION_API_KEY="ntn_test_token"');
    const config = JSON.parse(fs.readFileSync(path.join(managed(), 'config.yaml'), 'utf-8'));
    expect(config.model).toMatchObject({ provider: 'gemini', default: 'gemini-3.8-flash' });
    // Forwarded headers are trusted from the gateway network only (IPv4, never an open range).
    expect(config.dashboard).toEqual({ trusted_proxies: ['172.20.0.0/16'] });

    expect(fs.readFileSync(path.join(home(), 'config.yaml'), 'utf-8')).toContain('cwd: /opt/data/workspace');
    expect(fs.existsSync(path.join(home(), 'openclaw.json'))).toBe(false);
    expect(fs.existsSync(path.join(home(), '.env'))).toBe(false);
    for (const skill of ['clawhuddle-platform', 'notion']) {
      expect(fs.existsSync(path.join(home(), 'skills', 'clawhuddle', skill, 'SKILL.md'))).toBe(true);
    }
  });

  it('count against the same per-member limit as OpenClaw instances', async () => {
    await req(ADMIN, 'PATCH', `/members/${om(HERMIT)}`, { max_gateways: 1 });
    const res = await createOwn(HERMIT);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'gateway_limit', limit: 1, current: 1 });
  });

  it('report running once the dashboard says its gateway is up, asked as the hermes user', async () => {
    docker.execs.length = 0;
    docker.execUsers.length = 0;
    const g = await row();
    const res = await req(HERMIT, 'GET', `/gateways/${g.id}/status`);
    expect(res.json().data.status).toBe('running');
    expect(docker.execs[0][0]).toBe('/opt/hermes/.venv/bin/python');
    expect(docker.execs[0][2]).toContain('/api/status');
    expect(docker.execUsers[0]).toBe('hermes');
    // No OpenClaw follow-up (secret store, device check) on a Hermes instance.
    expect(docker.execs.flat().join(' ')).not.toContain('openclaw');
  });

  it('are redeployed on their own by "Redeploy all Hermes", in the background', async () => {
    expect((await req(ADMIN, 'GET', '/gateways/redeploy-all')).json().data).toBeNull();
    expect((await req(ADMIN, 'POST', '/gateways/redeploy-all', { runtime: 'skynet' })).statusCode).toBe(400);
    expect((await req(MEMBER, 'POST', '/gateways/redeploy-all', { runtime: 'hermes' })).statusCode).toBe(403);
    expect((await req(MEMBER, 'GET', '/gateways/redeploy-all')).statusCode).toBe(403);

    const g = await row();
    const before = docker.created.length;
    let release = () => {};
    docker.gate = new Promise<void>((resolve) => { release = resolve; });
    const res = await req(ADMIN, 'POST', '/gateways/redeploy-all', { runtime: 'hermes' });
    expect(res.statusCode).toBe(202);
    expect(res.json().data).toMatchObject({ runtime: 'hermes', concurrency: 2, finishedAt: null });
    expect(res.json().data.items.map((i: any) => i.gatewayId)).toEqual([g.id]);
    // A second click while it runs starts nothing.
    const again = await req(ADMIN, 'POST', '/gateways/redeploy-all', {});
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('redeploy_in_progress');

    docker.gate = null;
    release();
    await redeploy.done;
    const run = (await req(ADMIN, 'GET', '/gateways/redeploy-all')).json().data;
    expect(run.finishedAt).not.toBeNull();
    expect(run.items).toMatchObject([{ gatewayId: g.id, runtime: 'hermes', state: 'done' }]);
    // Only the Hermes container was created again; no OpenClaw instance was touched.
    expect(docker.created.slice(before)).toEqual([NAME]);
  });

  it('hand an admin the sign-in instead of a token link', async () => {
    const g = await row();
    const res = await req(ADMIN, 'GET', `/gateways/${g.id}/access`);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      runtime: 'hermes', gateway_token: g.token, gateway_subdomain: g.subdomain, gateway_port: 9119, dashboard_username: g.subdomain,
    });
  });

  it('keep what the member changed in their own config across a redeploy', async () => {
    const g = await row();
    const file = path.join(home(), 'config.yaml');
    fs.writeFileSync(file, 'agent:\n  reasoning_effort: high\n');
    expect((await req(HERMIT, 'POST', `/gateways/${g.id}/redeploy`)).statusCode).toBe(200);
    expect(fs.readFileSync(file, 'utf-8')).toBe('agent:\n  reasoning_effort: high\n');
    expect(docker.removed).toContain(NAME);
  });

  it('follow a model pin and a new key without a restart', async () => {
    const { setGatewayState } = await import('../../services/gateway-store.js');
    const g = await row();
    setGatewayState(g.id, { status: 'running' });
    docker.restarted.length = 0;
    const created = docker.created.length;

    const key = await req(ADMIN, 'POST', '/api-keys', { provider: 'token-kiosk', key: 'sk-kiosk-test', credentialType: 'api_key' });
    expect(key.statusCode).toBe(201);
    expect(fs.readFileSync(path.join(managed(), '.env'), 'utf-8')).toContain('TOKEN_KIOSK_API_KEY="sk-kiosk-test"');

    const pin = await req(HERMIT, 'PATCH', `/gateways/${g.id}`, { primary_model: 'tokenkiosk/claude-sonnet-5' });
    expect(pin.statusCode).toBe(200);
    const config = JSON.parse(fs.readFileSync(path.join(managed(), 'config.yaml'), 'utf-8'));
    expect(config.model).toMatchObject({ provider: 'custom:tokenkiosk', default: 'claude-sonnet-5' });
    expect(config.providers.tokenkiosk).toEqual({
      base_url: 'https://agent-router.gaib.ai/v1', key_env: 'TOKEN_KIOSK_API_KEY', api_mode: 'chat_completions',
      models: ['azure/gpt-5.5', 'claude-sonnet-5', 'minimax-m3.1-flash'], discover_models: false,
    });
    expect(JSON.stringify(config)).not.toContain('sk-kiosk-test');
    expect(config.dashboard).toEqual({ trusted_proxies: ['172.20.0.0/16'] });

    expect(docker.restarted).toEqual([]);
    expect(docker.created.length).toBe(created);
  });

  it('show Notion and the Google client as installed on the API Keys page', async () => {
    const mineStatus = (await req(HERMIT, 'GET', '/me/api-keys/secret-status')).json().data;
    expect(mineStatus[0].secrets).toMatchObject({ notion: 'injected', 'google-workspace': 'injected' });
    const client = JSON.parse(fs.readFileSync(path.join(home(), 'google_client_secret.json'), 'utf-8'));
    expect(client.installed.client_id).toBe('123456789012-abc.apps.googleusercontent.com');
    // The secret-store sync of OpenClaw never ran here.
    expect(fs.existsSync(path.join(home(), '.clawhuddle-secrets.json'))).toBe(false);
  });

  it("never replace a Google client the member installed themselves", async () => {
    const state = path.join(managed(), 'clawhuddle-state.json');
    const saved = fs.readFileSync(state, 'utf-8');
    fs.writeFileSync(state, '{}');
    fs.writeFileSync(path.join(home(), 'google_client_secret.json'), '{"installed":{"client_id":"own","client_secret":"own"}}');
    const g = await row();
    expect((await req(HERMIT, 'POST', `/gateways/${g.id}/restart`)).statusCode).toBe(200);
    expect(fs.readFileSync(path.join(home(), 'google_client_secret.json'), 'utf-8')).toContain('"own"');
    expect((await req(HERMIT, 'GET', '/me/api-keys/secret-status')).json().data[0].secrets['google-workspace']).toBe('member');
    // Back to the platform's client for the tests below.
    fs.rmSync(path.join(home(), 'google_client_secret.json'));
    fs.writeFileSync(state, saved);
    const { setGatewayState } = await import('../../services/gateway-store.js');
    setGatewayState(g.id, { status: 'running' });
  });

  it('connect one Google account through the helper, the pasted address passed in a file', async () => {
    const g = await row();
    const call = (by: { id: string }, method: 'GET' | 'POST' | 'DELETE', suffix: string, payload?: object) =>
      req(by, method, `/gateways/${g.id}/google${suffix}`, payload);

    // The client file was removed above: the first read puts the platform's back.
    expect((await call(HERMIT, 'GET', '')).json().data).toEqual({ readiness: 'ready', accounts: [] });
    expect((await call(ADMIN, 'POST', '/start', { email: 'hermit@example.com' })).statusCode).toBe(403);

    docker.helper = {
      'google-start': '{"auth_url":"https://accounts.google.com/o/oauth2/auth?client_id=x"}',
      'google-finish': '{"ok":true}',
      'google-revoke': '{"ok":true}',
    };
    const start = await call(HERMIT, 'POST', '/start', { email: 'hermit@example.com' });
    expect(start.statusCode).toBe(200);
    expect(start.json().data.authUrl).toMatch(/^https:\/\/accounts\.google\.com\//);

    expect((await call(HERMIT, 'POST', '/finish', { email: 'hermit@example.com', url: 'https://evil.example/?code=c&state=s' })).statusCode).toBe(400);
    docker.execs.length = 0;
    const url = 'http://localhost:1/?state=s123&code=4%2Fsecret-code&scope=email';
    const finish = await call(HERMIT, 'POST', '/finish', { email: 'hermit@example.com', url });
    expect(finish.statusCode).toBe(200);
    expect(helperCalls()).toEqual([['google-finish', '/opt/data/.clawhuddle-google-redirect.tmp', 'hermit@example.com']]);
    expect(docker.execs.flat().join(' ')).not.toContain('secret-code');
    expect(fs.existsSync(path.join(home(), '.clawhuddle-google-redirect.tmp'))).toBe(false);

    // What the helper leaves behind after a real sign-in.
    fs.writeFileSync(path.join(home(), 'google_token.json'), '{}');
    fs.writeFileSync(path.join(home(), '.clawhuddle-google.json'), '{"email":"hermit@example.com"}');
    expect((await call(ADMIN, 'GET', '')).json().data.accounts).toEqual([
      { email: 'hermit@example.com', services: ['gmail', 'calendar', 'drive', 'contacts', 'sheets', 'docs'] },
    ]);
    expect((await call(HERMIT, 'DELETE', '/accounts/hermit%40example.com')).statusCode).toBe(200);
    expect(helperCalls().at(-1)).toEqual(['google-revoke']);
  });

  it('reports a helper error without the secrets it may quote', async () => {
    const g = await row();
    docker.helper['google-start'] = '{"error":"token exchange failed for code=4/abc with GOCSPX-leaky"}';
    const res = await req(HERMIT, 'POST', `/gateways/${g.id}/google/start`, { email: 'hermit@example.com' });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).not.toContain('GOCSPX-leaky');
  });

  it('approve a chat pairing with the code as its own argument', async () => {
    const g = await row();
    const pair = (code: string) => req(HERMIT, 'POST', `/gateways/${g.id}/channels/slack/pair`, { code });
    expect((await pair('abc; rm -rf /')).statusCode).toBe(400);
    docker.execs.length = 0;
    expect((await pair('ABCD-1234')).statusCode).toBe(200);
    expect(docker.execs).toEqual([['/opt/hermes/bin/hermes', 'pairing', 'approve', 'slack', 'ABCD-1234']]);

    docker.helper['pairing-list'] = '{"pending":[{"platform":"slack","user_id":"U1","user_name":"sam","age_minutes":3}]}';
    const list = await req(HERMIT, 'GET', `/gateways/${g.id}/channels/slack/pair`);
    expect(list.json().data.output).toContain('sam (U1) · waiting 3 min');
    expect((await req(HERMIT, 'GET', `/gateways/${g.id}/channels/irc/pair`)).statusCode).toBe(400);
  });

  it('take channel tokens into the managed env', async () => {
    const g = await row();
    const put = await req(HERMIT, 'PUT', `/gateways/${g.id}/channels/slack`, { bot_token: 'xoxb-h', app_token: 'xapp-h' });
    expect(put.statusCode).toBe(200);
    const env = fs.readFileSync(path.join(managed(), '.env'), 'utf-8');
    expect(env).toContain('SLACK_BOT_TOKEN="xoxb-h"');
    expect(env).toContain('SLACK_APP_TOKEN="xapp-h"');
    expect(fs.statSync(path.join(managed(), '.env')).mode & 0o007).toBe(0);
  });

  it('have no device requests', async () => {
    const g = await row();
    const { setGatewayState } = await import('../../services/gateway-store.js');
    setGatewayState(g.id, { status: 'running' });
    docker.execs.length = 0;
    expect((await req(HERMIT, 'GET', '/me/device-requests')).json().data).toEqual([]);
    expect((await req(HERMIT, 'GET', `/gateways/${g.id}/devices`)).json().data).toEqual([]);
    expect(docker.execs).toEqual([]);
    const res = await req(HERMIT, 'POST', `/gateways/${g.id}/devices/0f6f2c1e-6a3e-4d4c-9b1c-0f3f2b9d1a11/approve`);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/Hermes/);
  });

  it('report usage in the same shape as an OpenClaw instance', async () => {
    const g = await row();
    const t = (totalTokens: number, totalCost: number) => ({ input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, totalCost });
    docker.helper.usage = JSON.stringify({
      totals: t(900, 0.3), sessions: 3,
      messages: { total: 12, user: 5, assistant: 7, toolCalls: 2, toolResults: 2, errors: 0 },
      byModel: [{ provider: 'gemini', model: 'gemini-3.8-flash', calls: 7, totals: t(900, 0.3) }],
      byChannel: [{ channel: 'slack', tokens: 600, cost: 0.2 }, { channel: 'other', tokens: 300, cost: 0.1 }],
      daily: [{ date: '2026-11-27', tokens: 900, cost: 0.3, messages: 12, toolCalls: 2, errors: 0 }],
    });
    docker.execs.length = 0;
    const res = await req(HERMIT, 'GET', `/gateways/${g.id}/usage?days=7`);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ gateway_id: g.id, cacheStatus: 'fresh', totals: { totalTokens: 900 } });
    expect(res.json().data.byModel[0]).toMatchObject({ provider: 'google', model: 'gemini-3.8-flash' });
    expect(helperCalls()[0][0]).toBe('usage');
    expect(docker.execs.flat().join(' ')).not.toContain('sessions.usage');
  });

  it('keep running when the organization turns Hermes off again; only new ones are refused', async () => {
    expect((await req(OWNER, 'PATCH', '', { hermes_enabled: false })).json().data.hermes_enabled).toBe(false);
    await req(ADMIN, 'PATCH', `/members/${om(HERMIT)}`, { max_gateways: 2 });
    expect((await createOwn(HERMIT, { runtime: 'hermes' })).statusCode).toBe(403);
    const g = await row();
    expect((await req(HERMIT, 'POST', `/gateways/${g.id}/restart`)).statusCode).toBe(200);
    // The same member can still add an OpenClaw instance next to it.
    const second = await createOwn(HERMIT);
    expect(second.statusCode).toBe(201);
    expect(second.json().data).toMatchObject({ slot: 2, runtime: 'openclaw' });
    expect(docker.configs[`${NAME}-2`].Image).not.toBe('clawhuddle-hermes:local');
  });

  it('are removed with their home and their managed layer', async () => {
    const g = await row();
    const res = await req(HERMIT, 'DELETE', `/gateways/${g.id}`);
    expect(res.statusCode).toBe(200);
    expect(fs.existsSync(home())).toBe(false);
    expect(fs.existsSync(managed())).toBe(false);
    // The OpenClaw instance next to it is untouched.
    expect(fs.existsSync(path.join(tmpDir, 'data', 'gateways', ORG, `${HERMIT.id}-2`, 'openclaw.json'))).toBe(true);
  });
});
