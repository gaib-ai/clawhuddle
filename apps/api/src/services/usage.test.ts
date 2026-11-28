import { describe, it, expect } from 'vitest';
import { condenseHermesUsage, condenseSessionsUsage, localClock, parseCliJson, snapshotWindows, usageWindow } from './usage.js';

const t = (totalTokens: number, totalCost = 0, extra: Record<string, number> = {}) => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, totalCost, missingCostEntries: 0, ...extra,
});

/** Trimmed shape of a real OpenClaw 2026.10.3 `sessions.usage` response. */
const RAW = {
  updatedAt: 1794215561289,
  startDate: '2026-11-07',
  endDate: '2026-11-09',
  sessions: [{ key: 'agent:main:slack:secret-thread', label: 'Private chat title', usage: t(5) }],
  totals: t(1000, 2.5, { input: 600, output: 100, cacheRead: 300 }),
  creatorOptions: [{ key: '["human","channel","main","slack","default","U123"]' }],
  cacheStatus: { status: 'fresh', cachedFiles: 5, pendingFiles: 0, staleFiles: 0 },
  aggregates: {
    sessionCount: 4,
    messages: { total: 30, user: 10, assistant: 20, toolCalls: 7, toolResults: 7, errors: 1 },
    byModel: [
      { provider: 'google', model: 'gemini-3.8-flash', count: 12, totals: t(400, 0.5) },
      { provider: 'openclaw', model: 'delivery-mirror', count: 3, totals: t(0) },
      { provider: 'tokenkiosk', model: 'azure/gpt-5.5', count: 8, totals: t(600, 2) },
    ],
    byChannel: [{ channel: 'slack', totals: t(700, 2) }],
    byCreator: [{ key: 'U123', totals: t(1000) }],
    daily: [
      { date: '2026-11-07', tokens: 300, cost: 1, messages: 9, toolCalls: 2, errors: 0 },
      { date: '2026-11-09', tokens: 700, cost: 1.5, messages: 21, toolCalls: 5, errors: 1 },
    ],
  },
};

describe('condenseSessionsUsage', () => {
  const window = { startDate: '2026-11-07', endDate: '2026-11-09' };
  const u = condenseSessionsUsage('gw-1', RAW, window);

  it('keeps aggregates and nothing per session or per person', () => {
    const json = JSON.stringify(u);
    expect(json).not.toContain('secret-thread');
    expect(json).not.toContain('Private chat title');
    expect(json).not.toContain('U123');
    expect(u.totals).toEqual(t(1000, 2.5, { input: 600, output: 100, cacheRead: 300 }));
    expect(u.sessions).toBe(4);
    expect(u.messages).toEqual({ user: 10, assistant: 20, toolCalls: 7, errors: 1 });
    expect(u.cacheStatus).toBe('fresh');
  });

  it('lists models by tokens and drops ones that used none', () => {
    expect(u.byModel.map((m) => `${m.provider}/${m.model}:${m.calls}`)).toEqual([
      'tokenkiosk/azure/gpt-5.5:8',
      'google/gemini-3.8-flash:12',
    ]);
  });

  it('puts usage outside any chat channel under other', () => {
    expect(u.byChannel).toEqual([
      { channel: 'slack', tokens: 700, cost: 2 },
      { channel: 'other', tokens: 300, cost: 0.5 },
    ]);
  });

  it('has one daily row per day in the window, zero-filled', () => {
    expect(u.daily.map((d) => [d.date, d.tokens])).toEqual([
      ['2026-11-07', 300],
      ['2026-11-08', 0],
      ['2026-11-09', 700],
    ]);
  });

  it('survives a response missing pieces', () => {
    const empty = condenseSessionsUsage('gw-2', { cacheStatus: { status: 'refreshing' } }, window);
    expect(empty.totals.totalTokens).toBe(0);
    expect(empty.byModel).toEqual([]);
    expect(empty.byChannel).toEqual([]);
    expect(empty.daily).toHaveLength(3);
    expect(empty.cacheStatus).toBe('refreshing');
  });
});

describe('usageWindow', () => {
  it('ends today (UTC) and spans the given number of days', () => {
    const now = new Date('2026-11-09T23:30:00Z');
    expect(usageWindow(1, now)).toEqual({ startDate: '2026-11-09', endDate: '2026-11-09' });
    expect(usageWindow(30, now)).toEqual({ startDate: '2026-10-11', endDate: '2026-11-09' });
  });
});

