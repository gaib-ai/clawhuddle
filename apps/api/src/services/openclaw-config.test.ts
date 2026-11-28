import { describe, expect, it } from 'vitest';
import { generateOpenClawConfig, mergeOpenClawConfig } from './openclaw-config.js';
import { PROVIDERS } from '@clawhuddle/shared';

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

describe('default model', () => {
  it('defaults the primary to Gemini 3.8 Flash when no provider is pinned', () => {
    expect(generateOpenClawConfig(base).agents!.defaults.model.primary).toBe('google/gemini-3.8-flash');
  });

  it('uses Gemini 3.8 Flash for a pinned google provider without a model override', () => {
    const cfg = generateOpenClawConfig({ ...base, primaryProviderId: 'google' });
    expect(cfg.agents!.defaults.model.primary).toBe('google/gemini-3.8-flash');
  });

  it('an instance pinned to another Gemini model runs on it', () => {
    const cfg = generateOpenClawConfig({ ...base, primaryProviderId: 'google', primaryModel: 'google/gemini-4-argon' });
    const defaults = cfg.agents!.defaults;
    expect(defaults.model.primary).toBe('google/gemini-4-argon');
    expect(defaults.modelPolicy!.allow).toContain('google/gemini-4-argon');
    expect(cfg.models!.providers.google!.models!.map((m) => m.id)).toContain('gemini-4-argon');
  });

  it('a key overridden to Gemini 4 Hydrogen uses that model for a provider pin', () => {
    const cfg = generateOpenClawConfig({ ...base, primaryProviderId: 'google', modelOverrides: { google: 'google/gemini-4-hydrogen' } });
    expect(cfg.agents!.defaults.model.primary).toBe('google/gemini-4-hydrogen');
    expect(cfg.agents!.defaults.modelPolicy!.allow).toContain('google/gemini-3.8-flash');
  });

  it('a pin to a retired model keeps working (no longer offered, still declared)', () => {
    const cfg = generateOpenClawConfig({ ...base, primaryProviderId: 'google', primaryModel: 'tokenkiosk/claude-sonnet-latest' });
    expect(cfg.agents!.defaults.model.primary).toBe('tokenkiosk/claude-sonnet-latest');
    expect(cfg.models!.providers.tokenkiosk!.models!.map((m) => m.id)).toContain('claude-sonnet-latest');
  });

  it('a pinned model beats the provider pin and the key override', () => {
    const cfg = generateOpenClawConfig({
      ...base,
      primaryProviderId: 'google',
      modelOverrides: { google: 'google/gemini-3.8-flash' },
      primaryModel: 'tokenkiosk/claude-sonnet-5',
    });
    const defaults = cfg.agents!.defaults;
    expect(defaults.model.primary).toBe('tokenkiosk/claude-sonnet-5');
    expect(defaults.model.fallbacks).toEqual(['google/gemini-3.8-flash']);
    expect(defaults.modelPolicy!.allow).toContain('tokenkiosk/claude-sonnet-5');
    expect(cfg.models!.providers.tokenkiosk!.models!.map((m) => m.id)).toContain('claude-sonnet-5');
  });

  it('loads every catalog model of the active providers so members can switch inside OpenClaw', () => {
    const defaults = generateOpenClawConfig({ ...base, primaryProviderId: 'google' }).agents!.defaults;
    const loaded = Object.keys(defaults.models);
    for (const id of ['google/gemini-3.8-flash', 'google/gemini-4-hydrogen', 'google/gemini-4-neon', 'google/gemini-4-argon', 'tokenkiosk/azure/gpt-5.5', 'tokenkiosk/claude-sonnet-5', 'tokenkiosk/minimax-m3.1-flash']) {
      expect(loaded).toContain(id);
    }
    expect(loaded[0]).toBe('google/gemini-3.8-flash');
    expect(defaults.modelPolicy!.allow).toEqual(loaded);
    // Retired models stay declared but not selectable.
    expect(loaded).not.toContain('tokenkiosk/claude-opus-latest');
    // Fallbacks stay one per provider.
    expect(defaults.model.fallbacks).toEqual(['tokenkiosk/azure/gpt-5.5']);
  });

  it('keeps a retired former default on the allowlist: automations and sessions inside OpenClaw still name it', () => {
    // 2026-11-27: taking Gemini 3.8 Flash off the list failed every automation that carried it as its model.
    const kiosk = PROVIDERS.find((p) => p.id === 'token-kiosk')!;
    const before = kiosk.formerDefaults;
    kiosk.formerDefaults = ['tokenkiosk/claude-opus-latest'];
    try {
      const allow = generateOpenClawConfig({ ...base, primaryProviderId: 'google' }).agents!.defaults.modelPolicy!.allow;
      expect(allow).toContain('tokenkiosk/claude-opus-latest');
      // Offered models come first, so the picker order inside OpenClaw is unchanged.
      expect(allow.indexOf('tokenkiosk/claude-opus-latest')).toBeGreaterThan(allow.indexOf('tokenkiosk/minimax-m3.1-flash'));
      // A provider the member has no key for contributes nothing.
      const googleOnly = generateOpenClawConfig({ ...base, activeProviderIds: ['google'], primaryProviderId: 'google' }).agents!.defaults;
      expect(googleOnly.modelPolicy!.allow).not.toContain('tokenkiosk/claude-opus-latest');
    } finally {
      kiosk.formerDefaults = before;
    }
  });

  it('ignores a pinned model whose provider the member has no key for', () => {
    const cfg = generateOpenClawConfig({ ...base, primaryProviderId: 'google', primaryModel: 'anthropic/claude-fable-5' });
    expect(cfg.agents!.defaults.model.primary).toBe('google/gemini-3.8-flash');
    expect(Object.keys(cfg.agents!.defaults.models)).not.toContain('anthropic/claude-fable-5');
  });
});

