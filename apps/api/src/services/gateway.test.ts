import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { authOwnerAgent, reconcileAuthProfileStore } from './gateway.js';

/**
 * The failure this guards is silent: OpenClaw's importer skips a profile id it
 * already holds, so a key replaced in the UI never reaches the gateway and it
 * keeps serving the old credential with no error anywhere.
 */

const ORG = 'org-1';
const USER = 'user-1';
const REF = { org_id: ORG, user_id: USER, slot: 1 };
let dataDir: string;

const agentDir = () => path.join(dataDir, 'gateways', ORG, USER, 'agents', 'main', 'agent');
const storePath = () => path.join(agentDir(), 'openclaw-agent.sqlite');
const fingerprintPath = () => path.join(agentDir(), '.clawhuddle-auth-fingerprints.json');

/** Creates the agent database with the one table reconcile touches. */
function createStore(profiles: Record<string, unknown> | null): void {
  fs.mkdirSync(agentDir(), { recursive: true });
  const db = new Database(storePath());
  db.exec('CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT)');
  if (profiles !== null) {
    db.prepare('INSERT INTO auth_profile_store (store_key, store_json) VALUES (?, ?)').run(
      'primary',
      JSON.stringify({ version: 1, profiles }),
    );
  }
  db.close();
}

/** Replaces the stored profiles, standing in for what the gateway itself wrote. */
function writeStore(profiles: Record<string, unknown>): void {
  const db = new Database(storePath());
  db.prepare("UPDATE auth_profile_store SET store_json = ? WHERE store_key = 'primary'").run(
    JSON.stringify({ version: 1, profiles }),
  );
  db.close();
}

function readStore(): Record<string, any> {
  const db = new Database(storePath());
  const row = db
    .prepare("SELECT store_json FROM auth_profile_store WHERE store_key = 'primary'")
    .get() as { store_json: string };
  db.close();
  return JSON.parse(row.store_json).profiles;
}

const oauth = (over: Record<string, unknown> = {}) => ({
  type: 'oauth',
  provider: 'openai',
  access: 'access-original',
  refresh: 'refresh-original',
  expires: 1784000000000,
  ...over,
});

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawhuddle-test-'));
  process.env.DATA_DIR = dataDir;
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  vi.restoreAllMocks();
});

