/**
 * Hermes Agent instances (`gateways.runtime = 'hermes'`): the files, the
 * container and the in-container calls. `gateway.ts` owns the lifecycle and
 * dispatches here; what goes into the files is decided in `hermes-config.ts`.
 *
 * Two host directories per instance:
 *  - the home, `data/gateways/<org>/<user>[-N]` → `/opt/data`: the member's
 *    (config.yaml, .env, sessions, skills). We seed it once and afterwards only
 *    write our own skills category and the Google client file.
 *  - the managed layer, `data/gateways/<org>/.hermes/<user>[-N]` → `/etc/hermes`
 *    read-only: keys, channel tokens, model. Rewritten wholesale on every sync;
 *    Hermes applies it over the member's files.
 */
import fs from "node:fs";
import path from "node:path";
import { PROVIDERS, type SecretInjectionState, type Skill } from "@clawhuddle/shared";
import { getResolvedApiKeysForMember } from "../routes/org/api-keys.js";
import {
  GATEWAY_DOMAIN,
  GATEWAY_NETWORK,
  IS_LOCAL_DEV,
  createTraefikLabels,
  docker,
  execInContainer,
  gatewayNetworkSubnets,
} from "./docker.js";
import {
  containerNameFor,
  gatewayDirName,
  getDataDir,
  getGatewayChannelTokens,
  getGatewayDir,
  getHostDataDir,
  getHostGatewayDir,
  getPrimaryPin,
  type GatewayRef,
  type GatewayRow,
} from "./gateway-store.js";
import {
  HERMES_CHANNEL_SOURCES,
  HERMES_DASHBOARD_PORT,
  HERMES_GOOGLE_SERVICES,
  HERMES_HOME,
  HERMES_MANAGED_DIR,
  HERMES_PAIRING_CODE,
  HERMES_SKILL_CATEGORY,
  HERMES_UID,
  buildHermesManaged,
  hermesDashboardEnv,
  hermesFingerprint,
  hermesGoogleClientFile,
  hermesPlatformSkills,
  renderHermesEnv,
  seedHermesConfig,
  type HermesManaged,
} from "./hermes-config.js";
import { installSkillsForUser } from "./skill-installer.js";
import type { GoogleAccountsInfo } from "./gateway.js";

export const HERMES_IMAGE = process.env.HERMES_IMAGE || "clawhuddle-hermes:local";

const PYTHON = "/opt/hermes/.venv/bin/python";
const HELPER = "/opt/clawhuddle/helper.py";
const HERMES_CLI = "/opt/hermes/bin/hermes";
/** In-container account every exec runs as, so nothing in the home ends up root-owned. */
const HERMES_USER = "hermes";

const STATE_FILE = "clawhuddle-state.json";
const GOOGLE_CLIENT_FILE = "google_client_secret.json";
const GOOGLE_TOKEN_FILE = "google_token.json";
const GOOGLE_LABEL_FILE = ".clawhuddle-google.json";
/** Marks a skill directory as written by the platform (as opposed to an org skill of the same name). */
const SKILL_MARKER = ".clawhuddle-managed";

const GIB = 1024 ** 3;

const refLabel = (ref: GatewayRef) => `${ref.org_id}/${gatewayDirName(ref.user_id, ref.slot)}`;
const managedRel = (ref: GatewayRef) => path.join("gateways", ref.org_id, ".hermes", gatewayDirName(ref.user_id, ref.slot));

export const getHermesManagedDir = (ref: GatewayRef) => path.join(getDataDir(), managedRel(ref));
const getHostHermesManagedDir = (ref: GatewayRef) => path.join(getHostDataDir(), managedRel(ref));

// --- files ------------------------------------------------------------------

/** chown that tolerates not being root (tests, local dev without Docker Desktop's root). */
function chown(target: string, uid: number, gid: number): void {
  try {
    fs.chownSync(target, uid, gid);
  } catch (err: any) {
    if (err?.code !== "EPERM") throw err;
  }
}

/** Atomic write that leaves an identical file alone. Returns whether it wrote. */
function writeIfChanged(file: string, content: string, mode: number, uid: number, gid: number): boolean {
  let current: string | null = null;
  try { current = fs.readFileSync(file, "utf-8"); } catch { /* missing */ }
  if (current === content) return false;
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.chmodSync(tmp, mode);
  chown(tmp, uid, gid);
  fs.renameSync(tmp, file);
  return true;
}

