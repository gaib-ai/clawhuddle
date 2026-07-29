'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useOrg } from '@/lib/org-context';
import { apiFetch, createOrgFetch } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import type { OrgMember } from '@clawhuddle/shared';

export default function SettingsPage() {
  const { data: session } = useSession();
  const { currentOrg, currentOrgId, memberRole, refreshOrgs } = useOrg();
  const { toast } = useToast();
  const router = useRouter();
  const userId = session?.user?.id;
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmName, setConfirmName] = useState('');

  const isAdmin = memberRole === 'admin' || memberRole === 'owner';

  const orgFetch = useCallback(
    <T,>(path: string, options?: RequestInit) => {
      if (!currentOrgId || !userId) return Promise.reject(new Error('No org'));
      return createOrgFetch(currentOrgId, userId)<T>(path, options);
    },
    [currentOrgId, userId]
  );

  useEffect(() => {
    if (!currentOrgId || !userId) return;
    orgFetch<{ data: OrgMember[] }>('/members')
      .then((res) => setMemberCount(res.data.length))
      .catch(() => toast('Failed to load member count', 'error'));
  }, [currentOrgId, userId, orgFetch]);

  const deleteOrg = async () => {
    if (!currentOrgId || !userId || !currentOrg) return;
    if (confirmName !== currentOrg.name) {
      toast('Organization name does not match', 'error');
      return;
    }
    setDeleting(true);
    try {
      await apiFetch(`/api/orgs/${currentOrgId}`, {
        method: 'DELETE',
        headers: { 'x-user-id': userId },
      });
      toast('Organization deleted', 'success');
      await refreshOrgs();
      router.push('/home');
    } catch (err: any) {
      toast(err.message || 'Failed to delete organization', 'error');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-8 max-w-3xl mx-auto w-full">
      <h1 className="text-lg font-semibold mb-6" style={{ color: 'var(--text-primary)' }}>
        Settings
      </h1>

      {/* Organization info */}
      <div
        className="rounded-xl p-5 mb-8"
        style={{
          background: 'var(--bg-primary)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        <span
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color: 'var(--text-tertiary)' }}
        >
          Organization
        </span>
        <p className="text-base font-semibold mt-1" style={{ color: 'var(--text-primary)' }}>
          {currentOrg?.name || '—'}
        </p>

        {memberCount !== null && (
          <p className="text-sm mt-3" style={{ color: 'var(--text-secondary)' }}>
            {memberCount} {memberCount === 1 ? 'member' : 'members'}
          </p>
        )}
      </div>

      {/* Danger Zone */}
      {isAdmin && (
        <div
          className="rounded-xl p-5 mb-8"
          style={{
            background: 'var(--bg-primary)',
            border: '1px solid rgba(255, 77, 77, 0.3)',
          }}
        >
          <h2 className="text-sm font-semibold mb-1" style={{ color: 'var(--red, #ff4d4d)' }}>
            Danger Zone
          </h2>
          <p className="text-xs mb-4" style={{ color: 'var(--text-tertiary)' }}>
            Deleting this organization will permanently remove all members, gateways, skills, and API keys. This cannot be undone.
          </p>
          <div className="space-y-2">
            <label className="block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
              Type <span className="font-mono font-semibold" style={{ color: 'var(--text-primary)' }}>{currentOrg?.name}</span> to confirm
            </label>
            <input
              type="text"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder={currentOrg?.name}
              className="w-full px-3 py-2 text-sm rounded-lg"
              style={{
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border-primary)',
                color: 'var(--text-primary)',
              }}
            />
            <button
              onClick={deleteOrg}
              disabled={deleting || confirmName !== currentOrg?.name}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-40"
              style={{
                background: 'rgba(255, 77, 77, 0.15)',
                color: 'var(--red, #ff4d4d)',
                border: '1px solid rgba(255, 77, 77, 0.3)',
              }}
              onMouseEnter={(e) => {
                if (!e.currentTarget.disabled) {
                  e.currentTarget.style.background = 'rgba(255, 77, 77, 0.25)';
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(255, 77, 77, 0.15)';
              }}
            >
              {deleting ? 'Deleting...' : 'Delete Organization'}
            </button>
          </div>
        </div>
      )}

      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
        Need help?{' '}
        <a
          href={`mailto:${process.env.NEXT_PUBLIC_SUPPORT_EMAIL || ''}`}
          className="underline transition-colors"
          style={{ color: 'var(--text-secondary)' }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-secondary)'; }}
        >
          Contact support
        </a>
      </p>
    </div>
  );
}
