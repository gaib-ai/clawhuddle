import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Applies schema.sql, then every migrations/*.sql in name order. There is no
 * ledger of applied files: each one is re-run on every boot and must either be
 * idempotent or fail with one of the errors below, which mean "already applied".
 * db.exec stops at the first error in a file, so keep one ALTER per file and
 * guard data backfills (see 020-gateways.sql).
 */
export function applyMigrations(db: Database.Database, log: (msg: string) => void = console.log): void {
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8'));

  const migrationsDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) return;

  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    try {
      db.exec(sql);
      log(`Migration applied: ${file}`);
    } catch (err: any) {
      if (
        err.message?.includes('duplicate column') ||
        err.message?.includes('already exists') ||
        err.message?.includes('no such table') ||
        err.message?.includes('no such column')
      ) {
        log(`Migration skipped (already applied): ${file}`);
      } else {
        throw err;
      }
    }
  }
}
