'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { useOrg } from '@/lib/org-context';
import { createOrgFetch } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { MemberApiKeysModal } from './member-api-keys-modal';
import { gatewayUrl, gatewayLabel, type GatewayAccess } from '@/lib/gateway-url';
import type { GatewaySummary, OrgMember } from '@clawhuddle/shared';

function Badge({ color, children }: { color: 'green' | 'red' | 'yellow' | 'blue' | 'purple' | 'gray'; children: React.ReactNode }) {
  const styles: Record<string, { bg: string; text: string }> = {
    green:  { bg: 'var(--green-muted)',  text: 'var(--green)' },
    red:    { bg: 'var(--red-muted)',    text: 'var(--red)' },
    yellow: { bg: 'var(--yellow-muted)', text: 'var(--yellow)' },
    blue:   { bg: 'var(--blue-muted)',   text: 'var(--blue)' },
    purple: { bg: 'var(--purple-muted)', text: 'var(--purple)' },
    gray:   { bg: 'var(--bg-tertiary)',  text: 'var(--text-tertiary)' },
  };
  const s = styles[color];
  return (
    <span
      className="inline-flex px-2 py-0.5 rounded text-[11px] font-medium"
      style={{ background: s.bg, color: s.text }}
    >
      {children}
    </span>
  );
}

function ActionBtn({ onClick, color = 'default', children }: { onClick: () => void; color?: 'default' | 'danger' | 'success'; children: React.ReactNode }) {
  const colorMap = {
    default: { normal: 'var(--accent)', hover: 'var(--accent-hover)' },
    danger:  { normal: 'var(--red)',    hover: '#fca5a5' },
    success: { normal: 'var(--green)',  hover: '#6ee7b7' },
  };
  const c = colorMap[color];
  return (
    <button
      onClick={onClick}
      className="text-xs font-medium transition-colors"
      style={{ color: c.normal }}
      onMouseEnter={(e) => { e.currentTarget.style.color = c.hover; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = c.normal; }}
    >
      {children}
    </button>
  );
}

interface Props {
  initialMembers: OrgMember[];
}

