/**
 * What ClawHuddle writes for a Hermes Agent instance. Pure: no Docker, no disk.
 *
 * Hermes reads two layers. The member's own home (`/opt/data`: `config.yaml`,
 * `.env`, sessions, skills) is theirs to edit from the dashboard. On top of it
 * sits the "managed scope" (`/etc/hermes`, mounted read-only): its `.env`
 * overrides the member's variables and its `config.yaml` is merged over
 * theirs leaf by leaf. Everything the platform decides goes there: API keys,
 * channel tokens, the model and the custom providers. So nothing here ever
 * merges into a file the member edits, and a platform key cannot be removed or
 * replaced from inside the instance.
 */
import crypto from "node:crypto";
import { PROVIDERS, hermesModelRef } from "@clawhuddle/shared";
import { resolvePrimaryModel, type ChannelTokens } from "./openclaw-config.js";

type Provider = (typeof PROVIDERS)[number];

/** A credential as `getResolvedApiKeysForMember` returns it. */
export interface HermesKey {
  provider: string;
  key: string;
  credential_type: string;
  default_model: string | null;
}

export const HERMES_DASHBOARD_PORT = 9119;
export const HERMES_UID = 10000;
/** Where the member's home and the platform's layer are mounted in the container. */
export const HERMES_HOME = "/opt/data";
export const HERMES_MANAGED_DIR = "/etc/hermes";
/** Org skills and the platform's own live in one category, so a redeploy can prune it without touching the member's skills. */
export const HERMES_SKILL_CATEGORY = "clawhuddle";

const TOKEN_KIOSK_DEFAULT_URL = "https://agent-router.gaib.ai/v1";
const CLAW_PROXY_DEFAULT_URL = "http://claw-proxy:3456/v1";

/** `providers.<name>` blocks for the OpenAI-compatible endpoints Hermes reaches as `custom:<name>`. */
const CUSTOM_ENDPOINTS: Record<string, { name: string; baseUrl: () => string }> = {
  "token-kiosk": { name: "tokenkiosk", baseUrl: () => process.env.TOKEN_KIOSK_URL || TOKEN_KIOSK_DEFAULT_URL },
  "claw-proxy": { name: "claw", baseUrl: () => process.env.CLAW_PROXY_URL || CLAW_PROXY_DEFAULT_URL },
};

/**
 * The dashboard sign-in for an instance. The password is the instance's
 * existing bearer token (`gateways.token`), so it follows that token's release
 * rules; the container only ever gets its scrypt hash. Salt and session secret
 * are derived from the token, so the container Env is the same on every
 * redeploy and changes exactly when the token is rotated.
 */
/**
 * The provider name the rest of the platform uses (the prefix of our model
 * ids: `google`, `tokenkiosk`, `claw` …) for a provider as Hermes records it.
 * Hermes logs every custom endpoint as plain `custom`, so those are told apart
 * by base URL.
 */
export function platformProviderName(hermesProvider: string, baseUrl?: string): string {
  const url = (baseUrl ?? "").replace(/\/+$/, "");
  for (const p of PROVIDERS) {
    const mapped = p.hermes?.provider;
    if (!mapped) continue;
    const custom = CUSTOM_ENDPOINTS[p.id];
    if (custom) {
      if (hermesProvider === mapped) return custom.name;
      if (hermesProvider === "custom" && url && url === custom.baseUrl().replace(/\/+$/, "")) return custom.name;
    } else if (hermesProvider === mapped) {
      return p.defaultModel.split("/")[0] || p.id;
    }
  }
  return hermesProvider;
}