describe('google catalog extension', () => {
  it('declares the Gemini models we offer', () => {
    const google = generateOpenClawConfig(base).models!.providers.google!;
    expect(google).not.toHaveProperty('apiKey');
    expect(google.models!.map((m) => m.id)).toEqual(
      expect.arrayContaining(['gemini-4-hydrogen', 'gemini-4-neon', 'gemini-4-argon', 'gemini-3.8-flash']),
    );
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

  it('streams Slack progress with per-tool rows showing the raw command', () => {
    const slack = generateOpenClawConfig(withSlack).channels!.slack!;
    expect(slack.streaming).toEqual({
      mode: 'progress',
      progress: { toolProgress: true, commandText: 'raw' },
    });
  });

  it('threads every Slack reply so the native status card renders in DMs, groups and channels', () => {
    const slack = generateOpenClawConfig(withSlack).channels!.slack!;
    expect(slack.replyToModeByChatType).toEqual({ direct: 'all', group: 'all', channel: 'all' });
  });

  it('names the raw tool call on progress rows', () => {
    expect(generateOpenClawConfig(base).agents!.defaults.toolProgressDetail).toBe('raw');
  });

  it('updates a platform-written streaming value and missing reply threading without touching the rest of the block', () => {
    const existing = generateOpenClawConfig(withSlack);
    const { replyToModeByChatType: _dropped, ...slackBlock } = existing.channels!.slack!;
    existing.channels!.slack = {
      ...slackBlock,
      botToken: 'xoxb-user-rotated',
      allowFrom: ['U123'],
      // The value the generator wrote before 2026-10-23.
      streaming: { mode: 'progress', progress: { toolProgress: true, commandText: 'status' } },
    };
    const merged = mergeOpenClawConfig(existing as unknown as Parameters<typeof mergeOpenClawConfig>[0], withSlack);
    const slack = merged.channels!.slack!;
    expect(slack.streaming).toEqual({
      mode: 'progress',
      progress: { toolProgress: true, commandText: 'raw' },
    });
    expect(slack.replyToModeByChatType).toEqual({ direct: 'all', group: 'all', channel: 'all' });
    expect(slack.botToken).toBe('xoxb-user-rotated');
    expect(slack.allowFrom).toEqual(['U123']);
  });

  it('keeps Slack streaming and reply threading the member chose', () => {
    const existing = generateOpenClawConfig(withSlack);
    const quiet = { progress: { style: 'card', toolProgress: false, nativeTaskCards: false }, mode: 'progress' };
    existing.channels!.slack = {
      ...existing.channels!.slack!,
      streaming: quiet as never,
      replyToModeByChatType: { direct: 'off', group: 'all', channel: 'all' },
    };
    const slack = mergeOpenClawConfig(existing as unknown as Parameters<typeof mergeOpenClawConfig>[0], withSlack).channels!.slack!;
    expect(slack.streaming).toEqual(quiet);
    expect(slack.replyToModeByChatType).toEqual({ direct: 'off', group: 'all', channel: 'all' });

    existing.channels!.slack!.streaming = { mode: 'off' };
    expect(mergeOpenClawConfig(existing as unknown as Parameters<typeof mergeOpenClawConfig>[0], withSlack).channels!.slack!.streaming).toEqual({ mode: 'off' });
  });

  it('treats the current platform value as ours whatever its key order', () => {
    const existing = generateOpenClawConfig(withSlack);
    existing.channels!.slack!.streaming = { progress: { commandText: 'raw', toolProgress: true }, mode: 'progress' } as never;
    const slack = mergeOpenClawConfig(existing as unknown as Parameters<typeof mergeOpenClawConfig>[0], withSlack).channels!.slack!;
    expect(JSON.stringify(slack.streaming)).toBe(JSON.stringify({ mode: 'progress', progress: { toolProgress: true, commandText: 'raw' } }));
  });

  it('replaces agents.defaults wholesale so thinkingDefault survives a redeploy', () => {
    const existing = generateOpenClawConfig(base);
    existing.agents!.defaults.thinkingDefault = 'medium';
    expect(mergeOpenClawConfig(existing as unknown as Parameters<typeof mergeOpenClawConfig>[0], base).agents!.defaults.thinkingDefault).toBe('low');
  });

  it('runs heartbeats in an isolated session by default and keeps a member-set per-agent heartbeat', () => {
    expect(generateOpenClawConfig(base).agents!.defaults.heartbeat).toEqual({ isolatedSession: true });
    const existing = generateOpenClawConfig(base) as unknown as Record<string, any>;
    delete existing.agents.defaults.heartbeat;
    existing.agents.entries = { main: { heartbeat: { every: '0m', isolatedSession: false } } };
    const merged = mergeOpenClawConfig(existing as Parameters<typeof mergeOpenClawConfig>[0], base) as unknown as Record<string, any>;
    expect(merged.agents.defaults.heartbeat).toEqual({ isolatedSession: true });
    expect(merged.agents.entries.main.heartbeat).toEqual({ every: '0m', isolatedSession: false });
  });

  it('keeps a member-set agents.defaults.heartbeat and only adds isolatedSession', () => {
    const existing = generateOpenClawConfig(base) as unknown as Record<string, any>;
    existing.agents.defaults.heartbeat = { every: '0m' };
    const merged = mergeOpenClawConfig(existing as Parameters<typeof mergeOpenClawConfig>[0], base) as unknown as Record<string, any>;
    expect(merged.agents.defaults.heartbeat).toEqual({ isolatedSession: true, every: '0m' });

    existing.agents.defaults.heartbeat = { isolatedSession: false };
    const optedOut = mergeOpenClawConfig(existing as Parameters<typeof mergeOpenClawConfig>[0], base) as unknown as Record<string, any>;
    expect(optedOut.agents.defaults.heartbeat).toEqual({ isolatedSession: false });
  });

  it('stops writing agents.defaults.heartbeat once OpenClaw 2026.11.5+ has taken the config over', () => {
    // From 11.5 the heartbeat is an automation and the key makes the config invalid.
    const merge = (version: string, heartbeat?: unknown) => {
      const existing = generateOpenClawConfig(base) as unknown as Record<string, any>;
      existing.meta = { lastTouchedVersion: version };
      if (heartbeat === undefined) delete existing.agents.defaults.heartbeat;
      else existing.agents.defaults.heartbeat = heartbeat;
      return (mergeOpenClawConfig(existing as Parameters<typeof mergeOpenClawConfig>[0], base) as unknown as Record<string, any>).agents.defaults;
    };
    // Doctor converted and removed it: it stays gone.
    expect(merge('2026.11.10')).not.toHaveProperty('heartbeat');
    expect(merge('2026.11.5')).not.toHaveProperty('heartbeat');
    expect(merge('2026.12.1')).not.toHaveProperty('heartbeat');
    expect(merge('2027.1.0')).not.toHaveProperty('heartbeat');
    // Our own block written back by an older API (Michael's instance, 2026-11-27): removed.
    expect(merge('2026.11.10', { isolatedSession: true })).not.toHaveProperty('heartbeat');
    // A setting Doctor could not convert is the member's to resolve: as found, nothing added.
    expect(merge('2026.11.10', { every: '0m' }).heartbeat).toEqual({ every: '0m' });
    // Not there yet: the key is still needed, and Doctor converts it at the first 11.5+ boot.
    expect(merge('2026.11.2').heartbeat).toEqual({ isolatedSession: true });
    expect(merge('2026.11.4', { every: '0m' }).heartbeat).toEqual({ isolatedSession: true, every: '0m' });
    expect(merge('2026.2.17').heartbeat).toEqual({ isolatedSession: true });
  });

  it('keeps agents.defaults.systemAgent, which OpenClaw writes on a multi-agent instance', () => {
    const existing = generateOpenClawConfig(base) as unknown as Record<string, any>;
    existing.agents.defaults.systemAgent = { agentId: 'main' };
    existing.agents.defaults.thinkingDefault = 'high';
    const merged = mergeOpenClawConfig(existing as Parameters<typeof mergeOpenClawConfig>[0], base) as unknown as Record<string, any>;
    expect(merged.agents.defaults.systemAgent).toEqual({ agentId: 'main' });
    // The rest of the block is still rewritten.
    expect(merged.agents.defaults.thinkingDefault).toBe('low');
    expect(generateOpenClawConfig(base).agents!.defaults).not.toHaveProperty('systemAgent');
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

describe('turn pipeline, DM session and secret-store defaults (2026-11-02)', () => {
  it('collects Slack bursts for 3 s, scopes DM sessions per peer and turns the egress proxy on', () => {
    const cfg = generateOpenClawConfig(base);
    expect(cfg.messages).toEqual({
      inbound: { byChannel: { slack: 3000 } },
      queue: { mode: 'collect', debounceMsByChannel: { slack: 3000 } },
    });
    expect(cfg.session).toEqual({ dmScope: 'per-channel-peer' });
    expect(cfg.secrets).toEqual({ egressProxy: { enabled: true } });
  });

  it('overlays those defaults without dropping what the member keeps in the same blocks', () => {
    const existing = {
      ...(generateOpenClawConfig(base) as unknown as Record<string, unknown>),
      messages: {
        groupChat: { mentionPatterns: ['@Kony2'] },
        queue: { mode: 'steer', debounceMsByChannel: { telegram: 500 } },
      },
      session: { dmScope: 'main', maintenance: { mode: 'warn' } },
      secrets: { egressProxy: { enabled: false, allowedHosts: ['api.notion.com'] }, providers: { vault: {} } },
    };
    const merged = mergeOpenClawConfig(existing, base) as unknown as Record<string, any>;
    expect(merged.messages).toEqual({
      groupChat: { mentionPatterns: ['@Kony2'] },
      inbound: { byChannel: { slack: 3000 } },
      queue: { mode: 'collect', debounceMsByChannel: { telegram: 500, slack: 3000 } },
    });
    expect(merged.session).toEqual({ dmScope: 'per-channel-peer', maintenance: { mode: 'warn' } });
    expect(merged.secrets).toEqual({
      egressProxy: { enabled: true, allowedHosts: ['api.notion.com'] },
      providers: { vault: {} },
    });
  });

  it('adds the blocks to a config that never had them', () => {
    const existing = generateOpenClawConfig(base) as unknown as Record<string, unknown>;
    delete existing.messages; delete existing.session; delete existing.secrets;
    const merged = mergeOpenClawConfig(existing, base);
    expect(merged.messages?.queue?.mode).toBe('collect');
    expect(merged.session?.dmScope).toBe('per-channel-peer');
    expect(merged.secrets?.egressProxy?.enabled).toBe(true);
  });
});

describe('secret-store providers (Notion)', () => {
  it('never treats a secret-kind key as a model provider', () => {
    const cfg = generateOpenClawConfig({ ...base, activeProviderIds: ['google', 'notion'] });
    expect(Object.keys(cfg.agents!.defaults.models).some((m) => m.startsWith('notion'))).toBe(false);
    expect(cfg.skills).toBeUndefined();
  });

  it('points the bundled skill at the store entry once the entry is known to exist', () => {
    const cfg = generateOpenClawConfig({ ...base, secretRefs: [{ skill: 'notion', name: 'NOTION_API_TOKEN' }] });
    expect(cfg.skills).toEqual({
      entries: { notion: { apiKey: { source: 'store', provider: 'default', id: 'NOTION_API_TOKEN' } } },
    });
  });

  it('overlays the ref onto the member\'s skills block and keeps their other skill settings', () => {
    const existing = {
      ...(generateOpenClawConfig(base) as unknown as Record<string, unknown>),
      skills: { entries: { notion: { enabled: true, env: { X: '1' } }, searxng: { enabled: false } }, load: { watch: true } },
    };
    const merged = mergeOpenClawConfig(existing, { ...base, secretRefs: [{ skill: 'notion', name: 'NOTION_API_TOKEN' }] }) as unknown as Record<string, any>;
    expect(merged.skills).toEqual({
      entries: {
        notion: { enabled: true, env: { X: '1' }, apiKey: { source: 'store', provider: 'default', id: 'NOTION_API_TOKEN' } },
        searxng: { enabled: false },
      },
      load: { watch: true },
    });
  });

  it('leaves an existing store ref alone when the store state is unknown, and drops it once the entry is known to be gone', () => {
    const withRef = {
      ...(generateOpenClawConfig(base) as unknown as Record<string, unknown>),
      skills: { entries: { notion: { apiKey: { source: 'store', provider: 'default', id: 'NOTION_API_TOKEN' } }, other: { apiKey: { source: 'store', provider: 'default', id: 'MY_OWN' } } } },
    };
    const unknown = mergeOpenClawConfig(withRef, base) as unknown as Record<string, any>;
    expect(unknown.skills.entries.notion.apiKey.id).toBe('NOTION_API_TOKEN');
    const known = mergeOpenClawConfig(withRef, { ...base, secretRefs: [] }) as unknown as Record<string, any>;
    expect(known.skills.entries.notion.apiKey).toBeUndefined();
    expect(known.skills.entries.other.apiKey.id).toBe('MY_OWN'); // not a platform-managed name
  });
});


describe('platform instructions hook (2026-11-13)', () => {
  const ENTRY = 'bootstrap-extra-files';
  const PATH = '.clawhuddle/AGENTS.md';
  type Any = Record<string, any>;
  const merge = (existing: Any) =>
    mergeOpenClawConfig(existing as Parameters<typeof mergeOpenClawConfig>[0], base) as unknown as Any;
  const withHooks = (hooks: unknown): Any => ({ ...(generateOpenClawConfig(base) as unknown as Any), hooks });

  it('loads our file via a named entry only, without the master flag (no other hook is switched on)', () => {
    const cfg = generateOpenClawConfig(base) as unknown as Any;
    expect(cfg.hooks).toEqual({ internal: { entries: { [ENTRY]: { enabled: true, paths: [PATH] } } } });
  });

  it('adds the entry to a config without hooks, once', () => {
    const existing = withHooks(undefined);
    delete existing.hooks;
    const once = merge(existing);
    expect(once.hooks.internal.entries[ENTRY]).toEqual({ enabled: true, paths: [PATH] });
    expect(once.hooks.internal).not.toHaveProperty('enabled');
    expect(merge(once).hooks.internal.entries[ENTRY].paths).toEqual([PATH]);
  });

  it("keeps the member's other hooks, webhook settings and own paths", () => {
    const merged = merge(withHooks({
      enabled: true,
      token: 'webhook-token',
      internal: { entries: { 'command-logger': { enabled: true }, [ENTRY]: { paths: ['packages/*/AGENTS.md'] } } },
    }));
    expect(merged.hooks.enabled).toBe(true);
    expect(merged.hooks.token).toBe('webhook-token');
    expect(merged.hooks.internal.entries['command-logger']).toEqual({ enabled: true });
    expect(merged.hooks.internal.entries[ENTRY]).toEqual({ enabled: true, paths: ['packages/*/AGENTS.md', PATH] });
  });

  it('joins the list the member uses when it is patterns rather than paths', () => {
    const merged = merge(withHooks({ internal: { entries: { [ENTRY]: { enabled: true, patterns: ['docs/AGENTS.md'] } } } }));
    expect(merged.hooks.internal.entries[ENTRY]).toEqual({ enabled: true, patterns: ['docs/AGENTS.md', PATH] });
  });

  it('leaves hooks alone when the member turned them or our hook off, or relies on open-ended discovery', () => {
    for (const hooks of [
      { internal: { enabled: false } },
      { internal: { entries: { [ENTRY]: { enabled: false } } } },
      { internal: { enabled: true } },
      { internal: { enabled: true, entries: { 'session-memory': { enabled: false } } } },
    ]) {
      expect(merge(withHooks(hooks)).hooks).toEqual(hooks);
    }
  });
});
