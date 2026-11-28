import Docker from "dockerode";
import { DASHBOARD_OPEN_PATH } from "@clawhuddle/shared";

/**
 * Docker plumbing shared by every instance runtime (OpenClaw in gateway.ts,
 * Hermes in hermes.ts): the client, the instance network, Traefik labels and
 * exec. Nothing here knows what runs inside the container.
 */
export const docker = new Docker();

// Instances run agent-controlled code, so they get a network of their own shared
// only with what they must reach (Traefik, claw-proxy) — never the API or web.
export const GATEWAY_NETWORK = process.env.GATEWAY_NETWORK || "clawhuddle-gateways";
export const DOMAIN = process.env.DOMAIN || "localhost";
export const GATEWAY_DOMAIN = process.env.GATEWAY_DOMAIN || DOMAIN;
export const IS_LOCAL_DEV = DOMAIN === "localhost";
/** The API's own Traefik service, as named by its labels in docker-compose.yml. */
const API_TRAEFIK_SERVICE = process.env.API_TRAEFIK_SERVICE || "api@docker";

export async function ensureNetwork(): Promise<void> {
  try {
    await docker.getNetwork(GATEWAY_NETWORK).inspect();
  } catch {
    await docker.createNetwork({ Name: GATEWAY_NETWORK, Driver: "bridge" });
  }
}

/**
 * IPv4 subnets of the gateway network: where Traefik's requests to an instance
 * come from. Empty when the network cannot be read.
 */
export async function gatewayNetworkSubnets(): Promise<string[]> {
  try {
    const info = await docker.getNetwork(GATEWAY_NETWORK).inspect();
    const subnets: unknown[] = (info?.IPAM?.Config ?? []).map((c: any) => c?.Subnet);
    return subnets.filter(
      (s): s is string => typeof s === "string" && /^\d{1,3}(\.\d{1,3}){3}\/(?:[89]|[12]\d|3[0-2])$/.test(s),
    );
  } catch {
    return [];
  }
}

/**
 * Routes `<subdomain>.<GATEWAY_DOMAIN>` to `port` in the container. For
 * OpenClaw that is the socat port (0.0.0.0:6101 → the loopback gateway port),
 * for Hermes the dashboard port.
 */
export function createTraefikLabels(
  containerName: string,
  subdomain: string,
  port: number,
  options: { openPage?: boolean } = {},
): Record<string, string> {
  // One path on the instance's host goes to the API instead of the container:
  // the one-click sign-in page (`routes/dashboard-open.ts`). The rule is longer
  // than the host-only one, so Traefik prefers it.
  const openPage: Record<string, string> = options.openPage
    ? {
        [`traefik.http.routers.${containerName}.service`]: containerName,
        [`traefik.http.routers.${containerName}-open.rule`]:
          `Host(\`${subdomain}.${GATEWAY_DOMAIN}\`) && Path(\`${DASHBOARD_OPEN_PATH}\`)`,
        [`traefik.http.routers.${containerName}-open.entrypoints`]: "web",
        [`traefik.http.routers.${containerName}-open.service`]: API_TRAEFIK_SERVICE,
      }
    : {};
  return {
    ...openPage,
    "traefik.enable": "true",
    // Traefik is on both networks; reach the instance over the gateway network
    "traefik.docker.network": GATEWAY_NETWORK,
    [`traefik.http.routers.${containerName}.rule`]: `Host(\`${subdomain}.${GATEWAY_DOMAIN}\`)`,
    [`traefik.http.routers.${containerName}.entrypoints`]: "web",
    [`traefik.http.services.${containerName}.loadbalancer.server.port`]: String(port),
    // Forward real client attribution. OpenClaw 2026.8+ rejects proxied requests whose
    // forwarded client IP resolves to loopback (proxy_attribution_required), so the old
    // trick of spoofing X-Forwarded-For: 127.0.0.1 to look local no longer works —
    // Traefik's own appended X-Forwarded-For plus gateway.trustedProxies (which includes
    // the Cloudflare ranges) attributes the request to the real client instead.
    // Strip Cloudflare pseudo-headers; attribution comes from X-Forwarded-For alone
    [`traefik.http.middlewares.${containerName}-headers.headers.customrequestheaders.CF-Connecting-IP`]:
      "",
    [`traefik.http.middlewares.${containerName}-headers.headers.customrequestheaders.True-Client-IP`]:
      "",
    [`traefik.http.middlewares.${containerName}-headers.headers.customrequestheaders.CF-IPCountry`]:
      "",
    [`traefik.http.middlewares.${containerName}-headers.headers.customrequestheaders.CF-Ray`]:
      "",
    [`traefik.http.middlewares.${containerName}-headers.headers.customrequestheaders.CF-Visitor`]:
      "",
    [`traefik.http.routers.${containerName}.middlewares`]: `${containerName}-headers`,
  };
}

export async function removeContainer(containerName: string): Promise<void> {
  try {
    const existing = docker.getContainer(containerName);
    await existing.stop().catch(() => {});
    await existing.remove();
  } catch {
    // Container doesn't exist, that's fine
  }
}

/**
 * Split a docker attach/exec stream into stdout and stderr. Without a TTY the
 * daemon multiplexes both into 8-byte-header frames (type, 3 zero bytes,
 * big-endian length); anything that doesn't parse as frames is passed through
 * as stdout so a plain stream still works.
 */
export function demuxDockerStream(raw: Buffer): { stdout: string; stderr: string } {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= raw.length) {
    const type = raw[offset];
    const zeros = raw[offset + 1] === 0 && raw[offset + 2] === 0 && raw[offset + 3] === 0;
    const size = raw.readUInt32BE(offset + 4);
    if (!zeros || type > 2 || offset + 8 + size > raw.length) {
      return { stdout: raw.toString("utf-8"), stderr: "" };
    }
    (type === 2 ? err : out).push(raw.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  if (offset !== raw.length) return { stdout: raw.toString("utf-8"), stderr: "" };
  return { stdout: Buffer.concat(out).toString("utf-8"), stderr: Buffer.concat(err).toString("utf-8") };
}

/**
 * Run a command inside an instance's container and return its stdout.
 * `user` runs it as that account instead of the image's default (Hermes keeps
 * its state under the `hermes` user; a root-run CLI would leave root-owned files).
 */
export async function execInContainer(
  containerName: string,
  cmd: string[],
  timeoutMs = 10000,
  opts: { user?: string } = {},
): Promise<string> {
  const container = docker.getContainer(containerName);
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    ...(opts.user ? { User: opts.user } : {}),
  });
  const stream = await exec.start({});
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", async () => {
      try {
        const info = await exec.inspect();
        const { stdout, stderr } = demuxDockerStream(Buffer.concat(chunks));
        if (info.ExitCode !== 0) {
          reject(new Error(stderr.trim() || stdout.trim() || `Exit code ${info.ExitCode}`));
        } else {
          resolve(stdout);
        }
      } catch (err) {
        reject(err);
      }
    });
    stream.on("error", reject);
    setTimeout(() => reject(new Error("exec timeout")), timeoutMs).unref();
  });
}
