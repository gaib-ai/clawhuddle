'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { gatewayLabel } from '@/lib/gateway-url';
import { runtimeLabel, type GatewayRuntime, type OrgMember, type RedeployAllRun } from '@clawhuddle/shared';

type OrgFetch = <T>(path: string, options?: RequestInit) => Promise<T>;

const DISMISSED_KEY = 'clawhuddle.redeployAll.dismissed';
const readDismissed = () => {
  try { return window.localStorage.getItem(DISMISSED_KEY); } catch { return null; }
};

const plural = (n: number, word = 'instance') => `${n} ${word}${n === 1 ? '' : 's'}`;
const scopeLabel = (runtime: GatewayRuntime | null) => (runtime ? `${runtimeLabel(runtime)} instances` : 'instances');

/**
 * "Redeploy all" on Admin → Members: every instance, or every instance of one
 * runtime. The API runs it in the background a few instances at a time; this
 * starts a run and follows it, including one started in another tab or by
 * another admin.
 */
export function useRedeployAll(members: OrgMember[], orgFetch: OrgFetch, enabled: boolean, onChange: () => void) {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [run, setRun] = useState<RedeployAllRun | null>(null);
  const [starting, setStarting] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const active = !!run && !run.finishedAt;
  const wasActive = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await orgFetch<{ data: RedeployAllRun | null }>('/gateways/redeploy-all');
      setRun(res.data);
    } catch { /* keep what is shown */ }
  }, [orgFetch]);

  useEffect(() => {
    if (!enabled) return;
    setDismissed(readDismissed());
    void load();
  }, [enabled, load]);

  // Follow a run while it is going; the members list shows each instance's status.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { void load(); onChange(); }, 5000);
    return () => clearInterval(timer);
  }, [active, load, onChange]);

  useEffect(() => {
    if (wasActive.current && run?.finishedAt) {
      const failed = run.items.filter((i) => i.state === 'failed').length;
      const done = run.items.filter((i) => i.state === 'done').length;
      if (run.halted) toast(`Redeploy stopped after ${plural(failed, 'failure')}; the remaining instances were not touched`, 'error');
      else if (failed) toast(`Redeployed ${done}, failed ${failed}`, 'error');
      else toast(`Redeployed ${plural(done)}`, 'success');
      onChange();
    }
    wasActive.current = active;
  }, [active, run, toast, onChange]);

  const gateways = members.flatMap((m) => m.gateways ?? []);
  const up = gateways.filter((g) => g.status !== 'stopped');
  const count = (runtime: GatewayRuntime | null) => up.filter((g) => !runtime || g.runtime === runtime).length;

  const start = async (runtime: GatewayRuntime | null) => {
    const n = count(runtime);
    const ok = await confirm({
      title: runtime ? `Redeploy all ${runtimeLabel(runtime)} instances` : 'Redeploy all instances',
      description:
        `${plural(n)} will be recreated on the current image, two at a time; the next one starts once the one before it is running again. ` +
        'Each is offline for a few minutes while it boots. Stopped instances are left stopped.',
      confirmLabel: 'Redeploy',
    });
    if (!ok) return;
    setStarting(true);
    try {
      const res = await orgFetch<{ data: RedeployAllRun }>('/gateways/redeploy-all', {
        method: 'POST',
        body: JSON.stringify({ runtime }),
      });
      wasActive.current = true;
      setRun(res.data);
      onChange();
    } catch (err: any) {
      toast(err.message, 'error');
      await load();
    } finally {
      setStarting(false);
    }
  };

  const dismiss = () => {
    if (!run) return;
    setDismissed(run.id);
    try { window.localStorage.setItem(DISMISSED_KEY, run.id); } catch { /* shown again on the next visit */ }
  };

  const nameOf = (gatewayId: string) => {
    for (const m of members) {
      const g = (m.gateways ?? []).find((x) => x.id === gatewayId);
      if (g) return `${m.name || m.email} · ${gatewayLabel(g)}`;
    }
    return 'A removed instance';
  };

  return {
    run,
    active,
    busy: active || starting,
    count,
    hasBoth: gateways.some((g) => g.runtime === 'hermes') && gateways.some((g) => g.runtime !== 'hermes'),
    hasAny: gateways.length > 0,
    start,
    dismiss,
    showSummary: !!run && (active || dismissed !== run.id),
    nameOf,
  };
}

type RedeployAll = ReturnType<typeof useRedeployAll>;

