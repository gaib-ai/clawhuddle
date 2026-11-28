import type Docker from "dockerode";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "../db/index.js";
import { getResolvedApiKeysForMember } from "../routes/org/api-keys.js";
import { generateOpenClawConfig, mergeOpenClawConfig, PLATFORM_INSTRUCTIONS_PATH } from "./openclaw-config.js";
import { renderPlatformInstructions } from "./platform-instructions.js";
import { installSkillsForUser } from "./skill-installer.js";
import { removePortForwardsForGateway, removePortForwardsForOrg } from "./port-forward.js";
import {
  CONTAINER_PREFIX,
  GATEWAY_INTERNAL_PORT,
  containerNameFor,
  createGatewayRow,
  deleteGatewayRow,
  gatewayDirName,
  getDataDir,
  getGatewayChannelTokens,
  getGatewayDir,
  getGatewayRow,
  getHostGatewayDir,
  getPrimaryPin,
  listMemberGateways,
  listOrgGateways,
  listUserGateways,
  markSlackAccessMigrated,
  setGatewayState,
  slackAccessMigrated,
  summarizeGateway,
  type GatewayRef,
  type GatewayRow,
} from "./gateway-store.js";
import type { DevicePairingRequest, DeviceRequestList, SecretInjectionState, Skill } from "@clawhuddle/shared";
import { PROVIDERS } from "@clawhuddle/shared";

import {
  GATEWAY_DOMAIN,
  GATEWAY_NETWORK,
  IS_LOCAL_DEV,
  createTraefikLabels,
  demuxDockerStream,
  docker,
  ensureNetwork,
  execInContainer,
  removeContainer,
} from "./docker.js";

import {
  approveHermesPairing,
  checkHermesHealth,
  finishHermesGoogleSignIn,
  getHermesGoogleAccounts,
  getHermesHostPort,
  hermesContainerConfig,
  hermesFilesExist,
  hermesSecretStatus,
  listHermesPairing,
  prepareHermesDeploy,
  removeHermesGoogleAccount,
  removeHermesManagedDir,
  startHermesGoogleSignIn,
  syncHermesFiles,
} from "./hermes.js";
import { HERMES_DASHBOARD_PORT } from "./hermes-config.js";
import type { GatewayRuntime } from "@clawhuddle/shared";

export { getContainerName, GatewayLimitError } from "./gateway-store.js";
export { demuxDockerStream, execInContainer } from "./docker.js";

const GATEWAY_IMAGE = "clawhuddle-gateway:local";
// OpenClaw listens on loopback:6100; socat bridges external traffic on 0.0.0.0:6101
const GATEWAY_EXTERNAL_PORT = 6101;

/** How an instance is referred to in log lines: <orgId>/<userId>[-<slot>]. */
const refLabel = (ref: GatewayRef) => `${ref.org_id}/${gatewayDirName(ref.user_id, ref.slot)}`;

