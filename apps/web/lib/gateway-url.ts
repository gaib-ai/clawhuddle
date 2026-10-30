/**
 * Control UI URL for a gateway instance, or null without a token. Accepts both
 * an instance row (`token`/`subdomain`/`port`) and the admin access response
 * (`gateway_token`/…). Local dev publishes a random host port instead of a
 * subdomain, so localhost links go straight to it.
 */
export interface GatewayAccess {
  token?: string | null;
  subdomain?: string | null;
  port?: number | null;
  gateway_token?: string | null;
  gateway_subdomain?: string | null;
  gateway_port?: number | null;
}

export function gatewayUrl(g: GatewayAccess): string | null {
  const token = g.token ?? g.gateway_token;
  const subdomain = g.subdomain ?? g.gateway_subdomain;
  const port = g.port ?? g.gateway_port;
  if (!token) return null;
  const { protocol, hostname } = window.location;
  if (hostname === 'localhost' && port) {
    return `http://localhost:${port}/?token=${token}`;
  }
  if (subdomain) {
    const gwDomain = process.env.NEXT_PUBLIC_GATEWAY_DOMAIN || hostname;
    return `${protocol}//${subdomain}.${gwDomain}/?token=${token}`;
  }
  return null;
}

/** "Instance 2" for an unlabelled slot. */
export function gatewayLabel(g: { label?: string | null; slot: number }): string {
  return g.label || `Instance ${g.slot}`;
}
