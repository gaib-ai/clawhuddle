# CLAUDE.md

## Project Overview

ClawHuddle is a multi-tenant platform for managing OpenClaw AI gateway instances. Each org member runs one or more personal OpenClaw Docker containers ("instances", rows in `gateways`, numbered by `slot`) with auto-provisioned config, credentials, and skills. How many a member may run is `org_members.max_gateways` → `organizations.max_gateways_per_user` → `MAX_GATEWAYS_PER_USER` (default 1). Skills and API keys are per user and shared by all of a member's instances; channel bot tokens (`gateway_channels`) and the primary-provider pin are per instance.

## Architecture

```
Monorepo
├── apps/api          Fastify + SQLite backend (dockerode for container management)
├── apps/web          Next.js 16 frontend (NextAuth v5)
├── packages/shared   Shared types, provider definitions
└── vendor/claw-proxy Git submodule — OpenAI-compatible proxy for Claude Max
```

**Data flow**: Frontend → API server → generates `openclaw.json` + `auth-profiles.json` → mounts into per-user Docker containers → OpenClaw gateway reads config on startup.

## API Authentication

The API never trusts a client-supplied user id. Both apps share `API_AUTH_SECRET` (≥ 32 chars; the API refuses to start without it) and use the HS256 helpers in `packages/shared/src/api-token.ts`:

- **User tokens** (`aud: 'user'`, 1h): minted in NextAuth's `jwt` callback (`apps/web/lib/auth.ts`), re-minted when < 15 min remain, exposed as `session.apiToken`. `apiFetch` (`apps/web/lib/api.ts`) attaches it as `Authorization: Bearer …` and retries once after refreshing the session on a 401. `authPlugin` verifies it.
- **Internal tokens** (`aud: 'internal'`, 60s): the web server's calls to `/api/auth/login` and `/api/auth/check-access`, guarded by `requireInternal`. These routes return any user's id by email, so they must never be reachable without one.
- A gateway's `token` is a bearer credential: it is only returned by `GET /me/gateways` for the caller's own instances. Admins get another member's one at a time from `GET /api/orgs/:orgId/gateways/:gatewayId/access` (logged; admins can't open an owner's gateway, owners can open any). Members act only on their own instances; `requireGatewayAccess` in `routes/org/gateways.ts` enforces it.

## Security Invariants

- Device pairing: `docker/gateway/entrypoint.sh` still auto-approves pending device requests every 5 s (kept on purpose). The web app's Device Requests page (`GET /me/device-requests`, admin `GET /device-requests`, `POST /gateways/:gatewayId/devices/:requestId/{approve,reject}` → `openclaw devices …` exec'd in the container) is the manual path; it only sees a request in the window before the loop approves it, or on a container where the loop is off. `openclaw devices list` costs ~4.5 CPU-seconds a run, so both the loop and `listDeviceRequests` first ask `clawhuddle-pending-devices` (`docker/gateway/pending-devices.cjs`), which counts unexpired rows in `device_pairing_pending` in OpenClaw's state database, and only run the CLI when the answer is not exactly 0. It reads an OpenClaw internal: on any error it prints nothing and callers fall back to the CLI, and an instance on an older image falls back the same way (exec exits 127). After an OpenClaw upgrade, check the table and `DEVICE_PAIRING_PENDING_TTL_MS` still match; a broken check costs CPU, not approvals.
- Gateways run agent-controlled code (and anyone who can message them can steer it). They live on `GATEWAY_NETWORK` (`clawhuddle-gateways`) with only Traefik and claw-proxy; the API and web stay on `clawhuddle-net`.
- Slack defaults to OpenClaw's own policy (`dmPolicy: pairing`, `groupPolicy: allowlist`, `allowBots: false`). `mergeOpenClawConfig` migrates blocks still carrying the old wide-open platform default; blocks the member changed are left alone. The migration runs once per gateway (`gateways.slack_access_migrated_at`), so a member can open Slack again — even to exactly the old default — and keep it across redeploys.
- Instance naming is in `services/gateway-store.ts`: slot 1 keeps the pre-instance container name `clawhuddle-gw-<org8>-<user8>` and data dir `data/gateways/<orgId>/<userId>`; slot N≥2 adds `-N` to both. `org_members.gateway_*` only mirror the slot-1 row (for rollback) — never read them. All `gateways` writes go through the store so the mirror stays right. `migrate.ts` re-runs every migration on each boot; one-shot backfills are guarded by `migration_marks` (see `020-gateways.sql`).
- Port-forward Traefik files are written with `JSON.stringify` (JSON is valid YAML) — never interpolate request input into them.
- Only owners can grant the owner role, including through invitations (checked when sent and again when accepted); roles and statuses are validated against fixed lists.
- Roles: `owner` > `admin` > `maintainer` > `member`. A maintainer sees only the Members page (`/admin`; other admin pages redirect), and `GET /members` returns them only `member` rows plus their own. They manage plain members' instances (deploy, start/stop/restart/redeploy, open via `/access`, channels, usage — but remove only their own instances; `canManageGatewaysOf` in `middleware/auth.ts`) but cannot invite, change roles, statuses or limits, see keys, or touch an admin's or owner's instance.