async function checkGatewayHealth(containerName: string): Promise<boolean> {
  try {
    const container = docker.getContainer(containerName);
    const exec = await container.exec({
      Cmd: [
        "node",
        "-e",
        `fetch('http://127.0.0.1:${GATEWAY_INTERNAL_PORT}/').then(r=>(r.ok||r.status===401)?process.exit(0):process.exit(1)).catch(()=>process.exit(1))`,
      ],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({});
    return new Promise<boolean>((resolve) => {
      stream.resume();
      stream.on("end", async () => {
        try {
          const info = await exec.inspect();
          resolve(info.ExitCode === 0);
        } catch {
          resolve(false);
        }
      });
      stream.on("error", () => resolve(false));
      setTimeout(() => resolve(false), 5000);
    });
  } catch {
    return false;
  }
}

function getMemberSkills(orgId: string, userId: string): Skill[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT s.* FROM skills s
       JOIN user_skills us ON us.skill_id = s.id
       WHERE us.user_id = ? AND us.enabled = 1 AND s.enabled = 1 AND s.org_id = ?
       UNION
       SELECT * FROM skills WHERE type = 'mandatory' AND enabled = 1 AND org_id = ?`,
    )
    .all(userId, orgId, orgId) as Skill[];
}

/**
 * Writes auth-profiles.json for a gateway.
 *
 * OpenClaw does not read this file at run time (2026.6.11 and 2026.7.1 alike):
 * the entrypoint's `openclaw doctor --fix` imports it into the agent's SQLite
 * auth store and then consumes the file. That import only ADDS profile ids it
 * has not seen — an id already present is never overwritten, and "present" only
 * means the fields are there, not that the credential still works. So writing
 * this file cannot by itself change a credential; see reconcileAuthProfileStore.
 *
 * Credentials are resolved per user, so every instance a member owns gets the
 * same keys (personal overrides where set, org defaults elsewhere).
 *
 * Also returns a fingerprint per profile id, taken from the credential in our
 * own database, which reconcile needs to tell an operator replacing a key apart
 * from OpenClaw refreshing one.
 */
/** A non-LLM credential bound for the instance's OpenClaw secret store. */
export interface ManagedSecret {
  provider: string;
  name: string;
  allowedHosts: string[];
  skill?: string;
  value: string;
}

function writeAuthProfiles(ref: GatewayRef, persist = true): {
  providerIds: string[];
  modelOverrides: Record<string, string>;
  clawProxyKey: string | null;
  tokenKioskKey: string | null;
  profiles: Record<string, Record<string, unknown>>;
  fingerprints: Record<string, string>;
  secrets: ManagedSecret[];
  /** Google OAuth client JSON for gog (kind 'oauth-client'), member key first. */
  gogClient: string | null;
} {
  const allKeys = getResolvedApiKeysForMember(ref.org_id, ref.user_id);
  const profiles: Record<string, Record<string, unknown>> = {};
  const fingerprints: Record<string, string> = {};
  const providerIds: string[] = [];
  const secrets: ManagedSecret[] = [];
  let gogClient: string | null = null;
  const modelOverrides: Record<string, string> = {};
  const order: Record<string, string[]> = {};
  const providerCounters: Record<string, number> = {};
  let clawProxyKey: string | null = null;
  let tokenKioskKey: string | null = null;

  for (const { provider, key, credential_type, default_model } of allKeys) {
    // claw-proxy and token-kiosk keys go directly into openclaw.json as custom providers, not auth-profiles
    if (provider === 'claw-proxy' || provider === 'token-kiosk') {
      if (provider === 'claw-proxy') clawProxyKey = key;
      else tokenKioskKey = key;
      if (!providerIds.includes(provider)) providerIds.push(provider);
      if (default_model && !modelOverrides[provider]) modelOverrides[provider] = default_model;
      continue;
    }

    const providerConfig = PROVIDERS.find((p) => p.id === provider);
    if (!providerConfig) continue;
    // Secret-store credentials (Notion) never touch auth-profiles.json and do
    // not count as a provider; ensureGatewaySecrets puts them in the store.
    if (providerConfig.kind === 'oauth-client') {
      if (gogClient === null) gogClient = key;
      continue;
    }
    if (providerConfig.kind === 'secret') {
      if (providerConfig.secret && !secrets.some((s) => s.name === providerConfig.secret!.name)) {
        secrets.push({ provider, value: key, ...providerConfig.secret });
      }
      continue;
    }
    if (!providerIds.includes(provider)) providerIds.push(provider);
    if (default_model && !modelOverrides[provider]) modelOverrides[provider] = default_model;

    // OpenClaw namespace for the auth profile. The `openai-codex` platform
    // provider maps to OpenClaw's canonical `openai` namespace so gpt-5.5 auth
    // resolves for `openai/gpt-5.5` model refs (Codex subscription rides the
    // same `openai` provider as API keys, distinguished by profile id + order).
    const ns = provider === "openai-codex" ? "openai" : provider;

    // Generate unique profile ID
    const count = (providerCounters[provider] ?? 0) + 1;
    providerCounters[provider] = count;
    const suffix = count === 1 ? '' : `-${count}`;

    let profileId: string;

    if (credential_type === "oauth") {
      try {
        const oauth = JSON.parse(key);
        const tokens = oauth.tokens ?? oauth;
        if (!tokens.access_token || !tokens.refresh_token) continue;

        let expires: number | undefined;
        try {
          const payload = JSON.parse(
            Buffer.from(tokens.access_token.split(".")[1], "base64").toString(),
          );
          // JWT `exp` is seconds; OpenClaw compares `expires` against Date.now()
          // in milliseconds. Passing raw seconds reads as 1970, so the token
          // looks expired on every single request and the gateway refreshes it
          // constantly — which rotates the refresh token until the provider
          // rejects the chain with refresh_token_invalidated.
          if (payload.exp) expires = payload.exp * 1000;
        } catch { /* non-JWT */ }

        profileId = `${ns}:oauth${suffix}`;
        profiles[profileId] = {
          type: "oauth",
          provider: ns,
          access: tokens.access_token,
          refresh: tokens.refresh_token,
          ...(expires ? { expires } : {}),
        };
      } catch {
        continue;
      }
    } else if (credential_type === "token") {
      profileId = `${ns}:setup-token${suffix}`;
      profiles[profileId] = {
        type: "token",
        provider: ns,
        token: key,
      };
    } else {
      profileId = `${ns}:manual${suffix}`;
      profiles[profileId] = { type: "api_key", provider: ns, key };
    }

    // Fingerprint of the credential as WE hold it, not as OpenClaw stores it:
    // this changes only when an operator supplies a different one.
    fingerprints[profileId] = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);

    if (!order[ns]) order[ns] = [];
    order[ns].push(profileId);
  }

  // Only include order for providers with multiple profiles
  const orderFiltered: Record<string, string[]> = {};
  for (const [provider, ids] of Object.entries(order)) {
    if (ids.length > 1) orderFiltered[provider] = ids;
  }

  const authProfilesPath = path.join(
    getGatewayDir(ref),
    "agents", "main", "agent", "auth-profiles.json",
  );
  if (persist) {
    fs.mkdirSync(path.dirname(authProfilesPath), { recursive: true });
    fs.writeFileSync(
      authProfilesPath,
      JSON.stringify({
        version: 1,
        profiles,
        ...(Object.keys(orderFiltered).length > 0 ? { order: orderFiltered } : {}),
      }, null, 2),
    );
  }

  return { providerIds, modelOverrides, clawProxyKey, tokenKioskKey, profiles, fingerprints, secrets, gogClient };
}

// ---------------------------------------------------------------------------
// Secret store (non-LLM credentials such as the Notion token)
//
// The value goes into the instance's OpenClaw secret store (SQLite under the
// state dir, so it survives redeploys) with `openclaw secrets store set`, run
// inside the container once the gateway is up. The bundled skill is then
// pointed at the entry with a store ref in openclaw.json. Order matters: an
// unresolved ref makes OpenClaw refuse to start or reload, so the ref is only
// written once the entry is known to be there (recorded in a state file).
//
// Entries a member created themselves (same name, no record of ours) are left
// alone: Michael's gateway carries his own NOTION_API_TOKEN.
// ---------------------------------------------------------------------------

type SecretState = Record<string, { fingerprint: string | null }>;

function secretStatePath(ref: GatewayRef): string {
  return path.join(getGatewayDir(ref), ".clawhuddle-secrets.json");
}

/** What we know is in the store: name -> our fingerprint (null = member-managed). Undefined = never looked. */
function readSecretState(ref: GatewayRef): SecretState | undefined {
  try {
    return JSON.parse(fs.readFileSync(secretStatePath(ref), "utf-8")) as SecretState;
  } catch {
    return undefined;
  }
}

/** Store refs for every platform-known secret present in the store, from the state file. */
function secretRefsFor(ref: GatewayRef): { skill: string; name: string }[] | undefined {
  const state = readSecretState(ref);
  if (!state) return undefined;
  return PROVIDERS.flatMap((p) =>
    p.secret?.skill && state[p.secret.name] ? [{ skill: p.secret.skill, name: p.secret.name }] : [],
  );
}

const secretFingerprint = (value: string) => crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);

/** True when a resolved secret is not yet known to be in the store as we hold it. */
function secretsOutOfDate(ref: GatewayRef, secrets: ManagedSecret[]): boolean {
  if (secrets.length === 0) return false;
  const state = readSecretState(ref);
  if (!state) return true;
  return secrets.some((s) => {
    const rec = state[s.name];
    return !rec || (rec.fingerprint !== null && rec.fingerprint !== secretFingerprint(s.value));
  });
}

/**
 * Per secret-kind provider, where this instance stands (for the API Keys
 * pages). `member` wins over everything: an entry the member created is never
 * touched, whatever key the org holds.
 */
export function secretStatusFor(g: GatewayRow): Record<string, SecretInjectionState> {
  if (g.runtime === "hermes") return hermesSecretStatus(g);
  const auth = writeAuthProfiles(g, false);
  const resolved = new Map(auth.secrets.map((s) => [s.provider, s] as const));
  const state = readSecretState(g);
  const out: Record<string, SecretInjectionState> = {};
  for (const p of PROVIDERS) {
    if (p.kind !== "secret" || !p.secret) continue;
    const rec = state?.[p.secret.name];
    const s = resolved.get(p.id);
    if (rec && rec.fingerprint === null) out[p.id] = "member";
    else if (!s) out[p.id] = "none";
    else if (rec && rec.fingerprint === secretFingerprint(s.value)) out[p.id] = "injected";
    else out[p.id] = "pending";
  }
  for (const p of PROVIDERS) {
    if (p.kind === "oauth-client") out[p.id] = gogClientState(g, auth.gogClient);
  }
  return out;
}

const secretSyncInFlight = new Map<string, Promise<void>>();

/**
 * Bring a RUNNING instance's secret store in line with the member's resolved
 * secret-kind keys, then (re)write openclaw.json so the skill refs match.
 * Idempotent; one run per gateway at a time; never throws.
 */
export function ensureGatewaySecrets(g: GatewayRow): Promise<void> {
  // Hermes has no secret store to fill: its keys are files, written by regenerateGatewayConfig.
  if (g.runtime === "hermes") return Promise.resolve();
  const inFlight = secretSyncInFlight.get(g.id);
  if (inFlight) return inFlight;
  const run = syncGatewaySecrets(g)
    .catch((err) => console.warn(`[gateway] secret sync failed for ${refLabel(g)}:`, err))
    .finally(() => secretSyncInFlight.delete(g.id));
  secretSyncInFlight.set(g.id, run);
  return run;
}

async function syncGatewaySecrets(g: GatewayRow): Promise<void> {
  const containerName = containerNameFor(g);
  if (!(await checkGatewayHealth(containerName))) return;
  // Independent steps: a failure in one must not hold up the other.
  await syncSecretStore(g, containerName)
    .catch((err) => console.warn(`[gateway] secret store sync failed for ${refLabel(g)}:`, err));
  await syncGogClient(g, containerName)
    .catch((err) => console.warn(`[gateway] gog client setup failed for ${refLabel(g)}:`, err));
  // Either step may have changed what the instructions can promise.
  writePlatformInstructions(getGatewayRow(g.org_id, g.id));
}

async function syncSecretStore(g: GatewayRow, containerName: string): Promise<void> {
  const desired = writeAuthProfiles(g, false).secrets;
  const listed = JSON.parse(
    await execInContainer(containerName, ["openclaw", "secrets", "store", "list", "--json"], 30000),
  ) as { name: string }[];
  const inStore = new Set(listed.map((e) => e.name));
  const before = readSecretState(g);
  const state: SecretState = { ...(before ?? {}) };

  for (const name of inStore) if (!state[name]) state[name] = { fingerprint: null }; // member-managed
  for (const name of Object.keys(state)) if (!inStore.has(name)) delete state[name];

  let injected = 0;
  for (const s of desired) {
    const rec = state[s.name];
    const fp = secretFingerprint(s.value);
    if (rec && rec.fingerprint === null) continue;            // the member's own entry
    if (rec && rec.fingerprint === fp) continue;              // already ours, unchanged
    const valueFile = `.clawhuddle-secret-${s.name}`;
    const hostPath = path.join(getGatewayDir(g), valueFile);
    fs.writeFileSync(hostPath, s.value, { mode: 0o600 });
    try {
      await execInContainer(containerName, [
        "openclaw", "secrets", "store", "set", s.name, "--kind", "secret",
        ...s.allowedHosts.flatMap((h) => ["--allow-host", h]),
        "--value-file", `/root/.openclaw/${valueFile}`,
      ], 30000);
    } finally {
      fs.rmSync(hostPath, { force: true });
    }
    state[s.name] = { fingerprint: fp };
    injected++;
    console.log(`[gateway] secret ${s.name} set in store for ${refLabel(g)} (${s.allowedHosts.join(", ")})`);
  }

  if (injected > 0) {
    // The reload RPC waits for in-flight turns; 30 s took it over the line on a busy gateway.
    await execInContainer(containerName, ["openclaw", "secrets", "reload"], 120000)
      .catch((err) => console.warn(`[gateway] secrets reload failed for ${refLabel(g)}:`, err));
  }

  const changed = JSON.stringify(before ?? null) !== JSON.stringify(state);
  if (changed) {
    fs.writeFileSync(secretStatePath(g), JSON.stringify(state, null, 2), { mode: 0o600 });
    // Refs follow the state file; openclaw.json hot-reloads.
    regenerateGatewayConfig(getGatewayRow(g.org_id, g.id));
  }
}

/** After a (re)start: wait for the gateway to come up, then sync its secret store. */
function scheduleSecretSync(g: GatewayRow): void {
  const containerName = containerNameFor(g);
  const deadline = Date.now() + 15 * 60 * 1000;
  const tick = async () => {
    if (Date.now() > deadline) return;
    try {
      if (await checkGatewayHealth(containerName)) {
        await ensureGatewaySecrets(getGatewayRow(g.org_id, g.id));
        return;
      }
    } catch { /* gone, or not yet there */ }
    setTimeout(tick, 15000).unref();
  };
  setTimeout(tick, 15000).unref();
}

// ---------------------------------------------------------------------------
// gog (Google Workspace CLI) OAuth client. An org key of kind 'oauth-client'
// holds the shared client JSON; every instance without a gog client of its
// own gets it via `gog auth credentials set`, so a member only has to run
// `gog auth add <email>`. gog keeps the client secret (and later the member's
// refresh tokens) in a file keyring whose password must be in the
// environment of every process that uses it, including the gateway's agents.
// The entrypoint exports /root/.openclaw/env at boot, so the password goes in
// there BEFORE the instance (re)boots, and the client is set once it is up.
//
// An instance whose gog already had a client when we first looked (no record
// of ours) belongs to its member and is never touched: Vasily runs his own.
// ---------------------------------------------------------------------------

type GogState = { fingerprint: string };

const GOG_ENV_KEYS = ["GOG_KEYRING_BACKEND", "GOG_KEYRING_PASSWORD"] as const;

const gogStatePath = (ref: GatewayRef) => path.join(getGatewayDir(ref), ".clawhuddle-gog.json");
const gogCredentialsPath = (ref: GatewayRef) => path.join(getGatewayDir(ref), "gog", "data", "credentials.json");
const memberEnvPath = (ref: GatewayRef) => path.join(getGatewayDir(ref), "env");

function readGogState(ref: GatewayRef): GogState | undefined {
  try {
    return JSON.parse(fs.readFileSync(gogStatePath(ref), "utf-8")) as GogState;
  } catch {
    return undefined;
  }
}

/** gog already has a client we did not put there. */
function gogMemberManaged(ref: GatewayRef): boolean {
  return !readGogState(ref) && fs.existsSync(gogCredentialsPath(ref));
}

/** KEY=value lines of the member env file the entrypoint loads. */
function readMemberEnv(ref: GatewayRef): Map<string, string> {
  const env = new Map<string, string>();
  try {
    for (const line of fs.readFileSync(memberEnvPath(ref), "utf-8").split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (m) env.set(m[1], m[2]);
    }
  } catch { /* no file */ }
  return env;
}

const gogEnvReady = (ref: GatewayRef) => {
  const env = readMemberEnv(ref);
  return GOG_ENV_KEYS.every((k) => env.has(k));
};

export function gogClientState(ref: GatewayRef, client: string | null): SecretInjectionState {
  if (gogMemberManaged(ref)) return "member";
  if (!client) return "none";
  if (readGogState(ref)?.fingerprint === secretFingerprint(client)) return "injected";
  return gogEnvReady(ref) ? "pending" : "restart";
}

/**
 * Before an instance boots: add the gog keyring settings to its env file when
 * the org has a client to install and gog is not the member's own. Never
 * changes a value already there (a keyring is unreadable under a new password).
 */
export function ensureGogEnv(ref: GatewayRef): void {
  if (!writeAuthProfiles(ref, false).gogClient || gogMemberManaged(ref)) return;
  const env = readMemberEnv(ref);
  const add: string[] = [];
  if (!env.has("GOG_KEYRING_BACKEND")) add.push("GOG_KEYRING_BACKEND=file");
  if (!env.has("GOG_KEYRING_PASSWORD")) add.push(`GOG_KEYRING_PASSWORD=${crypto.randomBytes(24).toString("hex")}`);
  if (add.length === 0) return;
  const file = memberEnvPath(ref);
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  const sep = current && !current.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(file, `${current}${sep}${add.join("\n")}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  console.log(`[gateway] gog keyring env added for ${refLabel(ref)} (${add.map((l) => l.split("=")[0]).join(", ")})`);
}

function gogClientOutOfDate(ref: GatewayRef, client: string | null): boolean {
  return gogClientState(ref, client) === "pending";
}

/** On a running instance whose env carries the keyring settings: install or update our client. */
async function syncGogClient(g: GatewayRow, containerName: string): Promise<void> {
  const client = writeAuthProfiles(g, false).gogClient;
  if (!gogClientOutOfDate(g, client)) return;
  const tmp = ".clawhuddle-gog-client.tmp.json";
  const hostPath = path.join(getGatewayDir(g), tmp);
  fs.writeFileSync(hostPath, client!, { mode: 0o600 });
  try {
    // Same env the gateway process got from the entrypoint; nothing secret on the command line.
    await execInContainer(containerName, [
      "sh", "-c", 'set -a; . /root/.openclaw/env; set +a; exec gog auth credentials set "$0"', `/root/.openclaw/${tmp}`,
    ], 30000);
  } finally {
    fs.rmSync(hostPath, { force: true });
  }
  fs.writeFileSync(gogStatePath(g), JSON.stringify({ fingerprint: secretFingerprint(client!) }, null, 2), { mode: 0o600 });
  console.log(`[gateway] gog OAuth client set for ${refLabel(g)}`);
}

// ---------------------------------------------------------------------------
// Google sign-in for gog from the Home card. gog's remote flow: step 1 prints
// Google's consent URL; after consent Google sends the browser to a loopback
// address (the client is a Desktop client, which only allows loopback
// redirects) that does not load, and the member pastes that address back;
// step 2 exchanges the code and stores the refresh token in gog's keyring.
// ---------------------------------------------------------------------------

/** Scopes asked for on sign-in; the set the hand recipe has used since October. */
export const GOG_SIGN_IN_SERVICES = "gmail,calendar,drive,docs,sheets,slides";

/**
 * Flags shared by both steps. gog checks step 2 against the state step 1
 * saved, and any difference (a missing --force-consent included) is refused
 * as "manual auth state mismatch".
 */
const GOG_SIGN_IN_FLAGS = '--services "$1" --remote --force-consent --json --no-input';

/**
 * ready: gog has a client and its keyring unlocks. pending: our client is being
 * installed right now. restart: it gets one at the next restart or redeploy.
 * no-client: the org has none to give. keyring: the member's own gog setup has
 * no keyring password in the instance env, so gog cannot store a sign-in.
 */
export type GoogleSignInReadiness = "ready" | "pending" | "restart" | "no-client" | "keyring";

export interface GoogleAccountsInfo {
  readiness: GoogleSignInReadiness;
  accounts: { email: string; services: string[] }[];
}

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function assertEmail(email: string): void {
  if (typeof email !== "string" || email.length > 254 || !EMAIL_RE.test(email)) throw new Error("Enter a valid Google account email");
}

/** gog errors can quote URLs; keep them free of codes and tokens before they reach a browser. */
function gogErrorMessage(err: unknown): string {
  let raw = err instanceof Error ? err.message : String(err);
  // gog prints a generic hint before its JSON error; keep only the error itself.
  const json = raw.lastIndexOf('{"error"');
  if (json >= 0) {
    try { raw = String(JSON.parse(raw.slice(json)).error?.message ?? raw); } catch { /* keep raw */ }
  }
  if (/state mismatch|state.*(not found|expired)/i.test(raw)) {
    return "This sign-in link is no longer the current one. Click Cancel, then Connect Google again and use the new tab.";
  }
  if (/invalid_grant/.test(raw)) {
    return "Google did not accept that code (it may have expired or been used already). Click Cancel and connect again.";
  }
  return raw
    .replace(/GOCSPX[-_A-Za-z0-9]+/g, "<redacted>")
    .replace(/\bya29\.[-_.A-Za-z0-9]+/g, "<redacted>")
    .replace(/\b1\/\/[-_A-Za-z0-9]+/g, "<redacted>")
    .replace(/([?&](?:code|state)=)[^&\s"]+/g, "$1<redacted>")
    .split("\n").filter((l) => l.trim()).slice(-3).join(" ")
    .slice(0, 400);
}

/** Runs gog in the instance with the env the gateway booted with. */
function execGog(containerName: string, script: string, args: string[], timeoutMs = 30000): Promise<string> {
  return execInContainer(containerName, [
    "sh", "-c", `[ -f /root/.openclaw/env ] && { set -a; . /root/.openclaw/env; set +a; }; ${script}`, ...args,
  ], timeoutMs);
}

function googleReadiness(g: GatewayRow): GoogleSignInReadiness {
  if (fs.existsSync(gogCredentialsPath(g))) return gogEnvReady(g) ? "ready" : "keyring";
  if (!writeAuthProfiles(g, false).gogClient) return "no-client";
  return gogEnvReady(g) ? "pending" : "restart";
}

export async function getGoogleAccounts(orgId: string, gatewayId: string): Promise<GoogleAccountsInfo> {
  const g = requireRunning(orgId, gatewayId);
  if (g.runtime === "hermes") return getHermesGoogleAccounts(g);
  const readiness = googleReadiness(g);
  if (readiness === "pending") void ensureGatewaySecrets(g);
  if (readiness !== "ready") return { readiness, accounts: [] };
  const out = await execGog(containerNameFor(g), "exec gog auth list --json --no-input", []);
  const parsed = JSON.parse(out) as { accounts?: { email: string; services?: string[] }[] };
  return {
    readiness,
    accounts: (parsed.accounts ?? []).map((a) => ({ email: a.email, services: a.services ?? [] })),
  };
}

export async function startGoogleSignIn(orgId: string, gatewayId: string, email: string): Promise<{ authUrl: string }> {
  assertEmail(email);
  const g = requireRunning(orgId, gatewayId);
  if (g.runtime === "hermes") return startHermesGoogleSignIn(g);
  if (googleReadiness(g) !== "ready") throw new Error("Google sign-in is not set up on this instance yet");
  let out: string;
  try {
    out = await execGog(containerNameFor(g),
      `exec gog auth add "$0" --step=1 ${GOG_SIGN_IN_FLAGS}`,
      [email, GOG_SIGN_IN_SERVICES]);
  } catch (err) {
    throw new Error(gogErrorMessage(err));
  }
  const authUrl = (JSON.parse(out.slice(out.indexOf("{"))) as { auth_url?: string }).auth_url;
  if (!authUrl || !authUrl.startsWith("https://accounts.google.com/")) throw new Error("gog did not return a Google sign-in link");
  return { authUrl };
}

/** The address Google sent the browser to: loopback, with the code and state. */
function assertRedirect(raw: string): string {
  let u: URL;
  try { u = new URL(String(raw).trim()); } catch { throw new Error("Paste the full address from the browser’s address bar"); }
  if (!["127.0.0.1", "localhost"].includes(u.hostname) || u.protocol !== "http:") {
    throw new Error("That is not the address Google redirected to (it starts with http://127.0.0.1 or http://localhost)");
  }
  if (u.searchParams.get("error")) throw new Error(`Google reported: ${u.searchParams.get("error")}`);
  if (!u.searchParams.get("code") || !u.searchParams.get("state")) throw new Error("The address has no sign-in code; paste it exactly as shown");
  return u.toString();
}

export async function finishGoogleSignIn(orgId: string, gatewayId: string, email: string, redirectUrl: string): Promise<GoogleAccountsInfo> {
  assertEmail(email);
  const url = assertRedirect(redirectUrl);
  const g = requireRunning(orgId, gatewayId);
  if (g.runtime === "hermes") return finishHermesGoogleSignIn(g, email, url);
  const tmp = ".clawhuddle-google-redirect.tmp";
  const hostPath = path.join(getGatewayDir(g), tmp);
  fs.writeFileSync(hostPath, url, { mode: 0o600 });
  try {
    await execGog(containerNameFor(g),
      `exec gog auth add "$0" --step=2 --auth-url "$(cat "$2")" ${GOG_SIGN_IN_FLAGS}`,
      [email, GOG_SIGN_IN_SERVICES, `/root/.openclaw/${tmp}`], 60000);
  } catch (err) {
    throw new Error(gogErrorMessage(err));
  } finally {
    fs.rmSync(hostPath, { force: true });
  }
  console.log(`[gateway] Google account ${email} signed in to gog on ${refLabel(g)}`);
  return getGoogleAccounts(orgId, gatewayId);
}

export async function removeGoogleAccount(orgId: string, gatewayId: string, email: string): Promise<GoogleAccountsInfo> {
  assertEmail(email);
  const g = requireRunning(orgId, gatewayId);
  if (g.runtime === "hermes") return removeHermesGoogleAccount(g);
  try {
    await execGog(containerNameFor(g), 'exec gog auth remove "$0" --force --no-input', [email]);
  } catch (err) {
    throw new Error(gogErrorMessage(err));
  }
  console.log(`[gateway] Google account ${email} removed from gog on ${refLabel(g)}`);
  return getGoogleAccounts(orgId, gatewayId);
}

const TOKEN_KIOSK_DEFAULT_URL = 'https://agent-router.gaib.ai/v1';

function getTokenKioskBaseUrl(): string {
  return process.env.TOKEN_KIOSK_URL || TOKEN_KIOSK_DEFAULT_URL;
}

/** Profile ids minted by writeAuthProfiles(), e.g. "openai:oauth", "google:manual-2". */
const MANAGED_PROFILE_ID = /^[^:]+:(manual|oauth|setup-token)(-\d+)?$/;

/** Our record of which credential each profile id was last handed to the importer. */
function authFingerprintPath(ref: GatewayRef): string {
  return path.join(
    getGatewayDir(ref),
    "agents", "main", "agent", ".clawhuddle-auth-fingerprints.json",
  );
}

/**
 * Where OpenClaw keeps auth profiles.
 *
 * - `shared` — 2026.11.x: the state database (config_machine_state, key
 *   `authProfiles.store`). Doctor archives auth-profiles.json there as
 *   "previously migrated" WITHOUT replaying it, so a profile is only ever
 *   changed with OpenClaw's own CLI while the gateway is stopped
 *   (saveAuthProfilesOffline). We never write this one ourselves.
 * - `agent` — the agent database's auth_profile_store table. Before 11.x it was
 *   the only store and Doctor re-imported whatever we dropped from it. On 11.x
 *   it is still read, as the per-agent layer over the shared store: Michael's
 *   instance kept `google:manual` there as a pointer to his own secret-store
 *   entry.
 */
const AUTH_STORES = {
  shared: {
    file: ["state", "openclaw.sqlite"],
    read: "SELECT value_json AS json FROM config_machine_state WHERE state_key = 'authProfiles.store'",
  },
  agent: {
    file: ["agents", "main", "agent", "openclaw-agent.sqlite"],
    read: "SELECT store_json AS json FROM auth_profile_store WHERE store_key = 'primary'",
  },
} as const;

type AuthProfileMap = Record<string, unknown>;

/**
 * The profiles in one store, or null when this instance has no such store
 * (never booted, or a version of OpenClaw that keeps none there). Throws on a
 * store that exists but cannot be read.
 */
function readAuthStoreProfiles(ref: GatewayRef, which: keyof typeof AUTH_STORES): AuthProfileMap | null {
  const loc = AUTH_STORES[which];
  const storePath = path.join(getGatewayDir(ref), ...loc.file);
  if (!fs.existsSync(storePath)) return null;
  const store = new Database(storePath, { readonly: true, fileMustExist: true });
  try {
    let row: { json: string } | undefined;
    try {
      row = store.prepare(loc.read).get() as { json: string } | undefined;
    } catch (err: any) {
      if (/no such table/.test(String(err?.message))) return null;
      throw err;
    }
    if (!row) return null;
    return (JSON.parse(row.json) as { profiles?: AuthProfileMap }).profiles ?? null;
  } finally {
    store.close();
  }
}

/** The secret field of a credential OpenClaw never refreshes (API key, setup token), or null. */
function staticSecret(profile: unknown): string | null {
  const p = profile as { type?: unknown; key?: unknown; token?: unknown } | null;
  if (p?.type === "api_key" && typeof p.key === "string") return p.key;
  if (p?.type === "token" && typeof p.token === "string") return p.token;
  return null;
}

/** True when a stored profile points at a credential kept elsewhere (`keyRef`, `tokenRef`: a secret-store entry, an env var). */
function pointsElsewhere(profile: unknown): boolean {
  if (!profile || typeof profile !== "object") return false;
  return Object.entries(profile).some(([k, v]) => /Ref$/.test(k) && v !== null && typeof v === "object");
}

/**
 * Makes a credential the operator replaced reach the gateway at its next boot.
 * Returns the profile ids that still have to be saved with
 * saveAuthProfilesOffline; before 11.x that list is always empty.
 *
 * OpenClaw's importer never overwrites a profile id it already has, so a key
 * changed in the UI is written to auth-profiles.json, silently skipped at
 * import, and the file consumed — the gateway keeps serving the old credential
 * forever.
 *
 * Before 11.x we delete the ids we mint whose source credential changed and
 * let the importer add them back. API keys and setup tokens are never rewritten
 * by the gateway, so those are compared by value. OAuth is judged on a
 * fingerprint of OUR copy of the credential instead, because the store is
 * legitimately newer than our file — the gateway writes refreshed tokens back
 * under the same id — and comparing content would drop a live credential on
 * every redeploy and re-import an original whose refresh token the provider
 * has since rotated away. With no OAuth fingerprint on record we keep what the
 * gateway has.
 *
 * On 11.x nothing is re-imported, so nothing is ever dropped (2026-11-23: the
 * old rule deleted Michael's `google:manual` pointer from the agent store when
 * the org Gemini key changed, and his agent lost Gemini). Instead every API
 * key or setup token of ours that the shared store lacks, holds without a
 * credential, or holds with a different value is returned for an offline save.
 * A profile that points elsewhere, in either store, is the member's own and is
 * left alone; a replaced OAuth credential is only reported.
 *
 * Only call this while the container is stopped — the gateway holds the store
 * open, and a running agent would not observe the change anyway.
 */
export function reconcileAuthProfileStore(
  ref: GatewayRef,
  profiles: Record<string, Record<string, unknown>>,
  fingerprints: Record<string, string>,
): string[] {
  let previous: Record<string, string> = {};
  try {
    previous = JSON.parse(fs.readFileSync(authFingerprintPath(ref), "utf-8"));
  } catch { /* first run, or unreadable — treated as "no record" below */ }

  const stale: string[] = [];
  try {
    const shared = readAuthStoreProfiles(ref, "shared");
    const agent = readAuthStoreProfiles(ref, "agent");

    if (shared) {
      const replacedOAuth: string[] = [];
      for (const [profileId, ours] of Object.entries(profiles)) {
        if (!MANAGED_PROFILE_ID.test(profileId)) continue;
        const stored = shared[profileId];
        const oursStatic = staticSecret(ours);
        if (oursStatic === null) {
          const before = previous[profileId];
          if (stored && before !== undefined && before !== fingerprints[profileId]) replacedOAuth.push(profileId);
          continue;
        }
        if (staticSecret(stored) === oursStatic) continue;                       // already the current key
        if (pointsElsewhere(stored) || pointsElsewhere(agent?.[profileId])) continue; // the member's own
        stale.push(profileId);
      }
      if (replacedOAuth.length > 0) {
        console.warn(
          `[gateway] ${refLabel(ref)}: the OAuth credential for ${replacedOAuth.join(", ")} was replaced in ClawHuddle, ` +
            "but OpenClaw 11.x keeps the one it has — sign in again on the instance (`openclaw models auth login`)",
        );
      }
    } else if (agent) {
      dropReplacedForReimport(ref, agent, profiles, fingerprints, previous);
    }
  } catch (err) {
    // A malformed or unfamiliar store must not block a redeploy: the gateway
    // still boots, it just keeps serving the previous credential. Claiming we
    // handed these over would make the next reconcile read a real OAuth change
    // as "unchanged" and skip it, so no fingerprints are recorded.
    console.warn(`[gateway] could not reconcile auth store for ${refLabel(ref)}:`, err);
    return [];
  }

  try {
    const target = authFingerprintPath(ref);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(fingerprints, null, 2));
  } catch (err) {
    console.warn(`[gateway] could not record auth fingerprints for ${refLabel(ref)}:`, err);
  }
  return stale;
}

/** The pre-11.x half of reconcileAuthProfileStore: drop replaced ids so Doctor imports them again. */
function dropReplacedForReimport(
  ref: GatewayRef,
  stored: AuthProfileMap,
  profiles: Record<string, Record<string, unknown>>,
  fingerprints: Record<string, string>,
  previous: Record<string, string>,
): void {
  const dropped: string[] = [];
  for (const profileId of Object.keys(stored)) {
    if (!MANAGED_PROFILE_ID.test(profileId)) continue;
    const ours = profiles[profileId];
    if (!ours) continue;                               // not ours to manage right now
    const oursStatic = staticSecret(ours);
    if (oursStatic !== null) {
      const storedStatic = staticSecret(stored[profileId]);
      if (storedStatic === null) continue;             // points elsewhere — the member's own
      if (storedStatic === oursStatic) continue;       // already the current key
    } else {
      const before = previous[profileId];
      if (before === undefined) continue;              // nothing to compare against — keep
      if (before === fingerprints[profileId]) continue; // same credential — keep the refreshed one
    }
    dropped.push(profileId);
  }
  if (dropped.length === 0) return;

  const kept = Object.fromEntries(Object.entries(stored).filter(([id]) => !dropped.includes(id)));
  const store = new Database(path.join(getGatewayDir(ref), ...AUTH_STORES.agent.file), { fileMustExist: true });
  try {
    const row = store.prepare(AUTH_STORES.agent.read).get() as { json: string };
    store
      .prepare("UPDATE auth_profile_store SET store_json = ? WHERE store_key = 'primary'")
      .run(JSON.stringify({ ...JSON.parse(row.json), profiles: kept }));
  } finally {
    store.close();
  }
  console.log(`[gateway] auth store reconciled for ${refLabel(ref)}: dropped ${dropped.join(", ")} for re-import`);
}

/** How long one offline `openclaw models auth …` run may take (a normal one is a few seconds). */
const OFFLINE_AUTH_TIMEOUT_MS = 120_000;

/**
 * Saves the given API keys / setup tokens into a STOPPED instance's auth store
 * with OpenClaw's own CLI (`openclaw models auth paste-api-key|paste-token`),
 * the only way a changed key reaches an 11.x gateway. The CLI demands exclusive
 * ownership of the state, hence stopped; it runs in a throwaway container of
 * `image` on the instance's state dir, with no network. The key travels in a
 * transient 0600 file in that dir, never on a command line or in a log.
 *
 * `image` must be the image the instance last ran on: the CLI of a newer
 * OpenClaw refuses state that Doctor has not upgraded yet (2026.11.10 on 11.2
 * state: "state database schema migration pending", then "config is invalid").
 *
 * auth-profiles.json is moved aside for the run: while that file holds a
 * credential the store has not imported yet (i.e. the very key being changed),
 * the CLI refuses with AUTH_PROFILE_MIGRATION_REQUIRED ("run openclaw doctor
 * --fix"). It is put back afterwards, for Doctor to archive at boot as before.
 *
 * Never throws: a failed save leaves the previous credential in place and is
 * logged, and the gateway still boots.
 */
export async function saveAuthProfilesOffline(
  g: GatewayRow,
  profiles: Record<string, Record<string, unknown>>,
  profileIds: string[],
  image: string,
): Promise<void> {
  if (profileIds.length === 0) return;
  const legacyFile = path.join(getGatewayDir(g), "agents", "main", "agent", "auth-profiles.json");
  const heldFile = path.join(path.dirname(legacyFile), ".clawhuddle-auth-profiles.held");
  let held = false;
  try {
    if (fs.existsSync(legacyFile)) {
      fs.renameSync(legacyFile, heldFile);
      held = true;
    }
  } catch (err) {
    console.warn(`[gateway] could not move auth-profiles.json aside for ${refLabel(g)}:`, err);
  }
  try {
    await saveEachAuthProfile(g, profiles, profileIds, image);
  } finally {
    if (held) {
      try {
        fs.renameSync(heldFile, legacyFile);
      } catch (err) {
        console.warn(`[gateway] could not put auth-profiles.json back for ${refLabel(g)}:`, err);
      }
    }
  }
}

/**
 * The instance's container is down, but its gateway was most likely killed
 * (`docker stop` on an image without the entrypoint's signal trap, a busy
 * gateway past the 10 s grace period, a crash) and still holds the state lock.
 * OpenClaw 2026.11.5+ never takes over a lock whose owner it cannot inspect,
 * which is every owner from another container, so the image's helper clears it
 * first (docker/gateway/recover-state-lock.sh). Images without the helper are
 * 11.2, where the lock runs out by itself: see ownerLeaseWaitMs.
 */
const AUTH_SAVE_RECOVER_LOCK =
  "if command -v clawhuddle-recover-lock >/dev/null 2>&1; then clawhuddle-recover-lock; fi; ";

/** One offline CLI run in a throwaway container. */
async function runAuthSave(
  g: GatewayRow,
  image: string,
  args: { command: string; provider: string; profileId: string; valueFile: string; agent: string | null },
): Promise<{ exitCode: number; output: string }> {
  const name = containerNameFor(g).replace(CONTAINER_PREFIX, "clawhuddle-authsave-");
  let container: Docker.Container | undefined;
  try {
    await docker.getContainer(name).remove({ force: true }).catch(() => {}); // left by a crashed run
    container = await docker.createContainer({
      Image: image,
      name,
      // Arguments are passed as argv, never spliced into the script.
      Entrypoint: [
        "sh", "-c",
        AUTH_SAVE_RECOVER_LOCK +
        'if [ -n "$5" ]; then exec openclaw models auth "$1" --agent "$5" --provider "$2" --profile-id "$3" < "$4"; ' +
          'else exec openclaw models auth "$1" --provider "$2" --profile-id "$3" < "$4"; fi',
        "sh", args.command, args.provider, args.profileId, `/root/.openclaw/${args.valueFile}`, args.agent ?? "",
      ],
      Cmd: [],
      // Without this the CLI hides why it failed ("The CLI command failed.").
      Env: ["OPENCLAW_DEBUG=1"],
      HostConfig: { Binds: [`${getHostGatewayDir(g)}:/root/.openclaw`], NetworkMode: "none" },
    });
    await container.start();
    const running = container;
    const timer = setTimeout(() => void running.kill().catch(() => {}), OFFLINE_AUTH_TIMEOUT_MS);
    let exitCode: number;
    try {
      exitCode = ((await container.wait()) as { StatusCode: number }).StatusCode;
    } finally {
      clearTimeout(timer);
    }
    if (exitCode === 0) return { exitCode, output: "" };
    const raw = (await container.logs({ stdout: true, stderr: true, tail: 60 })) as unknown as Buffer;
    const { stdout, stderr } = demuxDockerStream(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw)));
    const lines = `${stdout}\n${stderr}`.split("\n").filter((l) => l.trim() && !/DeprecationWarning|--trace-deprecation/.test(l));
    return { exitCode, output: lines.join("\n") };
  } finally {
    await container?.remove({ force: true }).catch(() => {});
  }
}

/**
 * With more than one agent configured the CLI refuses to guess whose
 * credentials it is saving ("Multiple agents are configured, but the model
 * command has no explicit owner. Pass --agent <id>", Kony's instance,
 * 2026-11-23). The API key lands in the shared store either way, so we name the
 * default agent; with one agent or none we pass nothing, as before.
 */
export function authOwnerAgent(config: unknown): string | null {
  const agents = (config as { agents?: { entries?: unknown; list?: unknown } } | null)?.agents;
  const found: { id: string; isDefault: boolean }[] = [];
  if (agents?.entries && typeof agents.entries === "object" && !Array.isArray(agents.entries)) {
    for (const [id, entry] of Object.entries(agents.entries as Record<string, { default?: unknown } | null>))
      found.push({ id, isDefault: entry?.default === true });
  }
  if (Array.isArray(agents?.list)) {
    for (const entry of agents.list as { id?: unknown; default?: unknown }[])
      if (typeof entry?.id === "string") found.push({ id: entry.id, isDefault: entry.default === true });
  }
  const ids = [...new Set(found.map((a) => a.id))].filter((id) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id));
  if (ids.length < 2) return null;
  return found.find((a) => a.isDefault && ids.includes(a.id))?.id ?? (ids.includes("main") ? "main" : ids[0]);
}

