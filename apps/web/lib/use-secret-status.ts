'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SecretStatusEntry } from '@clawhuddle/shared';

type OrgFetch = (<T>(path: string, options?: RequestInit) => Promise<T>) | null;

/**
 * Per-instance state of the secret-kind keys (Notion) from
 * `…/api-keys/secret-status`. Injection happens in the background once an
 * instance is running, so while any running instance still shows `pending`
 * the list is refetched every 10 s until it settles.
 */
export function useSecretStatus(orgFetch: OrgFetch, path: string) {
  const [status, setStatus] = useState<SecretStatusEntry[]>([]);

  const reload = useCallback(async () => {
    if (!orgFetch) return;
    try {
      const res = await orgFetch<{ data: SecretStatusEntry[] }>(path);
      setStatus(res.data);
    } catch {
      // non-fatal — the card just shows no per-instance list
    }
  }, [orgFetch, path]);

  useEffect(() => { void reload(); }, [reload]);

  const settling = status.some((e) => e.status === 'running' && Object.values(e.secrets).includes('pending'));
  useEffect(() => {
    if (!settling) return;
    const id = setInterval(() => { void reload(); }, 10000);
    return () => clearInterval(id);
  }, [settling, reload]);

  return { secretStatus: status, reloadSecretStatus: reload };
}