## Claw Proxy Integration

claw-proxy routes OpenAI-format requests through `claude -p` CLI using Claude Max subscriptions. It registers as a **custom OpenClaw provider** (not env var override).

### How it works

1. Admin adds bearer token via UI under "Claw Proxy (Claude Max)" provider — this alone enables proxy
2. On gateway provision/redeploy, `generateOpenClawConfig()` writes a `models.providers.claw` section into `openclaw.json` with:
   - `baseUrl` (default `http://claw-proxy:3456/v1`, override via `CLAW_PROXY_URL` env var)
   - `apiKey` (bearer token from DB)
   - `api: "openai-completions"`
   - Full model definitions (id, name, reasoning, contextWindow, cost=0)
3. Model IDs use `claw/` prefix (e.g. `claw/claude-sonnet-4-6`)
4. Bearer token goes into `openclaw.json` directly — NOT `auth-profiles.json`

### Key env vars

| Variable | Where | Purpose |
|----------|-------|---------|
| `CLAW_PROXY_URL` | API server `.env` | Optional override for claw-proxy base URL (default: `http://claw-proxy:3456/v1`) |

### Frontend behavior

- "Claw Proxy (Claude Max)" always visible as a provider card in Admin → API Keys
- Adding a bearer token is the only step needed to enable proxy — no env var required

### Starting claw-proxy

```bash
docker compose --profile proxy up -d --build
```

Config: `data/claw-proxy/config.json` (bearerToken + accounts with oauthTokens from `claude setup-token`).

## Token Kiosk Integration

Token Kiosk (internal OpenRouter-style gateway at `https://agent-router.gaib.ai/v1`, docs at `https://token-kiosk.gaib.ai/docs`) follows the same custom-provider pattern as claw-proxy:

1. Admin adds an `sk-...` key via UI under "Token Kiosk" provider
2. `generateOpenClawConfig()` writes a `models.providers.tokenkiosk` section into `openclaw.json` (baseUrl default `https://agent-router.gaib.ai/v1`, override via `TOKEN_KIOSK_URL` env var)
3. Model IDs use `tokenkiosk/` prefix plus the kiosk's own id — either a `<provider>/<model>` id (e.g. `tokenkiosk/azure/gpt-5.5`, `tokenkiosk/bedrock/kimi-k2.5`; the kiosk routes on its prefix) or one of the kiosk's rolling aliases (e.g. `tokenkiosk/claude-opus-latest`)
4. Key goes into `openclaw.json` directly — NOT `auth-profiles.json`

Curated models: Azure GPT-5.5 / GPT-5.6 Sol, AWS Bedrock Kimi K2.5 / K2 Thinking, Claude Opus (latest). The kiosk's full catalog is public at `GET /v1/models` (no auth) if more are wanted.

## Provider System

Providers are defined in `packages/shared/src/index.ts` as `PROVIDERS` array. Each has:
- `id`, `label`, `envVar`, `placeholder`, `defaultModel`
- `models[]` — available models (with optional `proxyOnly` flag)
- Optional: `supportsSetupToken`, `supportsOAuth`

API keys are stored in `api_keys` table (org-scoped), written to `auth-profiles.json` for standard providers, or embedded in `openclaw.json` for custom providers (claw-proxy, token-kiosk).

