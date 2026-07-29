'use client';

import { useState, useEffect, useCallback } from 'react';
import { useOrgFetch } from '@/lib/use-org-fetch';
import { useToast } from '@/components/ui/toast';
import { ApiKeyForm, type ApiKeyDisplay, type ProviderSummary } from '@/components/admin/api-key-form';

export default function MyApiKeysPage() {
  const { orgFetch, ready } = useOrgFetch();
  const { toast } = useToast();
  const [keys, setKeys] = useState<ApiKeyDisplay[]>([]);
  const [summary, setSummary] = useState<ProviderSummary[]>([]);
  const [loading, setLoading] = useState(true);

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
    ])
      .then(([keysRes, summaryRes]) => {
        setKeys(keysRes.data);
        setSummary(summaryRes.data);
      })
      .catch(() => toast('Failed to load API keys', 'error'))
      .finally(() => setLoading(false));
  }, [orgFetch]);

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
