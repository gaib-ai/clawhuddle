import { describe, expect, it } from 'vitest';
import { generateOpenClawConfig, mergeOpenClawConfig } from './openclaw-config.js';

const base = {
  port: 6100,
  token: 'gw-token',
  activeProviderIds: ['google', 'token-kiosk'],
  tokenKiosk: { baseUrl: 'https://kiosk.example/v1', apiKey: 'sk-test' },
};

describe('generateOpenClawConfig (OpenClaw 2026.10.x schema)', () => {
  it('emits no keys the strict schema rejects', () => {
    const cfg = generateOpenClawConfig(base) as unknown as Record<string, any>;
    expect(cfg.meta).toEqual({ lastTouchedVersion: '2026.2.17' });
    expect(cfg.gateway.controlUi).not.toHaveProperty('allowInsecureAuth');
  });

  it('declares the model allowlist Doctor would otherwise derive', () => {
    const cfg = generateOpenClawConfig(base);
    const defaults = cfg.agents!.defaults;
    expect(defaults.modelPolicy).toEqual({ allow: Object.keys(defaults.models) });
    expect(defaults.modelPolicy!.allow).toContain(defaults.model.primary);
  });
});

const withSlack = {
  ...base,
  channelTokens: { slack: { botToken: 'xoxb-test', appToken: 'xapp-test' } },
};

describe('reply latency defaults (2026-10-16)', () => {
  it('defaults chat thinking to low', () => {
    expect(generateOpenClawConfig(base).agents!.defaults.thinkingDefault).toBe('low');
  });

  it('streams Slack progress with per-tool rows and no raw command text', () => {
    const slack = generateOpenClawConfig(withSlack).channels!.slack!;
    expect(slack.streaming).toEqual({
      mode: 'progress',
      progress: { toolProgress: true, commandText: 'status' },
    });
  });

  it('overlays streaming onto an existing Slack block without touching the rest of it', () => {
    const existing = generateOpenClawConfig(withSlack);
    existing.channels!.slack = {
      ...existing.channels!.slack!,
      botToken: 'xoxb-user-rotated',
      allowFrom: ['U123'],
      streaming: { mode: 'off' },
    };
    const merged = mergeOpenClawConfig(existing as unknown as Parameters<typeof mergeOpenClawConfig>[0], withSlack);
    const slack = merged.channels!.slack!;
    expect(slack.streaming).toEqual({
      mode: 'progress',
      progress: { toolProgress: true, commandText: 'status' },
    });
    expect(slack.botToken).toBe('xoxb-user-rotated');
    expect(slack.allowFrom).toEqual(['U123']);
  });

  it('replaces agents.defaults wholesale so thinkingDefault survives a redeploy', () => {
    const existing = generateOpenClawConfig(base);
    existing.agents!.defaults.thinkingDefault = 'medium';
    expect(mergeOpenClawConfig(existing as unknown as Parameters<typeof mergeOpenClawConfig>[0], base).agents!.defaults.thinkingDefault).toBe('low');
  });
});

describe('Slack access (2026-10-21)', () => {
  type MergeInput = Parameters<typeof mergeOpenClawConfig>[0];
  const legacyOpenSlack = () => ({
    enabled: true,
    mode: 'socket',
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    groupPolicy: 'open',
    allowBots: true,
    dmPolicy: 'open',
    dm: { enabled: true, policy: 'open' },
    allowFrom: ['*'],
  });

  it('only answers paired DMs and allowlisted channels, and ignores other bots', () => {
    const slack = generateOpenClawConfig(withSlack).channels!.slack!;
    expect(slack).toMatchObject({ dmPolicy: 'pairing', groupPolicy: 'allowlist', allowBots: false });
    expect(slack.allowFrom).toBeUndefined();
    expect(slack.dm).toBeUndefined();
  });

  it('locks down a Slack block still carrying the old open platform default', () => {
    const existing = { ...generateOpenClawConfig(withSlack), channels: { slack: legacyOpenSlack() } };
    const slack = mergeOpenClawConfig(existing as unknown as MergeInput, withSlack).channels!.slack!;
    expect(slack).toMatchObject({ dmPolicy: 'pairing', groupPolicy: 'allowlist', allowBots: false, botToken: 'xoxb-test' });
    expect(slack.allowFrom).toBeUndefined();
    expect(slack.dm).toEqual({ enabled: true });
  });

  it('locks it down even when the member no longer has a Slack token with us', () => {
    const existing = { ...generateOpenClawConfig(base), channels: { slack: legacyOpenSlack() } };
    const slack = mergeOpenClawConfig(existing as unknown as MergeInput, base).channels!.slack!;
    expect(slack.dmPolicy).toBe('pairing');
  });

  it("leaves a Slack block the member customised alone", () => {
    const custom = { ...legacyOpenSlack(), allowFrom: ['U123'], dmPolicy: 'allowlist' };
    const existing = { ...generateOpenClawConfig(withSlack), channels: { slack: custom } };
    const slack = mergeOpenClawConfig(existing as unknown as MergeInput, withSlack).channels!.slack!;
    expect(slack).toMatchObject({ dmPolicy: 'allowlist', allowFrom: ['U123'], groupPolicy: 'open', allowBots: true });
  });

  it('leaves even the old default alone when the lockdown has already run', () => {
    const existing = { ...generateOpenClawConfig(withSlack), channels: { slack: legacyOpenSlack() } };
    const slack = mergeOpenClawConfig(existing as unknown as MergeInput, withSlack, { lockDownLegacySlack: false })
      .channels!.slack!;
    expect(slack).toMatchObject({ dmPolicy: 'open', allowFrom: ['*'], groupPolicy: 'open', allowBots: true });
  });
});

describe('mergeOpenClawConfig meta handling', () => {
  it('keeps the meta Doctor recorded, including its migrations ledger', () => {
    const existing = {
      ...generateOpenClawConfig(base),
      meta: { lastTouchedVersion: '2026.10.3', migrations: { modelPolicyAllowlist: true } },
    };
    const merged = mergeOpenClawConfig(existing, base);
    expect(merged.meta).toEqual({ lastTouchedVersion: '2026.10.3', migrations: { modelPolicyAllowlist: true } });
  });

  it('strips the retired lastTouchedAt from a config written by an older platform', () => {
    const existing = {
      ...generateOpenClawConfig(base),
      meta: { lastTouchedVersion: '2026.2.17', lastTouchedAt: '2026-10-16T11:56:24.359Z' },
    } as unknown as Parameters<typeof mergeOpenClawConfig>[0];
    const merged = mergeOpenClawConfig(existing, base);
    expect(merged.meta).toEqual({ lastTouchedVersion: '2026.2.17' });
  });

  it('falls back to generated meta when the existing config has none', () => {
    const { meta: _omit, ...rest } = generateOpenClawConfig(base);
    const merged = mergeOpenClawConfig(rest as unknown as Parameters<typeof mergeOpenClawConfig>[0], base);
    expect(merged.meta).toEqual({ lastTouchedVersion: '2026.2.17' });
  });
});