export function hermesDashboardEnv(g: { token: string; subdomain: string }, publicUrl: string): string[] {
  const salt = crypto.createHmac("sha256", g.token).update("dashboard-salt").digest().subarray(0, 16);
  const derived = crypto.scryptSync(Buffer.from(g.token, "utf-8"), salt, 32, { N: 16384, r: 8, p: 1 });
  const hash = `scrypt$16384$8$1$${salt.toString("base64")}$${derived.toString("base64")}`;
  const secret = crypto.createHmac("sha256", g.token).update("dashboard-session").digest("hex");
  return [
    "HERMES_DASHBOARD=1",
    `HERMES_DASHBOARD_PUBLIC_URL=${publicUrl}`,
    `HERMES_DASHBOARD_BASIC_AUTH_USERNAME=${g.subdomain}`,
    `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH=${hash}`,
    `HERMES_DASHBOARD_BASIC_AUTH_SECRET=${secret}`,
  ];
}

export interface HermesManaged {
  /** Variables of the managed `.env`, in a stable order. */
  env: Record<string, string>;
  /** The managed `config.yaml` (written as JSON, which the YAML loader accepts). Null without a usable model provider. */
  config: Record<string, unknown> | null;
  /** Our provider ids that can serve this instance's model calls. */
  providerIds: string[];
  /** `<hermes provider>/<model>` the instance answers with, for logs and tests. */
  primary: string | null;
  /** The org's Google OAuth client JSON (kind `oauth-client`), member key first. */
  googleClient: string | null;
  /** A Notion key is in the env, so the Notion skill is worth installing. */
  notion: boolean;
}

/**
 * Everything the platform sets for one Hermes instance, from the member's
 * resolved keys, the instance's channel tokens and its model pin.
 *
 * A provider counts only when Hermes can use the credential: OAuth credentials
 * (Codex, Claude subscription JSON) are OpenClaw-only and are skipped, as are
 * providers without a `hermes` mapping. The first key per variable wins, which
 * is the member's own when they have one.
 */
export function buildHermesManaged(input: {
  keys: HermesKey[];
  channelTokens?: ChannelTokens;
  primaryProviderId?: string | null;
  primaryModel?: string | null;
}): HermesManaged {
  const env: Record<string, string> = {};
  const providerIds: string[] = [];
  const modelOverrides: Record<string, string> = {};
  let googleClient: string | null = null;

  for (const { provider, key, credential_type, default_model } of input.keys) {
    const config = PROVIDERS.find((p) => p.id === provider);
    if (!config) continue;
    if (config.kind === "oauth-client") {
      if (googleClient === null) googleClient = key;
      continue;
    }
    if (!config.hermes || credential_type === "oauth") continue;
    const name = credential_type === "token" ? config.hermes.tokenEnvVar : config.hermes.envVar;
    if (!name) continue;
    if (!(name in env)) env[name] = key;
    if (config.kind === "secret" || !config.hermes.provider) continue;
    if (!providerIds.includes(provider)) providerIds.push(provider);
    if (default_model && !modelOverrides[provider]) modelOverrides[provider] = default_model;
  }

  const tokens = input.channelTokens ?? {};
  if (tokens.slack?.botToken) {
    env.SLACK_BOT_TOKEN = tokens.slack.botToken;
    if (tokens.slack.appToken) env.SLACK_APP_TOKEN = tokens.slack.appToken;
  }
  if (tokens.telegram) env.TELEGRAM_BOT_TOKEN = tokens.telegram;
  if (tokens.discord) env.DISCORD_BOT_TOKEN = tokens.discord;

  const { config, primary } = hermesModelConfig({
    providerIds,
    modelOverrides,
    primaryProviderId: input.primaryProviderId ?? undefined,
    primaryModel: input.primaryModel ?? undefined,
  });

  return { env, config, providerIds, primary, googleClient, notion: "NOTION_API_KEY" in env };
}

/**
 * The model section of the managed config. Same pin rule as OpenClaw
 * (`resolvePrimaryModel`); the one difference is the last resort: OpenClaw
 * names the platform default even without a Google key, Hermes would then fail
 * every turn, so the first provider that has a key is used instead.
 */
