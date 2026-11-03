'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { PROVIDERS, providerForModel, type Gateway } from '@clawhuddle/shared';
import { gatewayUrl, gatewayLabel } from '@/lib/gateway-url';
import { useToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { GoogleConnect } from '@/components/google-connect';

type OrgFetch = <T>(path: string, options?: RequestInit) => Promise<T>;

interface Props {
  gateway: Gateway;
  orgFetch: OrgFetch;
  /** Called after any action; the parent refetches the list. */
  onChanged: () => Promise<void>;
  /** Provider ids the member has a key for (org or personal); only their models are offered. */
  activeProviders: string[];
}

/** One of the member's own instances: open, stop, restart, delete, rename, pin a model. */
const BUSY_LABEL: Record<string, string> = {
  Start: 'starting', Stop: 'stopping', Restart: 'restarting', Redeploy: 'redeploying', Deploy: 'deploying', Delete: 'deleting', Rename: 'renaming', Model: 'updating',
};

export function GatewayCard({ gateway, orgFetch, onChanged, activeProviders }: Props) {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelInput, setLabelInput] = useState(gateway.label ?? '');

  const status = gateway.status || 'not deployed';
  const color =
    status === 'running' ? 'var(--green)' :
    status === 'deploying' || status === 'provisioning' ? 'var(--blue)' :
    status === 'stopped' ? 'var(--yellow)' :
    'var(--text-tertiary)';

  // The list endpoint returns the stored status; only the status route resyncs
  // it with the container's real health. Poll that while starting up.
  useEffect(() => {
    if (status !== 'deploying' && status !== 'provisioning') return;
    const tick = async () => {
      try {
        const res = await orgFetch<{ data: Gateway }>(`/gateways/${gateway.id}/status`);
        if (res.data.status !== 'deploying') await onChanged();
      } catch {
        // ignore — keep polling
      }
    };
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [status, gateway.id, orgFetch, onChanged]);

  const act = async (what: string, run: () => Promise<unknown>) => {
    setBusy(what);
    setError('');
    try {
      await run();
      await onChanged();
    } catch (err: any) {
      setError(err.message || `${what} failed`);
    } finally {
      setBusy(null);
    }
  };

  const open = () => {
    const url = gatewayUrl(gateway);
    if (url) window.open(url, '_blank');
  };
  const stop = () => act('Stop', () => orgFetch(`/gateways/${gateway.id}/stop`, { method: 'POST' }));
  const start = () => act('Start', () => orgFetch(`/gateways/${gateway.id}/start`, { method: 'POST' }));
  const restart = () => act('Restart', () => orgFetch(`/gateways/${gateway.id}/restart`, { method: 'POST' }));
  const redeploy = () => act('Redeploy', () => orgFetch(`/gateways/${gateway.id}/redeploy`, { method: 'POST' }));
  const remove = async () => {
    const ok = await confirm({
      title: 'Delete instance',
      description: `Delete ${gatewayLabel(gateway)}? Its workspace, chat history and channel connections are removed.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await act('Delete', () => orgFetch(`/gateways/${gateway.id}`, { method: 'DELETE' }));
  };

  const saveLabel = async () => {
    setEditingLabel(false);
    const next = labelInput.trim() || null;
    if (next === (gateway.label ?? null)) return;
    await act('Rename', () => orgFetch(`/gateways/${gateway.id}`, { method: 'PATCH', body: JSON.stringify({ label: next }) }));
  };

  const setModel = async (value: string) => {
    await act('Model', () =>
      orgFetch(`/gateways/${gateway.id}`, { method: 'PATCH', body: JSON.stringify({ primary_model: value || null }) }),
    );
    toast('Model updated. Restart this instance for the change to take effect.', 'success');
  };

  const primaryBtn = (label: string, onClick: () => void, disabled = false) => (
    <button
      onClick={onClick}
      disabled={disabled || !!busy}
      className="flex-1 py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
      style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent-hover)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--accent)'; }}
    >
      {label}
    </button>
  );
  const quietBtn = (label: string, onClick: () => void, danger = false) => (
    <button
      onClick={onClick}
      disabled={!!busy}
      className="px-4 py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
      style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border-primary)' }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = danger ? 'var(--red)' : 'var(--accent)'; e.currentTarget.style.color = danger ? 'var(--red)' : 'var(--accent)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-primary)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
    >
      {label}
    </button>
  );

  return (
    <div
      className="rounded-xl p-5"
      style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="flex items-center justify-between mb-3 gap-3">
        {editingLabel ? (
          <input
            autoFocus
            value={labelInput}
            onChange={(e) => setLabelInput(e.target.value)}
            onBlur={saveLabel}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveLabel();
              if (e.key === 'Escape') { setLabelInput(gateway.label ?? ''); setEditingLabel(false); }
            }}
            maxLength={60}
            placeholder={`Instance ${gateway.slot}`}
            className="flex-1 px-2 py-1 text-sm rounded-md"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
          />
        ) : (
          <button
            onClick={() => { setLabelInput(gateway.label ?? ''); setEditingLabel(true); }}
            className="text-sm font-semibold text-left hover:underline"
            style={{ color: 'var(--text-primary)' }}
            title="Rename"
          >
            {gatewayLabel(gateway)}
          </button>
        )}
        <div className="flex items-center gap-2 shrink-0">
          <span className="w-2 h-2 rounded-full" style={{ background: color }} />
          <span className="text-xs font-medium" style={{ color }}>
            {busy ? `${BUSY_LABEL[busy] ?? busy.toLowerCase()}...` : status === 'deploying' || status === 'provisioning' ? 'starting...' : status}
          </span>
        </div>
      </div>

      {status === 'running' ? (
        <>
          <div className="flex gap-2">
            {primaryBtn('Open', open)}
            {quietBtn('Restart', restart)}
            {quietBtn('Redeploy', redeploy)}
            {quietBtn('Stop', stop, true)}
          </div>
          <p className="text-[11px] mt-2" style={{ color: 'var(--text-tertiary)' }}>
            First time from this browser? Let it in under{' '}
            <Link href="/devices" style={{ color: 'var(--accent)' }}>Device Requests</Link>.
          </p>
          <p className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
            <span style={{ color: 'var(--text-secondary)' }}>Restart</span> reboots the instance as it is.{' '}
            <span style={{ color: 'var(--text-secondary)' }}>Redeploy</span> rebuilds it from the current config — use it after changing skills, API keys, channels or the model. Both take a few minutes.
          </p>
          <GoogleConnect gatewayId={gateway.id} orgFetch={orgFetch} />
        </>
      ) : status === 'deploying' || status === 'provisioning' ? (
        <div className="flex items-center justify-between py-2">
          <div className="flex items-center gap-2">
            <div
              className="w-4 h-4 rounded-full border-2 animate-spin"
              style={{ borderColor: 'var(--border-primary)', borderTopColor: 'var(--blue)' }}
            />
            <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              This instance is starting up...
            </span>
          </div>
          {quietBtn('Stop', stop, true)}
        </div>
      ) : (
        <div className="flex gap-2">
          {primaryBtn(status === 'stopped' ? 'Start' : 'Deploy', status === 'stopped' ? start : redeploy)}
          {status === 'stopped' && quietBtn('Redeploy', redeploy)}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 mt-4 pt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
        <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
          Model
          <select
            value={gateway.primary_model ?? ''}
            onChange={(e) => setModel(e.target.value)}
            disabled={!!busy}
            className="px-2 py-1 text-xs rounded-md"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
          >
            <option value="">Follow my default</option>
            {/* A pinned model whose key has since gone stays visible so the pick is not silently lost. */}
            {gateway.primary_model && !activeProviders.includes(providerForModel(gateway.primary_model)?.id ?? '') && (
              <option value={gateway.primary_model}>{gateway.primary_model} (no key)</option>
            )}
            {PROVIDERS.filter((p) => p.models?.length && activeProviders.includes(p.id)).map((p) => (
              <optgroup key={p.id} label={p.label}>
                {p.models!.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <button
          onClick={remove}
          disabled={!!busy}
          className="text-xs font-medium transition-colors disabled:opacity-50"
          style={{ color: 'var(--red)' }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.7'; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
        >
          Delete instance
        </button>
      </div>

      {error && <p className="text-xs mt-2" style={{ color: 'var(--red)' }}>{error}</p>}
    </div>
  );
}
