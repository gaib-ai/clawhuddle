import type { DevicePairingRequest } from "@clawhuddle/shared";

/**
 * What is waiting to be paired on an OpenClaw instance, read straight from its
 * state database in one ~0.1 s `node -e` run inside the container:
 *
 * - `pending`: how many device requests are waiting (`device_pairing_pending`).
 *   `openclaw devices list` costs ~4.5 CPU-seconds, so the list only runs it
 *   when this is not exactly 0. Same rule as the image's own
 *   `clawhuddle-pending-devices`, which the entrypoint loop keeps using.
 * - `browser`: the browsers showing a pairing code
 *   (`device_pairing_browser_requests`, OpenClaw 2026.11+). No CLI or gateway
 *   method lists them; `openclaw pair <code>` only looks one up by its code.
 *
 * Both are OpenClaw internals, so each part answers null rather than guess when
 * it cannot be read (a renamed column, a missing database): a null `pending`
 * sends the caller to the CLI, a null `browser` lists none. The browser table
 * is only created by an instance's first pairing code, so its absence is an
 * honest empty list. Check both after an OpenClaw upgrade.
 */
export const PAIRING_CHECK_SCRIPT = `
const { DatabaseSync } = require('node:sqlite');
const out = { pending: null, browser: null };
try {
  const db = new DatabaseSync(process.env.HOME + '/.openclaw/state/openclaw.sqlite', { readOnly: true, timeout: 1000 });
  const now = Date.now();
  try {
    // Mirrors DEVICE_PAIRING_PENDING_TTL_MS: expired rows stay in the table and the CLI hides them.
    out.pending = Number(db.prepare('SELECT count(*) AS n FROM device_pairing_pending WHERE coalesce(refreshed_at_ms, ts) >= ?').get(now - 300000).n);
  } catch (e) {}
  try {
    const has = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'device_pairing_browser_requests'").get();
    out.browser = !has ? [] : db.prepare(
      "SELECT request_id AS requestId, code, device_id AS deviceId, remote_ip AS remoteIp, user_agent AS userAgent, " +
      "origin, created_at_ms AS createdAtMs, expires_at_ms AS expiresAtMs " +
      "FROM device_pairing_browser_requests WHERE status = 'pending' AND expires_at_ms > ? ORDER BY created_at_ms DESC"
    ).all(now).map(function (r) { return Object.assign({}, r, { createdAtMs: Number(r.createdAtMs), expiresAtMs: Number(r.expiresAtMs) }); });
  } catch (e) {}
} catch (e) {}
console.log(JSON.stringify(out));
`;

/** The command that runs the check in a gateway container. */
export const PAIRING_CHECK_CMD = ["node", "--disable-warning=ExperimentalWarning", "-e", PAIRING_CHECK_SCRIPT];

/** A waiting browser as the check read it. `code` stays on the server. */
export interface BrowserPairRow {
  requestId: string;
  code: string;
  deviceId: string;
  remoteIp?: string;
  userAgent?: string;
  origin?: string;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface PairingCheck {
  /** Device requests waiting; null = unknown, ask the CLI. */
  pending: number | null;
  /** Browsers showing a code; null = could not be read. */
  browser: BrowserPairRow[] | null;
}

const UNKNOWN: PairingCheck = { pending: null, browser: null };

/** Read the check's one line of JSON; anything unexpected is "unknown", never a guess. */
export function parsePairingCheck(output: string): PairingCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    return UNKNOWN;
  }
  if (!parsed || typeof parsed !== "object") return UNKNOWN;
  const { pending, browser } = parsed as { pending?: unknown; browser?: unknown };
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const rows = Array.isArray(browser)
    ? browser
        .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
        .filter((r) => typeof r.requestId === "string" && typeof r.code === "string")
        .map((r) => ({
          requestId: r.requestId as string,
          code: r.code as string,
          deviceId: String(r.deviceId ?? ""),
          remoteIp: str(r.remoteIp),
          userAgent: str(r.userAgent),
          origin: str(r.origin),
          createdAtMs: typeof r.createdAtMs === "number" ? r.createdAtMs : 0,
          expiresAtMs: typeof r.expiresAtMs === "number" ? r.expiresAtMs : 0,
        }))
    : null;
  return {
    pending: typeof pending === "number" && Number.isInteger(pending) && pending >= 0 ? pending : null,
    browser: rows,
  };
}

/** What the web app may see of a waiting browser: everything but its code. */
export function toBrowserPairRequest(row: BrowserPairRow): DevicePairingRequest {
  return {
    kind: "browser-code",
    requestId: row.requestId,
    deviceId: row.deviceId,
    userAgent: row.userAgent,
    remoteIp: row.remoteIp,
    browserOrigin: row.origin,
    ts: row.createdAtMs,
    expiresAt: row.expiresAtMs,
  };
}
