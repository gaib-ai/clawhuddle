'use client';

import { useState, useEffect } from 'react';
import { useOrgFetch } from '@/lib/use-org-fetch';
import { useOrg } from '@/lib/org-context';
import { useToast } from '@/components/ui/toast';
import { apiFetch } from '@/lib/api';
import { useSession } from 'next-auth/react';
import { PROVIDERS } from '@clawhuddle/shared';
import { ApiKeyForm, type ApiKeyDisplay } from '@/components/admin/api-key-form';

export default function ApiKeysPage() {
  const { orgFetch, ready } = useOrgFetch();
  const { currentOrg, currentOrgId, refreshOrgs } = useOrg();
  const { data: session } = useSession();
  const userId = session?.user?.id;
  const { toast } = useToast();
  const [keys, setKeys] = useState<ApiKeyDisplay[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingPrimary, setSavingPrimary] = useState(false);

  useEffect(() => {
    if (!orgFetch) return;
    orgFetch<{ data: ApiKeyDisplay[] }>('/api-keys')
      .then((res) => setKeys(res.data))
      .catch(() => toast('Failed to load API keys', 'error'))
      .finally(() => setLoading(false));
  }, [orgFetch]);

  const providersWithOrgKey = new Set(keys.map((k) => k.provider));
  const currentPrimary = currentOrg?.primary_provider ?? '';

  const updatePrimary = async (value: string) => {
    if (!currentOrgId || !userId) return;
    setSavingPrimary(true);
    try {
      await apiFetch(`/api/orgs/${currentOrgId}`, {
        method: 'PATCH',
        headers: { 'x-user-id': userId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ primary_provider: value === '' ? null : value }),
      });
      await refreshOrgs();
      toast('Primary provider updated. Restart gateways for the change to take effect.', 'success');
    } catch (err: any) {
      toast(err.message || 'Failed to update primary provider', 'error');
    } finally {
      setSavingPrimary(false);
    }
  };

  if (loading || !ready) {
    return (
      <div>
        <h1 className="text-xl font-semibold tracking-tight mb-6" style={{ color: 'var(--text-primary)' }}>
          API Keys
        </h1>
        <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>Loading...</p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight mb-2" style={{ color: 'var(--text-primary)' }}>
        Organization API Keys
      </h1>
      <p className="text-sm mb-6" style={{ color: 'var(--text-tertiary)' }}>
        These keys are the default for every member. Individuals can override them under Settings → My API Keys.
      </p>

      <div
        className="rounded-xl p-5 mb-6 max-w-lg"
        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}
      >
        <div className="flex items-baseline justify-between mb-1">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Primary Provider
          </h3>
          <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            Sets <code>agents.defaults.model.primary</code>
          </span>
        </div>
        <p className="text-xs mb-3" style={{ color: 'var(--text-tertiary)' }}>
          Pin one provider to always be the primary model on every member’s gateway. Members can
          override this for their own gateway under My API Keys — a personal pick wins over this
          default. Takes effect on the next gateway restart.
        </p>
        <select
          value={currentPrimary}
          onChange={(e) => updatePrimary(e.target.value)}
          disabled={savingPrimary}
          className="w-full px-3 py-2 text-sm rounded-lg"
          style={{
            background: 'var(--bg-tertiary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-subtle)',
          }}
        >
          <option value="">No pin (alphabetical order)</option>
          {PROVIDERS.map((p) => {
            const hasOrgKey = providersWithOrgKey.has(p.id);
            return (
              <option key={p.id} value={p.id}>
                {p.label}
                {!hasOrgKey ? ' (no org key set)' : ''}
              </option>
            );
          })}
        </select>
      </div>

      <ApiKeyForm initialKeys={keys} fetchFn={orgFetch!} scope="org" />
    </div>
  );
}
