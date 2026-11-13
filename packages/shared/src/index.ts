export * from './api-token.js';

// === Tier System ===

export type OrgTier = 'free' | 'pro' | 'enterprise';

/** Default member limit per org. Override via MAX_MEMBERS_PER_ORG env var. */
export const DEFAULT_MAX_MEMBERS = 50;

/**
 * Default number of gateway instances one member may run. Override platform-wide
 * via MAX_GATEWAYS_PER_USER; per org via organizations.max_gateways_per_user;
 * per member via org_members.max_gateways (most specific wins).
 */
export const DEFAULT_MAX_GATEWAYS_PER_USER = 1;

// === Database Row Types ===

export interface Organization {
  id: string;
  name: string;
  slug: string;
  tier: OrgTier;
  /** Provider id (e.g. "openai-codex") pinned by admin as agents.defaults.model.primary. Null = alphabetical fallback. */
  primary_provider: string | null;
  /**
   * Model ref (e.g. "google/gemini-4-argon") pinned by admin within
   * primary_provider. Null = that provider's default (or the org key's model
   * override). Cleared whenever primary_provider changes.
   */
  primary_model: string | null;
  /** Gateway instances each member may run. Null = platform default. */
  max_gateways_per_user: number | null;
  created_at: string;
}

export interface UpdateOrgRequest {
  /** Pass null to clear the pin and fall back to alphabetical ordering. */
  primary_provider?: string | null;
  /** One of the pinned provider's MODEL_IDS, or null for the provider default. */
  primary_model?: string | null;
  /** Integer >= 1, or null to follow the platform default. */
  max_gateways_per_user?: number | null;
}

/**
 * owner > admin > maintainer > member. A maintainer only sees the Members
 * table, only the rows of plain members (plus their own), and only manages
 * those members' instances: no invites, role/status/limit changes or keys.
 */
export type OrgRole = 'owner' | 'admin' | 'maintainer' | 'member';

export interface OrgMember {
  id: string;
  org_id: string;
  user_id: string;
  role: OrgRole;
  status: 'active' | 'disabled';
  /**
   * Mirror of the member's slot-1 gateway (see `Gateway`), kept so an older
   * platform build still finds the first instance. New code reads `gateways`.
   */
  gateway_port: number | null;
  gateway_status: GatewayStatus | null;
  gateway_token: string | null;
  gateway_subdomain: string | null;
  /** Personal primary-provider pin; null = follow the org. */
  primary_provider?: string | null;
  /** Per-member cap on gateway instances. Null = follow the org. */
  max_gateways: number | null;
  joined_at: string;
  email?: string;
  name?: string;
  avatar_url?: string;
  /** Members list only: this member's instances (tokens stripped) and limit. */
  gateways?: GatewaySummary[];
  gateway_count?: number;
  effective_max_gateways?: number;
}

export type GatewayStatus = 'running' | 'stopped' | 'deploying' | 'provisioning';

/** One OpenClaw container. A member may own several, numbered by `slot`. */
export interface Gateway {
  id: string;
  org_id: string;
  member_id: string;
  slot: number;
  label: string | null;
  status: GatewayStatus | null;
  port: number | null;
  /** Bearer credential for the Control UI; only returned to the owner or via the access route. */
  token: string | null;
  subdomain: string;
  /** Per-instance primary-provider pin; null = follow the member, then the org. */
  primary_provider: string | null;
  /** Per-instance model pin (full ref, provider implied); wins over primary_provider. */
  primary_model: string | null;
  created_at: string;
  container_id?: string | null;
  user_id?: string;
  email?: string;
  name?: string | null;
  member_role?: string;
}

export type GatewaySummary = Omit<Gateway, 'token'>;

export interface CreateGatewayRequest {
  label?: string;
}

export interface UpdateGatewayRequest {
  label?: string | null;
  primary_provider?: string | null;
  /** Full model ref from MODEL_IDS; its provider is implied. Null = follow the org/member default. */
  primary_model?: string | null;
}

