'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useOrgFetch } from '@/lib/use-org-fetch';
import { useToast } from '@/components/ui/toast';
import { gatewayLabel } from '@/lib/gateway-url';
import type { Gateway } from '@clawhuddle/shared';

interface ChannelConfig {
  channel: string;
  configured: boolean;
  masked_token?: string;
  updated_at?: string;
}

const CHANNELS = [
  {
    id: 'telegram',
    label: 'Telegram Bot',
    description: 'Connect a Telegram bot to your AI assistant via BotFather.',
    placeholder: '123456789:ABCdefGhIJKlmNoPQRsTUVwxyz',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
      </svg>
    ),
  },
];

function PairingSection({ gatewayId, channelId, orgFetch }: { gatewayId: string; channelId: string; orgFetch: any }) {
  const { toast } = useToast();
  const [pairingCode, setPairingCode] = useState('');
  const [approving, setApproving] = useState(false);

  const approve = async () => {
    if (!pairingCode.trim()) return;
    setApproving(true);
    try {
      await orgFetch(`/gateways/${gatewayId}/channels/${channelId}/pair`, {
        method: 'POST',
        body: JSON.stringify({ code: pairingCode.trim() }),
      });
      toast('Pairing approved!', 'success');
      setPairingCode('');
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setApproving(false);
    }
  };

  return (
    <div className="px-4 pb-4">
      <div
        className="rounded-lg px-3 py-3"
        style={{ background: 'var(--bg-secondary)' }}
      >
        <p className="text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
          Approve a new user
        </p>
        <p className="text-[11px] mb-2" style={{ color: 'var(--text-tertiary)' }}>
          Message your bot on Telegram to get a pairing code, then paste it here.
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={pairingCode}
            onChange={(e) => setPairingCode(e.target.value.toUpperCase())}
            placeholder="e.g. SAXMVEC7"
            className="flex-1 min-w-0 px-3 py-1.5 text-sm rounded-lg font-mono uppercase tracking-wider"
            style={{
              background: 'var(--bg-primary)',
              border: '1px solid var(--border-primary)',
              color: 'var(--text-primary)',
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') approve();
            }}
          />
          <button
            onClick={approve}
            disabled={approving || !pairingCode.trim()}
            className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all disabled:opacity-50"
            style={{
              background: 'var(--green)',
              color: '#fff',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.85'; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
          >
            {approving ? 'Approving...' : 'Approve'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ChannelsPage() {
  const { orgFetch, ready } = useOrgFetch();
  const { toast } = useToast();
  const [configs, setConfigs] = useState<ChannelConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingChannel, setEditingChannel] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  const [saving, setSaving] = useState(false);
  // Bot tokens are per instance (a Slack app or Telegram bot can only be
  // consumed by one container), so the page works on one selected instance.
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const fetchGateways = useCallback(async () => {
    if (!orgFetch) return;
    try {
      const res = await orgFetch<{ data: Gateway[] }>('/me/gateways');
      setGateways(res.data);
      setSelectedId((current) => (current && res.data.some((g) => g.id === current) ? current : res.data[0]?.id ?? null));
      if (res.data.length === 0) setLoading(false);
    } catch {
      setLoading(false);
    }
  }, [orgFetch]);

  const fetchChannels = useCallback(async () => {
    if (!orgFetch || !selectedId) return;
    try {
      const res = await orgFetch<{ data: ChannelConfig[] }>(`/gateways/${selectedId}/channels`);
      setConfigs(res.data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [orgFetch, selectedId]);

  useEffect(() => {
    fetchGateways();
  }, [fetchGateways]);

  useEffect(() => {
    setConfigs([]);
    setEditingChannel(null);
    fetchChannels();
  }, [fetchChannels]);

  const getConfig = (channelId: string) =>
    configs.find((c) => c.channel === channelId);

  const saveToken = async (channelId: string) => {
    if (!orgFetch || !selectedId || !tokenInput.trim()) return;
    setSaving(true);
    try {
      await orgFetch(`/gateways/${selectedId}/channels/${channelId}`, {
        method: 'PUT',
        body: JSON.stringify({ bot_token: tokenInput.trim() }),
      });
      toast('Token saved. Instance redeploying...', 'success');
      setTokenInput('');
      setEditingChannel(null);
      await fetchChannels();
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const removeToken = async (channelId: string) => {
    if (!orgFetch || !selectedId) return;
    setSaving(true);
    try {
      await orgFetch(`/gateways/${selectedId}/channels/${channelId}`, { method: 'DELETE' });
      toast('Channel disconnected. Instance redeploying...', 'success');
      setEditingChannel(null);
      await fetchChannels();
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-4 py-5 md:px-6 md:py-8">
        <h1
          className="text-xl font-semibold tracking-tight mb-1"
          style={{ color: 'var(--text-primary)' }}
        >
          Channels
        </h1>
        <p className="text-sm mb-6" style={{ color: 'var(--text-tertiary)' }}>
          Connect messaging platforms to your AI assistant.
          {gateways.length > 1 && ' Each instance has its own connections.'}
        </p>

        {/* Instance picker — only when there is a choice */}
        {!loading && ready && gateways.length > 1 && (
          <div className="flex items-center gap-2 mb-4">
            <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>Instance</label>
            <select
              value={selectedId ?? ''}
              onChange={(e) => setSelectedId(e.target.value)}
              className="px-3 py-1.5 text-sm rounded-lg"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
            >
              {gateways.map((g) => (
                <option key={g.id} value={g.id}>{gatewayLabel(g)}</option>
              ))}
            </select>
          </div>
        )}

        {!loading && ready && gateways.length === 0 && (
          <div
            className="rounded-xl p-8 text-center"
            style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}
          >
            <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
              Deploy an instance on the <Link href="/home" className="underline">Home</Link> page first, then connect channels to it here.
            </p>
          </div>
        )}

        {loading || !ready ? (
          <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>Loading...</p>
        ) : !selectedId ? null : (
          <div className="space-y-2">
            {CHANNELS.map((ch) => {
              const config = getConfig(ch.id);
              const isEditing = editingChannel === ch.id;

              return (
                <div
                  key={ch.id}
                  className="rounded-xl transition-colors"
                  style={{
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--border-subtle)',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--border-primary)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-subtle)'; }}
                >
                  {/* Channel header row */}
                  <div className="flex items-center gap-3 sm:gap-4 px-4 py-3">
                    <span style={{ color: config?.configured ? 'var(--accent)' : 'var(--text-tertiary)' }}>
                      {ch.icon}
                    </span>

                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                          {ch.label}
                        </span>
                        {config?.configured ? (
                          <span
                            className="inline-flex px-2 py-0.5 rounded text-[11px] font-medium"
                            style={{ background: 'var(--green-muted)', color: 'var(--green)' }}
                          >
                            connected
                          </span>
                        ) : (
                          <span
                            className="inline-flex px-2 py-0.5 rounded text-[11px] font-medium"
                            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)' }}
                          >
                            not configured
                          </span>
                        )}
                      </div>
                      <p className="text-xs mt-0.5 break-all" style={{ color: 'var(--text-tertiary)' }}>
                        {config?.configured
                          ? `Token: ${config.masked_token}`
                          : ch.description}
                      </p>
                    </div>

                    {config?.configured ? (
                      <button
                        onClick={() => {
                          setEditingChannel(isEditing ? null : ch.id);
                          setTokenInput('');
                        }}
                        className="shrink-0 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
                        style={{ color: 'var(--text-tertiary)', background: 'transparent' }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = 'var(--bg-hover)';
                          e.currentTarget.style.color = 'var(--text-secondary)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'transparent';
                          e.currentTarget.style.color = 'var(--text-tertiary)';
                        }}
                      >
                        {isEditing ? 'Cancel' : 'Edit token'}
                      </button>
                    ) : (
                      <button
                        onClick={() => {
                          setEditingChannel(isEditing ? null : ch.id);
                          setTokenInput('');
                        }}
                        className="shrink-0 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
                        style={{ color: 'var(--accent)', background: 'var(--accent-muted)' }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = 'var(--accent-hover)';
                          e.currentTarget.style.color = 'var(--text-inverse)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'var(--accent-muted)';
                          e.currentTarget.style.color = 'var(--accent)';
                        }}
                      >
                        {isEditing ? 'Cancel' : 'Set up'}
                      </button>
                    )}
                  </div>

                  {/* Pairing section — always visible when configured */}
                  {config?.configured && !isEditing && (
                    <PairingSection gatewayId={selectedId} channelId={ch.id} orgFetch={orgFetch} />
                  )}

                  {/* Edit token area — only when editing */}
                  {isEditing && (
                    <div
                      className="px-4 pb-4 pt-1"
                      style={{ borderTop: '1px solid var(--border-subtle)' }}
                    >
                      <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                        {config?.configured ? 'Replace Bot Token' : 'Bot Token'}
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={tokenInput}
                          onChange={(e) => setTokenInput(e.target.value)}
                          placeholder={ch.placeholder}
                          className="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg font-mono"
                          style={{
                            background: 'var(--bg-secondary)',
                            border: '1px solid var(--border-primary)',
                            color: 'var(--text-primary)',
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveToken(ch.id);
                          }}
                          autoFocus
                        />
                        <button
                          onClick={() => saveToken(ch.id)}
                          disabled={saving || !tokenInput.trim()}
                          className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50"
                          style={{
                            background: 'var(--accent)',
                            color: 'var(--text-inverse)',
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent-hover)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--accent)'; }}
                        >
                          {saving ? 'Saving...' : 'Save'}
                        </button>
                      </div>
                      <p className="text-[11px] mt-2" style={{ color: 'var(--text-tertiary)' }}>
                        Get your bot token from <span className="font-medium">@BotFather</span> on Telegram.
                        {config?.configured && ' Saving a new token will replace the existing one.'}
                      </p>

                      {config?.configured && (
                        <button
                          onClick={() => removeToken(ch.id)}
                          disabled={saving}
                          className="mt-3 text-xs font-medium transition-colors"
                          style={{ color: 'var(--red)' }}
                          onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.7'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
                        >
                          Disconnect {ch.label}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            <div
              className="rounded-xl px-4 py-3 text-xs"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', color: 'var(--text-tertiary)' }}
            >
              <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>Other channels</span>
              {' '}(Slack, Discord, WhatsApp, Signal, iMessage and the rest) are set up inside OpenClaw itself, not here.
              Open your instance from <Link href="/home" style={{ color: 'var(--accent)' }}>Home</Link> and add them under its Channels settings.
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