describe('reconcileAuthProfileStore', () => {
  it('drops a profile whose source credential was replaced, so the importer re-adds it', () => {
    createStore({ 'openai:oauth': oauth() });
    // First reconcile only records what the importer already has.
    reconcileAuthProfileStore(REF, { 'openai:oauth': oauth() }, { 'openai:oauth': 'fp-a' });
    expect(readStore()['openai:oauth']).toBeDefined();

    // Operator pastes a new auth.json -> different fingerprint.
    reconcileAuthProfileStore(REF, { 'openai:oauth': oauth() }, { 'openai:oauth': 'fp-b' });

    expect(readStore()['openai:oauth']).toBeUndefined();
  });

  it('keeps a refreshed OAuth credential when the source key is unchanged', () => {
    // The gateway writes refreshed tokens back under the same id, and OpenAI
    // rotates the refresh token as it does — so the store being newer than our
    // file is normal, and re-importing would restore a dead token.
    createStore({ 'openai:oauth': oauth() });
    reconcileAuthProfileStore(REF, { 'openai:oauth': oauth() }, { 'openai:oauth': 'fp-a' });

    writeStore({ 'openai:oauth': oauth({ access: 'access-refreshed', refresh: 'refresh-rotated' }) });
    reconcileAuthProfileStore(REF, { 'openai:oauth': oauth() }, { 'openai:oauth': 'fp-a' });

    expect(readStore()['openai:oauth'].refresh).toBe('refresh-rotated');
  });

  it('keeps the credential when no fingerprint was ever recorded', () => {
    // First run after this shipped: we cannot tell a replaced key from a
    // refreshed one, so leave the gateway alone rather than risk a rewind.
    createStore({ 'openai:oauth': oauth({ refresh: 'refresh-rotated' }) });
    reconcileAuthProfileStore(REF, { 'openai:oauth': oauth() }, { 'openai:oauth': 'fp-a' });

    expect(readStore()['openai:oauth'].refresh).toBe('refresh-rotated');
    expect(JSON.parse(fs.readFileSync(fingerprintPath(), 'utf-8'))).toEqual({ 'openai:oauth': 'fp-a' });
  });

  it('leaves profiles it does not mint alone', () => {
    // e.g. one the user created themselves through the OpenClaw CLI.
    createStore({ 'copilot:cli-login': { type: 'api_key', provider: 'copilot', key: 'user-owned' } });
    reconcileAuthProfileStore(REF, {}, {});

    expect(readStore()['copilot:cli-login']).toBeDefined();
  });

  it('records fingerprints when there is no store yet', () => {
    reconcileAuthProfileStore(REF, { 'openai:oauth': oauth() }, { 'openai:oauth': 'fp-a' });
    expect(JSON.parse(fs.readFileSync(fingerprintPath(), 'utf-8'))).toEqual({ 'openai:oauth': 'fp-a' });
  });

  it('records nothing when the store could not be read', () => {
    // Claiming we handed these over would make the next reconcile read a real
    // key change as "unchanged" and skip it.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.mkdirSync(agentDir(), { recursive: true });
    fs.writeFileSync(storePath(), 'this is not a database');

    expect(() =>
      reconcileAuthProfileStore(REF, { 'openai:oauth': oauth() }, { 'openai:oauth': 'fp-a' }),
    ).not.toThrow();
    expect(fs.existsSync(fingerprintPath())).toBe(false);
  });
});

/** OpenClaw 2026.11.x keeps the store in the state database instead. */
const statePath = () => path.join(dataDir, 'gateways', ORG, USER, 'state', 'openclaw.sqlite');

function createStateStore(profiles: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  const db = new Database(statePath());
  db.exec('CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL)');
  db.prepare('INSERT INTO config_machine_state VALUES (?, ?, ?)').run(
    'authProfiles.store',
    JSON.stringify({ version: 1, profiles, authorizationLifetimes: {} }),
    1,
  );
  db.prepare('INSERT INTO config_machine_state VALUES (?, ?, ?)').run('authProfiles.state', '{"order":{}}', 1);
  db.close();
}

function readStateStore(): Record<string, any> {
  const db = new Database(statePath());
  const row = db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'authProfiles.store'").get() as {
    value_json: string;
  };
  db.close();
  return JSON.parse(row.value_json);
}

const apiKey = (key: string) => ({ type: 'api_key', provider: 'google', key });