function readAuthOwnerAgent(g: GatewayRow): string | null {
  try {
    return authOwnerAgent(JSON.parse(fs.readFileSync(path.join(getGatewayDir(g), "openclaw.json"), "utf-8")));
  } catch {
    return null;
  }
}

/**
 * OpenClaw 2026.11.2 only (later images clear the lock, see
 * AUTH_SAVE_RECOVER_LOCK): a gateway that was killed rather than shut down
 * still owns the state until its heartbeat is 90 s old, and the CLI in another
 * container refuses until then ("the owner heartbeat is fresh … wait 59 s and
 * retry"). We wait that long, once per boot.
 */
const OWNER_LEASE_MAX_WAIT_MS = 110_000;
function ownerLeaseWaitMs(output: string): number | null {
  if (!/owner heartbeat is fresh/i.test(output)) return null;
  const seconds = Number(/wait (\d+) s and retry/i.exec(output)?.[1] ?? 15);
  return (Math.min(seconds, 90) + 1) * 1000;
}

async function saveEachAuthProfile(
  g: GatewayRow,
  profiles: Record<string, Record<string, unknown>>,
  profileIds: string[],
  image: string,
): Promise<void> {
  const giveUpAt = Date.now() + OWNER_LEASE_MAX_WAIT_MS;
  const agent = readAuthOwnerAgent(g);
  for (const profileId of profileIds) {
    const profile = profiles[profileId];
    const secret = staticSecret(profile);
    const provider = typeof profile?.provider === "string" ? profile.provider : "";
    if (secret === null || !MANAGED_PROFILE_ID.test(profileId) || !/^[a-z0-9][a-z0-9-]*$/.test(provider)) continue;
    const command = profile.type === "token" ? "paste-token" : "paste-api-key";

    const valueFile = `.clawhuddle-auth-${crypto.randomBytes(6).toString("hex")}`;
    const hostPath = path.join(getGatewayDir(g), valueFile);
    try {
      fs.writeFileSync(hostPath, secret, { mode: 0o600 });
      for (;;) {
        const run = await runAuthSave(g, image, { command, provider, profileId, valueFile, agent });
        const saved = staticSecret(readAuthStoreProfiles(g, "shared")?.[profileId]) === secret;
        if (run.exitCode === 0 && saved) {
          console.log(`[gateway] ${profileId} saved into the auth store of ${refLabel(g)} (key changed in ClawHuddle)`);
          break;
        }
        const waitMs = ownerLeaseWaitMs(run.output);
        if (waitMs !== null && Date.now() + waitMs <= giveUpAt) {
          console.log(
            `[gateway] ${refLabel(g)}: the stopped gateway still owns the state; saving ${profileId} in ${Math.round(waitMs / 1000)} s`,
          );
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }
        // The reason comes first, then a stack.
        const output = run.output.split(secret).join("<redacted>").slice(0, 2000);
        console.warn(
          `[gateway] could not save ${profileId} into the auth store of ${refLabel(g)} ` +
            `(exit ${run.exitCode}, ${saved ? "saved" : "store unchanged"}); it keeps its previous credential. ${output}`,
        );
        break;
      }
    } catch (err) {
      console.warn(`[gateway] could not save ${profileId} into the auth store of ${refLabel(g)}:`, err);
    } finally {
      fs.rmSync(hostPath, { force: true });
    }
  }
}

