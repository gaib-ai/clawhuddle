'use client';

import { useState, useEffect } from 'react';
import { useOrgFetch } from '@/lib/use-org-fetch';
import { useOrg } from '@/lib/org-context';
import { useToast } from '@/components/ui/toast';
import { apiFetch } from '@/lib/api';
import { useSession } from 'next-auth/react';
import { PROVIDERS, MODEL_PROVIDERS } from '@clawhuddle/shared';
import { ApiKeyForm, type ApiKeyDisplay } from '@/components/admin/api-key-form';
import { useSecretStatus } from '@/lib/use-secret-status';

export default function ApiKeysPage() {
  const { orgFetch, ready } = useOrgFetch();
  const { currentOrg, currentOrgId, refreshOrgs } = useOrg();
  const { data: session } = useSession();
  const userId = session?.user?.id;
  const { toast } = useToast();
  const [keys, setKeys] = useState<ApiKeyDisplay[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingPrimary, setSavingPrimary] = useState(false);
  const [savingMax, setSavingMax] = useState(false);
  const { secretStatus, reloadSecretStatus } = useSecretStatus(orgFetch, '/api-keys/secret-status');

  useEffect(() => {
    if (!orgFetch) return;
    orgFetch<{ data: ApiKeyDisplay[] }>('/api-keys')
      .then((res) => setKeys(res.data))
      .catch(() => toast('Failed to load API keys', 'error'))
      .finally(() => setLoading(false));
  }, [orgFetch]);

  const providersWithOrgKey = new Set(keys.map((k) => k.provider));
  const currentPrimary = currentOrg?.primary_provider ?? '';
  const currentModel = currentOrg?.primary_model ?? '';
  const primaryModels = PROVIDERS.find((p) => p.id === currentPrimary)?.models ?? [];

  const updateOrg = async (body: { primary_provider?: string | null; primary_model?: string | null }, what: string) => {
    if (!currentOrgId || !userId) return;
    setSavingPrimary(true);
    try {
      await apiFetch(`/api/orgs/${currentOrgId}`, { method: 'PATCH', body: JSON.stringify(body) });
      await refreshOrgs();
      toast(`${what} updated. Restart gateways for the change to take effect.`, 'success');
    } catch (err: any) {
      toast(err.message || `Failed to update ${what.toLowerCase()}`, 'error');
    } finally {
      setSavingPrimary(false);
    }
  };

  // Changing the provider also clears the model pin server-side (a model
  // belongs to the provider it was picked under).
  const updatePrimary = (value: string) => updateOrg({ primary_provider: value === '' ? null : value }, 'Primary provider');
  const updateModel = (value: string) => updateOrg({ primary_model: value === '' ? null : value }, 'Primary model');

  // Blank = platform default (MAX_GATEWAYS_PER_USER, normally 1). Per-member
  // overrides live in the members table.
  const updateMaxGateways = async (raw: string) => {
    if (!currentOrgId || !userId) return;
    const next = raw.trim() === '' ? null : Number(raw);
    if (next === (currentOrg?.max_gateways_per_user ?? null)) return;
    if (next !== null && (!Number.isInteger(next) || next < 1)) {
      toast('Enter a whole number of 1 or more, or leave blank for the default', 'error');
      return;
    }
    setSavingMax(true);
    try {
      await apiFetch(`/api/orgs/${currentOrgId}`, {
        method: 'PATCH',
        body: JSON.stringify({ max_gateways_per_user: next }),
      });
      await refreshOrgs();
      toast(next === null ? 'Instance limit reset to the platform default' : `Members may now run up to ${next} instance${next === 1 ? '' : 's'}`, 'success');
    } catch (err: any) {
      toast(err.message || 'Failed to update instance limit', 'error');
    } finally {
      setSavingMax(false);
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
          Pin one provider, and optionally one of its models, as the primary on every member’s
          gateway. Members can override this for themselves under My API Keys, and pick a model
          per instance on Home — the most specific pick wins. Takes effect on the next gateway restart.
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
          {MODEL_PROVIDERS.map((p) => {
            const hasOrgKey = providersWithOrgKey.has(p.id);
            return (
              <option key={p.id} value={p.id}>
                {p.label}
                {!hasOrgKey ? ' (no org key set)' : ''}
              </option>
            );
          })}
        </select>

        <label className="block text-xs font-medium mt-4 mb-1.5" style={{ color: 'var(--text-secondary)' }}>
          Model
        </label>
        <select
          value={currentModel}
          onChange={(e) => updateModel(e.target.value)}
          disabled={savingPrimary || !currentPrimary || primaryModels.length === 0}
          className="w-full px-3 py-2 text-sm rounded-lg disabled:opacity-50"
          style={{
            background: 'var(--bg-tertiary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-subtle)',
          }}
        >
          <option value="">
            {!currentPrimary
              ? 'Pin a provider first'
              : primaryModels.length === 0
                ? 'No models listed for this provider'
                : 'Provider default (or the org key’s model override)'}
          </option>
          {primaryModels.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </div>

      <div
        className="rounded-xl p-5 mb-6 max-w-lg"
        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}
      >
        <div className="flex items-baseline justify-between mb-1">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Instances per member
          </h3>
          <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            Each instance is its own container
          </span>
        </div>
        <p className="text-xs mb-3" style={{ color: 'var(--text-tertiary)' }}>
          How many AI assistant instances each member may run. Leave blank for the platform
          default. Override it for one person in the Max column under Members.
        </p>
        <input
          type="number"
          min={1}
          key={currentOrg?.max_gateways_per_user ?? 'default'}
          defaultValue={currentOrg?.max_gateways_per_user ?? ''}
          placeholder="Platform default"
          disabled={savingMax}
          onBlur={(e) => updateMaxGateways(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          className="w-40 px-3 py-2 text-sm rounded-lg"
          style={{
            background: 'var(--bg-tertiary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-subtle)',
          }}
        />
      </div>

      <ApiKeyForm initialKeys={keys} fetchFn={orgFetch!} scope="org" secretStatus={secretStatus} onMutate={reloadSecretStatus} />
    </div>
  );
}
