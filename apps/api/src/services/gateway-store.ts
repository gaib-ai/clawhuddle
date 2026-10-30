import crypto from "node:crypto";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";
import { DEFAULT_MAX_GATEWAYS_PER_USER } from "@clawhuddle/shared";
import type { GatewayStatus } from "@clawhuddle/shared";
import type { ChannelTokens } from "./openclaw-config.js";

/**
 * Gateway rows, naming and limits — everything about an instance that does not
 * need Docker. gateway.ts (containers, files) and port-forward.ts build on it.
 *
 * A member may own several instances, numbered by `slot`. Slot 1 keeps the
 * names from before instances existed (container clawhuddle-gw-<org8>-<user8>,
 * data dir <orgId>/<userId>) so the gateways already running were not touched
 * by the change; slot N>=2 adds a "-N" suffix to both.
 */

export const CONTAINER_PREFIX = "clawhuddle-gw-";
// OpenClaw listens on loopback:6100 inside every container
export const GATEWAY_INTERNAL_PORT = 6100;

export interface GatewayRow {
  id: string;
  org_id: string;
  member_id: string;
  slot: number;
  label: string | null;
  status: GatewayStatus | null;
  port: number | null;
  token: string;
  subdomain: string;
  primary_provider: string | null;
  primary_model: string | null;
  slack_access_migrated_at: string | null;
  created_at: string;
  // joined from org_members
  user_id: string;
  member_role: string;
}

/** What naming needs: enough to locate an instance on disk and in Docker. */
export type GatewayRef = Pick<GatewayRow, "org_id" | "user_id" | "slot">;

export class GatewayLimitError extends Error {
  code = "gateway_limit" as const;
  constructor(public limit: number, public current: number) {
    super(`Gateway limit reached (${current}/${limit}). Ask an admin to raise it.`);
  }
}

// --- naming -----------------------------------------------------------------

export function getDataDir(): string {
  return process.env.DATA_DIR || path.resolve("./data");
}

// Host path for Docker bind mounts — must be an absolute path on the HOST machine.
// In Docker Compose this is set to ${PWD}/data automatically.
// For local dev (no container), falls back to getDataDir() which is already on the host.
export function getHostDataDir(): string {
  const dir = process.env.HOST_DATA_DIR || getDataDir();
  if (!path.isAbsolute(dir)) {
    throw new Error(
      `HOST_DATA_DIR must be an absolute path (got "${dir}"). Set it in .env or docker-compose.yml.`,
    );
  }
  return dir;
}

export function gatewayDirName(userId: string, slot: number): string {
  return slot === 1 ? userId : `${userId}-${slot}`;
}

export function getGatewayDir(ref: GatewayRef): string {
  return path.join(getDataDir(), "gateways", ref.org_id, gatewayDirName(ref.user_id, ref.slot));
}

export function getHostGatewayDir(ref: GatewayRef): string {
  return path.join(getHostDataDir(), "gateways", ref.org_id, gatewayDirName(ref.user_id, ref.slot));
}

export function getContainerName(orgId: string, userId: string, slot = 1): string {
  // Keep under 63 chars for Docker DNS resolution (this is at most 34)
  const base = `${CONTAINER_PREFIX}${orgId.slice(0, 8)}-${userId.slice(0, 8)}`;
  return slot === 1 ? base : `${base}-${slot}`;
}

export function containerNameFor(ref: GatewayRef): string {
  return getContainerName(ref.org_id, ref.user_id, ref.slot);
}

// Gateway subdomain: "claw-{hex}" under parent domain
export function generateSubdomain(): string {
  return `claw-${crypto.randomBytes(4).toString("hex")}`;
}

// --- rows -------------------------------------------------------------------

const SELECT_ROW = `SELECT g.*, om.user_id, om.role AS member_role
  FROM gateways g JOIN org_members om ON om.id = g.member_id`;

export function findGatewayRow(orgId: string, gatewayId: string): GatewayRow | undefined {
  return getDb()
    .prepare(`${SELECT_ROW} WHERE g.id = ? AND g.org_id = ?`)
    .get(gatewayId, orgId) as GatewayRow | undefined;
}

