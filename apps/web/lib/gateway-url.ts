import { DASHBOARD_OPEN_PATH, RUNTIME_FEATURES, type GatewayRuntime } from '@clawhuddle/shared';

/**
 * Web UI address of an instance, or null when it cannot be opened yet. Accepts
 * both an instance row (`token`/`subdomain`/`port`) and the admin access
 * response (`gateway_token`/…). Local dev publishes a random host port instead
 * of a subdomain, so localhost links go straight to it.
 *
 * An OpenClaw link carries the instance token. A Hermes dashboard has a
 * sign-in page instead, so its link goes to the platform's sign-in helper on
 * the instance's own address, with the login (see `gatewayLogin`) in the URL
 * fragment: the browser keeps a fragment to itself, and the helper drops it
 * from the address before signing in. Local dev has no such helper (it is a
 * Traefik route), so the link is the bare address and the login is typed.
 */
export interface GatewayAccess {
  runtime?: GatewayRuntime | null;
  token?: string | null;
  subdomain?: string | null;
  port?: number | null;
  gateway_token?: string | null;
  gateway_subdomain?: string | null;
  gateway_port?: number | null;
  dashboard_username?: string | null;
}

export function gatewayUrl(g: GatewayAccess): string | null {
  const token = g.token ?? g.gateway_token;
  const subdomain = g.subdomain ?? g.gateway_subdomain;
  const port = g.port ?? g.gateway_port;
  const tokenLink = RUNTIME_FEATURES[g.runtime ?? 'openclaw'].tokenLink;
  if (tokenLink && !token) return null;
  const query = tokenLink ? `?token=${token}` : '';
  const { protocol, hostname } = window.location;
  if (hostname === 'localhost' && port) {
    return `http://localhost:${port}/${query}`;
  }
  if (subdomain) {
    const gwDomain = process.env.NEXT_PUBLIC_GATEWAY_DOMAIN || hostname;
    const origin = `${protocol}//${subdomain}.${gwDomain}`;
    const login = gatewayLogin(g);
    if (!login) return `${origin}/${query}`;
    const fragment = new URLSearchParams({ u: login.username, p: login.password });
    return `${origin}${DASHBOARD_OPEN_PATH}#${fragment}`;
  }
  return null;
}

/** Username and password for an instance whose web UI has a sign-in page; null for token-link runtimes. */
export function gatewayLogin(g: GatewayAccess): { username: string; password: string } | null {
  if (RUNTIME_FEATURES[g.runtime ?? 'openclaw'].tokenLink) return null;
  const username = g.dashboard_username ?? g.subdomain ?? g.gateway_subdomain;
  const password = g.token ?? g.gateway_token;
  return username && password ? { username, password } : null;
}

/** "Instance 2" for an unlabelled slot. */
export function gatewayLabel(g: { label?: string | null; slot: number }): string {
  return g.label || `Instance ${g.slot}`;
}
