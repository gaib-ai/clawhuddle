import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { PROVIDERS, hermesModelRef } from '@clawhuddle/shared';
import {
  buildHermesManaged,
  hermesDashboardEnv,
  hermesGoogleClientFile,
  hermesPlatformSkills,
  renderHermesEnv,
  seedHermesConfig,
  type HermesKey,
} from './hermes-config.js';

const key = (provider: string, value: string, extra: Partial<HermesKey> = {}): HermesKey => ({
  provider, key: value, credential_type: 'api_key', default_model: null, ...extra,
});

describe('buildHermesManaged', () => {
  it('turns a Gemini key into the managed env and the default model', () => {
    const m = buildHermesManaged({ keys: [key('google', 'AIza-1')] });
    expect(m.env).toEqual({ GOOGLE_API_KEY: 'AIza-1' });
    expect(m.providerIds).toEqual(['google']);
    expect(m.primary).toBe('gemini/gemini-3.8-flash');
    expect(m.config).toEqual({
      model: { provider: 'gemini', default: 'gemini-3.8-flash', base_url: '' },
      fallback_providers: [],
    });
  });

  it('keeps the first key per variable, which is the member\'s own', () => {
    const m = buildHermesManaged({ keys: [key('google', 'personal'), key('google', 'org-default')] });
    expect(m.env.GOOGLE_API_KEY).toBe('personal');
    expect(m.providerIds).toEqual(['google']);
  });

  it('follows a model pin to Token Kiosk and declares the endpoint', () => {
    const m = buildHermesManaged({
      keys: [key('google', 'AIza-1'), key('token-kiosk', 'sk-kiosk')],
      primaryModel: 'tokenkiosk/claude-sonnet-5',
    });
    expect(m.env).toEqual({ GOOGLE_API_KEY: 'AIza-1', TOKEN_KIOSK_API_KEY: 'sk-kiosk' });
    expect(m.config).toMatchObject({
      model: { provider: 'custom:tokenkiosk', default: 'claude-sonnet-5' },
      fallback_providers: [{ provider: 'gemini', model: 'gemini-3.8-flash' }],
      providers: {
        tokenkiosk: {
          base_url: 'https://agent-router.gaib.ai/v1', key_env: 'TOKEN_KIOSK_API_KEY', api_mode: 'chat_completions',
          // What the dashboard's model picker lists: the Home card's pick-list, nothing discovered.
          models: ['azure/gpt-5.5', 'claude-sonnet-5', 'minimax-m3.1-flash'],
          discover_models: false,
        },
      },
    });
    // The key itself is only ever in the env file, never in the config.
    expect(JSON.stringify(m.config)).not.toContain('sk-kiosk');
  });

  it('also lists an older pin the instance still runs on, so the picker shows the current model', () => {
    const m = buildHermesManaged({ keys: [key('token-kiosk', 'sk-kiosk')], primaryModel: 'tokenkiosk/claude-opus-latest' });
    expect(m.primary).toBe('custom:tokenkiosk/claude-opus-latest');
    expect((m.config as any).providers.tokenkiosk.models).toEqual(['azure/gpt-5.5', 'claude-sonnet-5', 'minimax-m3.1-flash', 'claude-opus-latest']);
  });

  it('ignores a model pin whose provider has no key', () => {
    const m = buildHermesManaged({ keys: [key('google', 'AIza-1')], primaryModel: 'tokenkiosk/azure/gpt-5.5' });
    expect(m.primary).toBe('gemini/gemini-3.8-flash');
  });

  it('uses the first provider with a key when there is no Google key', () => {
    const m = buildHermesManaged({ keys: [key('claw-proxy', 'bearer-1')] });
    expect(m.primary).toBe('custom:claw/claude-sonnet-4-6');
    expect(m.config).toMatchObject({ providers: { claw: { base_url: 'http://claw-proxy:3456/v1', key_env: 'CLAW_PROXY_API_KEY', api_mode: 'chat_completions' } } });
    const claw = (m.config as any).providers.claw;
    expect(claw.models).toContain('claude-sonnet-4-6');
    expect(claw.discover_models).toBe(false);
  });

  it('writes an Anthropic setup token under its own variable', () => {
    const m = buildHermesManaged({ keys: [key('anthropic', 'sk-ant-oat', { credential_type: 'token' })] });
    expect(m.env).toEqual({ ANTHROPIC_TOKEN: 'sk-ant-oat' });
    expect(m.primary).toBe('anthropic/claude-fable-5');
  });

  it('skips credentials Hermes cannot use: OAuth JSON and providers without a mapping', () => {
    const m = buildHermesManaged({
      keys: [key('anthropic', '{"claudeAiOauth":{}}', { credential_type: 'oauth' }), key('openai-codex', '{"tokens":{}}', { credential_type: 'oauth' })],
    });
    expect(m.env).toEqual({});
    expect(m.providerIds).toEqual([]);
    expect(m.config).toBeNull();
    expect(m.primary).toBeNull();
  });

  it('treats Notion as a plain variable, never as a model provider', () => {
    const m = buildHermesManaged({ keys: [key('notion', 'ntn_1')] });
    expect(m.env).toEqual({ NOTION_API_KEY: 'ntn_1' });
    expect(m.notion).toBe(true);
    expect(m.providerIds).toEqual([]);
    expect(m.config).toBeNull();
  });

  it('hands the Google OAuth client over separately, not through the env', () => {
    const client = '{"installed":{"client_id":"id","client_secret":"GOCSPX-x"}}';
    const m = buildHermesManaged({ keys: [key('google', 'AIza-1'), key('google-workspace', client)] });
    expect(m.googleClient).toBe(client);
    expect(Object.values(m.env).join(' ')).not.toContain('GOCSPX');
  });

  it('adds the instance\'s channel tokens', () => {
    const m = buildHermesManaged({
      keys: [key('google', 'AIza-1')],
      channelTokens: { slack: { botToken: 'xoxb-1', appToken: 'xapp-1' }, telegram: 'tg-1', discord: 'dc-1' },
    });
    expect(m.env).toMatchObject({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_APP_TOKEN: 'xapp-1', TELEGRAM_BOT_TOKEN: 'tg-1', DISCORD_BOT_TOKEN: 'dc-1' });
  });

  it('ignores a per-key default model the provider no longer offers', () => {
    const m = buildHermesManaged({
      keys: [key('google', 'AIza-1'), key('token-kiosk', 'sk-kiosk', { default_model: 'tokenkiosk/minimax-m3.1-flash:free' })],
    });
    expect(m.config).toMatchObject({ fallback_providers: [{ provider: 'custom:tokenkiosk', model: 'azure/gpt-5.5' }] });
    const pinned = buildHermesManaged({
      keys: [key('token-kiosk', 'sk-kiosk', { default_model: 'tokenkiosk/minimax-m3.1-flash:free' })],
      primaryProviderId: 'token-kiosk',
    });
    expect(pinned.primary).toBe('custom:tokenkiosk/azure/gpt-5.5');
  });

  it('honours a per-key default model', () => {
    const m = buildHermesManaged({ keys: [key('google', 'AIza-1', { default_model: 'google/gemini-4-neon' })], primaryProviderId: 'google' });
    expect(m.primary).toBe('gemini/gemini-4-neon');
  });
});