**Primary model.** `agents.defaults.model.primary` is resolved per instance by `getPrimaryPin` in `services/gateway-store.ts`, most specific first: `gateways.primary_model` (Home card picks a model by name, provider implied via `providerForModel`) → `gateways.primary_provider` (older pin) → `org_members.primary_provider` (My API Keys) → `organizations.primary_provider` + `organizations.primary_model` (Admin → API Keys: provider select plus a model select limited to that provider; changing the provider clears the model). A model pin only counts when the member has a key for its provider; otherwise the generator falls back to the provider pin, then to `DEFAULT_PRIMARY`. The provider pick-lists in `PROVIDERS[].models` are deliberately short (Google: Flash 3.8 + Argon 4; Token Kiosk: GPT-5.5 + Claude Sonnet 5 + MiniMax M3.1 Flash); the generator still declares the previously offered kiosk models so old pins keep resolving.

## Secret-store providers (Notion)

A provider with `kind: 'secret'` in `PROVIDERS` (today: `notion`, entry `NOTION_API_TOKEN`, host `api.notion.com`, skill `notion`) is a non-LLM credential. Its key uses the normal org/personal key plumbing but never reaches auth-profiles.json and is never a primary-provider candidate (`MODEL_PROVIDERS`). `ensureGatewaySecrets` in `services/gateway.ts` writes it into the running instance's OpenClaw secret store (`openclaw secrets store set … --allow-host …` exec'd in the container, value passed through a transient 0600 file in the data dir, then `secrets reload`) and records what it set in `<gatewayDir>/.clawhuddle-secrets.json`. Only then does the generator emit `skills.entries.<skill>.apiKey = {source:'store', id}` — OpenClaw refuses to start or reload on an unresolved store ref, so the ref follows the state file. It runs after deploy/restart (`scheduleSecretSync`), on status promotion to running, and on key changes. A same-named entry the member created themselves (no record of ours) is left untouched.

**gog OAuth client (`kind: 'oauth-client'`, provider `google-workspace`, org-level only).** The key is the Google Cloud `client_secret_….json`, validated by `parseGoogleOAuthClient` and shown by client id. gog keeps the client secret and members' refresh tokens in a file keyring whose password must be in the environment of every process using it, so `ensureGogEnv` adds `GOG_KEYRING_BACKEND=file` + a random `GOG_KEYRING_PASSWORD` to the instance's `env` file (sourced by the entrypoint) before deploy, restart or start, never changing a value already there. Once the instance is up, the sync runs `gog auth credentials set` (env sourced, client via a transient 0600 file) and records the fingerprint in `<gatewayDir>/.clawhuddle-gog.json`. An instance whose `gog/data/credentials.json` exists without that record is the member's own and is never touched. A running instance without the env settings shows `restart` on the API Keys page; it gets the client at its next restart or redeploy. Members still sign in with `gog auth add <email>`.

**Google sign-in from Home.** Each running instance card has a Google account section (`components/google-connect.tsx`) backed by `GET /gateways/:gatewayId/google` (readiness `ready` / `pending` / `restart` / `no-client` / `keyring`, plus connected accounts) and, for the instance's own member only (`requireGatewayAccess({ ownOnly: true })`), `POST …/google/start`, `POST …/google/finish` and `DELETE …/google/accounts/:email`. They drive gog's remote flow (`gog auth add <email> --remote --step=1|2`, services `GOG_SIGN_IN_SERVICES`) with the instance env sourced. The shared client is a Desktop OAuth client, which only allows loopback redirects, so Google ends on an `http://127.0.0.1:<port>/oauth2/callback?…` page that does not load; the member pastes that address back, it is validated as loopback with `code` and `state`, and handed to gog through a transient 0600 file, never on a command line or in a log.

## LLM usage (Admin → Usage)

