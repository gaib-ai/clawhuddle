import crypto from "node:crypto";
import type { GatewayRuntime, RedeployAllItem, RedeployAllRun } from "@clawhuddle/shared";
import { listOrgGateways } from "./gateway-store.js";
import { deployGateway, getGatewayStatus } from "./gateway.js";

/**
 * "Redeploy all" from Admin → Members, as a background run.
 *
 * A redeploy returns as soon as the container is started, but the instance is
 * busy for minutes after that (OpenClaw runs Doctor on every boot), so firing
 * every redeploy in a row boots the whole fleet at once and starves the host.
 * A run therefore takes a few instances at a time (`REDEPLOY_CONCURRENCY`,
 * default 2) and waits for each to answer its health check before it takes
 * the next one.
 *
 * - An instance that is stopped when its turn comes is left stopped.
 * - A failed instance does not stop the run, two failures in a row do: that is
 *   what a bad image or a broken host looks like, and the instances not yet
 *   touched keep running on what they have.
 * - One run per org at a time. The run lives in this process: an API restart
 *   forgets it (instances already redeployed keep booting on their own).
 */

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
export const REDEPLOY_CONCURRENCY = clamp(Math.trunc(Number(process.env.REDEPLOY_CONCURRENCY)) || 2, 1, 8);
/** The first boot on a new OpenClaw upgrades the state: ~9 min for a large instance. */
const WAIT_TIMEOUT_MS = 20 * 60_000;
const POLL_MS = 5_000;
/** Polls in a row that find the container down before the redeploy counts as failed. */
const DOWN_POLLS = 6;
const HALT_AFTER_FAILURES_IN_A_ROW = 2;

export interface RedeployDeps {
  list(orgId: string): { id: string; member_id: string; slot: number; runtime: GatewayRuntime }[];
  deploy(orgId: string, gatewayId: string): Promise<unknown>;
  status(orgId: string, gatewayId: string): Promise<{ status?: string | null }>;
  pollMs: number;
  timeoutMs: number;
  concurrency: number;
}

const defaults: RedeployDeps = {
  list: listOrgGateways,
  deploy: deployGateway,
  status: getGatewayStatus,
  pollMs: POLL_MS,
  timeoutMs: WAIT_TIMEOUT_MS,
  concurrency: REDEPLOY_CONCURRENCY,
};

export class RedeployInProgressError extends Error {
  constructor(public run: RedeployAllRun) {
    super("A redeploy of all instances is already running");
  }
}

const runs = new Map<string, RedeployAllRun>();

/** The org's current run, or its last one since this process started. */
export function getRedeployAll(orgId: string): RedeployAllRun | null {
  return runs.get(orgId) ?? null;
}

/**
 * Starts a run over the org's instances (`runtime`: only that runtime) and
 * returns it at once; `getRedeployAll` follows it. `done` resolves when the
 * run has finished (for tests).
 */
export function startRedeployAll(
  orgId: string,
  runtime: GatewayRuntime | null,
  overrides: Partial<RedeployDeps> = {},
): { run: RedeployAllRun; done: Promise<void> } {
  const current = runs.get(orgId);
  if (current && !current.finishedAt) throw new RedeployInProgressError(current);

  const deps = { ...defaults, ...overrides };
  const run: RedeployAllRun = {
    id: crypto.randomUUID(),
    runtime,
    concurrency: deps.concurrency,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    halted: false,
    items: deps
      .list(orgId)
      .filter((g) => !runtime || g.runtime === runtime)
      .map((g) => ({ gatewayId: g.id, memberId: g.member_id, slot: g.slot, runtime: g.runtime, state: "queued" as const })),
  };
  runs.set(orgId, run);
  const done = work(orgId, run, deps).catch((err) => {
    console.error(`Redeploy all (${orgId}) stopped unexpectedly:`, err?.message ?? err);
    run.halted = true;
    run.finishedAt = new Date().toISOString();
  });
  return { run, done };
}

async function work(orgId: string, run: RedeployAllRun, deps: RedeployDeps): Promise<void> {
  let next = 0;
  let failuresInARow = 0;

  const worker = async () => {
    while (!run.halted && next < run.items.length) {
      const item = run.items[next++];
      try {
        // Also how an instance removed since the run began is noticed: the lookup throws.
        const before = await deps.status(orgId, item.gatewayId).catch(() => null);
        if (!before || before.status === "stopped") {
          item.state = "skipped";
          item.reason = "stopped";
          continue;
        }
        // Halted while this one was being looked at: it stays queued and is reported as not reached.
        if (run.halted) break;
        item.state = "deploying";
        await deps.deploy(orgId, item.gatewayId);
        await untilRunning(orgId, item, deps);
        item.state = "done";
        failuresInARow = 0;
      } catch (err: any) {
        item.state = "failed";
        item.error = String(err?.message ?? err).slice(0, 300);
        console.error(`Redeploy all (${orgId}): instance ${item.gatewayId} failed: ${item.error}`);
        if (++failuresInARow >= HALT_AFTER_FAILURES_IN_A_ROW) run.halted = true;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(deps.concurrency, run.items.length) }, worker));
  for (const item of run.items) {
    if (item.state === "queued") {
      item.state = "skipped";
      item.reason = "halted";
    }
  }
  run.finishedAt = new Date().toISOString();
}

async function untilRunning(orgId: string, item: RedeployAllItem, deps: RedeployDeps): Promise<void> {
  const deadline = Date.now() + deps.timeoutMs;
  let down = 0;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, deps.pollMs));
    const { status } = await deps.status(orgId, item.gatewayId);
    if (status === "running") return;
    down = status === "stopped" ? down + 1 : 0;
    if (down >= DOWN_POLLS) throw new Error("The container stopped after the redeploy");
    if (Date.now() >= deadline) throw new Error(`Not running ${Math.round(deps.timeoutMs / 60_000)} min after the redeploy`);
  }
}