describe('hermesModelRef', () => {
  it('maps every offered model of every Hermes-capable provider', () => {
    for (const p of PROVIDERS) {
      for (const m of p.models ?? []) {
        const ref = hermesModelRef(p, m.id);
        if (!p.hermes?.provider) {
          expect(ref, m.id).toBeNull();
          continue;
        }
        expect(ref?.provider, m.id).toBe(p.hermes.provider);
        expect(ref?.model, m.id).toBe(m.id.slice(m.id.indexOf('/') + 1));
        expect(ref?.model, m.id).not.toBe('');
      }
    }
  });

  it('keeps the kiosk\'s own provider prefix', () => {
    const kiosk = PROVIDERS.find((p) => p.id === 'token-kiosk')!;
    expect(hermesModelRef(kiosk, 'tokenkiosk/azure/gpt-5.5')).toEqual({ provider: 'custom:tokenkiosk', model: 'azure/gpt-5.5' });
  });
});

describe('renderHermesEnv', () => {
  it('sorts, quotes and escapes, and drops line breaks and bad names', () => {
    const text = renderHermesEnv({ B_KEY: 'has "quotes" and \\ slash', A_KEY: 'two\nlines', 'bad name': 'x' });
    expect(text.split('\n').slice(1)).toEqual([
      'A_KEY="twolines"',
      'B_KEY="has \\"quotes\\" and \\\\ slash"',
      '',
    ]);
    expect(text.startsWith('#')).toBe(true);
  });

  it('is stable for the same input in any order', () => {
    expect(renderHermesEnv({ A: '1', B: '2' })).toBe(renderHermesEnv({ B: '2', A: '1' }));
  });
});