function hermesModelConfig(options: {
  providerIds: string[];
  modelOverrides: Record<string, string>;
  primaryProviderId?: string;
  primaryModel?: string;
}): { config: Record<string, unknown> | null; primary: string | null } {
  // A key's stored default model can outlive the model (the org's kiosk key
  // still named a promotion id the kiosk retired). OpenClaw skips a fallback it
  // cannot resolve; Hermes stops the turn on it. So an override that is not on
  // the provider's pick-list is ignored here and the provider default is used.
  const modelOverrides: Record<string, string> = {};
  for (const [providerId, modelId] of Object.entries(options.modelOverrides)) {
    const offered = PROVIDERS.find((p) => p.id === providerId)?.models ?? [];
    if (offered.length === 0 || offered.some((m) => m.id === modelId)) modelOverrides[providerId] = modelId;
  }
  const { primary, activeProviders, resolveModel } = resolvePrimaryModel({
    activeProviderIds: options.providerIds,
    modelOverrides,
    primaryProviderId: options.primaryProviderId,
    primaryModel: options.primaryModel,
  });
  if (activeProviders.length === 0) return { config: null, primary: null };

  const refFor = (modelId: string) => {
    const owner = activeProviders.find((p) => modelBelongsTo(p, modelId));
    return owner ? hermesModelRef(owner, modelId) : null;
  };

  const candidates = [primary, ...activeProviders.map(resolveModel)];
  const refs: { provider: string; model: string }[] = [];
  for (const id of candidates) {
    const ref = refFor(id);
    // One entry per provider: a fallback is for when a provider is down, not a second model of the same one.
    if (ref && !refs.some((r) => r.provider === ref.provider)) refs.push(ref);
  }
  if (refs.length === 0) return { config: null, primary: null };

  const providers: Record<string, unknown> = {};
  for (const p of activeProviders) {
    const endpoint = CUSTOM_ENDPOINTS[p.id];
    // The wire is declared: as a fallback, Hermes otherwise guesses it from
    // the model name and sends a gpt-5.x id to /v1/responses, which neither
    // endpoint has (as the primary it already uses chat completions).
    if (endpoint && p.hermes) {
      // The dashboard's model picker lists a saved endpoint's models from this
      // block (it only asks the current endpoint for a live catalog), so the
      // platform's pick-list is declared, plus the model this instance uses on
      // the endpoint when that is an older pin. Discovery is off: the list
      // stays the one the Home card offers, not the endpoint's whole catalog.
      const models = (p.models ?? []).map((m) => hermesModelRef(p, m.id)?.model).filter((id): id is string => !!id);
      const inUse = refs.find((r) => r.provider === p.hermes?.provider)?.model;
      if (inUse && !models.includes(inUse)) models.push(inUse);
      providers[endpoint.name] = {
        base_url: endpoint.baseUrl(),
        key_env: p.hermes.envVar,
        api_mode: "chat_completions",
        models,
        discover_models: false,
      };
    }
  }

  const [first, ...rest] = refs;
  const config: Record<string, unknown> = {
    // base_url is cleared so an endpoint the member once picked in the
    // dashboard cannot be combined with the platform's provider.
    model: { provider: first.provider, default: first.model, base_url: "" },
    fallback_providers: rest,
  };
  if (Object.keys(providers).length > 0) config.providers = providers;
  return { config, primary: `${first.provider}/${first.model}` };
}

/** Whether `modelId` is one of the provider's models (offered, retired, its default) or carries its namespace. */
function modelBelongsTo(p: Provider, modelId: string): boolean {
  if (p.defaultModel === modelId) return true;
  if (p.models?.some((m) => m.id === modelId)) return true;
  if (p.retiredModels?.includes(modelId)) return true;
  return modelId.startsWith(`${p.defaultModel.split("/")[0]}/`);
}

