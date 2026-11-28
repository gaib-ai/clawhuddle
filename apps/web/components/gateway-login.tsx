'use client';

import { useState } from 'react';

/**
 * Sign-in for an instance whose web UI asks for one (Hermes dashboard). The
 * password stays masked until asked for; both values copy with one click.
 */
export function GatewayLogin({ username, password }: { username: string; password: string }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (what: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      setTimeout(() => setCopied((c) => (c === what ? null : c)), 1500);
    } catch {
      // Clipboard blocked (http, permissions): reveal it so it can be selected by hand.
      if (what === 'password') setShown(true);
    }
  };

  const link = (label: string, onClick: () => void) => (
    <button
      onClick={onClick}
      className="py-1.5 sm:py-0 text-[11px] font-medium shrink-0"
      style={{ color: 'var(--accent)' }}
    >
      {label}
    </button>
  );
  const row = (label: string, what: string, value: string, display: string, extra?: React.ReactNode) => (
    <div className="flex items-center gap-3 text-xs">
      <span className="w-16 shrink-0" style={{ color: 'var(--text-tertiary)' }}>{label}</span>
      <code className="flex-1 min-w-0 truncate" style={{ color: 'var(--text-secondary)' }}>{display}</code>
      {extra}
      {link(copied === what ? 'Copied' : 'Copy', () => copy(what, value))}
    </div>
  );

  return (
    <div
      className="mt-3 rounded-lg px-3 py-2 space-y-1"
      style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}
    >
      {row('Username', 'username', username, username)}
      {row('Password', 'password', password, shown ? password : '•'.repeat(16), link(shown ? 'Hide' : 'Show', () => setShown((s) => !s)))}
    </div>
  );
}
