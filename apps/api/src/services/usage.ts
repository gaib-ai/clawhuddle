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
import type { GatewayUsage, UsageTotals } from "@clawhuddle/shared";
import { execInContainer } from "./gateway.js";
import { containerNameFor, type GatewayRow } from "./gateway-store.js";

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

/** Parse CLI stdout, tolerating anything printed before the JSON object. */
export function parseCliJson(stdout: string): any {
  const start = stdout.indexOf("{");
  if (start < 0) throw new Error("OpenClaw returned no usage data");
  return JSON.parse(stdout.slice(start));
}

async function fetchUsage(g: GatewayRow, days: number): Promise<GatewayUsage> {
  const window = usageWindow(days);
  const params = JSON.stringify({ ...window, agentScope: "all", limit: 1 });
  const stdout = await withSlot(() =>
    execInContainer(
      containerNameFor(g),
      ["openclaw", "gateway", "call", "sessions.usage", "--json", "--timeout", String(CLI_TIMEOUT_MS), "--params", params],
      CLI_TIMEOUT_MS + 15_000,
    ),
  );
  return condenseSessionsUsage(g.id, parseCliJson(stdout), window);
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