/**
 * `.env` text for the managed scope. Values are double-quoted with the two
 * escapes Hermes's own tokenizer reverses (`\"`, `\\`); a line break cannot be
 * represented and never belongs in a key, so it is dropped.
 */
export function renderHermesEnv(env: Record<string, string>): string {
  const lines = ["# Written by ClawHuddle on every deploy and key change. Edits here are overwritten."];
  for (const name of Object.keys(env).sort()) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    const value = env[name].replace(/[\r\n]/g, "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    lines.push(`${name}="${value}"`);
  }
  return lines.join("\n") + "\n";
}

/** Fingerprint of what a managed `.env` would hold, to tell "written" from "pending" without comparing secrets. */
export function hermesFingerprint(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * The member's own `config.yaml`, written once when the home has none and
 * never touched again. Only starting points a member may change: commands run
 * in the workspace, reasoning stays light (reply latency), and scheduled jobs
 * use the team's clock.
 */
export function seedHermesConfig(timeZone: string): string {
  const zone = /^[A-Za-z0-9_+\-/]+$/.test(timeZone) ? timeZone : "UTC";
  return [
    "# Starting configuration from ClawHuddle. This file is yours: change it here or in the dashboard.",
    "# The model, API keys and channel tokens come from ClawHuddle (Home and API Keys pages) and",
    "# override what is set here.",
    "terminal:",
    `  cwd: ${HERMES_HOME}/workspace`,
    "agent:",
    "  reasoning_effort: low",
    `timezone: ${zone}`,
    "",
  ].join("\n");
}

export interface HermesSkillFile {
  /** Directory name under `skills/clawhuddle/`. */
  name: string;
  content: string;
}

/**
 * Skills the platform itself provides. Hermes has no always-loaded platform
 * note and no bundled Notion skill, so both arrive as skills: the agent sees
 * their descriptions in every session and opens them when relevant.
 */
export function hermesPlatformSkills(facts: { notion: boolean; google: boolean }): HermesSkillFile[] {
  const skills: HermesSkillFile[] = [];

  const notes = [
    "---",
    "name: clawhuddle-platform",
    'description: "How this instance is set up by ClawHuddle: which accounts are already connected (Notion, Google) and where keys, model and chat channels are managed. Read before asking anyone for a token or an API key."',
    "version: 1.0.0",
    "author: ClawHuddle",
    "platforms: [linux]",
    "metadata:",
    "  hermes:",
    "    tags: [ClawHuddle, Platform, Setup]",
    "---",
    "",
    "# ClawHuddle platform notes",
    "",
    "This instance runs on ClawHuddle. Written by the platform and rewritten on every deploy; keep your own notes elsewhere.",
    "",
    "## Keys, model and channels",
    "",
    "API keys, the model and the Slack, Telegram and Discord bot tokens are set by ClawHuddle and override anything in `config.yaml` or `.env`. To change one, ask the person to use the ClawHuddle web app (Home for the model, API Keys for keys, Channels for bots). Do not ask for a key in chat.",
  ];
  if (facts.notion) {
    notes.push(
      "",
      "## Notion",
      "",
      "Notion is already connected with the organization's Notion integration: `NOTION_API_KEY` is set. Use the `notion` skill. Do not ask anyone for a Notion token, and never print the key or send it to a host other than `api.notion.com`.",
    );
  }
  if (facts.google) {
    notes.push(
      "",
      "## Google",
      "",
      "Google (Gmail, Calendar, Drive, Docs, Sheets) goes through the `google-workspace` skill. The OAuth client is already installed, so skip the skill's client-secret steps. If no Google account is connected yet, ask the person to connect one from this instance's card on the ClawHuddle Home page; do not walk them through the setup script.",
    );
  }
  skills.push({ name: "clawhuddle-platform", content: notes.join("\n") + "\n" });

  if (facts.notion) {
    skills.push({
      name: "notion",
      content: [
        "---",
        "name: notion",
        'description: "Read and write Notion pages, databases and comments through the Notion REST API with curl. Already connected: NOTION_API_KEY is set."',
        "version: 1.0.0",
        "author: ClawHuddle",
        "platforms: [linux]",
        "metadata:",
        "  hermes:",
        "    tags: [Notion, Notes, Docs, Wiki, API]",
        "prerequisites:",
        "  env_vars: [NOTION_API_KEY]",
        "  commands: [curl]",
        "required_environment_variables:",
        "  - name: NOTION_API_KEY",
        "    prompt: Notion integration token",
        '    help: "Set by ClawHuddle from the organization\'s Notion key"',
        "---",
        "",
        "# Notion",
        "",
        "Notion is connected with the organization's integration. `NOTION_API_KEY` is set for your commands; never print it and only send it to `api.notion.com`.",
        "",
        "Every request needs these headers:",
        "",
        "```bash",
        'curl -s https://api.notion.com/v1/search \\',
        '  -H "Authorization: Bearer $NOTION_API_KEY" \\',
        '  -H "Notion-Version: 2022-06-28" \\',
        '  -H "Content-Type: application/json" \\',
        "  -d '{\"query\": \"roadmap\", \"page_size\": 10}'",
        "```",
        "",
        "## Common calls",
        "",
        "- Search pages and databases: `POST /v1/search` with `{\"query\": \"…\"}`.",
        "- Read a page's properties: `GET /v1/pages/<page_id>`.",
        "- Read a page's content: `GET /v1/blocks/<page_id>/children?page_size=100` (follow `next_cursor`; nested blocks need their own call).",
        "- Query a database: `POST /v1/databases/<database_id>/query` with optional `filter` and `sorts`.",
        "- Create a page: `POST /v1/pages` with `parent` (`{\"database_id\": …}` or `{\"page_id\": …}`), `properties` and optional `children`.",
        "- Update properties: `PATCH /v1/pages/<page_id>`.",
        "- Append content: `PATCH /v1/blocks/<block_id>/children` with `children`.",
        "- Comment: `POST /v1/comments` with `parent.page_id` and `rich_text`.",
        "",
        "An id is the 32 hex characters at the end of a Notion URL (dashes optional).",
        "",
        "## When a call fails",
        "",
        "- `404` or `object_not_found`: the page or database is not shared with the integration. Ask the person to open it in Notion and add the integration under ••• → Connections, then try again.",
        "- `401`: the key was replaced. Tell the person to check the Notion key on the ClawHuddle API Keys page; do not ask for a token in chat.",
        "- `429`: wait the `Retry-After` seconds and retry.",
        "",
      ].join("\n"),
    });
  }
  return skills;
}

/**
 * The org's Google OAuth client in the shape Hermes's google-workspace skill
 * loads (`{"installed": {...}}`). The key may hold the downloaded file as it
 * is, a `web` client, or a bare `{client_id, client_secret}`; the endpoints
 * are Google's fixed ones. Null when it is not a client at all.
 */
export function hermesGoogleClientFile(raw: string): string | null {
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return null; }
  const client = parsed?.installed ?? parsed?.web ?? parsed;
  if (typeof client?.client_id !== "string" || typeof client?.client_secret !== "string") return null;
  return JSON.stringify({
    installed: {
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      redirect_uris: ["http://localhost"],
      ...client,
    },
  }, null, 2) + "\n";
}

/** What the google-workspace skill's scopes cover, for the Home card. */
export const HERMES_GOOGLE_SERVICES = ["gmail", "calendar", "drive", "contacts", "sheets", "docs"];

/** Sessions started from these Hermes sources count as that chat channel on the Usage page; everything else is `other`. */
export const HERMES_CHANNEL_SOURCES = ["slack", "telegram", "discord"];

/** Pairing codes and platform names are passed to a CLI in the container: letters, digits and dashes only. */
export const HERMES_PAIRING_CODE = /^[A-Za-z0-9-]{4,32}$/;
