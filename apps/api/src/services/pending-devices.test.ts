import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The gateway image's pending check. A wrong 0 stops device approvals with no
 * error anywhere, so it must only print a number it actually read.
 */

const SCRIPT = fileURLToPath(new URL('../../../../docker/gateway/pending-devices.cjs', import.meta.url));
const MINUTE = 60_000;

let home: string;
const dbPath = () => path.join(home, '.openclaw', 'state', 'openclaw.sqlite');

const check = () => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT], {
  env: { ...process.env, HOME: home },
  encoding: 'utf-8',
});

/** The columns the check relies on, from OpenClaw 2026.10.3's schema. */
function createStore(rows: { ts: number; refreshed?: number }[]): void {
  fs.mkdirSync(path.dirname(dbPath()), { recursive: true });
  const db = new Database(dbPath());
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE device_pairing_pending (request_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, refreshed_at_ms INTEGER)');
  const insert = db.prepare('INSERT INTO device_pairing_pending VALUES (?, ?, ?)');
  rows.forEach((r, i) => insert.run(`req-${i}`, r.ts, r.refreshed ?? null));
  db.close();
}

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-devices-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('clawhuddle-pending-devices', () => {
  it('prints 0 for an empty table', () => {
    createStore([]);
    const res = check();
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('0\n');
  });

  it('counts live requests and ignores expired ones, which stay in the table', () => {
    const now = Date.now();
    createStore([
      { ts: now - MINUTE },
      { ts: now - 10 * MINUTE },
      { ts: now - 10 * MINUTE, refreshed: now - MINUTE },
      { ts: now - 10 * MINUTE, refreshed: now - 6 * MINUTE },
    ]);
    expect(check().stdout).toBe('2\n');
  });

  it('prints nothing and fails when the database is missing', () => {
    const res = check();
    expect(res.status).not.toBe(0);
    expect(res.stdout).toBe('');
  });

  it('prints nothing and fails when the table has changed shape', () => {
    fs.mkdirSync(path.dirname(dbPath()), { recursive: true });
    const db = new Database(dbPath());
    db.exec('CREATE TABLE some_other_table (id TEXT)');
    db.close();
    const res = check();
    expect(res.status).not.toBe(0);
    expect(res.stdout).toBe('');
  });
});
