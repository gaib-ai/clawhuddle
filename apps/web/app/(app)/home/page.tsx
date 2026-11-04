'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useSession, signOut } from 'next-auth/react';
import { useOrg } from '@/lib/org-context';
import { useOrgFetch } from '@/lib/use-org-fetch';
import { apiFetch } from '@/lib/api';
import { GatewayCard } from '@/components/gateway-card';
import type { Gateway, OrgMember, Skill } from '@clawhuddle/shared';

interface SkillWithStatus extends Skill {
  assigned: boolean;
}

export default function DashboardPage() {
  const { orgs, currentOrgId, refreshOrgs, loading: orgLoading } = useOrg();

  // No orgs — show create org form
  if (!orgLoading && orgs.length === 0) {
    return <CreateOrgView onCreated={refreshOrgs} />;
  }

  // Has org selected — show dashboard
  if (currentOrgId) {
    return <DashboardView />;
  }

  // Loading / transitioning
  return (
    <div className="flex-1 flex items-center justify-center">
      <div
        className="w-8 h-8 rounded-full border-2 animate-spin"
        style={{ borderColor: 'var(--border-primary)', borderTopColor: 'var(--accent)' }}
      />
    </div>
  );
}

/* ─── Create Organization ─── */

function CreateOrgView({ onCreated }: { onCreated: () => Promise<void> }) {
  const { data: session } = useSession();
  const userId = session?.user?.id;
  const [orgName, setOrgName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const createOrg = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orgName.trim() || !userId) {
      if (!userId) setError('Session error: please sign out and sign in again.');
      return;
    }
    setCreating(true);
    setError('');
    try {
      await apiFetch('/api/orgs', {
        method: 'POST',
        body: JSON.stringify({ name: orgName.trim() }),
      });
      await onCreated();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="max-w-sm w-full p-8">
        <div className="text-center mb-8">
          <div
            className="inline-flex items-center justify-center w-14 h-14 rounded-2xl mb-5"
            style={{
              background: 'var(--accent-muted)',
              border: '1px solid rgba(199, 148, 74, 0.2)',
            }}
          >
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z"/>
              <path d="M2 17l10 5 10-5"/>
              <path d="M2 12l10 5 10-5"/>
            </svg>
          </div>
          <h1
            className="text-2xl font-semibold tracking-tight"
            style={{ color: 'var(--text-primary)' }}
          >
            Welcome to ClawHuddle
          </h1>
          <p className="mt-2 text-sm" style={{ color: 'var(--text-tertiary)' }}>
            Create your organization to get started
          </p>
        </div>

        <form onSubmit={createOrg} className="space-y-4">
          <div>
            <label
              className="block text-xs font-medium mb-1.5 uppercase tracking-wider"
              style={{ color: 'var(--text-tertiary)' }}
            >
              Organization Name
            </label>
            <input
              type="text"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="Acme Corp"
              className="w-full px-4 py-3 text-sm rounded-lg"
              autoFocus
              required
            />
          </div>

          {error && (
            <p className="text-xs" style={{ color: 'var(--red)' }}>{error}</p>
          )}

          <button
            type="submit"
            disabled={creating}
            className="w-full px-4 py-3 rounded-lg font-medium text-sm transition-all duration-150 disabled:opacity-50"
            style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--accent)'; }}
          >
            {creating ? 'Creating...' : 'Create Organization'}
          </button>
        </form>

        <div className="mt-6 text-center">
          <button
            onClick={() => signOut({ callbackUrl: '/login' })}
            className="text-xs transition-colors"
            style={{ color: 'var(--text-tertiary)' }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-secondary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-tertiary)'; }}
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Dashboard ─── */

function DashboardView() {
  const { orgFetch, ready } = useOrgFetch();
  const { memberRole } = useOrg();
  const isAdmin = memberRole === 'admin' || memberRole === 'owner';

  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [limit, setLimit] = useState({ limit: 1, current: 0 });
  const [memberCount, setMemberCount] = useState(0);
  const [runningCount, setRunningCount] = useState(0);
  const [skillStats, setSkillStats] = useState<{ enabled: number; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  // Providers this member can actually use (org key or a personal one); the
  // instance card only offers models from these.
  const [activeProviders, setActiveProviders] = useState<string[]>([]);

  const fetchData = useCallback(async () => {
    if (!orgFetch) return;
    try {
      const [mineRes, membersRes, skillsRes, keysRes] = await Promise.all([
        orgFetch<{ data: Gateway[]; limit: number; current: number }>('/me/gateways'),
        orgFetch<{ data: OrgMember[] }>('/members'),
        orgFetch<{ data: SkillWithStatus[] }>('/me/skills'),
        orgFetch<{ data: { provider: string; source: 'user' | 'org' | 'none' }[] }>('/me/api-keys/summary'),
      ]);

      setGateways(mineRes.data);
      setActiveProviders(keysRes.data.filter((k) => k.source !== 'none').map((k) => k.provider));
      setLimit({ limit: mineRes.limit, current: mineRes.current });
      setMemberCount(membersRes.data.length);
      setRunningCount(
        membersRes.data.flatMap((m) => m.gateways ?? []).filter((g) => g.status === 'running').length,
      );

      const enabled = skillsRes.data.filter((s) => s.assigned).length;
      setSkillStats({ enabled, total: skillsRes.data.length });
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [orgFetch]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const createInstance = async () => {
    if (!orgFetch) return;
    setCreating(true);
    setCreateError('');
    try {
      await orgFetch('/me/gateways', { method: 'POST', body: JSON.stringify({}) });
      await fetchData();
    } catch (err: any) {
      setCreateError(
        err.code === 'gateway_limit'
          ? `Instance limit reached (${err.data?.current}/${err.data?.limit}). Ask an admin to raise it.`
          : err.message || 'Deploy failed',
      );
    } finally {
      setCreating(false);
    }
  };

  if (loading || !ready || !orgFetch) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div
          className="w-8 h-8 rounded-full border-2 animate-spin"
          style={{ borderColor: 'var(--border-primary)', borderTopColor: 'var(--accent)' }}
        />
      </div>
    );
  }

  const atLimit = limit.current >= limit.limit;

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-4 py-5 md:px-6 md:py-8 space-y-4">
        {/* Instances */}
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            {gateways.length === 1 ? 'AI Assistant' : 'AI Assistants'}
          </h2>
          <span className="text-xs tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
            {limit.current} of {limit.limit} instance{limit.limit === 1 ? '' : 's'}
          </span>
        </div>

        {gateways.map((g) => (
          <GatewayCard key={g.id} gateway={g} orgFetch={orgFetch} onChanged={fetchData} activeProviders={activeProviders} />
        ))}

        <div
          className="rounded-xl p-5"
          style={{ background: 'var(--bg-primary)', border: '1px dashed var(--border-primary)' }}
        >
          {gateways.length === 0 && (
            <p className="text-xs mb-2" style={{ color: 'var(--text-tertiary)' }}>
              Your assistant is not yet deployed.
            </p>
          )}
          <button
            onClick={createInstance}
            disabled={creating || atLimit}
            title={atLimit ? `Limit of ${limit.limit} reached — ask an admin to raise it` : undefined}
            className="w-full py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--accent)'; }}
          >
            {creating ? 'Deploying...' : gateways.length === 0 ? 'Deploy My Assistant' : '+ New instance'}
          </button>
          {atLimit && gateways.length > 0 && (
            <p className="text-xs mt-2" style={{ color: 'var(--text-tertiary)' }}>
              Limit of {limit.limit} reached — ask an admin to raise it.
            </p>
          )}
          {createError && (
            <p className="text-xs mt-2" style={{ color: 'var(--red)' }}>{createError}</p>
          )}
        </div>

        {/* Skills Card */}
        {skillStats && (
          <Link
            href="/skills"
            className="block rounded-xl p-5 transition-colors"
            style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--border-primary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-subtle)'; }}
          >
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  My Skills
                </h2>
                <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                  {skillStats.enabled} of {skillStats.total} enabled
                  {gateways.length > 1 ? ' · shared by every instance' : ''}
                </p>
              </div>
              <span className="text-xs font-medium" style={{ color: 'var(--accent)' }}>
                Manage &rarr;
              </span>
            </div>
          </Link>
        )}

        {/* Admin Overview Card */}
        {isAdmin && (
          <div
            className="rounded-xl p-5"
            style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}
          >
            <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>
              Team Overview
            </h2>
            <div className="flex gap-6 mb-4">
              <div>
                <p className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {memberCount}
                </p>
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>members</p>
              </div>
              <div>
                <p className="text-lg font-semibold" style={{ color: 'var(--green)' }}>
                  {runningCount}
                </p>
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>gateways running</p>
              </div>
            </div>
            <div className="flex gap-3">
              <QuickLink href="/admin">Members</QuickLink>
              <QuickLink href="/admin/skills">Skills</QuickLink>
              <QuickLink href="/admin/api-keys">API Keys</QuickLink>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function QuickLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="text-xs font-medium px-3 py-1.5 rounded-md transition-colors"
      style={{ color: 'var(--accent)', background: 'var(--accent-muted)' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent)'; e.currentTarget.style.color = 'var(--text-inverse)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--accent-muted)'; e.currentTarget.style.color = 'var(--accent)'; }}
    >
      {children}
    </Link>
  );
}
