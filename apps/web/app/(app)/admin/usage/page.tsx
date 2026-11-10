'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOrgFetch } from '@/lib/use-org-fetch';
import { gatewayLabel } from '@/lib/gateway-url';
import type { GatewaySummary, GatewayUsage, UsageRange } from '@clawhuddle/shared';

type Row = GatewaySummary & { email?: string; name?: string | null };

type Entry =
  | { state: 'idle' }
  | { state: 'loading'; usage?: GatewayUsage }
  | { state: 'done'; usage: GatewayUsage }
  | { state: 'error'; message: string };

const RANGES: { days: UsageRange; label: string }[] = [
  { days: 1, label: 'Today' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
];

/** How many instances the page asks about at once (each is a CLI run in that container). */
const CONCURRENCY = 3;
/** Re-ask an instance whose OpenClaw is still indexing, like the Control UI does. */
const INCOMPLETE_RETRY_MS = [5000, 10000, 20000];

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
}

function fmtCost(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  return n >= 1000 ? `$${Math.round(n).toLocaleString()}` : `$${n.toFixed(2)}`;
}

function fmtDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function who(r: Row): string {
  return r.name || r.email || 'Unknown member';
}

export default function UsagePage() {
  const { orgFetch, ready } = useOrgFetch();
  const [days, setDays] = useState<UsageRange>(30);
  const [gateways, setGateways] = useState<Row[] | null>(null);
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [listError, setListError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  // Bumped on every range change / refresh so answers to an older request are dropped.
  const runRef = useRef(0);

  const load = useCallback(
    async (refresh: boolean) => {
      if (!orgFetch) return;
      const run = ++runRef.current;
      let list: Row[];
      try {
        list = (await orgFetch<{ data: Row[] }>('/gateways')).data;
      } catch (err: any) {
        setListError(err.message || 'Could not load instances');
        return;
      }
      if (run !== runRef.current) return;
      setListError('');
      setGateways(list);
      const running = list.filter((g) => g.status === 'running');
      setEntries(Object.fromEntries(running.map((g) => [g.id, { state: 'loading' } as Entry])));

      const fetchOne = async (g: Row, attempt: number): Promise<void> => {
        try {
          const qs = `days=${days}${refresh && attempt === 0 ? '&refresh=1' : ''}`;
          const { data } = await orgFetch<{ data: GatewayUsage }>(`/gateways/${g.id}/usage?${qs}`);
          if (run !== runRef.current) return;
          if (data.cacheStatus !== 'fresh' && attempt < INCOMPLETE_RETRY_MS.length) {
            setEntries((prev) => ({ ...prev, [g.id]: { state: 'loading', usage: data } }));
            await new Promise((r) => setTimeout(r, INCOMPLETE_RETRY_MS[attempt]));
            if (run !== runRef.current) return;
            return fetchOne(g, attempt + 1);
          }
          setEntries((prev) => ({ ...prev, [g.id]: { state: 'done', usage: data } }));
        } catch (err: any) {
          if (run !== runRef.current) return;
          setEntries((prev) => ({ ...prev, [g.id]: { state: 'error', message: err.message || 'Could not read usage' } }));
        }
      };

      const queue = [...running];
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
          for (let g = queue.shift(); g; g = queue.shift()) {
            if (run !== runRef.current) return;
            await fetchOne(g, 0);
          }
        }),
      );
    },
    [orgFetch, days],
  );

  useEffect(() => {
    load(false);
  }, [load]);

  const usageOf = (id: string): GatewayUsage | undefined => {
    const e = entries[id];
    return e && 'usage' in e ? e.usage : undefined;
  };

  const rows = useMemo(() => {
    if (!gateways) return [];
    return [...gateways].sort((a, b) => {
      const ua = usageOf(a.id)?.totals.totalTokens ?? -1;
      const ub = usageOf(b.id)?.totals.totalTokens ?? -1;
      if (ua !== ub) return ub - ua;
      return who(a).localeCompare(who(b)) || a.slot - b.slot;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateways, entries]);

  const loaded = Object.values(entries).filter((e) => 'usage' in e && e.usage).map((e) => (e as { usage: GatewayUsage }).usage);
  const runningCount = gateways?.filter((g) => g.status === 'running').length ?? 0;
  const busy = Object.values(entries).some((e) => e.state === 'loading');

  const summary = useMemo(() => {
    const s = { tokens: 0, cost: 0, replies: 0, errors: 0, unpriced: 0 };
    for (const u of loaded) {
      s.tokens += u.totals.totalTokens;
      s.cost += u.totals.totalCost;
      s.replies += u.messages.assistant;
      s.errors += u.messages.errors;
      s.unpriced += u.totals.missingCostEntries;
    }
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  const daily = useMemo(() => {
    const byDate = new Map<string, { tokens: number; cost: number }>();
    for (const u of loaded) {
      for (const d of u.daily) {
        const cur = byDate.get(d.date) ?? { tokens: 0, cost: 0 };
        cur.tokens += d.tokens;
        cur.cost += d.cost;
        byDate.set(d.date, cur);
      }
    }
    return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  if (!ready || (!gateways && !listError)) {
    return (
      <div className="flex-1 flex items-center justify-center py-24">
        <div
          className="w-8 h-8 rounded-full border-2 animate-spin"
          style={{ borderColor: 'var(--border-primary)', borderTopColor: 'var(--accent)' }}
        />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>Usage</h1>
          <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
            Tokens and estimated cost per instance, from each assistant&apos;s own session records. Running instances only.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex rounded-lg p-0.5" style={{ background: 'var(--bg-secondary)' }} role="radiogroup" aria-label="Date range">
            {RANGES.map((r) => (
              <button
                key={r.days}
                role="radio"
                aria-checked={days === r.days}
                onClick={() => setDays(r.days)}
                className="px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors"
                style={
                  days === r.days
                    ? { background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }
                    : { color: 'var(--text-tertiary)' }
                }
              >
                {r.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => load(true)}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
          >
            {busy ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {listError && <p className="text-xs mb-4" style={{ color: 'var(--red)' }}>{listError}</p>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Stat label="Tokens" value={fmtTokens(summary.tokens)} />
        <Stat
          label="Est. cost"
          value={fmtCost(summary.cost)}
          note={summary.unpriced > 0 ? `${summary.unpriced} unpriced call${summary.unpriced === 1 ? '' : 's'}` : undefined}
        />
        <Stat label="Model replies" value={summary.replies.toLocaleString()} />
        <Stat label="Errors" value={summary.errors.toLocaleString()} />
      </div>
      <p className="text-[11px] -mt-4 mb-6" style={{ color: 'var(--text-tertiary)' }}>
        {loaded.length} of {runningCount} running instance{runningCount === 1 ? '' : 's'} counted
        {busy ? ' so far' : ''}.
      </p>

      {days > 1 && daily.length > 0 && (
        <section
          className="rounded-xl p-4 mb-6"
          style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}
        >
          <h2 className="text-sm font-medium mb-3" style={{ color: 'var(--text-primary)' }}>Tokens per day, all instances</h2>
          <DailyBars data={daily} />
        </section>
      )}

      <section className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}>
        <table className="w-full text-xs">
          <thead>
            <tr style={{ color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)' }}>
              <th className="text-left font-medium px-4 py-2.5">Instance</th>
              <th className="text-right font-medium px-3 py-2.5">Tokens</th>
              <th className="text-right font-medium px-3 py-2.5">Est. cost</th>
              <th className="text-right font-medium px-3 py-2.5 hidden sm:table-cell">Replies</th>
              <th className="text-right font-medium px-3 py-2.5 hidden sm:table-cell">Errors</th>
              <th className="text-left font-medium px-4 py-2.5 hidden md:table-cell">Top model</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((g) => {
              const e = entries[g.id];
              const u = usageOf(g.id);
              const open = expanded === g.id && !!u;
              return (
                <Fragment key={g.id}>
                  <tr
                    onClick={() => u && setExpanded(open ? null : g.id)}
                    className={u ? 'cursor-pointer' : ''}
                    style={{ borderTop: '1px solid var(--border-subtle)', background: open ? 'var(--bg-secondary)' : undefined }}
                    aria-expanded={u ? open : undefined}
                  >
                    <td className="px-4 py-2.5 min-w-0">
                      <div className="flex items-center gap-1.5">
                        {u && (
                          <span aria-hidden style={{ color: 'var(--text-tertiary)', display: 'inline-block', width: 10 }}>
                            {open ? '▾' : '▸'}
                          </span>
                        )}
                        <div className="min-w-0">
                          <p className="truncate" style={{ color: 'var(--text-primary)' }}>{who(g)}</p>
                          <p className="truncate text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                            {gatewayLabel(g)}
                            {g.status !== 'running' && ` · ${g.status ?? 'not deployed'}`}
                            {e?.state === 'loading' && (u ? ' · still counting…' : ' · loading…')}
                            {e?.state === 'done' && u && u.cacheStatus !== 'fresh' && ' · partial'}
                          </p>
                        </div>
                      </div>
                    </td>
                    {e?.state === 'error' ? (
                      <td colSpan={5} className="px-3 py-2.5 text-right" style={{ color: 'var(--red)' }} title={e.message}>
                        Could not read usage
                      </td>
                    ) : (
                      <>
                        <td className="px-3 py-2.5 text-right tabular-nums" style={{ color: 'var(--text-primary)' }}>
                          {u ? fmtTokens(u.totals.totalTokens) : '—'}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                          {u ? fmtCost(u.totals.totalCost) : '—'}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums hidden sm:table-cell" style={{ color: 'var(--text-secondary)' }}>
                          {u ? u.messages.assistant.toLocaleString() : '—'}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums hidden sm:table-cell" style={{ color: 'var(--text-secondary)' }}>
                          {u ? u.messages.errors.toLocaleString() : '—'}
                        </td>
                        <td className="px-4 py-2.5 hidden md:table-cell truncate max-w-[14rem]" style={{ color: 'var(--text-secondary)' }}>
                          {u?.byModel[0] ? `${u.byModel[0].provider}/${u.byModel[0].model}` : '—'}
                        </td>
                      </>
                    )}
                  </tr>
                  {open && u && (
                    <tr style={{ background: 'var(--bg-secondary)' }}>
                      <td colSpan={6} className="px-4 pb-4 pt-1">
                        <Breakdown usage={u} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center" style={{ color: 'var(--text-tertiary)' }}>
                  No instances in this organization yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <p className="text-[11px] mt-4 leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
        Cost is OpenClaw&apos;s estimate at each model&apos;s list price, not a bill: Token Kiosk and Claw Proxy charge
        differently, and calls to a model with no listed price count as $0. Days are UTC. Numbers can be low for a few
        seconds after an instance restarts while it re-reads its records.
      </p>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl px-4 py-3" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}>
      <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{label}</p>
      <p className="text-xl font-semibold tabular-nums mt-0.5" style={{ color: 'var(--text-primary)' }}>{value}</p>
      {note && <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{note}</p>}
    </div>
  );
}

function Breakdown({ usage }: { usage: GatewayUsage }) {
  return (
    <div className="grid gap-4 md:grid-cols-[2fr_1fr]">
      <div className="min-w-0 overflow-x-auto">
        <p className="text-[11px] font-medium mb-1.5" style={{ color: 'var(--text-tertiary)' }}>By model</p>
        {usage.byModel.length === 0 ? (
          <p style={{ color: 'var(--text-tertiary)' }}>No model calls in this range.</p>
        ) : (
          <table className="w-full text-[11px]">
            <thead>
              <tr style={{ color: 'var(--text-tertiary)' }}>
                <th className="text-left font-normal pr-3 py-1">Model</th>
                <th className="text-right font-normal px-2 py-1">Calls</th>
                <th className="text-right font-normal px-2 py-1">Input</th>
                <th className="text-right font-normal px-2 py-1">Output</th>
                <th className="text-right font-normal px-2 py-1">Cache read</th>
                <th className="text-right font-normal px-2 py-1">Total</th>
                <th className="text-right font-normal pl-2 py-1">Est. cost</th>
              </tr>
            </thead>
            <tbody className="tabular-nums" style={{ color: 'var(--text-secondary)' }}>
              {usage.byModel.map((m) => (
                <tr key={`${m.provider}/${m.model}`}>
                  <td className="pr-3 py-1 font-mono break-all" style={{ color: 'var(--text-primary)' }}>{m.provider}/{m.model}</td>
                  <td className="text-right px-2 py-1">{m.calls.toLocaleString()}</td>
                  <td className="text-right px-2 py-1">{fmtTokens(m.totals.input)}</td>
                  <td className="text-right px-2 py-1">{fmtTokens(m.totals.output)}</td>
                  <td className="text-right px-2 py-1">{fmtTokens(m.totals.cacheRead)}</td>
                  <td className="text-right px-2 py-1" style={{ color: 'var(--text-primary)' }}>{fmtTokens(m.totals.totalTokens)}</td>
                  <td className="text-right pl-2 py-1">
                    {m.totals.missingCostEntries > 0 && m.totals.totalCost === 0 ? 'no price' : fmtCost(m.totals.totalCost)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-medium mb-1.5" style={{ color: 'var(--text-tertiary)' }}>By channel</p>
        <ul className="space-y-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
          {usage.byChannel.map((c) => (
            <li key={c.channel} className="flex justify-between gap-3 tabular-nums">
              <span style={{ color: 'var(--text-primary)' }}>{c.channel === 'other' ? 'Other (cron, heartbeat, Control UI)' : c.channel}</span>
              <span>{fmtTokens(c.tokens)} · {fmtCost(c.cost)}</span>
            </li>
          ))}
          {usage.byChannel.length === 0 && <li style={{ color: 'var(--text-tertiary)' }}>Nothing yet.</li>}
        </ul>
        <p className="text-[11px] mt-3" style={{ color: 'var(--text-tertiary)' }}>
          {usage.sessions.toLocaleString()} session{usage.sessions === 1 ? '' : 's'} · {usage.messages.toolCalls.toLocaleString()} tool calls
        </p>
        {usage.daily.length > 1 && (
          <div className="mt-3">
            <p className="text-[11px] font-medium mb-1.5" style={{ color: 'var(--text-tertiary)' }}>Tokens per day</p>
            <DailyBars data={usage.daily} height={64} compact />
          </div>
        )}
      </div>
    </div>
  );
}

/** Single-series daily bar chart with a hover tooltip: one hue, rounded data ends, 2px gaps. */
function DailyBars({ data, height = 140, compact = false }: { data: { date: string; tokens: number; cost: number }[]; height?: number; compact?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.tokens));
  const n = data.length;
  const labelEvery = n > 45 ? 14 : n > 20 ? 7 : n > 10 ? 2 : 1;
  const h = hover !== null ? data[hover] : null;

  return (
    <div className="relative select-none">
      {!compact && (
        <p className="absolute right-0 -top-7 text-[11px] tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
          peak {fmtTokens(max)}
        </p>
      )}
      <div
        className="flex items-end"
        style={{ height, gap: 2, borderBottom: '1px solid var(--border-primary)' }}
        role="img"
        aria-label={`Tokens per day, ${data[0]?.date} to ${data[n - 1]?.date}, peak ${fmtTokens(max)}`}
        onMouseLeave={() => setHover(null)}
      >
        {data.map((d, i) => (
          <div
            key={d.date}
            className="flex-1 h-full flex items-end min-w-0"
            onMouseEnter={() => setHover(i)}
            onClick={() => setHover(i)}
          >
            <div
              className="w-full"
              style={{
                height: d.tokens > 0 ? `max(2px, ${(d.tokens / max) * 96}%)` : 0,
                background: 'var(--blue)',
                borderRadius: '4px 4px 0 0',
                opacity: hover === null || hover === i ? 1 : 0.45,
              }}
            />
          </div>
        ))}
      </div>
      {!compact && (
        <div className="flex mt-1" style={{ gap: 2 }}>
          {data.map((d, i) => (
            <div key={d.date} className="flex-1 min-w-0 text-[10px] text-center overflow-visible whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>
              {i % labelEvery === 0 ? fmtDate(d.date) : ''}
            </div>
          ))}
        </div>
      )}
      {h && hover !== null && (
        <div
          className="absolute pointer-events-none rounded-md px-2 py-1 text-[11px] tabular-nums whitespace-nowrap z-10"
          style={{
            left: `${((hover + 0.5) / n) * 100}%`,
            top: compact ? -28 : 0,
            transform: `translateX(${hover > n * 0.7 ? '-100%' : hover < n * 0.3 ? '0' : '-50%'})`,
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--border-primary)',
            color: 'var(--text-primary)',
          }}
        >
          <span style={{ color: 'var(--text-tertiary)' }}>{fmtDate(h.date)}</span> · {fmtTokens(h.tokens)} tokens · {fmtCost(h.cost)}
        </div>
      )}
    </div>
  );
}
