import fs from "node:fs";
import path from "node:path";
import { getDb } from "../db/index.js";
import { getContainerName, type GatewayRef } from "./gateway-store.js";

const DOMAIN = process.env.DOMAIN || "localhost";
const GATEWAY_DOMAIN = process.env.GATEWAY_DOMAIN || DOMAIN;

export interface PortForward {
  id: string;
  org_id: string;
  member_id: string;
  /** Instance the forward targets. Null only on rows from before instances existed (= the member's slot 1). */
  gateway_id: string | null;
  subdomain: string;
  port: number;
  description: string | null;
  created_at: string;
}

function getTraefikDynamicDir(): string {
  const dataDir = process.env.DATA_DIR || path.resolve("./data");
  return path.join(dataDir, "traefik-dynamic");
}

function getConfigPath(id: string): string {
  return path.join(getTraefikDynamicDir(), `pf-${id}.yml`);
}

export function portForwardHostname(subdomain: string): string {
  return `${subdomain}.${GATEWAY_DOMAIN}`;
}

/**
 * Why a forward may not use this subdomain, or null if it may. A forward's
 * router outranks the frontend's catch-all, so one on the app's own hostname
 * would take over the login page; `claw-` is the prefix gateways are given.
 */
export function reservedSubdomainReason(subdomain: string): string | null {
  if (portForwardHostname(subdomain) === DOMAIN) return "Subdomain is the app's own hostname";
  if (subdomain.startsWith("claw-")) return 'Subdomains starting with "claw-" are reserved for gateways';
  return null;
}

function targetGateway(pf: PortForward): GatewayRef {
  const db = getDb();
  const row = (pf.gateway_id
    ? db
        .prepare(
          `SELECT g.org_id, g.slot, om.user_id FROM gateways g JOIN org_members om ON om.id = g.member_id
           WHERE g.id = ? AND g.org_id = ?`,
        )
        .get(pf.gateway_id, pf.org_id)
    : db
        .prepare(
          `SELECT g.org_id, g.slot, om.user_id FROM gateways g JOIN org_members om ON om.id = g.member_id
           WHERE g.member_id = ? AND g.org_id = ? AND g.slot = 1`,
        )
        .get(pf.member_id, pf.org_id)) as GatewayRef | undefined;
  if (!row) throw new Error("Gateway not found");
  return row;
}

// Writes a traefik file-provider config routing Host(`<subdomain>.<GATEWAY_DOMAIN>`)
// to a port inside one gateway container. The container name is stable across
// redeploys (derived from org/user id prefixes and the instance slot), so the
// file survives platform redeploys — the forwarded service must listen on
// 0.0.0.0:<port>.
//
// The body is emitted as JSON (valid YAML) via JSON.stringify, never by string
// interpolation: Traefik watches this directory, so any user-controlled text that
// could break out of a value would let a caller rewrite routing for the whole
// platform. The description is deliberately left out of the file.
export function writePortForwardConfig(pf: PortForward): void {
  const target = targetGateway(pf);
  const containerName = getContainerName(target.org_id, target.user_id, target.slot);
  const routerName = `pf-${pf.id}`;
  const config = {
    http: {
      routers: {
        [routerName]: {
          rule: `Host(\`${portForwardHostname(pf.subdomain)}\`)`,
          entryPoints: ["web"],
          service: routerName,
        },
      },
      services: {
        [routerName]: {
          loadBalancer: {
            servers: [{ url: `http://${containerName}:${pf.port}` }],
          },
        },
      },
    },
  };
  const body = `# Managed by ClawHuddle — port forward ${pf.id}. Do not edit.\n${JSON.stringify(config, null, 2)}\n`;

  fs.mkdirSync(getTraefikDynamicDir(), { recursive: true });
  fs.writeFileSync(getConfigPath(pf.id), body);
}

export function removePortForwardConfig(id: string): void {
  fs.rmSync(getConfigPath(id), { force: true });
}

// A gateway's forwards go with it. The DB cascade would drop the rows anyway,
// but cannot remove the Traefik files, so this runs before the row is deleted.
export function removePortForwardsForGateway(gatewayId: string): void {
  const db = getDb();
  const rows = db.prepare("SELECT id FROM port_forwards WHERE gateway_id = ?").all(gatewayId) as { id: string }[];
  for (const { id } of rows) removePortForwardConfig(id);
  db.prepare("DELETE FROM port_forwards WHERE gateway_id = ?").run(gatewayId);
}

export function removePortForwardsForOrg(orgId: string): void {
  const db = getDb();
  const rows = db.prepare("SELECT id FROM port_forwards WHERE org_id = ?").all(orgId) as { id: string }[];
  for (const { id } of rows) removePortForwardConfig(id);
  db.prepare("DELETE FROM port_forwards WHERE org_id = ?").run(orgId);
}

// Rewrite config files for every stored port forward (e.g. on API startup),
// so routes recover if the traefik-dynamic dir is wiped or a file was hand-deleted.
export function syncAllPortForwards(): void {
  const db = getDb();
  let rows: PortForward[];
  try {
    rows = db.prepare("SELECT * FROM port_forwards").all() as PortForward[];
  } catch {
    // Table doesn't exist yet (migrations not run) — nothing to sync
    return;
  }
  for (const pf of rows) {
    try {
      writePortForwardConfig(pf);
    } catch (err: any) {
      console.error(`Failed to sync port forward ${pf.id}: ${err.message}`);
    }
  }
}
