'use client';

import { useState, useEffect, useCallback } from 'react';
import { useOrgFetch } from '@/lib/use-org-fetch';
import { useToast } from '@/components/ui/toast';

interface PortForward {
  id: string;
  member_id: string;
  subdomain: string;
  hostname: string;
  port: number;
  description: string | null;
  created_at: string;
  member_email: string;
  member_name: string | null;
  gateway_status: string | null;
}

interface Member {
  id: string;
  email: string;
  name: string | null;
  gateway_status: string | null;
}

export default function PortForwardsPage() {
  const { orgFetch, ready } = useOrgFetch();
  const { toast } = useToast();
  const [forwards, setForwards] = useState<PortForward[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [edit, setEdit] = useState({ memberId: '', subdomain: '', port: '', description: '' });

  const [memberId, setMemberId] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const [port, setPort] = useState('');
  const [description, setDescription] = useState('');

  const gwDomain =
    process.env.NEXT_PUBLIC_GATEWAY_DOMAIN ||
    (typeof window !== 'undefined' ? window.location.hostname : '');

  const fetchAll = useCallback(async () => {
    if (!orgFetch) return;
    try {
      const [fwRes, memberRes] = await Promise.all([
        orgFetch<{ data: PortForward[] }>('/port-forwards'),
        orgFetch<{ data: Member[] }>('/members'),
      ]);
      setForwards(fwRes.data);
      setMembers(memberRes.data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [orgFetch]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const createForward = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orgFetch) return;
    setSubmitting(true);
    try {
      await orgFetch('/port-forwards', {
        method: 'POST',
        body: JSON.stringify({
          memberId,
          subdomain: subdomain.trim().toLowerCase(),
          port: Number(port),
          description: description.trim() || undefined,
        }),
      });
      setSubdomain('');
      setPort('');
      setDescription('');
      await fetchAll();
      toast('Port forward created', 'success');
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const startEdit = (fw: PortForward) => {
    setEditingId(fw.id);
    setEdit({
      memberId: fw.member_id,
      subdomain: fw.subdomain,
      port: String(fw.port),
      description: fw.description || '',
    });
  };

  const saveEdit = async () => {
    if (!orgFetch || !editingId) return;
    setSaving(true);
    try {
      await orgFetch(`/port-forwards/${editingId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          memberId: edit.memberId,
          subdomain: edit.subdomain.trim().toLowerCase(),
          port: Number(edit.port),
          description: edit.description.trim() || null,
        }),
      });
      setEditingId(null);
      await fetchAll();
      toast('Port forward updated', 'success');
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const deleteForward = async (id: string) => {
    if (!orgFetch) return;
    setDeleting(id);
    try {
      await orgFetch(`/port-forwards/${id}`, { method: 'DELETE' });
      await fetchAll();
      toast('Port forward removed', 'success');
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setDeleting(null);
    }
  };

  if (loading || !ready) {
    return (
      <div>
        <h1 className="text-xl font-semibold tracking-tight mb-6" style={{ color: 'var(--text-primary)' }}>
          Port Forwards
        </h1>
        <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>Loading...</p>
      </div>
    );
  }

  const inputStyle = {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-primary)',
    color: 'var(--text-primary)',
  } as const;

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight mb-1" style={{ color: 'var(--text-primary)' }}>
        Port Forwards
      </h1>
      <p className="text-sm mb-6" style={{ color: 'var(--text-tertiary)' }}>
        Expose a port inside a member&apos;s gateway container on a public subdomain. The service must
        listen on <code>0.0.0.0</code> at the chosen port inside the container.
      </p>

      <form
        onSubmit={createForward}
        className="rounded-xl p-5 mb-6 flex flex-wrap items-end gap-3"
        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}
      >
        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
            Member
          </label>
          <select
            required
            value={memberId}
            onChange={(e) => setMemberId(e.target.value)}
            className="rounded-lg px-3 py-2 text-sm min-w-52"
            style={inputStyle}
          >
            <option value="">Select member...</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name || m.email}{m.gateway_status ? '' : ' (no gateway)'}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
            Subdomain
          </label>
          <div className="flex items-center gap-1.5">
            <input
              required
              value={subdomain}
              onChange={(e) => setSubdomain(e.target.value)}
              placeholder="my-service"
              pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
              className="rounded-lg px-3 py-2 text-sm w-40"
              style={inputStyle}
            />
            <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>.{gwDomain}</span>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
            Port
          </label>
          <input
            required
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => setPort(e.target.value)}
            placeholder="8080"
            className="rounded-lg px-3 py-2 text-sm w-24"
            style={inputStyle}
          />
        </div>

        <div className="flex flex-col gap-1.5 flex-1 min-w-40">
          <label className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
            Description (optional)
          </label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this exposes"
            className="rounded-lg px-3 py-2 text-sm w-full"
            style={inputStyle}
          />
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50"
          style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
        >
          {submitting ? 'Creating...' : 'Create'}
        </button>
      </form>

      {forwards.length === 0 ? (
        <div
          className="rounded-xl p-8 text-center"
          style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}
        >
          <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
            No port forwards yet. Create one above to expose a service running inside a member&apos;s gateway.
          </p>
        </div>
      ) : (
        <div
          className="rounded-xl overflow-hidden"
          style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}
        >
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-primary)' }}>
                {['URL', 'Member', 'Port', 'Description', 'Created', 'Actions'].map((h) => (
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
              {forwards.map((fw, i) => {
                const isEditing = editingId === fw.id;
                const rowBorder = i < forwards.length - 1 ? '1px solid var(--border-subtle)' : 'none';
                if (isEditing) {
                  return (
                    <tr key={fw.id} style={{ borderBottom: rowBorder, background: 'var(--bg-hover)' }}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <input
                            value={edit.subdomain}
                            onChange={(e) => setEdit({ ...edit, subdomain: e.target.value })}
                            pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
                            className="rounded-lg px-2 py-1.5 text-sm w-36"
                            style={inputStyle}
                          />
                          <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>.{gwDomain}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <select
                          value={edit.memberId}
                          onChange={(e) => setEdit({ ...edit, memberId: e.target.value })}
                          className="rounded-lg px-2 py-1.5 text-sm w-full"
                          style={inputStyle}
                        >
                          {members.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name || m.email}{m.gateway_status ? '' : ' (no gateway)'}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-3">
                        <input
                          type="number"
                          min={1}
                          max={65535}
                          value={edit.port}
                          onChange={(e) => setEdit({ ...edit, port: e.target.value })}
                          className="rounded-lg px-2 py-1.5 text-sm w-20"
                          style={inputStyle}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <input
                          value={edit.description}
                          onChange={(e) => setEdit({ ...edit, description: e.target.value })}
                          placeholder="What this exposes"
                          className="rounded-lg px-2 py-1.5 text-sm w-full"
                          style={inputStyle}
                        />
                      </td>
                      <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        {new Date(fw.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3">
                        {saving ? (
                          <span className="text-xs animate-pulse" style={{ color: 'var(--text-tertiary)' }}>
                            saving...
                          </span>
                        ) : (
                          <div className="flex items-center gap-3">
                            <button
                              onClick={saveEdit}
                              className="text-xs font-medium"
                              style={{ color: 'var(--accent)' }}
                            >
                              Save
                            </button>
                            <button
                              onClick={() => setEditingId(null)}
                              className="text-xs font-medium"
                              style={{ color: 'var(--text-tertiary)' }}
                            >
                              Cancel
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr
                    key={fw.id}
                    className="transition-colors"
                    style={{ borderBottom: rowBorder }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <td className="px-4 py-3">
                      <a
                        href={`${window.location.protocol}//${fw.hostname}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium hover:underline"
                        style={{ color: 'var(--accent)' }}
                      >
                        {fw.hostname}
                      </a>
                    </td>
                    <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>
                      {fw.member_name || fw.member_email}
                      {!fw.gateway_status && (
                        <span className="ml-2 text-[11px]" style={{ color: 'var(--yellow)' }}>no gateway</span>
                      )}
                    </td>
                    <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{fw.port}</td>
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      {fw.description || '—'}
                    </td>
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      {new Date(fw.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      {deleting === fw.id ? (
                        <span className="text-xs animate-pulse" style={{ color: 'var(--text-tertiary)' }}>
                          removing...
                        </span>
                      ) : (
                        <div className="flex items-center gap-3">
                          <button
                            onClick={() => startEdit(fw)}
                            className="text-xs font-medium transition-colors"
                            style={{ color: 'var(--accent)' }}
                            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent-hover)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--accent)'; }}
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => deleteForward(fw.id)}
                            className="text-xs font-medium transition-colors"
                            style={{ color: 'var(--red)' }}
                            onMouseEnter={(e) => { e.currentTarget.style.color = '#fca5a5'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--red)'; }}
                          >
                            Remove
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