export function getGatewayRow(orgId: string, gatewayId: string): GatewayRow {
  const row = findGatewayRow(orgId, gatewayId);
  if (!row) throw new Error("Gateway not found");
  return row;
}

export function listMemberGateways(memberId: string): GatewayRow[] {
  return getDb()
    .prepare(`${SELECT_ROW} WHERE g.member_id = ? ORDER BY g.slot`)
    .all(memberId) as GatewayRow[];
}

export function listUserGateways(orgId: string, userId: string): GatewayRow[] {
  return getDb()
    .prepare(`${SELECT_ROW} WHERE g.org_id = ? AND om.user_id = ? ORDER BY g.slot`)
    .all(orgId, userId) as GatewayRow[];
}

export function listOrgGateways(orgId: string): GatewayRow[] {
  return getDb()
    .prepare(`${SELECT_ROW} WHERE g.org_id = ? ORDER BY om.joined_at, g.slot`)
    .all(orgId) as GatewayRow[];
}

/** The row without its bearer token, for responses that are not the owner's. */
export function summarizeGateway<T extends { token?: string | null }>(row: T): Omit<T, "token"> {
  const { token: _token, ...rest } = row;
  return rest;
}

// --- limits -----------------------------------------------------------------

export function platformGatewayLimit(): number {
  return Number(process.env.MAX_GATEWAYS_PER_USER) || DEFAULT_MAX_GATEWAYS_PER_USER;
}

/** Member override, else org setting, else platform default; plus how many exist. */
export function effectiveGatewayLimit(orgId: string, memberId: string): { limit: number; current: number } {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(om.max_gateways, o.max_gateways_per_user, ?) AS "limit",
              (SELECT COUNT(*) FROM gateways g WHERE g.member_id = om.id) AS current
       FROM org_members om JOIN organizations o ON o.id = om.org_id
       WHERE om.id = ? AND om.org_id = ?`,
    )
    .get(platformGatewayLimit(), memberId, orgId) as { limit: number; current: number } | undefined;
  if (!row) throw new Error("Member not found");
  return row;
}

export function assertCanCreateGateway(orgId: string, memberId: string): void {
  const { limit, current } = effectiveGatewayLimit(orgId, memberId);
  if (current >= limit) throw new GatewayLimitError(limit, current);
}

// --- writes (all go through here so the slot-1 mirror stays right) ----------

// org_members.gateway_* mirror the slot-1 row so an older build still finds the
// first instance after a rollback. NULLed when slot 1 is gone.
function mirrorSlot1(memberId: string): void {
  const db = getDb();
  const first = db
    .prepare("SELECT status, port, token, subdomain FROM gateways WHERE member_id = ? AND slot = 1")
    .get(memberId) as { status: string | null; port: number | null; token: string; subdomain: string } | undefined;
  db.prepare(
    "UPDATE org_members SET gateway_status = ?, gateway_port = ?, gateway_token = ?, gateway_subdomain = ? WHERE id = ?",
  ).run(first?.status ?? null, first?.port ?? null, first?.token ?? null, first?.subdomain ?? null, memberId);
}

/**
 * Inserts the next instance for a member, or throws GatewayLimitError. Check
 * and insert share one synchronous transaction, so two requests racing for the
 * last slot cannot both win.
 */
export function createGatewayRow(orgId: string, memberId: string, opts: { label?: string | null } = {}): GatewayRow {
  const db = getDb();
  const insert = db.transaction(() => {
    assertCanCreateGateway(orgId, memberId);
    const taken = new Set(
      (db.prepare("SELECT slot FROM gateways WHERE member_id = ?").all(memberId) as { slot: number }[]).map((r) => r.slot),
    );
    let slot = 1;
    while (taken.has(slot)) slot++;

    const id = uuid();
    db.prepare(
      `INSERT INTO gateways (id, org_id, member_id, slot, label, status, port, token, subdomain)
       VALUES (?, ?, ?, ?, ?, 'provisioning', ?, ?, ?)`,
    ).run(
      id, orgId, memberId, slot, opts.label ?? null,
      GATEWAY_INTERNAL_PORT, crypto.randomBytes(24).toString("hex"), generateSubdomain(),
    );
    // A fresh config already has the locked-down Slack defaults, so there is nothing to migrate.
    markSlackAccessMigrated(id);
    mirrorSlot1(memberId);
    return id;
  });
  return getGatewayRow(orgId, insert());
}

export function setGatewayState(
  gatewayId: string,
  patch: Partial<Pick<GatewayRow, "status" | "port" | "label" | "primary_provider" | "primary_model">>,
): void {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const key of ["status", "port", "label", "primary_provider", "primary_model"] as const) {
    if (key in patch) {
      sets.push(`${key} = ?`);
      values.push(patch[key] ?? null);
    }
  }
  if (sets.length === 0) return;
  values.push(gatewayId);
  db.prepare(`UPDATE gateways SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  const row = db.prepare("SELECT member_id FROM gateways WHERE id = ?").get(gatewayId) as { member_id: string } | undefined;
  if (row) mirrorSlot1(row.member_id);
}

