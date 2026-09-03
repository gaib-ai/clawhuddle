'use client';

import { useState, useEffect, useCallback } from 'react';
import { useOrgFetch } from '@/lib/use-org-fetch';
import { useToast } from '@/components/ui/toast';
import { PROVIDERS } from '@clawhuddle/shared';
import { ApiKeyForm, type ApiKeyDisplay, type ProviderSummary } from '@/components/admin/api-key-form';

export default function MyApiKeysPage() {
  const { orgFetch, ready } = useOrgFetch();
  const { toast } = useToast();
  const [keys, setKeys] = useState<ApiKeyDisplay[]>([]);
  const [summary, setSummary] = useState<ProviderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [myPrimary, setMyPrimary] = useState<string>('');
  const [orgPrimary, setOrgPrimary] = useState<string | null>(null);
  const [savingPrimary, setSavingPrimary] = useState(false);

  const loadSummary = useCallback(async () => {
    if (!orgFetch) return;
    try {
      const res = await orgFetch<{ data: ProviderSummary[] }>('/me/api-keys/summary');
      setSummary(res.data);
    } catch {
      // non-fatal — UI will fall back to deriving source from keys list
    }
  }, [orgFetch]);

  useEffect(() => {
    if (!orgFetch) return;
    Promise.all([
      orgFetch<{ data: ApiKeyDisplay[] }>('/me/api-keys'),
      orgFetch<{ data: ProviderSummary[] }>('/me/api-keys/summary'),
      orgFetch<{ data: { primary_provider: string | null; org_primary_provider: string | null } }>('/me/primary-provider'),
    ])
      .then(([keysRes, summaryRes, primaryRes]) => {
        setKeys(keysRes.data);
        setSummary(summaryRes.data);
        setMyPrimary(primaryRes.data.primary_provider ?? '');
        setOrgPrimary(primaryRes.data.org_primary_provider);
      })
      .catch(() => toast('Failed to load API keys', 'error'))
      .finally(() => setLoading(false));
  }, [orgFetch]);

  const updateMyPrimary = async (value: string) => {
    if (!orgFetch) return;
    const previous = myPrimary;
    setMyPrimary(value);
    setSavingPrimary(true);
    try {
      await orgFetch('/me/primary-provider', {
        method: 'PUT',
        body: JSON.stringify({ primary_provider: value === '' ? null : value }),
      });
      toast('Primary provider updated. Restart your gateway for the change to take effect.', 'success');
    } catch (err: any) {
      setMyPrimary(previous);
      toast(err.message || 'Failed to update primary provider', 'error');
    } finally {
      setSavingPrimary(false);
    }
  };

  if (loading || !ready) {
    return (
      <div className="flex-1 overflow-y-auto scrollbar-hide p-8 max-w-3xl mx-auto w-full">
        <h1 className="text-xl font-semibold tracking-tight mb-6" style={{ color: 'var(--text-primary)' }}>
          My API Keys
        </h1>
        <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto scrollbar-hide p-8 max-w-3xl mx-auto w-full">
      <h1 className="text-xl font-semibold tracking-tight mb-2" style={{ color: 'var(--text-primary)' }}>
        My API Keys
      </h1>
      <p className="text-sm mb-6" style={{ color: 'var(--text-tertiary)' }}>
        Personal keys override the organization defaults for your gateway only. Changes apply via hot-reload — no redeploy needed.
      </p>

      <div
        className="rounded-xl p-5 mb-6 max-w-lg"
        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}
      >
        <div className="flex items-baseline justify-between mb-1">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Primary Model Provider
          </h3>
          <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            Sets <code>agents.defaults.model.primary</code>
          </span>
        </div>
        <p className="text-xs mb-3" style={{ color: 'var(--text-tertiary)' }}>
          Choose which provider your gateway uses as its primary model. Leave it on the org default
          to follow whatever your admin sets. Takes effect the next time your gateway restarts
          (use Deploy/Restart on the Home page).
        </p>
        <select
          value={myPrimary}
          onChange={(e) => updateMyPrimary(e.target.value)}
          disabled={savingPrimary}
          className="w-full px-3 py-2 text-sm rounded-lg"
          style={{
            background: 'var(--bg-tertiary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-subtle)',
          }}
        >
          <option value="">
            Org default{orgPrimary ? ` (${PROVIDERS.find((p) => p.id === orgPrimary)?.label ?? orgPrimary})` : ' (no pin)'}
          </option>
          {PROVIDERS.map((p) => {
            const hasKey = summary.some((s) => s.provider === p.id && s.source !== 'none');
            return (
              <option key={p.id} value={p.id}>
                {p.label}
                {!hasKey ? ' (no key available)' : ''}
              </option>
            );
          })}
        </select>
      </div>

      <ApiKeyForm
        scope="user"
        initialKeys={keys}
        summary={summary}
        fetchFn={orgFetch!}
        onMutate={loadSummary}
      />
    </div>
  );
}