/** Compute Control UI allowed origins for a gateway subdomain. */
function getControlUiOrigins(subdomain: string): { allowedOrigins?: string[]; useHostHeaderFallback?: boolean } {
  if (IS_LOCAL_DEV) {
    // Local dev uses random ports — fall back to Host header
    return { useHostHeaderFallback: true };
  }
  // Production: explicit origins (both http and https in case of external SSL termination)
  const host = `${subdomain}.${GATEWAY_DOMAIN}`;
  return { allowedOrigins: [`http://${host}`, `https://${host}`] };
}

function configOptionsFor(
  g: GatewayRow,
  auth: { providerIds: string[]; modelOverrides: Record<string, string>; clawProxyKey: string | null; tokenKioskKey: string | null },
) {
  const clawProxyBaseUrl = process.env.CLAW_PROXY_URL || 'http://claw-proxy:3456/v1';
  const pin = getPrimaryPin(g);
  return {
    port: GATEWAY_INTERNAL_PORT,
    token: g.token,
    activeProviderIds: auth.providerIds,
    modelOverrides: auth.modelOverrides,
    channelTokens: getGatewayChannelTokens(g.id),
    clawProxy: auth.clawProxyKey ? { baseUrl: clawProxyBaseUrl, apiKey: auth.clawProxyKey } : undefined,
    tokenKiosk: auth.tokenKioskKey ? { baseUrl: getTokenKioskBaseUrl(), apiKey: auth.tokenKioskKey } : undefined,
    primaryProviderId: pin.provider ?? undefined,
    primaryModel: pin.model ?? undefined,
    secretRefs: secretRefsFor(g),
    ...getControlUiOrigins(g.subdomain),
  };
}