describe('hermesDashboardEnv', () => {
  const g = { token: 'a'.repeat(48), subdomain: 'claw-abc12345' };

  it('never puts the password itself into the container environment', () => {
    const env = hermesDashboardEnv(g, 'https://claw-abc12345.example.com');
    expect(env.join('\n')).not.toContain(g.token);
    expect(env).toContain('HERMES_DASHBOARD=1');
    expect(env).toContain('HERMES_DASHBOARD_BASIC_AUTH_USERNAME=claw-abc12345');
    expect(env).toContain('HERMES_DASHBOARD_PUBLIC_URL=https://claw-abc12345.example.com');
  });

  it('carries a scrypt hash the token verifies against', () => {
    const line = hermesDashboardEnv(g, 'https://x.example.com').find((l) => l.startsWith('HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH='))!;
    const [scheme, n, r, p, salt, dk] = line.slice(line.indexOf('=') + 1).split('$');
    expect([scheme, n, r, p]).toEqual(['scrypt', '16384', '8', '1']);
    const again = crypto.scryptSync(Buffer.from(g.token), Buffer.from(salt, 'base64'), 32, { N: 16384, r: 8, p: 1 });
    expect(again.toString('base64')).toBe(dk);
  });

  it('is the same on every redeploy and changes with the token', () => {
    expect(hermesDashboardEnv(g, 'https://x.example.com')).toEqual(hermesDashboardEnv(g, 'https://x.example.com'));
    const other = hermesDashboardEnv({ ...g, token: 'b'.repeat(48) }, 'https://x.example.com');
    expect(other[3]).not.toBe(hermesDashboardEnv(g, 'https://x.example.com')[3]);
    expect(other[4]).not.toBe(hermesDashboardEnv(g, 'https://x.example.com')[4]);
  });
});

describe('hermesGoogleClientFile', () => {
  it('keeps an installed client and fills in Google\'s endpoints', () => {
    const out = JSON.parse(hermesGoogleClientFile('{"installed":{"client_id":"id","client_secret":"s","project_id":"p"}}')!);
    expect(out.installed).toMatchObject({ client_id: 'id', client_secret: 's', project_id: 'p', token_uri: 'https://oauth2.googleapis.com/token' });
  });

  it('wraps a web client or a bare object as installed', () => {
    for (const raw of ['{"web":{"client_id":"id","client_secret":"s"}}', '{"client_id":"id","client_secret":"s"}']) {
      const out = JSON.parse(hermesGoogleClientFile(raw)!);
      expect(Object.keys(out)).toEqual(['installed']);
      expect(out.installed.client_id).toBe('id');
      expect(out.installed.redirect_uris).toEqual(['http://localhost']);
    }
  });

  it('returns null for anything that is not a client', () => {
    expect(hermesGoogleClientFile('not json')).toBeNull();
    expect(hermesGoogleClientFile('{"installed":{"client_id":"id"}}')).toBeNull();
  });
});

describe('platform files', () => {
  it('always ships the platform note, and Notion only with a key', () => {
    expect(hermesPlatformSkills({ notion: false, google: false }).map((s) => s.name)).toEqual(['clawhuddle-platform']);
    const withNotion = hermesPlatformSkills({ notion: true, google: true });
    expect(withNotion.map((s) => s.name)).toEqual(['clawhuddle-platform', 'notion']);
    expect(withNotion[0].content).toContain('## Notion');
    expect(withNotion[0].content).toContain('## Google');
    for (const s of withNotion) expect(s.content.startsWith('---\nname: ')).toBe(true);
  });

  it('seeds a config with the workspace, light reasoning and a safe time zone', () => {
    expect(seedHermesConfig('Asia/Singapore')).toContain('timezone: Asia/Singapore');
    expect(seedHermesConfig('Asia/Singapore')).toContain('cwd: /opt/data/workspace');
    expect(seedHermesConfig('x: y\nmodel: evil')).toContain('timezone: UTC');
  });
});