/**
 * A browser or device waiting to be let into an instance's Control UI — one
 * entry of OpenClaw's `devices list --json` pending list, public key dropped.
 */
export interface DevicePairingRequest {
  requestId: string;
  deviceId: string;
  displayName?: string;
  platform?: string;
  deviceFamily?: string;
  clientId?: string;
  clientMode?: string;
  browserOrigin?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  remoteIp?: string;
  /** The device was paired before and is asking again (e.g. after a token reset). */
  isRepair?: boolean;
  /** Requested at, epoch ms. */
  ts: number;
}

/** A pending request together with the instance it is waiting on. */
export interface GatewayDeviceRequest extends DevicePairingRequest {
  gateway: GatewaySummary;
}

export interface DeviceRequestList {
  data: GatewayDeviceRequest[];
  /** Running instances whose pending list could not be read. */
  errors: { gateway_id: string; message: string }[];
}

/** Token counts and OpenClaw's list-price cost estimate (USD) for a set of model calls. */
export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  totalCost: number;
  /** Calls whose model has no price in OpenClaw's catalog (cost counted as 0). */
  missingCostEntries: number;
}

/** Usage windows the usage route accepts, in days ending today (UTC). */
export const USAGE_RANGES = [1, 7, 30, 90] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

/**
 * One instance's LLM usage over a date range, condensed from OpenClaw's
 * `sessions.usage` gateway method. Aggregates only: no session titles,
 * participants or message content.
 */
export interface GatewayUsage {
  gateway_id: string;
  startDate: string;
  endDate: string;
  /** When OpenClaw computed it, epoch ms. */
  updatedAt: number;
  /** `fresh` = complete; otherwise OpenClaw is still indexing transcripts and totals may be low. */
  cacheStatus: string;
  totals: UsageTotals;
  sessions: number;
  messages: { user: number; assistant: number; toolCalls: number; errors: number };
  byModel: { provider: string; model: string; calls: number; totals: UsageTotals }[];
  /** Tokens by chat channel; `other` = sessions with no channel (cron, heartbeat, Control UI). */
  byChannel: { channel: string; tokens: number; cost: number }[];
  daily: { date: string; tokens: number; cost: number; messages: number; errors: number }[];
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  status: 'active' | 'disabled';
  created_at: string;
  last_login: string | null;
}

