/**
 * LLM usage per instance, read from OpenClaw's own `sessions.usage` gateway
 * method (the numbers behind the Control UI's Usage tab): token counts and a
 * list-price cost estimate from the session transcripts, by model, channel and
 * day. Only aggregates leave the container — never session titles, who started
 * a session, or message content.
 *
 * Each call is an `openclaw gateway call` CLI run (~2-6 s, a few CPU-seconds),
 * so complete results are cached for a few minutes and at most a few run at
 * once across the whole API.
 */
import { USAGE_SCOPES, type GatewayUsage, type UsageScope, type UsageSnapshot, type UsageTotals } from "@clawhuddle/shared";
import { getDb } from "../db/index.js";
import { execInContainer } from "./gateway.js";
import { containerNameFor, listOrgGateways, type GatewayRow } from "./gateway-store.js";
import { fetchHermesUsage } from "./hermes.js";
import { platformProviderName } from "./hermes-config.js";

const FRESH_TTL_MS = 5 * 60_000;
const MAX_CONCURRENT = 3;
const CLI_TIMEOUT_MS = 60_000;

const cache = new Map<string, { at: number; value: GatewayUsage }>();
const inflight = new Map<string, Promise<GatewayUsage>>();

let running = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** The `days` calendar days (UTC) ending today, as YYYY-MM-DD. */
export function usageWindow(days: number, now = new Date()): { startDate: string; endDate: string } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function arr(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

function totalsOf(t: any): UsageTotals {
  return {
    input: num(t?.input),
    output: num(t?.output),
    cacheRead: num(t?.cacheRead),
    cacheWrite: num(t?.cacheWrite),
    totalTokens: num(t?.totalTokens),
    totalCost: num(t?.totalCost),
    missingCostEntries: num(t?.missingCostEntries),
  };
}

/** Every date from startDate to endDate inclusive. */
function datesBetween(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${endDate}T00:00:00Z`);
  for (let t = Date.parse(`${startDate}T00:00:00Z`); t <= end && out.length < 400; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Keep the aggregates of a `sessions.usage` response; drop everything per session or per person. */
export function condenseSessionsUsage(
  gatewayId: string,
  raw: any,
  window: { startDate: string; endDate: string },
): GatewayUsage {
  const agg = raw?.aggregates ?? {};
  const totals = totalsOf(raw?.totals);

  const byModel = arr(agg.byModel)
    .map((m) => ({ provider: str(m?.provider), model: str(m?.model), calls: num(m?.count), totals: totalsOf(m?.totals) }))
    .filter((m) => m.totals.totalTokens > 0)
    .sort((a, b) => b.totals.totalTokens - a.totals.totalTokens);

  const byChannel = arr(agg.byChannel)
    .map((c) => ({ channel: str(c?.channel, "unknown"), tokens: num(c?.totals?.totalTokens), cost: num(c?.totals?.totalCost) }))
    .filter((c) => c.tokens > 0);
  const otherTokens = totals.totalTokens - byChannel.reduce((s, c) => s + c.tokens, 0);
  const otherCost = totals.totalCost - byChannel.reduce((s, c) => s + c.cost, 0);
  if (otherTokens > 0) byChannel.push({ channel: "other", tokens: otherTokens, cost: Math.max(0, otherCost) });
  byChannel.sort((a, b) => b.tokens - a.tokens);

  const reported = new Map(arr(agg.daily).map((d) => [str(d?.date), d]));
  const daily = datesBetween(window.startDate, window.endDate).map((date) => {
    const d = reported.get(date);
    return { date, tokens: num(d?.tokens), cost: num(d?.cost), messages: num(d?.messages), errors: num(d?.errors) };
  });

  return {
    gateway_id: gatewayId,
    startDate: window.startDate,
    endDate: window.endDate,
    updatedAt: num(raw?.updatedAt) || Date.now(),
    cacheStatus: str(raw?.cacheStatus?.status, "fresh"),
    totals,
    sessions: num(agg.sessionCount),
    messages: {
      user: num(agg.messages?.user),
      assistant: num(agg.messages?.assistant),
      toolCalls: num(agg.messages?.toolCalls),
      errors: num(agg.messages?.errors),
    },
    byModel,
    byChannel,
    daily,
  };
}

/**
 * A Hermes instance's usage (aggregates the image's helper reads from the
 * sessions database, see docker/hermes/helper.py) as the same `GatewayUsage`.
 * Hermes accounts per session, so a session counts on the day it started, and
 * the answer is always complete: there is no transcript index to warm up.
 */
export function condenseHermesUsage(
  gatewayId: string,
  raw: any,
  window: { startDate: string; endDate: string },
): GatewayUsage {
  return condenseSessionsUsage(
    gatewayId,
    {
      totals: raw?.totals,
      aggregates: {
        byModel: arr(raw?.byModel).map((m) => ({
          provider: platformProviderName(String(m?.provider ?? ""), typeof m?.baseUrl === "string" ? m.baseUrl : undefined),
          model: m?.model,
          count: m?.calls,
          totals: m?.totals,
        })),
        byChannel: arr(raw?.byChannel).map((c) => ({ channel: c?.channel, totals: { totalTokens: c?.tokens, totalCost: c?.cost } })),
        daily: raw?.daily,
        sessionCount: raw?.sessions,
        messages: raw?.messages,
      },
    },
    window,
  );
}

/** Parse CLI stdout, tolerating anything printed before the JSON object. */
export function parseCliJson(stdout: string): any {
  const start = stdout.indexOf("{");
  if (start < 0) throw new Error("OpenClaw returned no usage data");
  return JSON.parse(stdout.slice(start));
}

type UsageDates = { startDate: string; endDate: string };

/** One `sessions.usage` run. With a time zone, days (and the window) are that zone's calendar days, not UTC's. */
async function fetchUsageWindow(g: GatewayRow, window: UsageDates, timeZone?: string): Promise<GatewayUsage> {
  if (g.runtime === "hermes") {
    return condenseHermesUsage(g.id, await withSlot(() => fetchHermesUsage(g, window, timeZone)), window);
  }
  const params = JSON.stringify({
    ...window,
    ...(timeZone ? { mode: "specific", timeZone } : {}),
    agentScope: "all",
    limit: 1,
  });
  const stdout = await withSlot(() =>
    execInContainer(
      containerNameFor(g),
      ["openclaw", "gateway", "call", "sessions.usage", "--json", "--timeout", String(CLI_TIMEOUT_MS), "--params", params],
      CLI_TIMEOUT_MS + 15_000,
    ),
  );
  return condenseSessionsUsage(g.id, parseCliJson(stdout), window);
}

function fetchUsage(g: GatewayRow, days: number): Promise<GatewayUsage> {
  return fetchUsageWindow(g, usageWindow(days));
}

/**
 * Usage for one running instance over the last `days` days. A complete result
 * is reused for FRESH_TTL_MS unless `refresh`; an incomplete one (OpenClaw
 * still indexing after a restart) is never cached, so asking again soon gets
 * the fuller numbers.
 */
export async function getGatewayUsage(g: GatewayRow, days: number, opts: { refresh?: boolean } = {}): Promise<GatewayUsage> {
  const key = `${g.id}:${days}`;
  const hit = cache.get(key);
  if (!opts.refresh && hit && Date.now() - hit.at < FRESH_TTL_MS && hit.value.endDate === usageWindow(days).endDate) {
    return hit.value;
  }
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = fetchUsage(g, days)
    .then((value) => {
      if (value.cacheStatus === "fresh") cache.set(key, { at: Date.now(), value });
      else cache.delete(key);
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------
// Nightly snapshot for Admin → Usage.
//
// Reading every instance live costs a CLI run per instance and range, during
// the working day. Instead one snapshot per org is taken at 01:00 in
// USAGE_TIME_ZONE (UTC+8 by default) and the page shows that. Each scope ends
// on the last complete day (yesterday, local time); `month` is the 1st of that
// day's month to it, so the snapshot taken on the 1st holds the whole previous
// month. Only the latest snapshot is kept (one row per org).
// ---------------------------------------------------------------------------

/** Time zone the snapshot's calendar days are counted in. */
export const USAGE_TIME_ZONE = process.env.USAGE_TIME_ZONE || "Asia/Singapore";
/** Local hours in which the nightly snapshot may start (01:00, with catch-up until 05:59 if the API was down). */
const SNAPSHOT_HOURS = [1, 2, 3, 4, 5];
const SNAPSHOT_CHECK_MS = 5 * 60_000;
/** OpenClaw re-indexes transcripts after a restart; wait for a complete answer before storing one. */
const SNAPSHOT_INCOMPLETE_RETRY_MS = [10_000, 20_000, 40_000];

/** Calendar date and hour of `now` in `timeZone`. */
export function localClock(now: Date, timeZone: string): { date: string; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The snapshot scopes as of local date `today`, each ending on the day before it. */
export function snapshotWindows(today: string): Record<UsageScope, UsageDates> {
  const end = shiftDate(today, -1);
  return {
    "7d": { startDate: shiftDate(end, -6), endDate: end },
    "30d": { startDate: shiftDate(end, -29), endDate: end },
    month: { startDate: `${end.slice(0, 8)}01`, endDate: end },
  };
}

async function completeUsage(g: GatewayRow, window: UsageDates, timeZone: string): Promise<GatewayUsage> {
  let usage = await fetchUsageWindow(g, window, timeZone);
  for (const wait of SNAPSHOT_INCOMPLETE_RETRY_MS) {
    if (usage.cacheStatus === "fresh") break;
    await new Promise((r) => setTimeout(r, wait));
    usage = await fetchUsageWindow(g, window, timeZone);
  }
  return usage;
}

const snapshotsRunning = new Set<string>();

export function isUsageSnapshotRunning(orgId: string): boolean {
  return snapshotsRunning.has(orgId);
}

export function getUsageSnapshot(orgId: string): UsageSnapshot | null {
  const row = getDb().prepare("SELECT data FROM usage_snapshots WHERE org_id = ?").get(orgId) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as UsageSnapshot) : null;
}

/**
 * Read every running instance of the org for each scope and replace the org's
 * stored snapshot. Instances are read one scope at a time through the shared
 * CLI slots, so at most MAX_CONCURRENT runs happen at once API-wide. Returns
 * null when a snapshot of this org is already being taken.
 */
export async function takeUsageSnapshot(orgId: string, now = new Date(), timeZone = USAGE_TIME_ZONE): Promise<UsageSnapshot | null> {
  if (snapshotsRunning.has(orgId)) return null;
  snapshotsRunning.add(orgId);
  try {
    const { date } = localClock(now, timeZone);
    const windows = snapshotWindows(date);
    const gateways: UsageSnapshot["gateways"] = {};
    const running = listOrgGateways(orgId).filter((g) => g.status === "running");
    await Promise.all(
      running.map(async (g) => {
        try {
          const usage = {} as Record<UsageScope, GatewayUsage>;
          for (const scope of USAGE_SCOPES) usage[scope] = await completeUsage(g, windows[scope], timeZone);
          gateways[g.id] = { usage };
        } catch (err: any) {
          gateways[g.id] = { error: err?.message || "Could not read usage" };
        }
      }),
    );
    const snapshot: UsageSnapshot = { takenAt: new Date().toISOString(), forDate: date, timeZone, windows, gateways };
    getDb()
      .prepare(
        `INSERT INTO usage_snapshots (org_id, taken_at, data) VALUES (?, ?, ?)
         ON CONFLICT(org_id) DO UPDATE SET taken_at = excluded.taken_at, data = excluded.data`,
      )
      .run(orgId, snapshot.takenAt, JSON.stringify(snapshot));
    return snapshot;
  } finally {
    snapshotsRunning.delete(orgId);
  }
}

/** Orgs with at least one instance whose stored snapshot is not from local date `today`. */
function orgsDueForSnapshot(today: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT g.org_id, s.data FROM gateways g
       LEFT JOIN usage_snapshots s ON s.org_id = g.org_id`,
    )
    .all() as { org_id: string; data: string | null }[];
  return rows
    .filter((r) => {
      if (!r.data) return true;
      try {
        return (JSON.parse(r.data) as UsageSnapshot).forDate !== today;
      } catch {
        return true;
      }
    })
    .map((r) => r.org_id);
}

/** Check every few minutes; between 01:00 and 05:59 local, snapshot each org that has none for today yet. */
export function startUsageSnapshotScheduler(log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void }): void {
  const tick = async () => {
    const { date, hour } = localClock(new Date(), USAGE_TIME_ZONE);
    if (!SNAPSHOT_HOURS.includes(hour)) return;
    for (const orgId of orgsDueForSnapshot(date)) {
      try {
        const s = await takeUsageSnapshot(orgId);
        if (s) log.info({ orgId, instances: Object.keys(s.gateways).length }, "usage snapshot taken");
      } catch (err: any) {
        log.warn({ orgId, err: err?.message }, "usage snapshot failed");
      }
    }
  };
  setInterval(() => void tick(), SNAPSHOT_CHECK_MS).unref();
  void tick();
}