/** A directory inside the home that the agent must be able to write. */
function ensureHomeDir(dir: string): void {
  if (fs.existsSync(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
  chown(dir, HERMES_UID, HERMES_UID);
}

interface HermesState {
  /** Fingerprint of the Google OAuth client we installed; absent = we installed none. */
  googleClient?: string;
  /**
   * The gateway network's subnets as of the last deploy. The dashboard trusts
   * `X-Forwarded-Proto/-For` only from these, i.e. from Traefik: without it the
   * session cookies are not marked Secure and every visitor shares one
   * sign-in rate limit. Read once at dashboard start, so it is fixed per deploy.
   */
  trustedProxies?: string[];
}

function readState(ref: GatewayRef): HermesState {
  try {
    return JSON.parse(fs.readFileSync(path.join(getHermesManagedDir(ref), STATE_FILE), "utf-8")) as HermesState;
  } catch {
    return {};
  }
}

function writeState(ref: GatewayRef, state: HermesState): void {
  const dir = getHermesManagedDir(ref);
  fs.mkdirSync(dir, { recursive: true });
  writeIfChanged(path.join(dir, STATE_FILE), JSON.stringify(state, null, 2) + "\n", 0o600, 0, 0);
}

function resolveManaged(g: GatewayRow): HermesManaged {
  const pin = getPrimaryPin(g);
  return buildHermesManaged({
    keys: getResolvedApiKeysForMember(g.org_id, g.user_id),
    channelTokens: getGatewayChannelTokens(g.id),
    primaryProviderId: pin.provider,
    primaryModel: pin.model,
  });
}

const googleClientPath = (ref: GatewayRef) => path.join(getGatewayDir(ref), GOOGLE_CLIENT_FILE);

/**
 * injected: the org's client is the one in the home. member: a client file we
 * have no record of, so the member's own, never replaced. pending: ours is not
 * written yet (the home does not exist before the first deploy).
 */
function googleClientState(ref: GatewayRef, client: string | null): SecretInjectionState {
  const exists = fs.existsSync(googleClientPath(ref));
  const recorded = readState(ref).googleClient;
  if (exists && !recorded) return "member";
  if (!client) return "none";
  return exists && recorded === hermesFingerprint(client) ? "injected" : "pending";
}

function syncGoogleClient(g: GatewayRow, client: string | null): void {
  if (!client || googleClientState(g, client) !== "pending") return;
  const content = hermesGoogleClientFile(client);
  if (!content) return;
  writeIfChanged(googleClientPath(g), content, 0o600, HERMES_UID, HERMES_UID);
  writeState(g, { ...readState(g), googleClient: hermesFingerprint(client) });
  console.log(`[hermes] Google OAuth client installed on ${refLabel(g)}`);
}

/**
 * The platform's own skills (notes, Notion) in `skills/clawhuddle/`. A
 * directory of the same name without our marker is an org skill and wins;
 * marked directories we no longer provide are removed.
 */
function syncPlatformSkills(g: GatewayRow, managed: HermesManaged): void {
  const home = getGatewayDir(g);
  ensureHomeDir(path.join(home, "skills"));
  const root = path.join(home, "skills", HERMES_SKILL_CATEGORY);
  ensureHomeDir(root);

  const wanted = hermesPlatformSkills({ notion: managed.notion, google: fs.existsSync(googleClientPath(g)) });
  for (const skill of wanted) {
    const dir = path.join(root, skill.name);
    const marker = path.join(dir, SKILL_MARKER);
    if (fs.existsSync(dir) && !fs.existsSync(marker)) continue;
    ensureHomeDir(dir);
    writeIfChanged(path.join(dir, "SKILL.md"), skill.content, 0o644, HERMES_UID, HERMES_UID);
    writeIfChanged(marker, "", 0o644, HERMES_UID, HERMES_UID);
  }
  const names = new Set(wanted.map((s) => s.name));
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || names.has(entry.name)) continue;
    const dir = path.join(root, entry.name);
    if (fs.existsSync(path.join(dir, SKILL_MARKER))) fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Bring the managed layer (and, once the home exists, the Google client and
 * the platform skills) in line with the member's keys, the instance's channel
 * tokens and its model pin. Safe under a running instance: Hermes re-reads the
 * managed `.env` on its own, and nothing the member edits is touched.
 */
export function syncHermesFiles(g: GatewayRow): HermesManaged {
  const managed = resolveManaged(g);
  const dir = getHermesManagedDir(g);
  fs.mkdirSync(dir, { recursive: true });
  // Root-owned, group-readable by the hermes user: the instance reads them and cannot change them.
  writeIfChanged(path.join(dir, ".env"), renderHermesEnv(managed.env), 0o640, 0, HERMES_UID);
  const proxies = readState(g).trustedProxies ?? [];
  const config = { ...(managed.config ?? {}), ...(proxies.length ? { dashboard: { trusted_proxies: proxies } } : {}) };
  writeIfChanged(path.join(dir, "config.yaml"), JSON.stringify(config, null, 2) + "\n", 0o640, 0, HERMES_UID);

  if (fs.existsSync(getGatewayDir(g))) {
    syncGoogleClient(g, managed.googleClient);
    syncPlatformSkills(g, managed);
  }
  return managed;
}

/** Whether this instance has been deployed at least once (its managed layer exists). */
export function hermesFilesExist(ref: GatewayRef): boolean {
  return fs.existsSync(getHermesManagedDir(ref));
}

/**
 * Before a deploy: make the home, seed the member's config when there is none,
 * install the org's skills, then write everything the platform manages. Throws
 * when the member has no key Hermes can use, before anything is created.
 */
export async function prepareHermesDeploy(g: GatewayRow, skills: Skill[]): Promise<HermesManaged> {
  if (resolveManaged(g).providerIds.length === 0) {
    throw new Error("No API key Hermes can use — add a Google, Anthropic, OpenAI, OpenRouter, Token Kiosk or Claw Proxy key");
  }
  const home = getGatewayDir(g);
  // The top directory keeps whatever owner it has: Hermes's boot hook re-owns a home that is not its own.
  fs.mkdirSync(home, { recursive: true });
  ensureHomeDir(path.join(home, "workspace"));
  const config = path.join(home, "config.yaml");
  if (!fs.existsSync(config)) {
    writeIfChanged(config, seedHermesConfig(process.env.USAGE_TIME_ZONE || "Asia/Singapore"), 0o600, HERMES_UID, HERMES_UID);
  }
  await installOrgSkills(g, skills);
  if (!IS_LOCAL_DEV) {
    const subnets = await gatewayNetworkSubnets();
    if (subnets.length) writeState(g, { ...readState(g), trustedProxies: subnets });
  }
  return syncHermesFiles(g);
}

/**
 * Org skills go into the platform's category and nowhere else, so skills that
 * are no longer assigned can be removed without touching the member's own.
 */
async function installOrgSkills(g: GatewayRow, skills: Skill[]): Promise<void> {
  const home = getGatewayDir(g);
  ensureHomeDir(path.join(home, "skills"));
  const root = path.join(home, "skills", HERMES_SKILL_CATEGORY);
  ensureHomeDir(root);
  const installed = new Set(
    await installSkillsForUser(path.join(g.org_id, gatewayDirName(g.user_id, g.slot)), skills, {
      subdir: HERMES_SKILL_CATEGORY,
      uid: HERMES_UID,
    }),
  );
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || installed.has(entry.name)) continue;
    const dir = path.join(root, entry.name);
    if (!fs.existsSync(path.join(dir, SKILL_MARKER))) fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Removes the managed layer of a deleted instance (its home is removed by the caller). */
export function removeHermesManagedDir(ref: GatewayRef): void {
  fs.rmSync(getHermesManagedDir(ref), { recursive: true, force: true });
}

// --- container --------------------------------------------------------------

export function hermesContainerConfig(g: GatewayRow) {
  const containerName = containerNameFor(g);
  const hostConfig: Record<string, any> = {
    Binds: [
      `${getHostGatewayDir(g)}:${HERMES_HOME}`,
      `${getHostHermesManagedDir(g)}:${HERMES_MANAGED_DIR}:ro`,
    ],
    RestartPolicy: { Name: "unless-stopped" },
    // Chromium (browser tool) needs more than Docker's 64 MB of /dev/shm.
    ShmSize: GIB,
    // Idle is ~0.6 GB; the cap keeps one runaway instance from starving its neighbours.
    Memory: 4 * GIB,
  };
  if (IS_LOCAL_DEV) {
    hostConfig.PortBindings = { [`${HERMES_DASHBOARD_PORT}/tcp`]: [{ HostPort: "0" }] };
  }

  // The public URL tells the dashboard where it is served from (cookies, redirects);
  // in local dev the port is random, so it is left to work that out from the request.
  const env = hermesDashboardEnv(g, `https://${g.subdomain}.${GATEWAY_DOMAIN}`)
    .filter((line) => !(IS_LOCAL_DEV && line.startsWith("HERMES_DASHBOARD_PUBLIC_URL=")));

  return {
    Image: HERMES_IMAGE,
    name: containerName,
    Cmd: ["gateway", "run"],
    Env: env,
    // The dashboard has a sign-in page; the extra route serves the one-click sign-in.
    Labels: createTraefikLabels(containerName, g.subdomain, HERMES_DASHBOARD_PORT, { openPage: true }),
    ExposedPorts: { [`${HERMES_DASHBOARD_PORT}/tcp`]: {} },
    HostConfig: hostConfig,
    NetworkingConfig: { EndpointsConfig: { [GATEWAY_NETWORK]: {} } },
  };
}

/** The host port Docker gave the dashboard (local dev only). */
export async function getHermesHostPort(containerName: string): Promise<number | null> {
  if (!IS_LOCAL_DEV) return null;
  try {
    const info = await docker.getContainer(containerName).inspect();
    const bound = info.NetworkSettings.Ports[`${HERMES_DASHBOARD_PORT}/tcp`];
    return bound?.[0]?.HostPort ? Number(bound[0].HostPort) : null;
  } catch {
    return null;
  }
}

const HEALTH_SCRIPT = [
  "import json, sys, urllib.request",
  `status = json.load(urllib.request.urlopen("http://127.0.0.1:${HERMES_DASHBOARD_PORT}/api/status", timeout=4))`,
  'sys.exit(0 if status.get("gateway_running") else 1)',
].join("\n");

/** Up = the dashboard answers and reports its messaging gateway running. */
export async function checkHermesHealth(containerName: string): Promise<boolean> {
  try {
    await execInContainer(containerName, [PYTHON, "-c", HEALTH_SCRIPT], 8000, { user: HERMES_USER });
    return true;
  } catch {
    return false;
  }
}

// --- in-container calls -----------------------------------------------------

/** Keep codes, tokens and client secrets out of anything shown in a browser or a log. */
function redact(text: string): string {
  return text
    .replace(/GOCSPX[-_A-Za-z0-9]+/g, "<redacted>")
    .replace(/\bya29\.[-_.A-Za-z0-9]+/g, "<redacted>")
    .replace(/\b1\/\/[-_A-Za-z0-9]+/g, "<redacted>")
    .replace(/([?&](?:code|state)=)[^&\s"']+/g, "$1<redacted>")
    .slice(0, 400);
}

/** Runs the image's helper and returns its JSON (see docker/hermes/helper.py). */
async function runHelper(g: GatewayRef, args: string[], timeoutMs = 30000): Promise<any> {
  let stdout: string;
  try {
    stdout = await execInContainer(containerNameFor(g), [PYTHON, HELPER, ...args], timeoutMs, { user: HERMES_USER });
  } catch (err: any) {
    throw new Error(redact(String(err?.message ?? err)));
  }
  const line = stdout.trim().split("\n").reverse().find((l) => l.startsWith("{"));
  if (!line) throw new Error("Hermes returned no data");
  const parsed = JSON.parse(line);
  if (parsed && typeof parsed.error === "string") throw new Error(redact(parsed.error));
  return parsed;
}

function assertPlatform(platform: string): void {
  if (!HERMES_CHANNEL_SOURCES.includes(platform)) throw new Error(`Unknown channel: ${platform}`);
}

/** Approve the code the bot sent an unknown sender. Returns what the CLI said. */
export async function approveHermesPairing(g: GatewayRef, platform: string, code: string): Promise<string> {
  assertPlatform(platform);
  if (!HERMES_PAIRING_CODE.test(code)) throw new Error("That does not look like a pairing code");
  const out = await execInContainer(
    containerNameFor(g),
    [HERMES_CLI, "pairing", "approve", platform, code],
    30000,
    { user: HERMES_USER },
  );
  return out.split("\n").filter((l) => l.trim() && !/install out of sync/i.test(l)).join("\n").trim();
}

/** Who is waiting to be approved. Hermes stores codes hashed, so only the sender can supply one. */
export async function listHermesPairing(g: GatewayRef, platform: string): Promise<string> {
  assertPlatform(platform);
  const { pending } = (await runHelper(g, ["pairing-list", platform])) as {
    pending?: { user_id: string; user_name: string; age_minutes: number }[];
  };
  if (!pending?.length) return "No pending pairing requests.";
  return [
    ...pending.map((p) => `${p.user_name || "unknown"} (${p.user_id}) · waiting ${p.age_minutes} min`),
    "",
    "Approve with the code the bot sent them.",
  ].join("\n");
}

/** Usage aggregates for a date range, in the helper's own shape (see `condenseHermesUsage`). */
export function fetchHermesUsage(g: GatewayRef, window: { startDate: string; endDate: string }, timeZone?: string): Promise<any> {
  return runHelper(g, ["usage", window.startDate, window.endDate, timeZone || "UTC"], 60000);
}

// --- secrets and Google -----------------------------------------------------

/**
 * Where each non-LLM credential stands. A secret is `injected` once the managed
 * `.env` on disk is the one we would write now; there is no `restart` state,
 * Hermes reads the file on its own.
 */
export function hermesSecretStatus(g: GatewayRow): Record<string, SecretInjectionState> {
  const managed = resolveManaged(g);
  let onDisk: string | null = null;
  try { onDisk = fs.readFileSync(path.join(getHermesManagedDir(g), ".env"), "utf-8"); } catch { /* not deployed yet */ }
  const written = onDisk === renderHermesEnv(managed.env);
  const out: Record<string, SecretInjectionState> = {};
  for (const p of PROVIDERS) {
    if (p.kind === "secret") out[p.id] = p.hermes && p.hermes.envVar in managed.env ? (written ? "injected" : "pending") : "none";
    else if (p.kind === "oauth-client") out[p.id] = googleClientState(g, managed.googleClient);
  }
  return out;
}

/**
 * One Google account per instance. Read from the home, not by exec: the token
 * file is the connection, and the label file (written by the helper after
 * sign-in) names it.
 */
export function getHermesGoogleAccounts(g: GatewayRow): GoogleAccountsInfo {
  const home = getGatewayDir(g);
  if (!fs.existsSync(googleClientPath(g))) {
    const { googleClient } = resolveManaged(g);
    if (!googleClient) return { readiness: "no-client", accounts: [] };
    syncHermesFiles(g);
    if (!fs.existsSync(googleClientPath(g))) return { readiness: "pending", accounts: [] };
  }
  if (!fs.existsSync(path.join(home, GOOGLE_TOKEN_FILE))) return { readiness: "ready", accounts: [] };
  let email = "";
  try { email = String(JSON.parse(fs.readFileSync(path.join(home, GOOGLE_LABEL_FILE), "utf-8")).email ?? ""); } catch { /* connected by hand */ }
  return { readiness: "ready", accounts: [{ email: email || "Google account", services: HERMES_GOOGLE_SERVICES }] };
}

export async function startHermesGoogleSignIn(g: GatewayRow): Promise<{ authUrl: string }> {
  if (getHermesGoogleAccounts(g).readiness !== "ready") throw new Error("Google sign-in is not set up on this instance yet");
  const { auth_url: authUrl } = (await runHelper(g, ["google-start"])) as { auth_url?: string };
  if (!authUrl || !authUrl.startsWith("https://accounts.google.com/")) throw new Error("Hermes did not return a Google sign-in link");
  return { authUrl };
}

/**
 * `redirectUrl` is the address Google sent the browser to (already validated
 * as loopback with a code and state). It reaches the helper through a
 * transient 0600 file in the home, never on a command line or in a log.
 */
export async function finishHermesGoogleSignIn(g: GatewayRow, email: string, redirectUrl: string): Promise<GoogleAccountsInfo> {
  const tmp = ".clawhuddle-google-redirect.tmp";
  const hostPath = path.join(getGatewayDir(g), tmp);
  fs.writeFileSync(hostPath, redirectUrl, { mode: 0o600 });
  chown(hostPath, HERMES_UID, HERMES_UID);
  try {
    await runHelper(g, ["google-finish", `${HERMES_HOME}/${tmp}`, email], 60000);
  } finally {
    fs.rmSync(hostPath, { force: true });
  }
  console.log(`[hermes] Google account connected on ${refLabel(g)}`);
  return getHermesGoogleAccounts(g);
}

export async function removeHermesGoogleAccount(g: GatewayRow): Promise<GoogleAccountsInfo> {
  await runHelper(g, ["google-revoke"]);
  console.log(`[hermes] Google account disconnected on ${refLabel(g)}`);
  return getHermesGoogleAccounts(g);
}