/** The button; with both runtimes in the org it opens a menu to pick one. */
export function RedeployAllButton({ redeploy }: { redeploy: RedeployAll }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  if (!redeploy.hasAny) return null;
  const options: { runtime: GatewayRuntime | null; label: string }[] = redeploy.hasBoth
    ? [
        { runtime: null, label: 'All instances' },
        { runtime: 'openclaw', label: `All ${runtimeLabel('openclaw')}` },
        { runtime: 'hermes', label: `All ${runtimeLabel('hermes')}` },
      ]
    : [];
  const pick = (runtime: GatewayRuntime | null) => {
    setOpen(false);
    void redeploy.start(runtime);
  };

  return (
    <div ref={ref} className="relative ml-auto">
      <button
        onClick={() => (options.length ? setOpen((v) => !v) : pick(null))}
        disabled={redeploy.busy || redeploy.count(null) === 0}
        aria-haspopup={options.length ? 'menu' : undefined}
        aria-expanded={options.length ? open : undefined}
        className="px-3 py-2.5 sm:py-2 rounded-lg text-xs font-medium transition-all disabled:opacity-50"
        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
        onMouseEnter={(e) => { if (!redeploy.busy) e.currentTarget.style.background = 'var(--bg-hover)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
      >
        {redeploy.active ? 'Redeploying…' : options.length ? 'Redeploy all ▾' : 'Redeploy all instances'}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-full mt-1 right-0 min-w-[13rem] rounded-lg py-1 z-50 shadow-lg"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
        >
          {options.map((o) => {
            const n = redeploy.count(o.runtime);
            return (
              <button
                key={o.runtime ?? 'all'}
                role="menuitem"
                onClick={() => pick(o.runtime)}
                disabled={n === 0}
                className="w-full flex items-center justify-between gap-4 px-3 py-2 text-left text-xs transition-colors disabled:opacity-50"
                style={{ color: 'var(--text-primary)' }}
                onMouseEnter={(e) => { if (n > 0) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <span>{o.label}</span>
                <span className="tabular-nums" style={{ color: 'var(--text-tertiary)' }}>{n}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Progress while a run is going, and its result until dismissed. */
export function RedeployAllStatus({ redeploy }: { redeploy: RedeployAll }) {
  const { run, active } = redeploy;
  if (!run || !redeploy.showSummary) return null;

  const by = (state: string, reason?: string) =>
    run.items.filter((i) => i.state === state && (!reason || i.reason === reason)).length;
  const done = by('done');
  const failed = run.items.filter((i) => i.state === 'failed');
  const stopped = by('skipped', 'stopped');
  const notReached = by('skipped', 'halted');
  const total = run.items.length - stopped;
  const problem = failed.length > 0 || run.halted;
  const inProgress = by('deploying');
  // Share of the bar per state; instances left stopped are not part of the run's work.
  const share = (n: number) => `${total ? (n / total) * 100 : 0}%`;

  const parts: string[] = [];
  if (active) {
    parts.push(`${done + failed.length} of ${total} done`);
    const now = run.items.filter((i) => i.state === 'deploying').map((i) => redeploy.nameOf(i.gatewayId));
    if (now.length) parts.push(`now: ${now.join(', ')}`);
  } else {
    parts.push(`${done} redeployed`);
  }
  if (failed.length) parts.push(`${failed.length} failed`);
  if (notReached) parts.push(`${notReached} not touched`);
  if (stopped) parts.push(`${stopped} stopped, left as they are`);

  return (
    <div
      className="flex items-start gap-3 mb-4 px-4 py-3 rounded-lg text-sm"
      style={{
        background: problem ? 'var(--red-muted)' : active ? 'var(--blue-muted)' : 'var(--green-muted)',
        border: '1px solid var(--border-primary)',
      }}
      role="status"
    >
      <div className="min-w-0 flex-1" style={{ color: 'var(--text-primary)' }}>
        <div>
          <span className="font-medium">
            {active
              ? `Redeploying all ${scopeLabel(run.runtime)}, ${run.concurrency} at a time`
              : run.halted
                ? `Redeploy of all ${scopeLabel(run.runtime)} stopped early`
                : `Redeploy of all ${scopeLabel(run.runtime)} finished`}
          </span>
          <span className="tabular-nums" style={{ color: 'var(--text-secondary)' }}> · {parts.join(' · ')}</span>
        </div>
        {total > 0 && (
          <div
            role="progressbar"
            aria-label="Redeploy progress"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done + failed.length}
            aria-valuetext={`${done + failed.length} of ${total} done`}
            className="flex gap-px h-1.5 mt-2 rounded-full overflow-hidden"
            style={{ background: 'var(--bg-tertiary)' }}
          >
            <div className="transition-all duration-500" style={{ width: share(done), background: 'var(--green)' }} />
            <div className="transition-all duration-500" style={{ width: share(failed.length), background: 'var(--red)' }} />
            <div className="transition-all duration-500 animate-pulse" style={{ width: share(inProgress), background: 'var(--blue)' }} />
          </div>
        )}
        {failed.map((i) => (
          <div key={i.gatewayId} className="text-xs mt-1 break-words" style={{ color: 'var(--text-secondary)' }}>
            {redeploy.nameOf(i.gatewayId)}: {i.error || 'failed'}
          </div>
        ))}
        {run.halted && !active && (
          <div className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
            Two instances in a row failed, so the rest were left running as they were.
          </div>
        )}
      </div>
      {!active && (
        <button
          onClick={redeploy.dismiss}
          aria-label="Dismiss"
          className="shrink-0 text-xs px-1 ml-auto"
          style={{ color: 'var(--text-tertiary)' }}
        >
          &times;
        </button>
      )}
    </div>
  );
}
