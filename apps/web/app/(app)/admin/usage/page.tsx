'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useOrgFetch } from '@/lib/use-org-fetch';
import { gatewayLabel } from '@/lib/gateway-url';
import type { GatewaySummary, GatewayUsage, UsageScope, UsageSnapshot } from '@clawhuddle/shared';

type Row = GatewaySummary & { email?: string; name?: string | null };

/** How often to re-read the snapshot while one is being taken. */
const POLL_MS = 5000;

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
}

function fmtCost(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  return n >= 1000 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`;
}

function fmtDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function monthName(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
}

/** SQLite's CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS", UTC) as epoch ms. */
function sqliteTime(t: string): number {
  return Date.parse(t.includes('T') ? t : `${t.replace(' ', 'T')}Z`);
}

function who(r: Row): string {
  return r.name || r.email || 'Unknown member';
}

export default function UsagePage() {
  const { orgFetch, ready } = useOrgFetch();
  const [scope, setScope] = useState<UsageScope>('30d');
  const [gateways, setGateways] = useState<Row[] | null>(null);
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [costGroup, setCostGroup] = useState<'model' | 'provider'>('model');

  const loadSnapshot = useCallback(async () => {
    if (!orgFetch) return;
    try {
      const res = await orgFetch<{ data: UsageSnapshot | null; running: boolean }>('/usage/snapshot');
      setSnapshot(res.data);
      setRunning(res.running);
      setError('');
    } catch (err: any) {
      setError(err.message || 'Could not load usage');
    }
  }, [orgFetch]);

  useEffect(() => {
    if (!orgFetch) return;
    orgFetch<{ data: Row[] }>('/gateways')
      .then((r) => setGateways(r.data))
      .catch((err: any) => setError(err.message || 'Could not load instances'));
    loadSnapshot();
  }, [orgFetch, loadSnapshot]);

  useEffect(() => {
    if (!running) return;
    const t = setTimeout(loadSnapshot, POLL_MS);
    return () => clearTimeout(t);
  }, [running, snapshot, loadSnapshot]);

  const takeNow = async () => {
    if (!orgFetch) return;
    setRunning(true);
    try {
      await orgFetch('/usage/snapshot', { method: 'POST', body: JSON.stringify({}) });
    } catch (err: any) {
      setRunning(false);
      setError(err.message || 'Could not start a snapshot');
    }
  };

  const usageOf = (id: string): GatewayUsage | undefined => snapshot?.gateways[id]?.usage?.[scope];

  const rows = useMemo(() => {
    if (!gateways) return [];
    return [...gateways].sort((a, b) => {
      const ua = usageOf(a.id)?.totals.totalTokens ?? -1;
      const ub = usageOf(b.id)?.totals.totalTokens ?? -1;
      if (ua !== ub) return ub - ua;
      return who(a).localeCompare(who(b)) || a.slot - b.slot;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateways, snapshot, scope]);

  const loaded = snapshot
    ? Object.values(snapshot.gateways).map((e) => e.usage?.[scope]).filter((u): u is GatewayUsage => !!u)
    : [];
  const counted = snapshot ? Object.keys(snapshot.gateways).length : 0;

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
  }, [snapshot, scope]);

  const byModel = useMemo(() => {
    const m = new Map<string, { model: string; calls: number; tokens: number; cost: number; unpriced: number; gateways: Set<string> }>();
    for (const u of loaded) {
      for (const x of u.byModel) {
        const key = costGroup === 'provider' ? x.provider || 'unknown' : `${x.provider}/${x.model}`;
        const cur = m.get(key) ?? { model: key, calls: 0, tokens: 0, cost: 0, unpriced: 0, gateways: new Set<string>() };
        cur.calls += x.calls;
        cur.tokens += x.totals.totalTokens;
        cur.cost += x.totals.totalCost;
        cur.unpriced += x.totals.missingCostEntries;
        cur.gateways.add(u.gateway_id);
        m.set(key, cur);
      }
    }
    return [...m.values()]
      .map(({ gateways, ...rest }) => ({ ...rest, instances: gateways.size }))
      .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, scope, costGroup]);

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
  }, [snapshot, scope]);

  if (!ready || (!gateways && !error)) {
    return (
      <div className="flex-1 flex items-center justify-center py-24">
        <div
          className="w-8 h-8 rounded-full border-2 animate-spin"
          style={{ borderColor: 'var(--border-primary)', borderTopColor: 'var(--accent)' }}
        />
      </div>
    );
  }

  const scopes: { id: UsageScope; label: string }[] = [
    { id: '7d', label: '7 days' },
    { id: '30d', label: '30 days' },
    { id: 'month', label: snapshot ? monthName(snapshot.windows.month.startDate) : 'This month' },
  ];
  const window = snapshot?.windows[scope];

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>Usage</h1>
          <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
            Tokens and estimated cost per instance, from each assistant&apos;s own session records. Taken every night at
            01:00 (UTC+8), up to the end of the previous day.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex rounded-lg p-0.5" style={{ background: 'var(--bg-secondary)' }} role="radiogroup" aria-label="Date range">
            {scopes.map((r) => (
              <button
                key={r.id}
                role="radio"
                aria-checked={scope === r.id}
                onClick={() => setScope(r.id)}
                className="px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors"
                style={
                  scope === r.id
                    ? { background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }
                    : { color: 'var(--text-tertiary)' }
                }
              >
                {r.label}
              </button>
            ))}
          </div>
          <button
            onClick={takeNow}
            disabled={running}
            className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
            title="Reads every running instance now. It takes a minute or two and loads each instance, so the nightly one is usually enough."
          >
            {running ? 'Taking snapshot…' : 'Snapshot now'}
          </button>
        </div>
      </div>

      {error && <p className="text-xs mb-4" style={{ color: 'var(--red)' }}>{error}</p>}

      {!snapshot ? (
        <section
          className="rounded-xl px-4 py-10 text-center text-xs"
          style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)', color: 'var(--text-tertiary)' }}
        >
          {running
            ? 'Taking the first snapshot. This takes a minute or two.'
            : 'No snapshot yet. The first one is taken tonight at 01:00 (UTC+8), or use Snapshot now.'}
        </section>
      ) : (
        <>
          <p className="text-[11px] mb-3" style={{ color: 'var(--text-tertiary)' }}>
            {window && `${fmtDate(window.startDate)} – ${fmtDate(window.endDate)}`} · snapshot taken{' '}
            {new Date(snapshot.takenAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
            {running && ' · taking a new one…'}
          </p>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <Stat label="Tokens" value={fmtTokens(summary.tokens)} />
            <Stat
              label="Est. cost"
              value={fmtCost(summary.cost)}
              note={summary.unpriced > 0 ? `${summary.unpriced} unpriced call${summary.unpriced === 1 ? '' : 's'}` : undefined}
            />
            <Stat label="Model replies" value={summary.replies.toLocaleString('en-US')} />
            <Stat label="Errors" value={summary.errors.toLocaleString('en-US')} />
          </div>
          <p className="text-[11px] -mt-4 mb-6" style={{ color: 'var(--text-tertiary)' }}>
            {loaded.length} of {counted} instance{counted === 1 ? '' : 's'} running at snapshot time counted.
          </p>

          {daily.length > 1 && (
            <section
              className="rounded-xl p-4 mb-6"
              style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}
            >
              <h2 className="text-sm font-medium mb-3" style={{ color: 'var(--text-primary)' }}>Tokens per day, all instances</h2>
              <DailyBars data={daily} />
            </section>
          )}

          {byModel.length > 0 && (
            <section
              className="rounded-xl p-4 mb-6 overflow-x-auto"
              style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}
            >
              <div className="flex items-center justify-between gap-3 mb-3">
                <h2 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  Cost by {costGroup}, all instances
                </h2>
                <div className="flex rounded-lg p-0.5" style={{ background: 'var(--bg-secondary)' }} role="radiogroup" aria-label="Group cost by">
                  {(['model', 'provider'] as const).map((g) => (
                    <button
                      key={g}
                      role="radio"
                      aria-checked={costGroup === g}
                      onClick={() => setCostGroup(g)}
                      className="px-2.5 py-1 rounded-md text-xs font-medium transition-colors"
                      style={
                        costGroup === g
                          ? { background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }
                          : { color: 'var(--text-tertiary)' }
                      }
                    >
                      {g === 'model' ? 'By model' : 'By provider'}
                    </button>
                  ))}
                </div>
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ color: 'var(--text-tertiary)' }}>
                    <th className="text-left font-medium pr-3 py-1.5">{costGroup === 'model' ? 'Model' : 'Provider'}</th>
                    <th className="text-right font-medium px-3 py-1.5 hidden sm:table-cell">Instances</th>
                    <th className="text-right font-medium px-3 py-1.5 hidden sm:table-cell">Calls</th>
                    <th className="text-right font-medium px-3 py-1.5">Tokens</th>
                    <th className="text-right font-medium px-3 py-1.5">Est. cost</th>
                    <th className="text-right font-medium pl-3 py-1.5">Share</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                  {byModel.map((m) => (
                    <tr key={m.model} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                      <td className="pr-3 py-1.5 font-mono break-all" style={{ color: 'var(--text-primary)' }}>{m.model}</td>
                      <td className="text-right px-3 py-1.5 hidden sm:table-cell">{m.instances.toLocaleString('en-US')}</td>
                      <td className="text-right px-3 py-1.5 hidden sm:table-cell">{m.calls.toLocaleString('en-US')}</td>
                      <td className="text-right px-3 py-1.5">{fmtTokens(m.tokens)}</td>
                      <td className="text-right px-3 py-1.5" style={{ color: 'var(--text-primary)' }}>
                        {m.unpriced > 0 && m.cost === 0 ? 'no price' : fmtCost(m.cost)}
                      </td>
                      <td className="text-right pl-3 py-1.5">
                        {summary.cost > 0 ? `${((m.cost / summary.cost) * 100).toFixed(m.cost / summary.cost < 0.1 ? 1 : 0)}%` : '—'}
                      </td>
                    </tr>
                  ))}
                  <tr style={{ borderTop: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}>
                    <td className="pr-3 py-1.5 font-medium">Total</td>
                    <td className="hidden sm:table-cell" />
                    <td className="text-right px-3 py-1.5 hidden sm:table-cell">
                      {byModel.reduce((n, m) => n + m.calls, 0).toLocaleString('en-US')}
                    </td>
                    <td className="text-right px-3 py-1.5">{fmtTokens(summary.tokens)}</td>
                    <td className="text-right px-3 py-1.5 font-medium">{fmtCost(summary.cost)}</td>
                    <td className="text-right pl-3 py-1.5">{summary.cost > 0 ? '100%' : '—'}</td>
                  </tr>
                </tbody>
              </table>
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
                  const e = snapshot.gateways[g.id];
                  const u = usageOf(g.id);
                  const open = expanded === g.id && !!u;
                  const note = !e
                    ? sqliteTime(g.created_at) > Date.parse(snapshot.takenAt)
                      ? 'added after this snapshot'
                      : 'not running at snapshot time'
                    : u && u.cacheStatus !== 'fresh'
                      ? 'partial'
                      : '';
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
                                {note && ` · ${note}`}
                              </p>
                            </div>
                          </div>
                        </td>
                        {e?.error ? (
                          <td colSpan={5} className="px-3 py-2.5 text-right" style={{ color: 'var(--red)' }} title={e.error}>
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
                              {u ? u.messages.assistant.toLocaleString('en-US') : '—'}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums hidden sm:table-cell" style={{ color: 'var(--text-secondary)' }}>
                              {u ? u.messages.errors.toLocaleString('en-US') : '—'}
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
        </>
      )}

      <p className="text-[11px] mt-4 leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
        Cost is OpenClaw&apos;s estimate at each model&apos;s list price, not a bill: Token Kiosk and Claw Proxy charge
        differently, and calls to a model with no listed price count as $0. Days run midnight to midnight UTC+8.
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
                  <td className="text-right px-2 py-1">{m.calls.toLocaleString('en-US')}</td>
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
          {usage.sessions.toLocaleString('en-US')} session{usage.sessions === 1 ? '' : 's'} · {usage.messages.toolCalls.toLocaleString('en-US')} tool calls
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
