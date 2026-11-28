import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PAIRING_CHECK_CMD, parsePairingCheck, toBrowserPairRequest } from './pairing-check.js';

/**
 * The check reads OpenClaw's state database from inside the container. A wrong
 * 0 would hide device requests and a wrong row would put a browser nobody is
 * waiting on in front of a member, so every part must be what it actually read.
 */

const MINUTE = 60_000;
let home: string;
const dbPath = () => path.join(home, '.openclaw', 'state', 'openclaw.sqlite');

const run = () => {
  const [, ...args] = PAIRING_CHECK_CMD;
  const res = spawnSync(process.execPath, args, { env: { ...process.env, HOME: home }, encoding: 'utf-8' });
  return { status: res.status, check: parsePairingCheck(res.stdout) };
};

/** The columns the check relies on, from OpenClaw 2026.11.10's schema. */
const PENDING_TABLE = 'CREATE TABLE device_pairing_pending (request_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, refreshed_at_ms INTEGER)';
const BROWSER_TABLE = `CREATE TABLE device_pairing_browser_requests (
  request_id TEXT NOT NULL PRIMARY KEY, code TEXT NOT NULL UNIQUE, device_id TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL,
  remote_ip TEXT, user_agent TEXT, origin TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  approved_token_sha256 TEXT, created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL
) STRICT`;

function store(build: (db: Database.Database) => void): void {
  fs.mkdirSync(path.dirname(dbPath()), { recursive: true });
  const db = new Database(dbPath());
  db.pragma('journal_mode = WAL');
  build(db);
  db.close();
}

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-check-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('pairing check script', () => {
  it('counts live device requests and ignores expired ones, which stay in the table', () => {
    const now = Date.now();
    store((db) => {
      db.exec(PENDING_TABLE);
      const insert = db.prepare('INSERT INTO device_pairing_pending VALUES (?, ?, ?)');
      insert.run('live', now - MINUTE, null);
      insert.run('expired', now - 10 * MINUTE, null);
      insert.run('refreshed', now - 10 * MINUTE, now - MINUTE);
      insert.run('refreshed-long-ago', now - 10 * MINUTE, now - 6 * MINUTE);
    });
    const { status, check } = run();
    expect(status).toBe(0);
    expect(check.pending).toBe(2);
  });

  it('lists no browsers on an instance that never showed a code: the table is not there yet', () => {
    store((db) => db.exec(PENDING_TABLE));
    expect(run().check).toEqual({ pending: 0, browser: [] });
  });

  it('lists the browsers still waiting, newest first, and none that were answered or expired', () => {
    const now = Date.now();
    store((db) => {
      db.exec(PENDING_TABLE);
      db.exec(BROWSER_TABLE);
      const insert = db.prepare('INSERT INTO device_pairing_browser_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      insert.run('older', 'AAAAAAAA', 'dev-older', 'pk', '198.51.100.7', 'UA older', 'https://claw-a.example.com', 'pending', null, now - 5 * MINUTE, now + 5 * MINUTE);
      insert.run('newer', 'BBBBBBBB', 'dev-newer', 'pk', null, null, null, 'pending', null, now - MINUTE, now + 9 * MINUTE);
      insert.run('approved', 'CCCCCCCC', 'dev-approved', 'pk', null, null, null, 'approved', 'sha', now - MINUTE, now + 9 * MINUTE);
      insert.run('rejected', 'DDDDDDDD', 'dev-rejected', 'pk', null, null, null, 'rejected', null, now - MINUTE, now + 9 * MINUTE);
      insert.run('expired', 'EEEEEEEE', 'dev-expired', 'pk', null, null, null, 'pending', null, now - 11 * MINUTE, now - MINUTE);
    });
    const { check } = run();
    expect(check.browser).toEqual([
      { requestId: 'newer', code: 'BBBBBBBB', deviceId: 'dev-newer', remoteIp: undefined, userAgent: undefined, origin: undefined, createdAtMs: now - MINUTE, expiresAtMs: now + 9 * MINUTE },
      { requestId: 'older', code: 'AAAAAAAA', deviceId: 'dev-older', remoteIp: '198.51.100.7', userAgent: 'UA older', origin: 'https://claw-a.example.com', createdAtMs: now - 5 * MINUTE, expiresAtMs: now + 5 * MINUTE },
    ]);
    // The public key never leaves the container, and the code never leaves the API.
    expect(JSON.stringify(check)).not.toContain('pk');
    expect(toBrowserPairRequest(check.browser![1])).toEqual({
      kind: 'browser-code', requestId: 'older', deviceId: 'dev-older', userAgent: 'UA older', remoteIp: '198.51.100.7',
      browserOrigin: 'https://claw-a.example.com', ts: now - 5 * MINUTE, expiresAt: now + 5 * MINUTE,
    });
  });

  it('answers unknown, part by part, rather than guess', () => {
    // No database at all.
    expect(run()).toEqual({ status: 0, check: { pending: null, browser: null } });
    // Both tables changed shape.
    store((db) => {
      db.exec('CREATE TABLE device_pairing_pending (id TEXT)');
      db.exec('CREATE TABLE device_pairing_browser_requests (id TEXT)');
    });
    expect(run().check).toEqual({ pending: null, browser: null });
  });

  it('still counts device requests when only the browser table changed shape', () => {
    store((db) => {
      db.exec(PENDING_TABLE);
      db.exec('CREATE TABLE device_pairing_browser_requests (id TEXT)');
    });
    expect(run().check).toEqual({ pending: 0, browser: null });
  });
});

describe('parsePairingCheck', () => {
  it.each([
    ['nothing', ''],
    ['a bare count', '0\n'],
    ['a warning', 'warn: 0\n'],
    ['half an answer', '{"pending":0'],
    ['an array', '[]'],
  ])('reads %s as unknown', (_case, output) => {
    expect(parsePairingCheck(output)).toEqual({ pending: null, browser: null });
  });

  it('accepts only a whole, non-negative count', () => {
    expect(parsePairingCheck('{"pending":3,"browser":[]}').pending).toBe(3);
    for (const bad of ['"0"', '-1', '1.5', 'true', 'null']) {
      expect(parsePairingCheck(`{"pending":${bad},"browser":[]}`).pending).toBeNull();
    }
  });

  it('drops browser rows without an id or a code', () => {
    const out = JSON.stringify({ pending: 0, browser: [{ requestId: 'a', code: 'AAAAAAAA' }, { requestId: 'b' }, { code: 'CCCCCCCC' }, null, 'x'] });
    expect(parsePairingCheck(out).browser?.map((r) => r.requestId)).toEqual(['a']);
  });
});
