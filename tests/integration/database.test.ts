import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { application, temporary } from '../helpers.ts';
import { migrations, SCHEMA_VERSION } from '../../src/infra/sqlite/migrations.ts';
import { bootstrap } from '../../src/app/bootstrap.ts';
import { verifyBackup } from '../../src/services/backup-service.ts';

test('migration from v1 makes a verified pre-migration snapshot and rebuilds indexes', async t => {
  const home = temporary(t); mkdirSync(path.join(home, 'data'));
  const file = path.join(home, 'data', 'memory.db'); const db = new DatabaseSync(file);
  db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at INTEGER NOT NULL)');
  db.exec(migrations[0].sql); db.prepare('INSERT INTO schema_migrations VALUES(1,?,?)').run(migrations[0].name, Date.now());
  db.close();
  const app = await bootstrap({ homeDir: home });
  try {
    assert.equal(app.doctor().schemaVersion, SCHEMA_VERSION);
    const files = readdirSync(path.join(home, 'backup')); assert.equal(files.length, 1);
    const snapshot = path.join(home, 'backup', files[0]!); verifyBackup(snapshot);
    const old = new DatabaseSync(snapshot, { readOnly: true });
    try { assert.equal(old.prepare('SELECT max(version) AS v FROM schema_migrations').get()!.v, 1); } finally { old.close(); }
  } finally { app.close(); }
});
test('unknown future migration fails closed', async t => {
  const app = await application(t); app.close();
  const db = new DatabaseSync(app.config.dbPath);
  db.prepare('INSERT INTO schema_migrations VALUES(999,?,?)').run('future', Date.now()); db.close();
  await assert.rejects(() => bootstrap({ homeDir: app.config.homeDir }), /schema version/);
});
test('migration SQL failure rolls back and preserves prior schema', async t => {
  const home = temporary(t); mkdirSync(path.join(home, 'data'));
  const dbPath = path.join(home, 'data', 'memory.db'); const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at INTEGER NOT NULL)');
  db.exec(migrations[0].sql); db.prepare('INSERT INTO schema_migrations VALUES(1,?,?)').run(migrations[0].name, Date.now());
  db.exec('CREATE TABLE memories_fts(conflict TEXT)'); db.close();
  await assert.rejects(() => bootstrap({ homeDir: home }), /Migration rolled back/);
  const check = new DatabaseSync(dbPath);
  try { assert.equal(check.prepare('SELECT max(version) AS v FROM schema_migrations').get()!.v, 1); }
  finally { check.close(); }
});
test('backup restores into a new verified database without replacing live data', async t => {
  const app = await application(t);
  const a = app.memory.add({ content: 'backed up memory' }).memory;
  const file = await app.backups.create();
  app.memory.add({ content: 'later memory' });
  const output = path.join(app.config.homeDir, 'recovered.db');
  const result = await app.backups.restore(file, output);
  assert.ok(result.current_backup); verifyBackup(output);
  const recovered = await bootstrap({ homeDir: app.config.homeDir, dbPath: output, namespace: 'test' });
  try { assert.equal(recovered.memory.list({}).total, 1); assert.equal(recovered.memory.get({ id: a.id }).content, 'backed up memory'); }
  finally { recovered.close(); }
  assert.equal(app.memory.list({}).total, 2);
  await assert.rejects(() => app.backups.restore(file, app.config.dbPath), /new, unused/);
  await assert.rejects(() => app.backups.restore(file, output), /new, unused/);
  const bad = path.join(app.config.homeDir, 'bad.db'); writeFileSync(bad, 'not a database');
  await assert.rejects(() => app.backups.restore(bad, path.join(app.config.homeDir, 'bad-output.db')));
});
