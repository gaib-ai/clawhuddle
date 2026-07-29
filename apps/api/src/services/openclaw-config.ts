import { PROVIDERS } from '@clawhuddle/shared';

// Channel plugins that have working dependencies in the Docker image.
// Excluded: matrix, nostr, tlon, twitch (missing npm modules in OpenClaw image)
const CHANNEL_PLUGINS = [
  'telegram',
  'whatsapp',
  'discord',
  'slack',
  'signal',
  'imessage',
  'irc',
  'googlechat',
  'msteams',
  'mattermost',
  'line',
  'feishu',
  'zalo',
  'zalouser',
];

export interface ChannelTokens {
  telegram?: string;
  discord?: string;
  slack?: string;
}

export interface OpenClawConfig {
  meta: {
    lastTouchedVersion: string;
    lastTouchedAt: string;
  };
  commands: {
    native: string;
    nativeSkills: string;
    config: boolean;
  };
  env?: Record<string, string>;
  models?: {
    providers: Record<string, {
      baseUrl: string;
      apiKey: string;
      api: string;
      models: {
        id: string;
        name: string;
        reasoning?: boolean;
        input?: string[];
        cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
        contextWindow: number;
        maxTokens: number;
      }[];
    }>;
  };
  gateway: {
    mode: string;
    port: number;
    bind: string;
    controlUi: {
      enabled: boolean;
      allowInsecureAuth: boolean;
      allowedOrigins?: string[];
      dangerouslyAllowHostHeaderOriginFallback?: boolean;
    };
    auth: {
      mode: string;
      token: string;

    };
    trustedProxies?: string[];
  };
  agents?: {
    defaults: {
      model: { primary: string; fallbacks?: string[] };
      models: Record<string, Record<string, never>>;
    };
  };
  channels?: Record<string, { enabled: boolean; botToken: string; dmPolicy?: string; allowFrom?: string[] }>;
  plugins: {
    entries: Record<string, { enabled: boolean }>;
  };
}