export function deleteGatewayRow(gatewayId: string): void {
  const db = getDb();
  const row = db.prepare("SELECT member_id FROM gateways WHERE id = ?").get(gatewayId) as { member_id: string } | undefined;
  if (!row) return;
  db.prepare("DELETE FROM gateways WHERE id = ?").run(gatewayId);
  mirrorSlot1(row.member_id);
}

// The legacy-open Slack lockdown in mergeOpenClawConfig runs once per gateway:
// after its first merge the Slack block is the member's, even if they later set
// it back to exactly the old platform default.
export function slackAccessMigrated(gatewayId: string): boolean {
  const row = getDb()
    .prepare("SELECT slack_access_migrated_at FROM gateways WHERE id = ?")
    .get(gatewayId) as { slack_access_migrated_at: string | null } | undefined;
  return !!row?.slack_access_migrated_at;
}

export function markSlackAccessMigrated(gatewayId: string): void {
  getDb()
    .prepare(
      "UPDATE gateways SET slack_access_migrated_at = COALESCE(slack_access_migrated_at, datetime('now')) WHERE id = ?",
    )
    .run(gatewayId);
}

// --- per-instance settings --------------------------------------------------

// Instance pin wins, then the member's personal one, then the org default.
/**
 * What the primary model of an instance is pinned to, most specific level
 * first: the instance (a model, or the older provider pin), then the member's
 * provider, then the org (provider + optional model within it). A model pin
 * implies its provider, so `provider` is null when `model` is set at the
 * instance level; the config generator resolves it from the catalog.
 */
export interface PrimaryPin {
  provider: string | null;
  model: string | null;
}

export function getPrimaryPin(g: GatewayRow): PrimaryPin {
  if (g.primary_model) return { provider: null, model: g.primary_model };
  if (g.primary_provider) return { provider: g.primary_provider, model: null };
  const db = getDb();
  const member = db
    .prepare("SELECT primary_provider FROM org_members WHERE id = ?")
    .get(g.member_id) as { primary_provider: string | null } | undefined;
  if (member?.primary_provider) return { provider: member.primary_provider, model: null };
  const org = db
    .prepare("SELECT primary_provider, primary_model FROM organizations WHERE id = ?")
    .get(g.org_id) as { primary_provider: string | null; primary_model: string | null } | undefined;
  return { provider: org?.primary_provider ?? null, model: org?.primary_model ?? null };
}

export function getPrimaryProvider(g: GatewayRow): string | null {
  return getPrimaryPin(g).provider;
}

export function getGatewayChannelTokens(gatewayId: string): ChannelTokens {
  const rows = getDb()
    .prepare("SELECT channel, bot_token, app_token FROM gateway_channels WHERE gateway_id = ?")
    .all(gatewayId) as { channel: string; bot_token: string; app_token: string | null }[];
  const tokens: ChannelTokens = {};
  for (const row of rows) {
    if (row.channel === "telegram") tokens.telegram = row.bot_token;
    else if (row.channel === "discord") tokens.discord = row.bot_token;
    else if (row.channel === "slack")
      tokens.slack = { botToken: row.bot_token, appToken: row.app_token ?? undefined };
  }
  return tokens;
}
