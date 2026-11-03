'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';

type OrgFetch = <T>(path: string, options?: RequestInit) => Promise<T>;

type Readiness = 'ready' | 'pending' | 'restart' | 'no-client' | 'keyring';
interface GoogleInfo {
  readiness: Readiness;
  accounts: { email: string; services: string[] }[];
}

/**
 * Google sign-in for the instance's gog CLI (Gmail, Calendar, Drive …). gog's
 * client is a Desktop OAuth client, so Google can only send the browser back to
 * a loopback address that does not load; the member copies that address here
 * and the API finishes the sign-in inside the instance.
 */
export function GoogleConnect({ gatewayId, orgFetch }: { gatewayId: string; orgFetch: OrgFetch }) {
  const { data: session } = useSession();
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [info, setInfo] = useState<GoogleInfo | null>(null);
  const [step, setStep] = useState<'idle' | 'email' | 'paste'>('idle');
  const [email, setEmail] = useState('');
  const [redirect, setRedirect] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const base = `/gateways/${gatewayId}/google`;

  const load = useCallback(async () => {
    try {
      const res = await orgFetch<{ data: GoogleInfo }>(base);
      setInfo(res.data);
    } catch {
      setInfo(null);
    }
  }, [orgFetch, base]);

  useEffect(() => { void load(); }, [load]);

  // The client is being installed right now; check again shortly.
  useEffect(() => {
    if (info?.readiness !== 'pending') return;
    const id = setInterval(() => { void load(); }, 10000);
    return () => clearInterval(id);
  }, [info?.readiness, load]);

  if (!info || info.readiness === 'no-client') return null;

  const begin = () => {
    setEmail(session?.user?.email ?? '');
    setRedirect('');
    setError('');
    setStep('email');
  };

  const openGoogle = async () => {
    // Open the tab inside the click so popup blockers allow it, then point it at Google.
    const tab = window.open('', '_blank');
    setBusy(true);
    setError('');
    try {
      const res = await orgFetch<{ data: { authUrl: string } }>(`${base}/start`, {
        method: 'POST',
        body: JSON.stringify({ email: email.trim() }),
      });
      if (tab) {
        tab.opener = null;
        tab.location.href = res.data.authUrl;
      } else {
        window.open(res.data.authUrl, '_blank', 'noopener');
      }
      setStep('paste');
    } catch (err: any) {
      tab?.close();
      setError(err.message || 'Could not start Google sign-in');
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await orgFetch<{ data: GoogleInfo }>(`${base}/finish`, {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), url: redirect.trim() }),
      });
      setInfo(res.data);
      setStep('idle');
      toast(`${email.trim()} connected. Your assistant can use it right away.`, 'success');
    } catch (err: any) {
      setError(err.message || 'Could not finish Google sign-in');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (account: string) => {
    const ok = await confirm({
      title: 'Disconnect Google account',
      description: `Remove ${account} from this instance? Your assistant loses access to its Gmail, Calendar and Drive until you connect it again.`,
      confirmLabel: 'Disconnect',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await orgFetch<{ data: GoogleInfo }>(`${base}/accounts/${encodeURIComponent(account)}`, { method: 'DELETE' });
      setInfo(res.data);
      toast(`${account} disconnected`, 'success');
    } catch (err: any) {
      toast(err.message || 'Could not disconnect', 'error');
    } finally {
      setBusy(false);
    }
  };

  const muted = { color: 'var(--text-tertiary)' };
  const input = {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-primary)',
    color: 'var(--text-primary)',
  };
  const smallBtn = (label: string, onClick: () => void, disabled = false, primary = false) => (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50 shrink-0"
      style={primary
        ? { background: 'var(--accent)', color: 'var(--text-inverse)' }
        : { background: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border-primary)' }}
    >
      {label}
    </button>
  );

  return (
    <div className="mt-4 pt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs" style={muted}>Google account</span>
        {info.readiness === 'ready' && step === 'idle' && smallBtn(info.accounts.length ? 'Connect another' : 'Connect Google', begin, false, !info.accounts.length)}
      </div>

      {info.readiness === 'restart' && (
        <p className="text-[11px] mt-1" style={muted}>
          Restart this instance to turn on Google sign-in (Gmail, Calendar, Drive, Docs).
        </p>
      )}
      {info.readiness === 'pending' && (
        <p className="text-[11px] mt-1" style={muted}>Setting up Google sign-in…</p>
      )}
      {info.readiness === 'keyring' && (
        <p className="text-[11px] mt-1" style={muted}>
          This instance has its own gog setup without a keyring password, so it cannot store a sign-in. Ask an admin to finish it.
        </p>
      )}

      {info.readiness === 'ready' && info.accounts.length > 0 && (
        <div className="mt-2 space-y-1">
          {info.accounts.map((a) => (
            <div key={a.email} className="flex items-center justify-between gap-3 text-xs">
              <span className="truncate" style={{ color: 'var(--text-secondary)' }}>
                {a.email}
                <span style={muted}> · {a.services.join(', ')}</span>
              </span>
              <button
                onClick={() => disconnect(a.email)}
                disabled={busy}
                className="text-[11px] disabled:opacity-50 shrink-0"
                style={{ color: 'var(--text-tertiary)' }}
                onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--red)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-tertiary)'; }}
              >
                Disconnect
              </button>
            </div>
          ))}
        </div>
      )}

      {step === 'email' && (
        <div className="mt-2">
          <p className="text-[11px] mb-2" style={muted}>
            Which Google account should your assistant use? Sign in to Google with the same account in the next tab.
          </p>
          <div className="flex gap-2">
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && email.trim()) void openGoogle(); }}
              type="email"
              placeholder="you@company.com"
              className="flex-1 px-2 py-1.5 text-xs rounded-md"
              style={input}
            />
            {smallBtn('Open Google sign-in', openGoogle, !email.trim(), true)}
            {smallBtn('Cancel', () => setStep('idle'))}
          </div>
        </div>
      )}

      {step === 'paste' && (
        <div className="mt-2">
          <p className="text-[11px] mb-2" style={muted}>
            Approve access in the Google tab. It then ends on a page that won’t load
            (“This site can’t be reached”, address starting with <code>http://127.0.0.1</code>).
            That is expected: copy that tab’s full address and paste it here, then close the tab.
          </p>
          <div className="flex gap-2">
            <input
              value={redirect}
              onChange={(e) => setRedirect(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && redirect.trim()) void finish(); }}
              placeholder="http://127.0.0.1:…/oauth2/callback?state=…&code=…"
              className="flex-1 px-2 py-1.5 text-xs font-mono rounded-md"
              style={input}
            />
            {smallBtn('Finish', finish, !redirect.trim(), true)}
            {smallBtn('Cancel', () => setStep('idle'))}
          </div>
        </div>
      )}

      {error && <p className="text-[11px] mt-2" style={{ color: 'var(--red)' }}>{error}</p>}
    </div>
  );
}