export interface Skill {
  id: string;
  name: string;
  description: string | null;
  type: 'mandatory' | 'optional' | 'restricted';
  path: string;
  git_url: string | null;
  git_path: string | null;
  org_id: string | null;
  enabled: boolean;
  created_at: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

// === API Request/Response Types ===

export interface CreateOrgRequest {
  name: string;
  slug?: string;
}

export interface InviteMemberRequest {
  email: string;
  role?: 'admin' | 'maintainer' | 'member';
}

export interface UpdateMemberRequest {
  role?: OrgRole;
  status?: 'active' | 'disabled';
  /** Integer >= 1, or null to follow the org default. */
  max_gateways?: number | null;
}

export interface AcceptInviteRequest {
  token: string;
}

export interface CreateSkillRequest {
  name: string;
  description?: string;
  type?: 'mandatory' | 'optional' | 'restricted';
  path?: string;
  git_url: string;
  git_path: string;
}

export interface UpdateSkillRequest {
  type?: 'mandatory' | 'optional' | 'restricted';
  enabled?: boolean;
  git_url?: string;
  git_path?: string;
}

export interface ScanRepoRequest {
  git_url: string;
}

export interface ScanRepoResult {
  name: string;
  git_path: string;
}

export interface ImportSkillsRequest {
  git_url: string;
  skills: { name: string; git_path: string }[];
}

export interface BatchUpdateUserSkillsRequest {
  skills: { id: string; enabled: boolean }[];
}

// === Provider Registry ===

export type CredentialType = 'api_key' | 'token' | 'oauth';

export interface ModelOption {
  id: string;
  label: string;
}

export interface ProviderConfig {
  id: string;
  label: string;
  envVar: string;
  placeholder: string;
  /** Model ID used for agents.defaults.model in openclaw.json */
  defaultModel: string;
  /**
   * OpenClaw agent runtime that serves this provider's models, written as
   * `agents.defaults.models[<id>].agentRuntime`. Set it for subscriptions whose
   * models come from a runtime and its linked account rather than from a
   * provider API: enabling such a plugin takes the model out of the built-in
   * catalog, and without this OpenClaw looks it up in
   * `models.providers[...].models[]`, finds nothing, and fails every agent turn
   * with "Unknown model".
   */
  agentRuntime?: string;
  /** Available models the user can choose from */
  models?: ModelOption[];
  /**
   * Model ids no longer offered in `models` but still recognised, so an
   * instance or org already pinned to one keeps that pin (providerForModel)
   * instead of silently falling back to the provider default.
   */
  retiredModels?: string[];
  /** Whether this provider supports setup tokens (e.g. `claude setup-token`) */
  supportsSetupToken?: boolean;
  /** Instructions shown in UI for obtaining a setup token */
  setupTokenInstructions?: string;
  /** Whether this provider supports OAuth token paste (e.g. Codex auth.json) */
  supportsOAuth?: boolean;
  /** Instructions shown in UI for obtaining OAuth tokens */
  oauthInstructions?: string;
  /**
   * Whether individual members can set a personal key that overrides the org default.
   * Defaults to true. Set to false for providers where org-wide control matters
   * (e.g. claw-proxy: shared bearer / cost tracking).
   */
  personalOverridable?: boolean;
  /**
   * `model` (default): an LLM provider whose key becomes an auth profile or a
   * custom provider block. `secret`: a non-LLM credential that goes into the
   * instance's OpenClaw secret store instead (see `secret`), never into
   * auth-profiles.json, and is never a primary-provider candidate.
   * `oauth-client`: a Google OAuth client JSON (`client_secret_….json`) that
   * the platform installs into each instance's gog CLI with
   * `gog auth credentials set`, so members only have to sign in. Org-level only.
   */
  kind?: 'model' | 'secret' | 'oauth-client';
  /** For `kind: 'secret'`: the store entry the key is written to, the HTTPS hosts the egress proxy may substitute it on, and the bundled skill that reads it. */
  secret?: { name: string; allowedHosts: string[]; skill?: string };
}

// Order matters: this is the display order of provider cards in the UI.
export const PROVIDERS: ProviderConfig[] = [
  {
    id: 'google', label: 'Google Gemini', envVar: 'GEMINI_API_KEY', placeholder: 'AIza...',
    defaultModel: 'google/gemini-3.8-flash',
    // Both are declared under models.providers.google by the config generator
    // (neither is in OpenClaw's own catalog); keep the two lists in step.
    models: [
      { id: 'google/gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
      { id: 'google/gemini-4-argon', label: 'Gemini 4 Argon' },
    ],
  },
  {
    id: 'token-kiosk', label: 'Token Kiosk', envVar: '', placeholder: 'sk-...',
    defaultModel: 'tokenkiosk/azure/gpt-5.5',
    // The pick-list is deliberately short (2026-10-30). The generator still
    // declares the kiosk models that were offered before, so a key or instance
    // already pinned to one keeps working.
    models: [
      { id: 'tokenkiosk/azure/gpt-5.5', label: 'GPT-5.5' },
      { id: 'tokenkiosk/claude-sonnet-5', label: 'Claude Sonnet 5' },
      { id: 'tokenkiosk/minimax-m3.1-flash', label: 'MiniMax M3.1 Flash' },
    ],
    // Still declared by the generator; Sonnet (latest) left the list 2026-11-04.
    retiredModels: [
      'tokenkiosk/claude-sonnet-latest',
      'tokenkiosk/claude-opus-latest',
      'tokenkiosk/azure/gpt-5.6-sol',
      'tokenkiosk/bedrock/kimi-k2.5',
      'tokenkiosk/bedrock/kimi-k2-thinking',
    ],
  },
  {
    id: 'anthropic', label: 'Anthropic', envVar: 'ANTHROPIC_API_KEY', placeholder: 'sk-ant-...',
    defaultModel: 'anthropic/claude-fable-5',
    models: [
      { id: 'anthropic/claude-fable-5', label: 'Claude Fable 5' },
      { id: 'anthropic/claude-opus-4-8', label: 'Claude Opus 4.8' },
      { id: 'anthropic/claude-opus-4-7', label: 'Claude Opus 4.7' },
      { id: 'anthropic/claude-opus-4-6', label: 'Claude Opus 4.6' },
      { id: 'anthropic/claude-opus-4-5', label: 'Claude Opus 4.5' },
      { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { id: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
      { id: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    ],
    supportsSetupToken: true, setupTokenInstructions: 'Run `claude setup-token` in your terminal and paste the result here.',
  },
  {
    id: 'openai', label: 'OpenAI', envVar: 'OPENAI_API_KEY', placeholder: 'sk-...',
    defaultModel: 'openai/gpt-4.1',
    models: [
      { id: 'openai/gpt-4.1', label: 'GPT-4.1' },
      { id: 'openai/gpt-4.1-mini', label: 'GPT-4.1 Mini' },
    ],
  },
  {
    id: 'claw-proxy', label: 'Claw Proxy (Claude Max)', envVar: '', placeholder: 'Bearer token from claw-proxy config',
    defaultModel: 'claw/claude-sonnet-4-6',
    personalOverridable: false,
    models: [
      { id: 'claw/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { id: 'claw/claude-opus-4-6', label: 'Claude Opus 4.6' },
      { id: 'claw/claude-sonnet-4', label: 'Claude Sonnet 4' },
      { id: 'claw/claude-opus-4', label: 'Claude Opus 4' },
      { id: 'claw/claude-haiku-4', label: 'Claude Haiku 4' },
    ],
  },
  // Codex subscription is served under OpenClaw's canonical `openai` namespace
  // (model ref `openai/gpt-5.5`); the auth-profile provider is remapped to
  // `openai` in writeAuthProfiles(). The `openai-codex` id stays as the
  // platform-level provider so ChatGPT/Codex OAuth keys are tracked separately
  // from OpenAI API keys in the DB/UI and org primary-provider pin.
  // Codex models are served by the bundled `codex` agent runtime off the linked
  // ChatGPT account, not by the OpenAI provider API — hence agentRuntime. They
  // still use `openai/*` refs because OpenClaw merges Codex into that namespace.
  //
  // Codex serves 5.6 only as the sol/terra/luna variants — plain `gpt-5.6` is an
  // OpenAI-API-provider model and the runtime rejects it, which is why it fails
  // at run time despite listing fine. `openclaw models list` reports the provider
  // catalog, not what the runtime accepts, so it is no help here; the slugs the
  // runtime knows come from the Codex CLI it bundles.
  { id: 'openai-codex', label: 'OpenAI Codex', envVar: '', placeholder: '', defaultModel: 'openai/gpt-5.6-terra', agentRuntime: 'codex', models: [{ id: 'openai/gpt-5.6-terra', label: 'GPT-5.6 Terra' }, { id: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol' }, { id: 'openai/gpt-5.6-luna', label: 'GPT-5.6 Luna' }, { id: 'openai/gpt-5.5', label: 'GPT-5.5' }], supportsOAuth: true, oauthInstructions: 'Run `codex` and sign in with your ChatGPT account, then run `cat ~/.codex/auth.json` and paste the JSON here.' },
  { id: 'openrouter', label: 'OpenRouter', envVar: 'OPENROUTER_API_KEY', placeholder: 'sk-or-...', defaultModel: 'openrouter/anthropic/claude-sonnet-4.5' },
  // Not an LLM: the token lands in each instance's OpenClaw secret store
  // (entry NOTION_API_TOKEN, substituted by the egress proxy on api.notion.com
  // only) and the bundled `notion` skill is pointed at it. Exec sees the token
  // as `$NOTION_API_TOKEN`, a sentinel that only becomes the real value on the
  // wire to api.notion.com.
  {
    id: 'notion', label: 'Notion', envVar: 'NOTION_API_TOKEN', placeholder: 'ntn_...', defaultModel: '',
    kind: 'secret',
    secret: { name: 'NOTION_API_TOKEN', allowedHosts: ['api.notion.com'], skill: 'notion' },
  },
  // Not an LLM either: the shared Google OAuth client for the gog CLI (Gmail,
  // Calendar, Drive, Docs …). Installed into every instance that has no gog
  // client of its own; each member still signs in with `gog auth add <email>`.
  {
    id: 'google-workspace', label: 'Google Workspace (gog OAuth client)', envVar: '',
    placeholder: '{"installed":{"client_id":"….apps.googleusercontent.com","client_secret":"GOCSPX-…", …}}',
    defaultModel: '', kind: 'oauth-client', personalOverridable: false,
  },
];

/**
 * Where a secret-kind provider's key stands on one instance, as reported by
 * GET …/api-keys/secret-status: `injected` = the key we hold is in the
 * instance's OpenClaw secret store; `pending` = a key exists but is not in the
 * store yet (injected once the instance is running); `member` = the member put
 * their own entry under that name and we leave it alone; `none` = no key.
 * `restart` (gog client only): set up at the next restart or redeploy, since
 * the keyring password it needs is only read when the instance boots.
 */
export type SecretInjectionState = 'injected' | 'pending' | 'restart' | 'member' | 'none';

export interface SecretStatusEntry {
  gateway_id: string;
  slot: number;
  label: string | null;
  status: string | null;
  email?: string;
  name?: string | null;
  /** keyed by provider id (e.g. `notion`) */
  secrets: Record<string, SecretInjectionState>;
}

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

/** Providers that serve models (primary-provider candidates); excludes non-LLM kinds. */
export const MODEL_PROVIDERS = PROVIDERS.filter((p) => (p.kind ?? 'model') === 'model');

/**
 * Parses a Google OAuth client JSON as downloaded from Google Cloud Console
 * (`{"installed": {...}}` or `{"web": {...}}`); null when it is not one.
 */
export function parseGoogleOAuthClient(raw: string): { client_id: string; client_secret: string } | null {
  try {
    const j = JSON.parse(raw);
    const c = j?.installed ?? j?.web ?? j;
    if (typeof c?.client_id === 'string' && typeof c?.client_secret === 'string'
      && c.client_id.endsWith('.apps.googleusercontent.com') && c.client_secret.length > 0) {
      return { client_id: c.client_id, client_secret: c.client_secret };
    }
  } catch { /* not JSON */ }
  return null;
}

/** Every pickable model ref across providers, in display order. */
export const MODEL_IDS = PROVIDERS.flatMap((p) => (p.models ?? []).map((m) => m.id));

/**
 * The provider a pickable model ref belongs to. Refs carry an OpenClaw
 * namespace, not a platform provider id (openai/gpt-5.5 is served by the
 * openai-codex provider), so this goes through the catalog, not the prefix.
 */
export function providerForModel(modelId: string): ProviderConfig | undefined {
  return (
    PROVIDERS.find((p) => p.models?.some((m) => m.id === modelId)) ??
    PROVIDERS.find((p) => p.retiredModels?.includes(modelId))
  );
}

export interface SetApiKeyRequest {
  provider: string;
  key: string;
  credentialType?: CredentialType;
  /** User-selected default model for this provider */
  defaultModel?: string;
}
