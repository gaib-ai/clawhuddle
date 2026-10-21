import { getSession } from 'next-auth/react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';

// Bearer token for the API, minted by NextAuth's jwt callback and carried on the
// session. Kept here so every apiFetch call can attach it without each caller
// threading the session through.
let apiToken: string | null = null;
let sessionRefresh: Promise<string | null> | null = null;

export function setApiToken(token: string | null | undefined) {
  apiToken = token ?? null;
}

// Re-read the session (the jwt callback re-mints the token when it's near expiry);
// concurrent callers share one request.
function refreshApiToken(): Promise<string | null> {
  if (!sessionRefresh) {
    sessionRefresh = getSession()
      .then((session) => {
        apiToken = session?.apiToken ?? null;
        return apiToken;
      })
      .catch(() => null)
      .finally(() => {
        sessionRefresh = null;
      });
  }
  return sessionRefresh;
}

async function send(path: string, options: RequestInit | undefined, token: string | null): Promise<Response> {
  const headers: Record<string, string> = { ...options?.headers as Record<string, string> };
  if (options?.body) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });
}

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const token = apiToken ?? (await refreshApiToken());
  let res = await send(path, options, token);

  // Token expired (e.g. a tab left open) — pick up a fresh one and retry once
  if (res.status === 401) {
    const fresh = await refreshApiToken();
    if (fresh && fresh !== token) {
      res = await send(path, options, fresh);
    }
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    const error = new Error(err.message || 'API request failed') as Error & { code?: string; data?: any };
    error.code = err.error;
    error.data = err;
    throw error;
  }

  return res.json();
}

// Org-scoped fetch helper — prepends /api/orgs/{orgId}
export function createOrgFetch(orgId: string) {
  return function orgFetch<T>(path: string, options?: RequestInit): Promise<T> {
    return apiFetch<T>(`/api/orgs/${orgId}${path}`, options);
  };
}
