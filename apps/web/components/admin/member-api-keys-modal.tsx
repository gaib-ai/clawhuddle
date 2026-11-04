'use client';

import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/components/ui/toast';
import { ApiKeyForm, type ApiKeyDisplay, type ProviderSummary } from './api-key-form';
import type { OrgMember } from '@clawhuddle/shared';

type FetchFn = <T>(path: string, options?: RequestInit) => Promise<T>;

interface Props {
  member: OrgMember;
  fetchFn: FetchFn;
  onClose: () => void;
}

export function MemberApiKeysModal({ member, fetchFn, onClose }: Props) {
  const { toast } = useToast();
  const base = `/members/${member.id}/api-keys`;
  const [keys, setKeys] = useState<ApiKeyDisplay[]>([]);
  const [summary, setSummary] = useState<ProviderSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const loadSummary = useCallback(async () => {
    try {
      const res = await fetchFn<{ data: ProviderSummary[] }>(`${base}/summary`);
      setSummary(res.data);
    } catch {
      /* non-fatal */
    }
  }, [fetchFn, base]);

  useEffect(() => {
    Promise.all([
      fetchFn<{ data: ApiKeyDisplay[] }>(base),
      fetchFn<{ data: ProviderSummary[] }>(`${base}/summary`),
    ])
      .then(([keysRes, summaryRes]) => {
        setKeys(keysRes.data);
        setSummary(summaryRes.data);
      })
      .catch(() => toast('Failed to load member API keys', 'error'))
      .finally(() => setLoading(false));
  }, [fetchFn, base]);

  return (
    <>
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9998,
          background: 'rgba(0,0,0,0.6)',
          backdropFilter: 'blur(4px)',
          animation: 'fade-in 0.15s ease-out',
        }}
        onClick={onClose}
      />
      <div
        className="modal-frame"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9999,
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'center',
          overflowY: 'auto',
        }}
      >
        <div
          className="modal-card"
          style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-primary)',
            borderRadius: 14,
            boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
            width: '100%',
            maxWidth: 560,
            marginTop: 40,
            marginBottom: 40,
            animation: 'dialog-enter 0.2s ease-out',
          }}
        >
          <div className="flex items-start justify-between mb-1">
            <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
              API Keys — {member.name || member.email}
            </h3>
            <button
              onClick={onClose}
              className="text-xl leading-none w-10 h-10 -mr-2 -mt-2 flex items-center justify-center shrink-0"
              style={{ color: 'var(--text-tertiary)' }}
              aria-label="Close"
            >
              &times;
            </button>
          </div>
          <p className="text-xs mb-5" style={{ color: 'var(--text-tertiary)' }}>
            Keys set here override the org defaults for this member only and behave exactly like
            their own personal keys (the member can still view and change them). Applies via
            hot-reload — no redeploy needed.
          </p>

          {loading ? (
            <p className="text-sm py-8 text-center" style={{ color: 'var(--text-tertiary)' }}>
              Loading...
            </p>
          ) : (
            <ApiKeyForm
              scope="user"
              basePathOverride={base}
              includeRestricted
              initialKeys={keys}
              summary={summary}
              fetchFn={fetchFn}
              onMutate={loadSummary}
            />
          )}
        </div>
      </div>
    </>
  );
}