export function MemberTable({ initialMembers }: Props) {
  const { data: session } = useSession();
  const { currentOrgId, memberRole } = useOrg();
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const userId = session?.user?.id;
  const [members, setMembers] = useState(initialMembers);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviting, setInviting] = useState(false);
  const [limitHit, setLimitHit] = useState(false);
  const [gatewayLimitHit, setGatewayLimitHit] = useState<{ member: OrgMember; limit: number } | null>(null);
  // keyed by gateway id, or by member id while a new instance is being created
  const [loadingGateway, setLoadingGateway] = useState<string | null>(null);
  const [redeployingAll, setRedeployingAll] = useState(false);
  const [apiKeysMember, setApiKeysMember] = useState<OrgMember | null>(null);

  const orgFetch = useCallback(
    <T,>(path: string, options?: RequestInit) => {
      if (!currentOrgId || !userId) return Promise.reject(new Error('No org'));
      return createOrgFetch(currentOrgId)<T>(path, options);
    },
    [currentOrgId, userId]
  );

  const refresh = useCallback(async () => {
    try {
      const res = await orgFetch<{ data: OrgMember[] }>('/members');
      setMembers(res.data);
    } catch { /* ignore */ }
  }, [orgFetch]);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isStarting = (g: GatewaySummary) => g.status === 'deploying' || g.status === 'provisioning';
  const hasDeploying = members.some((m) => (m.gateways ?? []).some(isStarting));

  useEffect(() => {
    if (hasDeploying) {
      pollingRef.current = setInterval(async () => {
        const deploying = members.flatMap((m) => m.gateways ?? []).filter(isStarting);
        for (const g of deploying) {
          try {
            const res = await orgFetch<{ data: { status: string } }>(`/gateways/${g.id}/status`);
            if (res.data.status !== 'deploying') {
              await refresh();
              return;
            }
          } catch { /* ignore */ }
        }
      }, 2000);
    }
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [hasDeploying, members, orgFetch, refresh]);

  const [inviteLink, setInviteLink] = useState<string | null>(null);

  const invite = async () => {
    if (!inviteEmail.trim()) return;
    setInviting(true);
    setInviteLink(null);
    try {
      const res = await orgFetch<{ data: { token: string } }>('/members/invite', {
        method: 'POST',
        body: JSON.stringify({ email: inviteEmail.trim() }),
      });
      const link = `${window.location.origin}/invite/${res.data.token}`;
      setInviteLink(link);
      setInviteEmail('');
    } catch (err: any) {
      if (err.code === 'member_limit') {
        setLimitHit(true);
      } else {
        toast(err.message, 'error');
      }
    } finally {
      setInviting(false);
    }
  };

  const removeMember = async (member: OrgMember) => {
    const ok = await confirm({
      title: 'Remove member',
      description: `Remove ${member.name || member.email} from this organization?`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await orgFetch(`/members/${member.id}`, { method: 'DELETE' });
      toast('Member removed', 'success');
      await refresh();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  const changeRole = async (member: OrgMember, role: string) => {
    if (role === member.role) return;
    try {
      await orgFetch(`/members/${member.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      });
      toast(`Role updated to ${role}`, 'success');
      await refresh();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  const toggleStatus = async (member: OrgMember) => {
    const newStatus = member.status === 'active' ? 'disabled' : 'active';
    await orgFetch(`/members/${member.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: newStatus }),
    });
    await refresh();
  };

  const deployNew = async (member: OrgMember) => {
    setLoadingGateway(member.id);
    setGatewayLimitHit(null);
    try {
      await orgFetch(`/gateways/members/${member.id}`, { method: 'POST', body: JSON.stringify({}) });
      await refresh();
    } catch (err: any) {
      if (err.code === 'gateway_limit') {
        setGatewayLimitHit({ member, limit: err.data?.limit ?? member.effective_max_gateways ?? 1 });
      } else {
        toast(err.message, 'error');
      }
    } finally {
      setLoadingGateway(null);
    }
  };

  const gatewayAction = async (gateway: GatewaySummary, action: 'start' | 'stop' | 'remove' | 'redeploy') => {
    if (action === 'remove') {
      const ok = await confirm({
        title: 'Remove instance',
        description: `Remove ${gatewayLabel(gateway)}? Its workspace and channel connections are deleted.`,
        confirmLabel: 'Remove',
        danger: true,
      });
      if (!ok) return;
    }
    setLoadingGateway(gateway.id);
    try {
      if (action === 'remove') {
        await orgFetch(`/gateways/${gateway.id}`, { method: 'DELETE' });
      } else {
        await orgFetch(`/gateways/${gateway.id}/${action}`, { method: 'POST' });
      }
      await refresh();
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setLoadingGateway(null);
    }
  };

  const setMaxGateways = async (member: OrgMember, raw: string) => {
    const next = raw.trim() === '' ? null : Number(raw);
    if (next === (member.max_gateways ?? null)) return;
    if (next !== null && (!Number.isInteger(next) || next < 1)) {
      toast('Max must be a whole number of 1 or more, or blank for the org default', 'error');
      return;
    }
    try {
      await orgFetch(`/members/${member.id}`, { method: 'PATCH', body: JSON.stringify({ max_gateways: next }) });
      setGatewayLimitHit(null);
      await refresh();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  const hasDeployedGateway = members.some((m) => (m.gateways ?? []).length > 0);

  const redeployAll = async () => {
    setRedeployingAll(true);
    try {
      const res = await orgFetch<{ data: { results: any[]; errors: any[] } }>(
        '/gateways/redeploy-all',
        { method: 'POST' },
      );
      const { results, errors } = res.data;
      if (errors.length > 0) {
        toast(`Redeployed ${results.length}, failed ${errors.length}`, 'error');
      } else {
        toast(`Redeploying ${results.length} gateway${results.length === 1 ? '' : 's'}`, 'success');
      }
      await refresh();
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setRedeployingAll(false);
    }
  };

  // Same rule as role changes: owners can open any gateway, admins any but an owner's.
  // The API enforces it; this only decides whether to show the button.
  const canOpenGateway = (member: OrgMember) =>
    member.user_id === userId || memberRole === 'owner' || (memberRole === 'admin' && member.role !== 'owner');

  const openGateway = async (gateway: GatewaySummary) => {
    // Open the tab during the click so popup blockers allow it, then point it at
    // the gateway once we have the token. Tokens aren't in the members list —
    // fetch them on demand from the admin-only access endpoint.
    const win = window.open('', '_blank');
    if (!win) return;
    win.opener = null;
    try {
      const access = (await orgFetch<{ data: GatewayAccess }>(`/gateways/${gateway.id}/access`)).data;
      const url = gatewayUrl(access);
      if (url) {
        win.location.href = url;
      } else {
        win.close();
      }
    } catch (err: any) {
      win.close();
      toast(err.message, 'error');
    }
  };

  const gatewayStatusBadge = (gateway: GatewaySummary) => {
    if (gateway.status === 'deploying' || gateway.status === 'provisioning') {
      return (
        <span className="animate-pulse-amber">
          <Badge color="blue">deploying...</Badge>
        </span>
      );
    }
    if (gateway.status === 'running') return <Badge color="green">running</Badge>;
    if (gateway.status === 'stopped') return <Badge color="yellow">stopped</Badge>;
    return <Badge color="gray">{gateway.status ?? 'unknown'}</Badge>;
  };

  const gatewayActions = (member: OrgMember, gateway: GatewaySummary) => {
    if (loadingGateway === gateway.id) {
      return (
        <span className="text-xs animate-pulse" style={{ color: 'var(--text-tertiary)' }}>
          working...
        </span>
      );
    }

    if (gateway.status === 'deploying' || gateway.status === 'provisioning') {
      return (
        <span className="flex gap-3 items-center">
          <span className="text-xs" style={{ color: 'var(--blue)' }}>starting up...</span>
          <ActionBtn onClick={() => gatewayAction(gateway, 'stop')}>Stop</ActionBtn>
          <ActionBtn onClick={() => gatewayAction(gateway, 'remove')} color="danger">Remove</ActionBtn>
        </span>
      );
    }

    if (gateway.status === 'running') {
      return (
        <span className="flex gap-3">
          {canOpenGateway(member) && (
            <ActionBtn onClick={() => openGateway(gateway)} color="success">Open</ActionBtn>
          )}
          <ActionBtn onClick={() => gatewayAction(gateway, 'redeploy')}>Redeploy</ActionBtn>
          <ActionBtn onClick={() => gatewayAction(gateway, 'stop')}>Stop</ActionBtn>
          <ActionBtn onClick={() => gatewayAction(gateway, 'remove')} color="danger">Remove</ActionBtn>
        </span>
      );
    }

    return (
      <span className="flex gap-3">
        <ActionBtn onClick={() => gatewayAction(gateway, 'start')} color="success">Start</ActionBtn>
        <ActionBtn onClick={() => gatewayAction(gateway, 'redeploy')}>Redeploy</ActionBtn>
        <ActionBtn onClick={() => gatewayAction(gateway, 'remove')} color="danger">Remove</ActionBtn>
      </span>
    );
  };

  // One line per instance, then the deploy affordance (greyed out at the limit).
  const gatewayCell = (member: OrgMember) => {
    const list = member.gateways ?? [];
    const max = member.effective_max_gateways ?? 1;
    const atLimit = list.length >= max;
    return (
      <div className="flex flex-col gap-2">
        {list.map((g) => (
          <div key={g.id} className="flex items-center gap-3 flex-wrap">
            <span className="text-xs font-medium min-w-20" style={{ color: 'var(--text-primary)' }} title={`slot ${g.slot}`}>
              {gatewayLabel(g)}
            </span>
            {gatewayStatusBadge(g)}
            {g.container_id && (
              <button
                onClick={() => {
                  navigator.clipboard.writeText(g.container_id!);
                  toast('Container ID copied', 'success');
                }}
                className="font-mono text-[10px] cursor-pointer hover:underline"
                style={{ color: 'var(--text-tertiary)' }}
                title={g.container_id}
              >
                {g.container_id.slice(0, 12)}
              </button>
            )}
            {gatewayActions(member, g)}
          </div>
        ))}
        {loadingGateway === member.id ? (
          <span className="text-xs animate-pulse" style={{ color: 'var(--text-tertiary)' }}>deploying...</span>
        ) : atLimit ? (
          list.length === 0 ? null : (
            <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
              {list.length}/{max} instances
            </span>
          )
        ) : (
          <span className="flex items-center gap-2">
            <ActionBtn onClick={() => deployNew(member)}>{list.length === 0 ? 'Deploy' : '+ New instance'}</ActionBtn>
            {list.length > 0 && (
              <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{list.length}/{max}</span>
            )}
          </span>
        )}
      </div>
    );
  };

  const roleColor = (role: string) => {
    if (role === 'owner') return 'yellow';
    if (role === 'admin') return 'purple';
    return 'gray';
  };

  return (
    <div>
      {/* Invite form */}
      <div className="flex items-center gap-2 mb-4">
        <input
          type="email"
          value={inviteEmail}
          onChange={(e) => { setInviteEmail(e.target.value); setLimitHit(false); }}
          placeholder="employee@company.com"
          className="flex-1 max-w-sm px-3 py-2 text-sm rounded-lg"
        />
        <button
          onClick={invite}
          disabled={inviting}
          className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50"
          style={{
            background: 'var(--accent)',
            color: 'var(--text-inverse)',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--accent)'; }}
        >
          Invite Member
        </button>
        <span className="text-xs tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
          {members.length} members
        </span>
        {hasDeployedGateway && (
          <button
            onClick={redeployAll}
            disabled={redeployingAll}
            className="ml-auto px-3 py-2 rounded-lg text-xs font-medium transition-all disabled:opacity-50"
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--text-secondary)',
            }}
            onMouseEnter={(e) => { if (!redeployingAll) e.currentTarget.style.background = 'var(--bg-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
          >
            {redeployingAll ? 'Redeploying...' : 'Redeploy All Gateways'}
          </button>
        )}
      </div>

      {/* Member limit banner */}
      {limitHit && (
        <div
          className="flex items-center gap-3 mb-4 px-4 py-3 rounded-lg text-sm"
          style={{ background: 'var(--yellow-muted)', border: '1px solid rgba(234, 179, 8, 0.3)' }}
        >
          <span style={{ color: 'var(--text-primary)' }}>
            Member limit reached. Adjust the <code>MAX_MEMBERS_PER_ORG</code> environment variable to increase.
          </span>
          <button
            onClick={() => setLimitHit(false)}
            className="shrink-0 text-xs px-1 ml-auto"
            style={{ color: 'var(--text-tertiary)' }}
          >
            &times;
          </button>
        </div>
      )}

      {/* Gateway limit banner */}
      {gatewayLimitHit && (
        <div
          className="flex items-center gap-3 mb-4 px-4 py-3 rounded-lg text-sm"
          style={{ background: 'var(--yellow-muted)', border: '1px solid rgba(234, 179, 8, 0.3)' }}
        >
          <span style={{ color: 'var(--text-primary)' }}>
            {gatewayLimitHit.member.name || gatewayLimitHit.member.email} is at their limit of {gatewayLimitHit.limit} instance{gatewayLimitHit.limit === 1 ? '' : 's'}.
            Raise it in the Max column, or for everyone under Admin → API Keys → Instances per member.
          </span>
          <button
            onClick={() => setGatewayLimitHit(null)}
            className="shrink-0 text-xs px-1 ml-auto"
            style={{ color: 'var(--text-tertiary)' }}
          >
            &times;
          </button>
        </div>
      )}

      {/* Invite link */}
      {inviteLink && (
        <div
          className="flex items-center gap-2 mb-6 px-4 py-3 rounded-lg text-sm"
          style={{ background: 'var(--green-muted)', border: '1px solid rgba(74, 199, 120, 0.2)' }}
        >
          <span className="flex-1 font-mono text-xs truncate" style={{ color: 'var(--text-primary)' }}>
            {inviteLink}
          </span>
          <button
            onClick={() => {
              navigator.clipboard.writeText(inviteLink);
              toast('Link copied to clipboard', 'success');
            }}
            className="shrink-0 text-xs font-medium px-3 py-1 rounded-md transition-colors"
            style={{ color: 'var(--green)', background: 'rgba(74, 199, 120, 0.15)' }}
          >
            Copy
          </button>
          <button
            onClick={() => setInviteLink(null)}
            className="shrink-0 text-xs px-1"
            style={{ color: 'var(--text-tertiary)' }}
          >
            &times;
          </button>
        </div>
      )}

      {/* Table */}
      <div
        className="rounded-xl overflow-hidden"
        style={{
          background: 'var(--bg-primary)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-primary)' }}>
              {['Name', 'Email', 'Role', 'Status', 'Gateways', 'Max', 'Member'].map((h) => (
                <th
                  key={h}
                  className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {members.map((member, i) => (
              <tr
                key={member.id}
                className="transition-colors"
                style={{
                  borderBottom: i < members.length - 1 ? '1px solid var(--border-subtle)' : 'none',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <td className="px-4 py-3 font-medium" style={{ color: 'var(--text-primary)' }}>
                  {member.name || '\u2014'}
                </td>
                <td className="px-4 py-3" style={{ color: 'var(--text-secondary)' }}>
                  {member.email}
                </td>
                <td className="px-4 py-3">
                  {member.user_id !== userId &&
                  (memberRole === 'owner' || (memberRole === 'admin' && member.role !== 'owner')) ? (
                    <select
                      value={member.role}
                      onChange={(e) => changeRole(member, e.target.value)}
                      className="px-2 py-0.5 rounded text-[11px] font-medium cursor-pointer appearance-none"
                      style={{
                        background:
                          member.role === 'owner' ? 'var(--yellow-muted)' :
                          member.role === 'admin' ? 'var(--purple-muted)' :
                          'var(--bg-tertiary)',
                        color:
                          member.role === 'owner' ? 'var(--yellow)' :
                          member.role === 'admin' ? 'var(--purple)' :
                          'var(--text-tertiary)',
                        border: 'none',
                      }}
                    >
                      {memberRole === 'owner' && <option value="owner">owner</option>}
                      <option value="admin">admin</option>
                      <option value="member">member</option>
                    </select>
                  ) : (
                    <Badge color={roleColor(member.role) as any}>
                      {member.role}
                    </Badge>
                  )}
                </td>
                <td className="px-4 py-3">
                  <Badge color={member.status === 'active' ? 'green' : 'red'}>
                    {member.status}
                  </Badge>
                </td>
                <td className="px-4 py-3">
                  {gatewayCell(member)}
                </td>
                <td className="px-4 py-3">
                  <input
                    type="number"
                    min={1}
                    key={`${member.id}-${member.max_gateways ?? ''}`}
                    defaultValue={member.max_gateways ?? ''}
                    placeholder={String(member.effective_max_gateways ?? 1)}
                    title="Max instances for this member. Blank = org default."
                    onBlur={(e) => setMaxGateways(member, e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    className="w-14 px-2 py-1 text-xs rounded-md"
                    style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                  />
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <ActionBtn onClick={() => setApiKeysMember(member)}>
                      API Keys
                    </ActionBtn>
                    {member.user_id !== userId && (
                      <ActionBtn onClick={() => toggleStatus(member)}>
                        {member.status === 'active' ? 'Suspend' : 'Activate'}
                      </ActionBtn>
                    )}
                    {member.role !== 'owner' && member.user_id !== userId && (
                      <ActionBtn onClick={() => removeMember(member)} color="danger">
                        Remove
                      </ActionBtn>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {members.length === 0 && (
          <p
            className="text-center py-12 text-sm"
            style={{ color: 'var(--text-tertiary)' }}
          >
            No members yet. Invite someone to get started.
          </p>
        )}
      </div>

      {apiKeysMember && (
        <MemberApiKeysModal
          member={apiKeysMember}
          fetchFn={orgFetch}
          onClose={() => setApiKeysMember(null)}
        />
      )}
    </div>
  );
}
