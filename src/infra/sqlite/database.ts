import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../app/config.ts';
import { AppError, asAppError } from '../../shared/errors.ts';
import { migrations, SCHEMA_VERSION } from './migrations.ts';

export function snapshotPath(directory: string, prefix = 'memory'): string {
  mkdirSync(directory, { recursive: true });
  return path.join(directory, `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.db`);
}
export async function openDatabase(config: AppConfig): Promise<DatabaseSync> {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new AppError('VALIDATION_ERROR', 'Node.js 24.x is required.');
  for (const folder of [path.dirname(config.dbPath), 'backup', 'logs', 'config'].map((p, i) => i === 0 ? p : path.join(config.homeDir, p))) mkdirSync(folder, { recursive: true });
  const existed = existsSync(config.dbPath);
  const db = new DatabaseSync(config.dbPath);
  try {
    db.exec(`PRAGMA busy_timeout=${config.busyTimeoutMs}; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL; PRAGMA journal_mode=WAL;`);
    const capabilities=probeFts(db);
    if (!capabilities.fts5 || !capabilities.trigram) {
      throw new AppError('MIGRATION_FAILED', 'SQLite FTS5/trigram is unavailable. Use an official Node.js 24 build with FTS5 support.');
    }
    await migrateDatabase(db, config, existed);
    const row = db.prepare('PRAGMA quick_check').get();
    if (!row || Object.values(row)[0] !== 'ok') throw new AppError('DATABASE_CORRUPT', 'Database quick_check failed. Restore a verified backup into a new path.');
    return db;
  } catch (error) { db.close(); throw asAppError(error); }
}

/** Exercise both tokenizers on the actual connection, without persistent data. */
export function probeFts(db: DatabaseSync): { fts5: boolean; trigram: boolean } {
  const probe = (trigram: boolean): boolean => {
    const table=`fts_probe_${randomUUID().replaceAll('-', '')}`;
    let created=false;
    try {
      db.exec(`CREATE VIRTUAL TABLE temp.${table} USING fts5(content${trigram ? ",tokenize='trigram'" : ''})`);
      created=true;
      db.prepare(`INSERT INTO temp.${table}(content) VALUES(?)`).run(trigram ? '中文记忆检索' : 'memory search');
      return Number(db.prepare(`SELECT count(*) n FROM temp.${table} WHERE ${table} MATCH ?`).get(trigram ? '记忆检索' : 'memory')!.n)===1;
    } catch { return false; }
    finally { if (created) db.exec(`DROP TABLE temp.${table}`); }
  };
  return { fts5:probe(false),trigram:probe(true) };
}

export async function migrateDatabase(db: DatabaseSync, config: AppConfig, existed = true): Promise<void> {
  db.exec('BEGIN IMMEDIATE');
  try {
    const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    const applied = hasTable ? db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() : [];
    if (applied.some((v, i) => v.version !== migrations[i]?.version || v.name !== migrations[i]?.name)) {
      throw new AppError('MIGRATION_FAILED', 'Unrecognized or out-of-order schema version. Use the matching application version.');
    }
    const current = Number(applied.at(-1)?.version ?? 0);
    const pending = migrations.filter(m => m.version > current);
    const userTables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get()!;
    if (!hasTable && Number(userTables.n) > 0) throw new AppError('MIGRATION_FAILED', 'Database has an unknown schema; refusing to modify it.');
    if (pending.length && existed && Number(userTables.n) > 0) {
      // BEGIN IMMEDIATE blocks other writers. A second read-only connection snapshots
      // the committed pre-migration state without backing up a connection in a write transaction.
      const reader = new DatabaseSync(config.dbPath, { readOnly: true });
      try { await backup(reader, snapshotPath(path.join(config.homeDir, 'backup'), `pre-migration-v${current}`)); }
      finally { reader.close(); }
    }
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at INTEGER NOT NULL)');
    for (const migration of pending) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)').run(migration.version, migration.name, Date.now());
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    const appError = asAppError(error);
    if (['DATABASE_BUSY', 'DATABASE_CORRUPT', 'MIGRATION_FAILED'].includes(appError.code)) throw appError;
    throw new AppError('MIGRATION_FAILED', 'Migration rolled back. Check backup, permissions, free disk space, and application version.');
  }
}
export function databaseInfo(db: DatabaseSync) {
  return { schemaVersion: SCHEMA_VERSION, migrations: db.prepare('SELECT version,name,applied_at FROM schema_migrations ORDER BY version').all(),
    sqlite: db.prepare('SELECT sqlite_version() AS version').get()!.version,
    integrity: Object.values(db.prepare('PRAGMA quick_check').get()!)[0],
    journalMode: Object.values(db.prepare('PRAGMA journal_mode').get()!)[0] };
}