describe('parseCliJson', () => {
  it('skips anything printed before the JSON', () => {
    expect(parseCliJson('warning: something\n{"a":1}\n')).toEqual({ a: 1 });
  });
  it('fails clearly on no JSON', () => {
    expect(() => parseCliJson('gateway closed')).toThrow(/no usage data/);
  });
});

describe('nightly snapshot windows', () => {
  it('reads the clock in the snapshot time zone, not UTC', () => {
    // 17:00 UTC on Nov 17 is 01:00 on Nov 18 in UTC+8.
    expect(localClock(new Date('2026-11-17T17:00:00Z'), 'Asia/Singapore')).toEqual({ date: '2026-11-18', hour: 1 });
    expect(localClock(new Date('2026-11-17T16:59:00Z'), 'Asia/Singapore')).toEqual({ date: '2026-11-18', hour: 0 });
  });

  it('ends every scope on the last complete day', () => {
    expect(snapshotWindows('2026-11-18')).toEqual({
      '7d': { startDate: '2026-11-11', endDate: '2026-11-17' },
      '30d': { startDate: '2026-10-19', endDate: '2026-11-17' },
      month: { startDate: '2026-11-01', endDate: '2026-11-17' },
    });
  });

  it('gives the whole previous month on the 1st', () => {
    expect(snapshotWindows('2026-12-01').month).toEqual({ startDate: '2026-11-01', endDate: '2026-11-30' });
    expect(snapshotWindows('2027-01-01')['7d']).toEqual({ startDate: '2026-12-25', endDate: '2026-12-31' });
  });
});


describe('condenseHermesUsage', () => {
  // The shape docker/hermes/helper.py prints for `usage <start> <end> <tz>`.
  const HELPER = {
    totals: t(1500, 0.9, { input: 1000, output: 200, cacheRead: 300 }),
    sessions: 4,
    messages: { total: 20, user: 8, assistant: 12, toolCalls: 5, toolResults: 5, errors: 1 },
    byModel: [
      { provider: 'gemini', model: 'gemini-3.8-flash', calls: 9, totals: t(1000, 0.4) },
      { provider: 'custom', baseUrl: 'https://agent-router.gaib.ai/v1', model: 'azure/gpt-5.5', calls: 3, totals: t(500, 0.5) },
    ],
    byChannel: [{ channel: 'slack', tokens: 1100, cost: 0.6 }, { channel: 'other', tokens: 400, cost: 0.3 }],
    daily: [{ date: '2026-11-26', tokens: 1500, cost: 0.9, messages: 20, toolCalls: 5, errors: 1 }],
  };
  const window = { startDate: '2026-11-22', endDate: '2026-11-28' };

  it('maps the helper output onto the same GatewayUsage as an OpenClaw instance', () => {
    const usage = condenseHermesUsage('gw-h', HELPER, window);
    expect(usage).toMatchObject({ gateway_id: 'gw-h', cacheStatus: 'fresh', sessions: 4, startDate: '2026-11-22', endDate: '2026-11-28' });
    expect(usage.totals).toMatchObject({ totalTokens: 1500, totalCost: 0.9, input: 1000 });
    expect(usage.byModel.map((m) => [m.provider, m.model, m.totals.totalTokens])).toEqual([
      ['google', 'gemini-3.8-flash', 1000],
      ['tokenkiosk', 'azure/gpt-5.5', 500],
    ]);
    expect(usage.byChannel.map((c) => [c.channel, c.tokens])).toEqual([['slack', 1100], ['other', 400]]);
    expect(usage.daily).toHaveLength(7);
    expect(usage.daily.find((d) => d.date === '2026-11-26')).toMatchObject({ tokens: 1500, messages: 20 });
  });

  it('names providers as the rest of the Usage page does, and leaves unknown ones as Hermes logged them', () => {
    const names = (byModel: object[]) => condenseHermesUsage('gw-h', { ...HELPER, byModel }, window).byModel.map((m) => m.provider);
    expect(names([
      { provider: 'custom', baseUrl: 'http://claw-proxy:3456/v1/', model: 'a', calls: 1, totals: t(1) },
      { provider: 'custom', baseUrl: 'https://example.com/v1', model: 'b', calls: 1, totals: t(1) },
      { provider: 'openai-api', model: 'c', calls: 1, totals: t(1) },
      { provider: 'nous', model: 'd', calls: 1, totals: t(1) },
    ])).toEqual(['claw', 'custom', 'openai', 'nous']);
  });

  it('survives an empty or missing answer', () => {
    expect(condenseHermesUsage('gw-h', {}, window).totals.totalTokens).toBe(0);
    expect(condenseHermesUsage('gw-h', null, window).byModel).toEqual([]);
  });
});
