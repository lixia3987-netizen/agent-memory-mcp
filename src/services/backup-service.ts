import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, mkdirSync, copyFileSync, unlinkSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../app/config.ts';
import { snapshotPath } from '../infra/sqlite/database.ts';
import { migrations } from '../infra/sqlite/migrations.ts';
import { AppError, asAppError } from '../shared/errors.ts';
import { safeInputPath } from '../shared/paths.ts';

export function verifyBackup(file: string): void {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (Object.values(db.prepare('PRAGMA integrity_check').get()!)[0] !== 'ok') throw new AppError('DATABASE_CORRUPT', 'Backup integrity check failed.');
    const applied = db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all();
    if (!applied.length || applied.some((m, i) => m.version !== migrations[i]?.version || m.name !== migrations[i]?.name)) throw new AppError('MIGRATION_FAILED', 'Backup schema is unsupported by this application.');
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new AppError('DATABASE_CORRUPT', 'Backup contains invalid references.');
    db.prepare('SELECT id,namespace,project,content FROM memories LIMIT 1').all();
  } finally { db.close(); }
}
export async function restoreDatabase(config: AppConfig, source: string, target: string, currentBackup?: () => Promise<string>) {
  const input = safeInputPath(source, []); const output = path.resolve(target);
  if (output === path.resolve(config.dbPath) || existsSync(output) || existsSync(output + '-wal') || existsSync(output + '-shm')) throw new AppError('CONFLICT', 'Restore requires a new, unused database path. Then stop clients and switch AGENT_MEMORY_DB.');
  verifyBackup(input);
  let currentBackupPath: string | null = null;
  if (currentBackup) currentBackupPath = await currentBackup();
  else if (existsSync(config.dbPath)) {
    let current: DatabaseSync | undefined;
    try {
      current = new DatabaseSync(config.dbPath, { readOnly: true });
      if (Object.values(current.prepare('PRAGMA integrity_check').get()!)[0] !== 'ok') throw new AppError('DATABASE_CORRUPT', 'Original database is damaged.');
      currentBackupPath = snapshotPath(path.join(config.homeDir, 'backup'), 'pre-restore');
      await backup(current, currentBackupPath);
    } catch (error) {
      // Recovery must also work when normal application startup rejects corruption.
      // The original DB/WAL/SHM are never replaced or removed.
      if (asAppError(error).code !== 'DATABASE_CORRUPT') throw error;
      currentBackupPath = null;
    } finally { current?.close(); }
  }
  mkdirSync(path.dirname(output), { recursive: true });
  const temp = output + `.restoring-${randomUUID()}`;
  const sourceDb = new DatabaseSync(input, { readOnly: true });
  try {
    await backup(sourceDb, temp); verifyBackup(temp);
    copyFileSync(temp, output, constants.COPYFILE_EXCL);
  } finally { sourceDb.close(); if (existsSync(temp)) unlinkSync(temp); }
  return { restored_to: output, current_backup: currentBackupPath, original_preserved: true };
}
export class BackupService {
  private db: DatabaseSync;
  private config: AppConfig;
  constructor(db: DatabaseSync, config: AppConfig) { this.db = db; this.config = config; }
  async create(): Promise<string> {
    const target = snapshotPath(path.join(this.config.homeDir, 'backup'));
    await backup(this.db, target); verifyBackup(target); return target;
  }
  // Recovery deliberately uses a NEW database path. Replacing a live WAL database
  // while other MCP processes hold it would risk divergent writes or data loss.
  async restore(source: string, target: string) {
    return restoreDatabase(this.config, source, target, () => this.create());
  }
  size(): number { return statSync(this.config.dbPath).size + (existsSync(this.config.dbPath + '-wal') ? statSync(this.config.dbPath + '-wal').size : 0); }
}