`GET /api/orgs/:orgId/gateways/:gatewayId/usage?days=1|7|30|90` (own instance or admin+, running only) runs OpenClaw's `sessions.usage` gateway method in the container (`openclaw gateway call sessions.usage`, the same numbers as the Control UI's Usage tab) and `services/usage.ts` condenses it to `GatewayUsage`: totals, by model, by channel (`other` = no channel: cron, heartbeat, Control UI), per day, message/error counts. Session keys, titles and creators are dropped; nothing per person or per message leaves the container. Cost is OpenClaw's list-price estimate, not what Token Kiosk or Claw Proxy bill. Each read is a CLI run (~2–6 s), so at most 3 run at once, complete results are cached 5 min (`refresh=1` skips it), and an incomplete one (`cacheStatus` ≠ `fresh`: OpenClaw re-indexes transcripts in memory after every restart, so the first read after a boot returns zeros) is never cached — the page re-asks after 5/10/20 s.

## Config Generation

`apps/api/src/services/openclaw-config.ts`:
- `generateOpenClawConfig()` — creates full `openclaw.json` from options
- `mergeOpenClawConfig()` — updates platform-managed fields while preserving user customizations

Platform-managed fields: `meta`, `gateway.*`, `models.providers.*` (custom providers), `agents.defaults`, `channels`, `plugins`.

Slack `streaming` (threaded progress card with tool rows) and `replyToModeByChatType` (`all`) are platform defaults written onto an existing Slack block only while it holds a value the platform wrote (`SLACK_STREAMING_HISTORY`) or none; a value the member set is kept across redeploys (Kony uses the Block Kit card without tool rows since 2026-11-04).

`agents.defaults` is rewritten wholesale on every merge. Besides the model lists it carries `thinkingDefault: low`, `toolProgressDetail: raw` and, since 2026-11-10, `heartbeat.isolatedSession: true`: OpenClaw otherwise runs the 30-minute heartbeat in the main session and replays its full history each tick. The one exception is `heartbeat`: keys a member set in `agents.defaults.heartbeat` (e.g. Michael's `every: 0m`) are kept and the platform's `isolatedSession` only fills a missing key; a member's `agents.entries.<id>.heartbeat` also overrides it per key.

**Platform instructions (since 2026-11-13).** `services/platform-instructions.ts` renders a short note for the agent (Notion is already connected: don't `ntn login` or ask for a token; Google goes through `gog`, connect from the Home card) from what the instance really has, and `writePlatformInstructions` in `services/gateway.ts` writes it to `<workspace>/.clawhuddle/AGENTS.md` on every config write and after each secret sync. The generator adds `hooks.internal.entries.bootstrap-extra-files = {enabled: true, paths: ['.clawhuddle/AGENTS.md']}` (no master flag, so it is an allowlist of one: no other bundled hook is switched on), and OpenClaw loads the file into each new session next to the member's own AGENTS.md, which stays theirs. The merge only joins our path to the list the member's entry already uses, and leaves hooks alone when they are off, our hook is disabled, or the member relies on open-ended discovery.

Three more blocks are platform defaults since 2026-11-02 and are overlaid key by key (`overlayBlock`), so whatever else a member keeps in them survives a redeploy: `messages` (Slack inbound quiet window 3 s, queue mode `collect`, Slack debounce 3 s — short bursts become one turn), `session.dmScope = per-channel-peer` (one DM session per Slack peer), and `secrets.egressProxy.enabled = true` (secret-store entries reach exec as sentinels, swapped in only on hosts bound with `openclaw secrets store set NAME --allow-host <host>`; HTTPS to other hosts is unrestricted unless the member sets `allowedHosts`; plain `http://` to non-loopback hosts is refused).

The API Keys pages show where each instance stands: `GET /api/orgs/:orgId/api-keys/secret-status` (admin) and `/me/api-keys/secret-status` (own instances) return one `SecretStatusEntry` per gateway with `secrets.<provider>` = `injected` (our fingerprint is in the state file) / `pending` (key exists, store not written yet; done once the instance is running) / `member` (state file records `null`: the member's own entry, never overwritten) / `none`. Computed by `secretStatusFor` in `services/gateway.ts`; the web hook `lib/use-secret-status.ts` repolls every 10 s while a running instance is `pending`.

## Build & Run

```bash
# Local dev
npm install
npm run dev          # starts api (4000) + web (3000)

# Docker
docker compose up -d --build                    # api + web
docker compose --profile proxy up -d --build    # + claw-proxy
```
