'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useOrg } from '@/lib/org-context';
import { useOrgFetch } from '@/lib/use-org-fetch';
import { useToast } from '@/components/ui/toast';
import { gatewayLabel } from '@/lib/gateway-url';
import { normalizeBrowserPairCode } from '@clawhuddle/shared';
import type { DeviceRequestList, GatewayDeviceRequest } from '@clawhuddle/shared';

const POLL_MS = 5000;

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/** "Chrome on Mac" if the client said so, else what we know of it. */
function deviceName(r: GatewayDeviceRequest): string {
  if (r.displayName) return r.displayName;
  const client = r.clientId === 'openclaw-control-ui' ? 'Control UI' : r.clientId || 'Device';
  return r.deviceFamily || r.platform ? `${client} on ${r.deviceFamily || r.platform}` : client;
}

const BROWSERS: [RegExp, string][] = [
  [/Edg(?:e|A|iOS)?\/(\d+)/, 'Edge'],
  [/OPR\/(\d+)/, 'Opera'],
  [/Firefox\/(\d+)/, 'Firefox'],
  [/HeadlessChrome\/(\d+)/, 'Headless Chrome'],
  [/(?:Chrome|CriOS)\/(\d+)/, 'Chrome'],
  [/Version\/(\d+)\S* .*Safari\//, 'Safari'],
];
const SYSTEMS: [RegExp, string][] = [
  [/Android/, 'Android'],
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Windows/, 'Windows'],
  [/Macintosh|Mac OS X/, 'Mac'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

/** "Chrome 156 on Linux" from a User-Agent; the browser said it, nobody checked it. */
function browserName(userAgent?: string): string {
  if (!userAgent) return 'A browser';
  let browser = 'A browser';
  for (const [re, name] of BROWSERS) {
    const m = userAgent.match(re);
    if (m) { browser = `${name} ${m[1]}`; break; }
  }
  const system = SYSTEMS.find(([re]) => re.test(userAgent))?.[1];
  return system ? `${browser} on ${system}` : browser;
}

const requestName = (r: GatewayDeviceRequest) => (r.kind === 'browser-code' ? browserName(r.userAgent) : deviceName(r));

function expiresIn(ms: number): string {
  const s = Math.round((ms - Date.now()) / 1000);
  if (s <= 0) return 'expired';
  return s < 90 ? `${s}s` : `${Math.round(s / 60)} min`;
}

/**
 * A browser on an instance's sign-in page showing a pairing code. It has proven
 * nothing, and approving makes it an administrator of the instance, so the page
 * never receives the code: whoever approves reads it off that browser.
 */
function BrowserCodeActions({
  busy, onApprove, onReject,
}: {
  busy: boolean;
  onApprove: (code: string) => void;
  onReject: () => void;
}) {
  const [typed, setTyped] = useState('');
  const code = normalizeBrowserPairCode(typed);
  return (
    <form
      className="mt-3 flex flex-col sm:flex-row gap-2"
      onSubmit={(e) => { e.preventDefault(); if (code && !busy) onApprove(code); }}
    >
      <input
        value={typed}
        onChange={(e) => setTyped(e.target.value.toUpperCase().slice(0, 12))}
        placeholder="ABCD-EFGH"
        aria-label="Code shown in that browser"
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        className="sm:w-40 px-3 py-2.5 sm:py-1.5 rounded-lg text-sm font-mono tracking-widest outline-none"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
      />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || !code}
          className="max-sm:flex-1 px-3 py-2.5 sm:py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
          style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
        >
          {busy ? 'Working...' : 'Approve'}
        </button>
        <button
          type="button"
          onClick={onReject}
          disabled={busy}
          className="max-sm:flex-1 px-3 py-2.5 sm:py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--red)' }}
        >
          Reject
        </button>
      </div>
    </form>
  );
}

export default function DeviceRequestsPage() {
  const { orgFetch, ready } = useOrgFetch();
  const { memberRole } = useOrg();
  const { toast } = useToast();
  const isAdmin = memberRole === 'admin' || memberRole === 'owner';

  const [requests, setRequests] = useState<GatewayDeviceRequest[]>([]);
  const [errors, setErrors] = useState<DeviceRequestList['errors']>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const fetchRequests = useCallback(async () => {
    if (!orgFetch) return;
    try {
      const res = await orgFetch<DeviceRequestList>(isAdmin ? '/device-requests' : '/me/device-requests');
      setRequests(res.data);
      setErrors(res.errors);
      setFetchError('');
    } catch (err: any) {
      setFetchError(err.message || 'Could not load device requests');
    } finally {
      setLoading(false);
    }
  }, [orgFetch, isAdmin]);

  // A request appears the moment someone opens an instance in a new browser,
  // so keep this list fresh while the page is open.
  useEffect(() => {
    fetchRequests();
    const timer = setInterval(fetchRequests, POLL_MS);
    return () => clearInterval(timer);
  }, [fetchRequests]);

  const decide = async (r: GatewayDeviceRequest, action: 'approve' | 'reject', code?: string) => {
    if (!orgFetch) return;
    setBusy(r.requestId);
    try {
      const kind = r.kind === 'browser-code' ? 'browser-pairs' : 'devices';
      await orgFetch(`/gateways/${r.gateway.id}/${kind}/${encodeURIComponent(r.requestId)}/${action}`, {
        method: 'POST',
        ...(code ? { body: JSON.stringify({ code }) } : {}),
      });
      toast(action === 'approve' ? `${requestName(r)} approved` : `${requestName(r)} rejected`, 'success');
      setRequests((prev) => prev.filter((x) => x.requestId !== r.requestId));
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setBusy(null);
    }
  };

  if (loading || !ready) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div
          className="w-8 h-8 rounded-full border-2 animate-spin"
          style={{ borderColor: 'var(--border-primary)', borderTopColor: 'var(--accent)' }}
        />
      </div>
    );
  }

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-4 py-5 md:px-6 md:py-8">
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <h1 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              Device Requests
            </h1>
            <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
              Each browser or device that opens an assistant for the first time has to be let in here.
              {isAdmin ? ' You see requests for every instance in the organization.' : ' Only you can approve devices for your instances.'}
              {' '}A browser that chose “Pair this browser” on an instance’s sign-in page is listed too; approve it by typing the code it shows.
              {' '}Hermes instances are not listed: their dashboard has a sign-in instead (shown on the instance’s card on Home).
            </p>
          </div>
          <span
            className="text-xs tabular-nums px-2 py-1 rounded-md shrink-0"
            style={{ background: 'var(--bg-secondary)', color: 'var(--text-tertiary)' }}
          >
            {requests.length} pending
          </span>
        </div>

        {fetchError && (
          <p className="text-xs mb-4" style={{ color: 'var(--red)' }}>{fetchError}</p>
        )}

        {requests.length === 0 ? (
          <div
            className="rounded-xl p-8 text-center"
            style={{ background: 'var(--bg-primary)', border: '1px dashed var(--border-primary)' }}
          >
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>No devices waiting.</p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
              Open an assistant from <Link href="/home" style={{ color: 'var(--accent)' }}>Home</Link> and its request will show up here within a few seconds.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {requests.map((r) => r.kind === 'browser-code' ? (
              <div
                key={`${r.gateway.id}:${r.requestId}`}
                className="rounded-xl p-4"
                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}
              >
                <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                  {browserName(r.userAgent)}
                  <span
                    className="ml-2 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded"
                    style={{ background: 'var(--yellow-muted)', color: 'var(--yellow)' }}
                  >
                    pairing code
                  </span>
                </p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                  is showing a code to pair with <span style={{ color: 'var(--text-secondary)' }}>{gatewayLabel(r.gateway)}</span>
                  {isAdmin && r.gateway.email && (
                    <> of <span style={{ color: 'var(--text-secondary)' }}>{r.gateway.name || r.gateway.email}</span></>
                  )}
                  {' · '}{timeAgo(r.ts)}
                </p>
                <dl className="mt-2 grid gap-x-4 gap-y-0.5 text-xs" style={{ gridTemplateColumns: 'max-content 1fr', color: 'var(--text-tertiary)' }}>
                  {r.remoteIp && (<><dt>From</dt><dd style={{ color: 'var(--text-secondary)' }}>{r.remoteIp}</dd></>)}
                  {r.browserOrigin && (<><dt>Page</dt><dd className="truncate" style={{ color: 'var(--text-secondary)' }}>{r.browserOrigin}</dd></>)}
                  <dt>Browser ID</dt><dd className="font-mono" title={r.deviceId}>{r.deviceId.slice(0, 8)}</dd>
                  {r.expiresAt ? (<><dt>Code expires</dt><dd style={{ color: 'var(--text-secondary)' }}>{expiresIn(r.expiresAt)}</dd></>) : null}
                </dl>
                <p className="text-xs mt-3" style={{ color: 'var(--text-secondary)' }}>
                  Approving gives this browser full administrator access to the instance. Anyone who can reach the sign-in page can ask,
                  and the browser name and page above are only what it reported. Approve only a browser you opened yourself,
                  by typing the code it is showing.
                </p>
                <BrowserCodeActions
                  busy={busy === r.requestId}
                  onApprove={(code) => decide(r, 'approve', code)}
                  onReject={() => decide(r, 'reject')}
                />
              </div>
            ) : (
              <div
                key={`${r.gateway.id}:${r.requestId}`}
                className="rounded-xl p-4"
                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}
              >
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                      {deviceName(r)}
                      {r.isRepair && (
                        <span
                          className="ml-2 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded"
                          style={{ background: 'var(--accent-muted)', color: 'var(--accent-text)' }}
                        >
                          re-pair
                        </span>
                      )}
                    </p>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                      wants to open <span style={{ color: 'var(--text-secondary)' }}>{gatewayLabel(r.gateway)}</span>
                      {isAdmin && r.gateway.email && (
                        <> of <span style={{ color: 'var(--text-secondary)' }}>{r.gateway.name || r.gateway.email}</span></>
                      )}
                      {' · '}{timeAgo(r.ts)}
                    </p>
                    <dl className="mt-2 grid gap-x-4 gap-y-0.5 text-xs" style={{ gridTemplateColumns: 'max-content 1fr', color: 'var(--text-tertiary)' }}>
                      {r.remoteIp && (<><dt>From</dt><dd style={{ color: 'var(--text-secondary)' }}>{r.remoteIp}</dd></>)}
                      {r.browserOrigin && (<><dt>Origin</dt><dd className="truncate" style={{ color: 'var(--text-secondary)' }}>{r.browserOrigin}</dd></>)}
                      {(r.roles?.length || r.role) && (
                        <><dt>Role</dt><dd style={{ color: 'var(--text-secondary)' }}>{(r.roles?.length ? r.roles : [r.role]).join(', ')}</dd></>
                      )}
                      {r.scopes?.length ? (<><dt>Scopes</dt><dd style={{ color: 'var(--text-secondary)' }}>{r.scopes.join(', ')}</dd></>) : null}
                      <dt>Device</dt><dd className="font-mono truncate" title={r.deviceId}>{r.deviceId.slice(0, 16)}…</dd>
                    </dl>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button
                      onClick={() => decide(r, 'reject')}
                      disabled={busy === r.requestId}
                      className="max-sm:flex-1 px-3 py-2.5 sm:py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                      style={{ background: 'var(--bg-tertiary)', color: 'var(--red)' }}
                    >
                      Reject
                    </button>
                    <button
                      onClick={() => decide(r, 'approve')}
                      disabled={busy === r.requestId}
                      className="max-sm:flex-1 px-3 py-2.5 sm:py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                      style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent-hover)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--accent)'; }}
                    >
                      {busy === r.requestId ? 'Working...' : 'Approve'}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {errors.length > 0 && (
          <p className="text-xs mt-4" style={{ color: 'var(--text-tertiary)' }}>
            Could not read {errors.length} running instance{errors.length === 1 ? '' : 's'}: {errors.map((e) => e.message).join('; ')}
          </p>
        )}
      </div>
    </main>
  );
}
