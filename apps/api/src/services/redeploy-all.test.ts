import { describe, it, expect, vi } from 'vitest';

// The run only needs the three calls it is handed; keep the real services (and Docker) out.
vi.mock('./gateway.js', () => ({ deployGateway: vi.fn(), getGatewayStatus: vi.fn() }));
vi.mock('./gateway-store.js', () => ({ listOrgGateways: vi.fn(() => []) }));

import { RedeployInProgressError, getRedeployAll, startRedeployAll, type RedeployDeps } from './redeploy-all.js';

type Runtime = 'openclaw' | 'hermes';
const gw = (id: string, runtime: Runtime = 'openclaw') => ({ id, member_id: `om-${id}`, slot: 1, runtime });

/**
 * A fleet where an instance is `running`, goes to `deploying` when redeployed
 * and is running again `bootPolls` status reads later.
 */
function fleet(ids: (string | [string, Runtime])[], opts: { bootPolls?: number; stopped?: string[]; broken?: string[]; dead?: string[] } = {}) {
  const rows = ids.map((x) => (Array.isArray(x) ? gw(x[0], x[1]) : gw(x)));
  const booting = new Map<string, number>();
  const log: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const deps: Partial<RedeployDeps> = {
    list: () => rows,
    pollMs: 1,
    timeoutMs: 2_000,
    concurrency: 2,
    deploy: async (_org, id) => {
      log.push(`deploy ${id}`);
      if (opts.broken?.includes(id)) throw new Error(`no keys for ${id}`);
      booting.set(id, opts.bootPolls ?? 3);
      peak = Math.max(peak, ++inFlight);
    },
    status: async (_org, id) => {
      if (opts.stopped?.includes(id)) return { status: 'stopped' };
      const left = booting.get(id);
      if (left === undefined) return { status: 'running' };
      if (opts.dead?.includes(id)) return { status: 'stopped' };
      if (left > 1) {
        booting.set(id, left - 1);
        return { status: 'deploying' };
      }
      booting.delete(id);
      inFlight--;
      log.push(`up ${id}`);
      return { status: 'running' };
    },
  };
  return { deps, log, peak: () => peak };
}

const states = (orgId: string) => Object.fromEntries(getRedeployAll(orgId)!.items.map((i) => [i.gatewayId, i.reason ?? i.state]));

describe('redeploy all', () => {
  it('redeploys two at a time and waits for each to be running before taking the next', async () => {
    const f = fleet(['a', 'b', 'c', 'd', 'e']);
    const { run, done } = startRedeployAll('org-two', null, f.deps);
    expect(run.finishedAt).toBeNull();
    expect(run.concurrency).toBe(2);
    await done;
    expect(f.peak()).toBe(2);
    expect(states('org-two')).toEqual({ a: 'done', b: 'done', c: 'done', d: 'done', e: 'done' });
    // The third instance is only touched after one of the first two is back.
    expect(f.log.indexOf('deploy c')).toBeGreaterThan(Math.min(f.log.indexOf('up a'), f.log.indexOf('up b')));
    expect(getRedeployAll('org-two')!.finishedAt).not.toBeNull();
    expect(getRedeployAll('org-two')!.halted).toBe(false);
  });

  it('takes only the runtime asked for', async () => {
    const f = fleet(['a', ['h1', 'hermes'], 'b', ['h2', 'hermes']]);
    const { run, done } = startRedeployAll('org-rt', 'hermes', f.deps);
    await done;
    expect(run.items.map((i) => i.gatewayId)).toEqual(['h1', 'h2']);
    expect(f.log.filter((l) => l.startsWith('deploy'))).toEqual(['deploy h1', 'deploy h2']);
    const open = startRedeployAll('org-rt', 'openclaw', f.deps);
    await open.done;
    expect(open.run.items.map((i) => i.gatewayId)).toEqual(['a', 'b']);
  });

  it('leaves a stopped instance stopped', async () => {
    const f = fleet(['a', 'b', 'c'], { stopped: ['b'] });
    await startRedeployAll('org-stop', null, f.deps).done;
    expect(states('org-stop')).toEqual({ a: 'done', b: 'stopped', c: 'done' });
    expect(f.log).not.toContain('deploy b');
  });

  it('carries on after one failure', async () => {
    const f = fleet(['a', 'b', 'c', 'd'], { broken: ['b'] });
    await startRedeployAll('org-one', null, f.deps).done;
    expect(states('org-one')).toEqual({ a: 'done', b: 'failed', c: 'done', d: 'done' });
    const run = getRedeployAll('org-one')!;
    expect(run.halted).toBe(false);
    expect(run.items[1].error).toBe('no keys for b');
  });

  it('halts after two failures in a row and does not touch the rest', async () => {
    const f = fleet(['a', 'b', 'c', 'd', 'e'], { broken: ['a', 'b'] });
    await startRedeployAll('org-halt', null, f.deps).done;
    expect(states('org-halt')).toEqual({ a: 'failed', b: 'failed', c: 'halted', d: 'halted', e: 'halted' });
    expect(getRedeployAll('org-halt')!.halted).toBe(true);
    expect(f.log.filter((l) => l.startsWith('deploy'))).toEqual(['deploy a', 'deploy b']);
  });

  it('fails an instance whose container stays down or never answers', async () => {
    const dead = fleet(['a', 'b'], { dead: ['a'] });
    await startRedeployAll('org-dead', null, { ...dead.deps, concurrency: 1 }).done;
    expect(states('org-dead')).toEqual({ a: 'failed', b: 'done' });
    expect(getRedeployAll('org-dead')!.items[0].error).toMatch(/stopped after the redeploy/);

    const slow = fleet(['a'], { bootPolls: 10_000 });
    await startRedeployAll('org-slow', null, { ...slow.deps, timeoutMs: 20 }).done;
    expect(getRedeployAll('org-slow')!.items[0].error).toMatch(/^Not running/);
  });

  it('refuses a second run for the org while one is going', async () => {
    const f = fleet(['a', 'b', 'c']);
    const first = startRedeployAll('org-busy', null, f.deps);
    expect(() => startRedeployAll('org-busy', 'hermes', f.deps)).toThrow(RedeployInProgressError);
    // Another org is not held up.
    await startRedeployAll('org-free', null, fleet(['x']).deps).done;
    await first.done;
    await startRedeployAll('org-busy', null, f.deps).done;
  });
});