describe('reconcileAuthProfileStore on OpenClaw 2026.11.x', () => {
  const NEW = { 'google:manual': apiKey('AIza-new') };
  const reconcile = (fp = 'fp-new') => reconcileAuthProfileStore(REF, NEW, { 'google:manual': fp });

  it('asks for a replaced API key to be saved offline, and edits nothing itself', () => {
    // 11.x never re-imports auth-profiles.json: a dropped profile would be gone.
    createStateStore({ 'google:manual': apiKey('AIza-old'), 'tokenkiosk:default': apiKey('sk-kiosk') });
    const before = readStateStore();

    expect(reconcile()).toEqual(['google:manual']);
    expect(readStateStore()).toEqual(before);
  });

  it('asks again on every boot until the store holds the key (no fingerprint shortcut)', () => {
    createStateStore({ 'google:manual': apiKey('AIza-old') });
    expect(reconcile()).toEqual(['google:manual']);
    expect(reconcile()).toEqual(['google:manual']);
  });

  it('asks for nothing when the store already holds our key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createStateStore({ 'google:manual': apiKey('AIza-new') });
    expect(reconcile()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('asks for a key the store has never seen, or holds without a credential', () => {
    createStateStore({ 'tokenkiosk:default': apiKey('sk-kiosk') });
    expect(reconcile()).toEqual(['google:manual']);

    fs.rmSync(statePath());
    createStateStore({ 'google:manual': { type: 'api_key', provider: 'google' } });
    expect(reconcile()).toEqual(['google:manual']);
  });

  it('leaves a profile the member pointed at their own secret-store entry alone', () => {
    const ref = { type: 'api_key', provider: 'google', keyRef: { source: 'store', provider: 'default', id: 'GOOGLE_API_KEY' } };
    createStateStore({ 'google:manual': ref });
    expect(reconcile()).toEqual([]);
    expect(readStateStore().profiles['google:manual']).toEqual(ref);
  });

  it("never drops the member's pointer from the agent store when the org key changes", () => {
    // Michael's instance, 2026-11-23: the shared profile was bare and the agent
    // store held the pointer. The pre-11 rule deleted it on a fingerprint
    // change, nothing re-imported it, and his agent lost Gemini.
    const ref = { type: 'api_key', provider: 'google', keyRef: { source: 'store', provider: 'default', id: 'GOOGLE_API_KEY' } };
    createStateStore({ 'google:manual': { type: 'api_key', provider: 'google' } });
    createStore({ 'google:manual': ref });
    fs.writeFileSync(fingerprintPath(), JSON.stringify({ 'google:manual': 'fp-old' }));

    expect(reconcile('fp-new')).toEqual([]);
    expect(readStore()['google:manual']).toEqual(ref);
  });

  it('never drops an inline key from the agent store either', () => {
    createStateStore({ 'google:manual': apiKey('AIza-old') });
    createStore({ 'google:manual': apiKey('AIza-older') });
    expect(reconcile()).toEqual(['google:manual']);
    expect(readStore()['google:manual'].key).toBe('AIza-older');
  });

  it('keeps a replaced OAuth credential, only reporting it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createStateStore({ 'openai:oauth': oauth({ refresh: 'refresh-rotated' }) });
    expect(reconcileAuthProfileStore(REF, { 'openai:oauth': oauth() }, { 'openai:oauth': 'fp-a' })).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(reconcileAuthProfileStore(REF, { 'openai:oauth': oauth() }, { 'openai:oauth': 'fp-b' })).toEqual([]);
    expect(readStateStore().profiles['openai:oauth'].refresh).toBe('refresh-rotated');
    expect(warn.mock.calls.some((c) => String(c[0]).includes('openai:oauth'))).toBe(true);
  });

  it('falls back to the pre-11 rule when the state database has no auth store', () => {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    new Database(statePath()).close();
    expect(reconcileAuthProfileStore(REF, { 'google:manual': apiKey('k') }, { 'google:manual': 'fp' })).toEqual([]);
    expect(JSON.parse(fs.readFileSync(fingerprintPath(), 'utf-8'))).toEqual({ 'google:manual': 'fp' });
  });
});

describe('authOwnerAgent', () => {
  it('names nobody with one agent or none', () => {
    expect(authOwnerAgent({})).toBeNull();
    expect(authOwnerAgent({ agents: { defaults: {} } })).toBeNull();
    expect(authOwnerAgent({ agents: { entries: { main: {} } } })).toBeNull();
  });

  it('names main, or the agent marked default, when there are several', () => {
    expect(authOwnerAgent({ agents: { entries: { main: {}, 'silicore-assistant': {} } } })).toBe('main');
    expect(authOwnerAgent({ agents: { entries: { main: {}, ops: { default: true } } } })).toBe('ops');
    expect(authOwnerAgent({ agents: { list: [{ id: 'a' }, { id: 'b' }] } })).toBe('a');
  });

  it('never passes an id that is not a plain agent id', () => {
    expect(authOwnerAgent({ agents: { entries: { 'x; rm -rf /': {}, main: {} } } })).toBeNull();
  });
});