export function generateOpenClawConfig(options: {
  port: number;
  token: string;
  enabledChannels?: string[];
  activeProviderIds?: string[];
  /** Per-provider model overrides from DB (provider id -> model id) */
  modelOverrides?: Record<string, string>;
  channelTokens?: ChannelTokens;
  /** Explicit allowed origins for Control UI (e.g. ["https://claw-xx.example.com"]) */
  allowedOrigins?: string[];
  /** Use Host-header fallback for origin check (local dev only) */
  useHostHeaderFallback?: boolean;
  /** Claw-proxy configuration (custom provider for Claude Max subscriptions) */
  clawProxy?: { baseUrl: string; apiKey: string };
  /** Token Kiosk configuration (custom provider; OpenAI-compatible gateway) */
  tokenKiosk?: { baseUrl: string; apiKey: string };
  /**
   * Provider id pinned by the org as the primary model. If set AND the user has a key
   * for it, that provider becomes agents.defaults.model.primary; otherwise falls back
   * to the natural (alphabetical) order of activeProviderIds.
   */
  primaryProviderId?: string;
}): OpenClawConfig {
  const { port, token } = options;
  const channels = options.enabledChannels ?? CHANNEL_PLUGINS;

  const pluginEntries: Record<string, { enabled: boolean }> = {};
  for (const ch of channels) {
    pluginEntries[ch] = { enabled: true };
  }

  const config: OpenClawConfig = {
    meta: {
      lastTouchedVersion: '2026.2.17',
      lastTouchedAt: new Date().toISOString(),
    },
    commands: {
      native: 'auto',
      nativeSkills: 'auto',
      config: true,
    },
    gateway: {
      mode: 'local',
      port,
      bind: 'loopback',
      controlUi: {
        enabled: true,
        allowInsecureAuth: true,
        ...(options.allowedOrigins?.length ? { allowedOrigins: options.allowedOrigins } : {}),
        ...(options.useHostHeaderFallback ? { dangerouslyAllowHostHeaderOriginFallback: true } : {}),
      },
      auth: {
        mode: 'token',
        token,

      },
      trustedProxies: [
          // Local / private ranges
          '127.0.0.0/8',
          '10.0.0.0/8',
          '172.16.0.0/12',
          '192.168.0.0/16',
          // Cloudflare IPv4 — https://www.cloudflare.com/ips-v4/
          '173.245.48.0/20',
          '103.21.244.0/22',
          '103.22.200.0/22',
          '103.31.4.0/22',
          '141.101.64.0/18',
          '108.162.192.0/18',
          '190.93.240.0/20',
          '188.114.96.0/20',
          '197.234.240.0/22',
          '198.41.128.0/17',
          '162.158.0.0/15',
          '172.64.0.0/13',
          '131.0.72.0/22',
          '104.16.0.0/13',
          '104.24.0.0/14',
        ],
    },
    plugins: {
      entries: pluginEntries,
    },
  };

  // Register custom OpenClaw providers (claw-proxy, Token Kiosk)
  const customProviders: NonNullable<OpenClawConfig['models']>['providers'] = {};
  if (options.clawProxy) {
    customProviders.claw = {
      baseUrl: options.clawProxy.baseUrl,
      apiKey: options.clawProxy.apiKey,
      api: 'openai-completions',
      models: [
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', reasoning: true, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 32000 },
        { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', reasoning: true, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 32000 },
        { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', reasoning: true, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 16000 },
        { id: 'claude-opus-4', name: 'Claude Opus 4', reasoning: true, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 32000 },
        { id: 'claude-haiku-4', name: 'Claude Haiku 4', input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 16000 },
      ],
    };
  }
  if (options.tokenKiosk) {
    // Model ids keep the kiosk's own <provider>/<model> prefix — the gateway
    // routes on it, so OpenClaw refs look like tokenkiosk/azure/gpt-5.5.
    customProviders.tokenkiosk = {
      baseUrl: options.tokenKiosk.baseUrl,
      apiKey: options.tokenKiosk.apiKey,
      api: 'openai-completions',
      models: [
        { id: 'azure/gpt-5.5', name: 'Azure GPT-5.5', reasoning: true, input: ['text', 'image'], cost: { input: 5, output: 30, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1050000, maxTokens: 32000 },
        { id: 'azure/gpt-5.6-sol', name: 'Azure GPT-5.6 Sol', reasoning: true, input: ['text', 'image'], cost: { input: 5, output: 30, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1050000, maxTokens: 32000 },
        { id: 'bedrock/kimi-k2.5', name: 'AWS Bedrock Kimi K2.5', input: ['text'], cost: { input: 0.72, output: 3.6, cacheRead: 0, cacheWrite: 0 }, contextWindow: 256000, maxTokens: 16000 },
        { id: 'bedrock/kimi-k2-thinking', name: 'AWS Bedrock Kimi K2 Thinking', reasoning: true, input: ['text'], cost: { input: 0.73, output: 3.03, cacheRead: 0, cacheWrite: 0 }, contextWindow: 256000, maxTokens: 16000 },
        { id: 'bedrock/claude-opus-4-7', name: 'AWS Bedrock Claude Opus 4.7', reasoning: true, input: ['text', 'image'], cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 32000 },
        { id: 'bedrock/claude-opus-4-6', name: 'AWS Bedrock Claude Opus 4.6', reasoning: true, input: ['text', 'image'], cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 32000 },
        { id: 'bedrock/claude-opus-4-5-20251101', name: 'AWS Bedrock Claude Opus 4.5', reasoning: true, input: ['text', 'image'], cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 32000 },
      ],
    };
  }
  if (Object.keys(customProviders).length > 0) {
    config.models = { providers: customProviders };
  }

  // Set default model based on active providers so OpenClaw doesn't
  // fall back to Anthropic when only another provider's key exists.
  // If the org pinned a primary provider AND the user has a key for it,
  // hoist that provider to the front so its model becomes primary.
  let activeProviders = (options.activeProviderIds ?? [])
    .map((id) => PROVIDERS.find((p) => p.id === id))
    .filter(Boolean) as typeof PROVIDERS;

  if (options.primaryProviderId) {
    const pinnedIdx = activeProviders.findIndex((p) => p.id === options.primaryProviderId);
    if (pinnedIdx > 0) {
      const pinned = activeProviders[pinnedIdx];
      activeProviders = [pinned, ...activeProviders.slice(0, pinnedIdx), ...activeProviders.slice(pinnedIdx + 1)];
    }
  }

  if (activeProviders.length > 0) {
    const overrides = options.modelOverrides ?? {};
    const models: Record<string, Record<string, never>> = {};
    // Use user-selected model if set, otherwise provider default
    const resolveModel = (p: (typeof PROVIDERS)[number]) => overrides[p.id] || p.defaultModel;

    for (const p of activeProviders) {
      models[resolveModel(p)] = {};
    }
    const primary = resolveModel(activeProviders[0]);
    const fallbacks = activeProviders.slice(1).map((p) => resolveModel(p));

    config.agents = {
      defaults: {
        model: { primary, ...(fallbacks.length > 0 ? { fallbacks } : {}) },
        models,
      },
    };
  }

  // Configure channel tokens (e.g. Telegram bot token)
  const ct = options.channelTokens;
  if (ct) {
    const channelsCfg: NonNullable<OpenClawConfig['channels']> = {};
    if (ct.telegram) {
      channelsCfg.telegram = { enabled: true, botToken: ct.telegram, dmPolicy: 'pairing' };
    }
    if (ct.discord) {
      channelsCfg.discord = { enabled: true, botToken: ct.discord };
    }
    if (ct.slack) {
      channelsCfg.slack = { enabled: true, botToken: ct.slack };
    }
    if (Object.keys(channelsCfg).length > 0) {
      config.channels = channelsCfg;
    }
  }

  return config;
}

/**
 * Merge platform-managed fields into an existing OpenClaw config,
 * preserving any user customizations (custom agent settings, extra fields, etc.).
 */
export function mergeOpenClawConfig(
  existing: Record<string, unknown>,
  options: Parameters<typeof generateOpenClawConfig>[0],
): OpenClawConfig {
  const generated = generateOpenClawConfig(options);

  // Deep clone existing to avoid mutation
  const merged = JSON.parse(JSON.stringify(existing)) as Record<string, unknown>;

  // Platform-managed: meta
  merged.meta = generated.meta;

  // Platform-managed: gateway auth, port, bind, controlUi, trustedProxies
  // (preserve any user-added gateway fields like custom mode settings)
  if (typeof merged.gateway !== 'object' || merged.gateway === null) {
    merged.gateway = {};
  }
  const gw = merged.gateway as Record<string, unknown>;
  gw.mode = generated.gateway.mode;
  gw.auth = generated.gateway.auth;
  gw.port = generated.gateway.port;
  gw.bind = generated.gateway.bind;
  gw.controlUi = generated.gateway.controlUi;
  gw.trustedProxies = generated.gateway.trustedProxies;

  // Platform-managed: models.providers (custom providers: claw-proxy, Token Kiosk)
  if (generated.models) {
    merged.models = generated.models;
  } else {
    delete merged.models;
  }

  // Clean up legacy env.OPENAI_BASE_URL if present
  if (merged.env && typeof merged.env === 'object') {
    delete (merged.env as Record<string, unknown>).OPENAI_BASE_URL;
    if (Object.keys(merged.env as object).length === 0) delete merged.env;
  }

  // Platform-managed: agents.defaults.model + agents.defaults.models
  if (generated.agents) {
    if (typeof merged.agents !== 'object' || merged.agents === null) {
      merged.agents = {};
    }
    (merged.agents as Record<string, unknown>).defaults = generated.agents.defaults;
  } else if (merged.agents && typeof merged.agents === 'object') {
    // No active providers — clear managed defaults but preserve other agent settings
    delete (merged.agents as Record<string, unknown>).defaults;
  }

  // Channels: initialize missing channels from generated, but preserve any
  // existing user customization (multi-account structures, group allowlists,
  // custom tokens, etc.). Once a channel exists in user config, the user owns it.
  // Never delete user's channels — they may have added accounts manually.
  if (generated.channels) {
    if (typeof merged.channels !== 'object' || merged.channels === null) {
      merged.channels = {};
    }
    const mergedChannels = merged.channels as Record<string, unknown>;
    for (const [channelId, channelCfg] of Object.entries(generated.channels)) {
      if (!(channelId in mergedChannels)) {
        mergedChannels[channelId] = channelCfg;
      }
    }
  }

  // Plugins: merge entries so user-added plugins (e.g. openai, anthropic)
  // are preserved. For platform-managed entries, shallow-merge so any extra
  // fields the user added on the same entry are kept.
  if (typeof merged.plugins !== 'object' || merged.plugins === null) {
    merged.plugins = { entries: {} };
  }
  const mergedPlugins = merged.plugins as { entries?: Record<string, { enabled: boolean }> };
  if (typeof mergedPlugins.entries !== 'object' || mergedPlugins.entries === null) {
    mergedPlugins.entries = {};
  }
  for (const [pluginId, pluginCfg] of Object.entries(generated.plugins.entries)) {
    mergedPlugins.entries[pluginId] = { ...(mergedPlugins.entries[pluginId] ?? {}), ...pluginCfg };
  }

  return merged as unknown as OpenClawConfig;
}