// Merge into the existing openclaw.json to preserve user customizations; a
// fresh instance (or a lost file) gets a generated one.
function writeOpenClawConfig(g: GatewayRow, options: ReturnType<typeof configOptionsFor>): void {
  const configPath = path.join(getGatewayDir(g), "openclaw.json");
  const lockDownLegacySlack = !slackAccessMigrated(g.id);
  let config;
  try {
    const existing = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    config = mergeOpenClawConfig(existing, options, { lockDownLegacySlack });
  } catch {
    config = generateOpenClawConfig(options);
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  markSlackAccessMigrated(g.id);
  writePlatformInstructions(g);
}

/**
 * (Re)write the platform's instructions file in the workspace from what this
 * instance has now. Read by OpenClaw at the start of each new session, so no
 * restart is needed. Never throws: a missing note must not fail a deploy.
 */
function writePlatformInstructions(g: GatewayRow): void {
  try {
    const notion = (secretRefsFor(g) ?? []).some((r) => r.skill === "notion");
    const gog = gogClientState(g, writeAuthProfiles(g, false).gogClient);
    const content = renderPlatformInstructions({ notion, google: gog === "injected" || gog === "member" });
    const file = path.join(getGatewayDir(g), "workspace", PLATFORM_INSTRUCTIONS_PATH);
    if (fs.existsSync(file) && fs.readFileSync(file, "utf-8") === content) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  } catch (err) {
    console.warn(`[gateway] platform instructions not written for ${refLabel(g)}:`, err);
  }
}

/**
 * Rewrite both files for one instance in place:
 *  - auth-profiles.json (credentials; imported by Doctor at the next boot)
 *  - openclaw.json (provider list + agents.defaults; hot-reloaded)
 *
 * Returns false if the instance has no directory yet — caller may treat this
 * as a no-op.
 */
function regenerateGatewayConfig(g: GatewayRow): boolean {
  if (g.runtime === "hermes") {
    // Keys, channel tokens and the model live in files Hermes reads on its own:
    // rewriting them is the whole sync, running or not.
    if (!hermesFilesExist(g)) return false;
    syncHermesFiles(g);
    return true;
  }
  if (!fs.existsSync(getGatewayDir(g))) return false;

  // OpenClaw 2026.10.x keeps credentials in SQLite and treats auth-profiles.json
  // as a legacy source that only Doctor (at boot) may import. Dropping a fresh
  // copy next to a RUNNING gateway makes it refuse every provider named in the
  // file ("requires legacy credential migration") until the next restart — that
  // is how an org-key edit on 2026-10-16 took every gateway offline. So while
  // the container is up, credentials are applied on the next start/redeploy
  // (both rewrite the file); only openclaw.json (model config, kiosk/proxy
  // keys) is refreshed now, which the gateway hot-reloads.
  const live = g.status === "running" || g.status === "deploying";
  const auth = writeAuthProfiles(g, !live);
  if (live) {
    console.log(`[gateway] auth-profiles for ${refLabel(g)} deferred to next restart (gateway is ${g.status})`);
  }

  writeOpenClawConfig(g, configOptionsFor(g, auth));
  return true;
}

/**
 * Sync every gateway in the org. Called after an org-level change (org-default
 * key add/delete, primary_provider update) that may affect every member.
 *
 * Note: openclaw.json hot-reloads (model config, custom-provider keys), but
 * auth-profiles.json is only imported by Doctor at boot and must not be
 * rewritten under a running gateway (see regenerateGatewayConfig). Standard
 * provider key changes therefore take effect on each gateway's next restart.
 */
export function syncAuthProfiles(orgId: string): void {
  for (const g of listOrgGateways(orgId)) {
    if (regenerateGatewayConfig(g) && g.status === "running") void ensureGatewaySecrets(g);
  }
}

/**
 * Sync every instance one member owns. Called after a personal key or
 * primary-provider change.
 */
export function syncAuthProfilesForUser(orgId: string, userId: string): void {
  for (const g of listUserGateways(orgId, userId)) {
    if (regenerateGatewayConfig(g) && g.status === "running") void ensureGatewaySecrets(g);
  }
}

/** Rewrite one instance's config (e.g. after its own primary-provider pin changed). */
export function syncGatewayConfig(orgId: string, gatewayId: string): void {
  regenerateGatewayConfig(getGatewayRow(orgId, gatewayId));
}

function createContainerConfig(g: GatewayRow) {
  const containerName = containerNameFor(g);
  const hostConfig: Record<string, any> = {
    Binds: [`${getHostGatewayDir(g)}:/root/.openclaw`],
    RestartPolicy: { Name: "unless-stopped" },
  };

  // Local dev: publish socat port so gateway is accessible without Traefik
  if (IS_LOCAL_DEV) {
    hostConfig.PortBindings = {
      [`${GATEWAY_EXTERNAL_PORT}/tcp`]: [{ HostPort: "0" }], // 0 = random available port
    };
  }

  return {
    Image: GATEWAY_IMAGE,
    name: containerName,
    Env: [],
    Labels: createTraefikLabels(containerName, g.subdomain, GATEWAY_EXTERNAL_PORT),
    ExposedPorts: { [`${GATEWAY_EXTERNAL_PORT}/tcp`]: {} },
    HostConfig: hostConfig,
    NetworkingConfig: {
      EndpointsConfig: {
        [GATEWAY_NETWORK]: {},
      },
    },
  };
}

// After container starts, read the actual host port Docker allocated
async function getHostPort(containerName: string): Promise<number | null> {
  if (!IS_LOCAL_DEV) return null;
  try {
    const container = docker.getContainer(containerName);
    const info = await container.inspect();
    const portBindings =
      info.NetworkSettings.Ports[`${GATEWAY_EXTERNAL_PORT}/tcp`];
    return portBindings?.[0]?.HostPort
      ? Number(portBindings[0].HostPort)
      : null;
  } catch {
    return null;
  }
}

/** What lifecycle calls hand back: the row as the owner may see it, minus the token. */
function publicState(g: GatewayRow) {
  return summarizeGateway(g);
}

/**
 * (Re)creates an instance's container from its current config. Serves both the
 * first deploy and every redeploy: the row already holds token and subdomain,
 * and the config writer merges an existing openclaw.json or generates one.
 */
export async function deployGateway(orgId: string, gatewayId: string) {
  await ensureNetwork();
  const g = getGatewayRow(orgId, gatewayId);
  const containerName = containerNameFor(g);
  if (g.runtime === "hermes") return deployHermesGateway(g);

  // The image the state was last run on, for the key save below.
  const previousImage = await docker.getContainer(containerName).inspect().then((info) => info.Image, () => undefined);

  // Stop and remove old container
  await removeContainer(containerName);

  fs.mkdirSync(getGatewayDir(g), { recursive: true });

  // Write auth-profiles.json (credentials read from file, not env vars). A key
  // may have changed since the last boot: reconcile, or the importer would skip
  // the id it already has and the gateway would come back on the old credential.
  const auth = writeAuthProfiles(g);
  const staleProfiles = reconcileAuthProfileStore(g, auth.profiles, auth.fingerprints);
  if (auth.providerIds.length === 0)
    throw new Error("No API keys configured — add at least one provider key");

  writeOpenClawConfig(g, configOptionsFor(g, auth));
  ensureGogEnv(g);

  // Install skill directories (shared per user, copied into every instance)
  await installSkillsForUser(path.join(g.org_id, gatewayDirName(g.user_id, g.slot)), getMemberSkills(orgId, g.user_id));

  // After the config is written: the CLI records the profile in openclaw.json too.
  // With the previous container's image, not the new one: when this deploy
  // moves the instance to a newer OpenClaw, only the old CLI can still write
  // the state (Doctor upgrades it at the boot that follows).
  await saveAuthProfilesOffline(g, auth.profiles, staleProfiles, previousImage || GATEWAY_IMAGE);

  const container = await docker.createContainer(createContainerConfig(g));
  await container.start();

  // In local dev, read the actual host port Docker allocated
  const port = (await getHostPort(containerName)) || GATEWAY_INTERNAL_PORT;
  // Mark as deploying — getGatewayStatus will promote to running after health check
  setGatewayState(g.id, { port, status: "deploying" });
  scheduleSecretSync(g);

  return publicState(getGatewayRow(orgId, gatewayId));
}

/**
 * A Hermes instance: files first (they are all it needs; there is no auth
 * store to save into and nothing to migrate), then a fresh container.
 */
async function deployHermesGateway(g: GatewayRow) {
  const containerName = containerNameFor(g);
  // Before the old container goes: a member without a usable key keeps what is running.
  await prepareHermesDeploy(g, getMemberSkills(g.org_id, g.user_id));
  await removeContainer(containerName);

  const container = await docker.createContainer(hermesContainerConfig(g));
  await container.start();

  const port = (await getHermesHostPort(containerName)) || HERMES_DASHBOARD_PORT;
  setGatewayState(g.id, { port, status: "deploying" });
  return publicState(getGatewayRow(g.org_id, g.id));
}

/**
 * Adds an instance for a member (subject to their limit) and deploys it. A
 * failed first deploy leaves nothing behind: the row, directory and any
 * half-made container are removed before the error is rethrown.
 */
export async function createGateway(
  orgId: string,
  memberId: string,
  opts: { label?: string | null; runtime?: GatewayRuntime } = {},
) {
  const g = createGatewayRow(orgId, memberId, opts);
  try {
    return await deployGateway(orgId, g.id);
  } catch (err) {
    await removeContainer(containerNameFor(g));
    fs.rmSync(getGatewayDir(g), { recursive: true, force: true });
    if (g.runtime === "hermes") removeHermesManagedDir(g);
    deleteGatewayRow(g.id);
    throw err;
  }
}

export async function stopGateway(orgId: string, gatewayId: string) {
  const g = getGatewayRow(orgId, gatewayId);
  await docker.getContainer(containerNameFor(g)).stop();
  setGatewayState(g.id, { status: "stopped" });
  return publicState(getGatewayRow(orgId, gatewayId));
}

/**
 * For a stopped instance about to boot in its existing container: write
 * auth-profiles.json and bring the auth store in line with the member's keys,
 * using the image that container was created from.
 */
async function syncAuthBeforeBoot(g: GatewayRow, container: Docker.Container): Promise<void> {
  const { profiles, fingerprints } = writeAuthProfiles(g);
  const stale = reconcileAuthProfileStore(g, profiles, fingerprints);
  if (stale.length === 0) return;
  const image = await container.inspect().then((info) => info.Image, () => undefined);
  await saveAuthProfilesOffline(g, profiles, stale, image || GATEWAY_IMAGE);
}

export async function startGateway(orgId: string, gatewayId: string) {
  const g = getGatewayRow(orgId, gatewayId);

  // A key may have changed while this gateway was stopped. Reconcile before it
  // boots: the importer would otherwise skip the id it already has and the
  // gateway would come back up on the old credential without saying so.
  const container = docker.getContainer(containerNameFor(g));
  if (g.runtime === "hermes") {
    syncHermesFiles(g);
    await container.start();
    setGatewayState(g.id, { status: "deploying" });
    return publicState(getGatewayRow(orgId, gatewayId));
  }
  await syncAuthBeforeBoot(g, container);
  ensureGogEnv(g);

  await container.start();
  setGatewayState(g.id, { status: "deploying" });
  scheduleSecretSync(g);
  return publicState(getGatewayRow(orgId, gatewayId));
}

/**
 * Reboots the container as it is — same image, same config files on disk.
 * Config edits the gateway could not hot-reload take effect; anything the
 * platform generates (keys, skills, channels) needs deployGateway instead.
 */
export async function restartGateway(orgId: string, gatewayId: string) {
  const g = getGatewayRow(orgId, gatewayId);
  const container = docker.getContainer(containerNameFor(g));
  // Stop first: the auth store must not be edited under a running gateway.
  await container.stop().catch((err: any) => {
    if (err?.statusCode !== 304) throw err; // 304 = already stopped
  });
  if (g.runtime === "hermes") {
    syncHermesFiles(g);
    await container.start();
    setGatewayState(g.id, { status: "deploying" });
    return publicState(getGatewayRow(orgId, gatewayId));
  }
  await syncAuthBeforeBoot(g, container);
  ensureGogEnv(g);

  await container.start();
  setGatewayState(g.id, { status: "deploying" });
  scheduleSecretSync(g);
  return publicState(getGatewayRow(orgId, gatewayId));
}

/** Removes the container, its port forwards, its workspace and its row. */
export async function removeGateway(orgId: string, gatewayId: string) {
  const g = getGatewayRow(orgId, gatewayId);

  await removeContainer(containerNameFor(g));
  // Files first: the row's DB cascade cannot remove Traefik configs
  removePortForwardsForGateway(g.id);
  fs.rmSync(getGatewayDir(g), { recursive: true, force: true });
  if (g.runtime === "hermes") removeHermesManagedDir(g);
  deleteGatewayRow(g.id);

  return { id: g.id, member_id: g.member_id, user_id: g.user_id, slot: g.slot, removed: true };
}

export async function redeployAllGateways(orgId: string) {
  const results: { gatewayId: string; memberId: string; slot: number; status: string | null }[] = [];
  const errors: { gatewayId: string; memberId: string; slot: number; error: string }[] = [];

  for (const g of listOrgGateways(orgId)) {
    try {
      const result = await deployGateway(orgId, g.id);
      results.push({ gatewayId: g.id, memberId: g.member_id, slot: g.slot, status: result.status });
    } catch (err: any) {
      console.error(`Failed to redeploy gateway ${refLabel(g)}:`, err.message);
      errors.push({ gatewayId: g.id, memberId: g.member_id, slot: g.slot, error: err.message });
    }
  }

  return { results, errors };
}

/**
 * Redeploys the instances a member currently has up, after something every
 * instance consumes changed (skills). Failures are logged, not raised: the
 * change itself was already saved.
 */
export async function redeployRunningGatewaysForMember(orgId: string, memberId: string): Promise<void> {
  for (const g of listMemberGateways(memberId)) {
    if (g.status !== "running" && g.status !== "deploying") continue;
    try {
      await deployGateway(orgId, g.id);
    } catch (err: any) {
      console.error(`Failed to redeploy gateway ${refLabel(g)}:`, err.message);
    }
  }
}

/** Syncs the row with the real container + health state and returns it. */
export async function getGatewayStatus(orgId: string, gatewayId: string) {
  const g = getGatewayRow(orgId, gatewayId);
  const containerName = containerNameFor(g);

  let actual: "running" | "deploying" | "stopped";
  try {
    const info = await docker.getContainer(containerName).inspect();
    if (!info.State.Running) {
      actual = "stopped";
    } else {
      // Container is running — check if gateway HTTP is actually ready
      const healthy = g.runtime === "hermes" ? checkHermesHealth(containerName) : checkGatewayHealth(containerName);
      actual = (await healthy) ? "running" : "deploying";
    }
  } catch {
    // Container doesn't exist
    actual = "stopped";
  }

  if (actual !== g.status) setGatewayState(g.id, { status: actual });
  if (g.runtime === "hermes") return publicState({ ...g, status: actual });
  const auth = actual === "running" ? writeAuthProfiles(g, false) : null;
  if (auth && (g.status !== "running" || secretsOutOfDate(g, auth.secrets) || gogClientOutOfDate(g, auth.gogClient))) {
    void ensureGatewaySecrets({ ...g, status: actual });
  }
  return publicState({ ...g, status: actual });
}

function requireRunning(orgId: string, gatewayId: string): GatewayRow {
  const g = getGatewayRow(orgId, gatewayId);
  if (g.status !== "running") throw new Error("Gateway is not running");
  return g;
}

/** For calls that only exist on OpenClaw (device pairing). */
function requireOpenClaw(g: GatewayRow): GatewayRow {
  if (g.runtime !== "openclaw") throw new Error("Not available on a Hermes instance");
  return g;
}

/** Approve a pairing code for a channel in the gateway container. */
export async function approvePairing(
  orgId: string,
  gatewayId: string,
  channel: string,
  code: string,
): Promise<string> {
  const g = requireRunning(orgId, gatewayId);
  if (g.runtime === "hermes") return approveHermesPairing(g, channel, code);
  const output = await execInContainer(containerNameFor(g), [
    "openclaw",
    "pairing",
    "approve",
    channel,
    code,
  ]);
  return output.trim();
}

/** List pending pairing requests for a channel. */
export async function listPairingRequests(
  orgId: string,
  gatewayId: string,
  channel: string,
): Promise<string> {
  const g = requireRunning(orgId, gatewayId);
  if (g.runtime === "hermes") return listHermesPairing(g, channel);
  const output = await execInContainer(containerNameFor(g), [
    "openclaw",
    "pairing",
    "list",
    channel,
  ]);
  return output.trim();
}

// OpenClaw request ids are UUIDs; anything else never reaches the CLI.
const DEVICE_REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** Keep only the fields the UI shows — never the device's public key. */
function toDeviceRequest(p: Record<string, unknown>): DevicePairingRequest {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
  return {
    requestId: String(p.requestId),
    deviceId: String(p.deviceId ?? ""),
    displayName: str(p.displayName),
    platform: str(p.platform),
    deviceFamily: str(p.deviceFamily),
    clientId: str(p.clientId),
    clientMode: str(p.clientMode),
    browserOrigin: str(p.browserOrigin),
    role: str(p.role),
    roles: list(p.roles),
    scopes: list(p.scopes),
    remoteIp: str(p.remoteIp),
    isRepair: p.isRepair === true ? true : undefined,
    ts: typeof p.ts === "number" ? p.ts : 0,
  };
}

/** Parse `openclaw devices list --json`, tolerating log lines ahead of the JSON. */
export function parseDeviceRequests(output: string): DevicePairingRequest[] {
  const start = output.indexOf("{");
  if (start < 0) throw new Error("devices list returned no JSON");
  const parsed = JSON.parse(output.slice(start)) as { pending?: Record<string, unknown>[] };
  return (parsed.pending ?? []).filter((p) => p && p.requestId).map(toDeviceRequest);
}

function assertRequestId(requestId: string): void {
  if (!DEVICE_REQUEST_ID.test(requestId)) throw new Error("Invalid request id");
}

/** Read `clawhuddle-pending-devices` output; null unless it is a plain count. */
export function parsePendingCount(output: string): number | null {
  const text = output.trim();
  return /^\d+$/.test(text) ? Number(text) : null;
}

/**
 * The cheap pending check (docker/gateway/pending-devices.cjs). Null means
 * unknown: the check failed, or the instance predates it and has not been
 * redeployed yet (exec exits 127).
 */
async function pendingDeviceCount(containerName: string): Promise<number | null> {
  try {
    return parsePendingCount(await execInContainer(containerName, ["clawhuddle-pending-devices"]));
  } catch {
    return null;
  }
}

/**
 * Browsers/devices waiting to be approved into an instance's Control UI. The
 * entrypoint auto-approves within seconds where its loop is running (see
 * docker/gateway/entrypoint.sh), so this is usually empty, and the sidebar polls
 * it from every open tab: the CLI, which costs ~4.5 CPU-seconds, runs only when
 * the cheap check does not say 0. A stopped instance simply has none.
 */
export async function listDeviceRequests(orgId: string, gatewayId: string): Promise<DevicePairingRequest[]> {
  const g = getGatewayRow(orgId, gatewayId);
  // Hermes has no device pairing: its dashboard is behind the instance's own sign-in.
  if (g.status !== "running" || g.runtime === "hermes") return [];
  const container = containerNameFor(g);
  if ((await pendingDeviceCount(container)) === 0) return [];
  const output = await execInContainer(container, ["openclaw", "devices", "list", "--json"]);
  return parseDeviceRequests(output);
}

export async function approveDeviceRequest(orgId: string, gatewayId: string, requestId: string): Promise<void> {
  assertRequestId(requestId);
  const g = requireOpenClaw(requireRunning(orgId, gatewayId));
  await execInContainer(containerNameFor(g), ["openclaw", "devices", "approve", requestId, "--json"]);
}

export async function rejectDeviceRequest(orgId: string, gatewayId: string, requestId: string): Promise<void> {
  assertRequestId(requestId);
  const g = requireOpenClaw(requireRunning(orgId, gatewayId));
  await execInContainer(containerNameFor(g), ["openclaw", "devices", "reject", requestId, "--json"]);
}

/**
 * Pending device requests across several instances (a member's, or the whole
 * org's), each tagged with its instance. Instances are read in parallel; one
 * that cannot be read is reported in `errors` rather than failing the lot.
 */
export async function collectDeviceRequests(
  gateways: GatewayRow[],
  describe: (g: GatewayRow) => DeviceRequestList["data"][number]["gateway"] = summarizeGateway,
): Promise<DeviceRequestList> {
  const running = gateways.filter((g) => g.status === "running" && g.runtime !== "hermes");
  const results = await Promise.allSettled(running.map((g) => listDeviceRequests(g.org_id, g.id)));
  const data: DeviceRequestList["data"] = [];
  const errors: DeviceRequestList["errors"] = [];
  results.forEach((r, i) => {
    const g = running[i];
    if (r.status === "fulfilled") {
      for (const req of r.value) data.push({ ...req, gateway: describe(g) });
    } else {
      errors.push({ gateway_id: g.id, message: r.reason?.message ?? String(r.reason) });
    }
  });
  data.sort((a, b) => b.ts - a.ts);
  return { data, errors };
}

/**
 * Remove all gateway containers, port-forward files and workspace files for an org.
 * Does NOT delete gateway rows — caller is responsible for deleting org rows.
 */
export async function deleteOrgGateways(orgId: string): Promise<void> {
  for (const g of listOrgGateways(orgId)) {
    await removeContainer(containerNameFor(g));
    fs.rmSync(getGatewayDir(g), { recursive: true, force: true });
  }
  removePortForwardsForOrg(orgId);

  // Remove the whole org gateway directory if it exists
  const orgGatewayDir = path.join(getDataDir(), "gateways", orgId);
  if (fs.existsSync(orgGatewayDir)) {
    fs.rmSync(orgGatewayDir, { recursive: true });
  }
}

/** Docker container IDs for every gateway container in an org, keyed by container name. */
export async function getOrgContainerIds(orgId: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  try {
    const containers = await docker.listContainers({
      all: true,
      filters: { name: [`${CONTAINER_PREFIX}${orgId.slice(0, 8)}-`] },
    });
    for (const c of containers) {
      const name = c.Names[0]?.replace(/^\//, "");
      if (name) result.set(name, c.Id);
    }
  } catch {
    // Docker may be unavailable
  }
  return result;
}
