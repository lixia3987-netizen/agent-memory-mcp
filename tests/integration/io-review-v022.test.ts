import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sqlite, { DatabaseSync } from 'node:sqlite';
import { syncBuiltinESMExports } from 'node:module';
import { cleanup, temporary } from '../helpers.ts';
import { resolveConfig } from '../../src/app/config.ts';
import { safeRead } from '../../src/shared/paths.ts';
import { asAppError } from '../../src/shared/errors.ts';
import { migrateDatabase } from '../../src/infra/sqlite/database.ts';
import { migrations, SCHEMA_VERSION } from '../../src/infra/sqlite/migrations.ts';

test('imports configuration rejects misspellings instead of discarding the allowlist', t => {
  const home = temporary(t), config = path.join(home, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ imports: { allowedroots: ['/safe'] } }));
  assert.throws(() => resolveConfig({ homeDir: home, config }, {}), /allowedroots/);
  assert.throws(() => resolveConfig({ homeDir: home, imports: { allowedRoots: ['   '] } }, {}), /blank/);
  fs.writeFileSync(config, JSON.stringify({ imports: { allowedRoots: [home] } }));
  assert.deepEqual(resolveConfig({ homeDir: home, config }, {}).imports.allowedRoots, [home]);
});

test('empty or invalid raw home/db paths are rejected before expansion for every configuration source', t => {
  const home = temporary(t), config = path.join(home, 'paths.json');
  for (const value of ['', '   ']) {
    assert.throws(() => resolveConfig({}, { AGENT_MEMORY_HOME: value }), /empty|blank/);
    assert.throws(() => resolveConfig({ homeDir: home }, { AGENT_MEMORY_DB: value }), /empty|blank/);
    assert.throws(() => resolveConfig({ homeDir: value }, {}), /empty|blank/);
    assert.throws(() => resolveConfig({ homeDir: home, dbPath: value }, {}), /empty|blank/);
    assert.throws(() => resolveConfig({ homeDir: home, config: value }, {}), /empty|blank/);
  }
  for (const key of ['homeDir', 'dbPath']) for (const value of ['', '  ', null, 42, {}]) {
    fs.writeFileSync(config, JSON.stringify({ [key]: value }));
    assert.throws(() => resolveConfig({ config }, {}));
  }
  fs.writeFileSync(config, JSON.stringify({ homeDir: home, dbPath: path.join(home, 'data', 'custom.db') }));
  assert.equal(resolveConfig({ config }, {}).homeDir, home);
});

test('configuration I/O failures retain their error category without being labeled invalid JSON', t => {
  const home = temporary(t), config = path.join(home, 'input.json');
  fs.writeFileSync(config, '{ malformed');
  assert.throws(() => resolveConfig({ homeDir: home, config }, {}), /valid JSON/);
  assert.throws(() => resolveConfig({ homeDir: home, config: home }, {}), /file.*directory/);
  const read = fs.readFileSync;
  const mocked = t.mock.method(fs, 'readFileSync', ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(file) === config) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return Reflect.apply(read, fs, [file, ...args]);
  }) as typeof read);
  syncBuiltinESMExports();
  try {
    assert.throws(() => resolveConfig({ homeDir: home, config }, {}), error =>
      asAppError(error).code === 'PERMISSION_DENIED' && !asAppError(error).message.includes('JSON'));
    mocked.mock.mockImplementation((() => { throw Object.assign(new Error('removed during read'), { code: 'ENOENT' }); }) as typeof read);
    assert.throws(() => resolveConfig({ homeDir: home, config }, {}), error => asAppError(error).code === 'NOT_FOUND');
    assert.equal(resolveConfig({ homeDir: home }, {}).homeDir, home, 'missing optional default config is allowed');
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test('safeRead stays bounded when a file grows after its first fstat', t => {
  const root = temporary(t), file = path.join(root, 'growing.md');
  fs.writeFileSync(file, 'small');
  const stat = fs.fstatSync, read = fs.readSync, unboundedRead = fs.readFileSync;
  let grew = false, bytesRead = 0;
  const statMock = t.mock.method(fs, 'fstatSync', ((...args: unknown[]) => {
    const result = Reflect.apply(stat, fs, args);
    if (!grew) { grew = true; fs.appendFileSync(file, Buffer.alloc(1024 * 1024, 65)); }
    return result;
  }) as typeof stat);
  const readMock = t.mock.method(fs, 'readSync', ((...args: unknown[]) => {
    const count = Reflect.apply(read, fs, args) as number;
    bytesRead += count;
    return count;
  }) as typeof read);
  const wholeMock = t.mock.method(fs, 'readFileSync', ((...args: unknown[]) => {
    if (typeof args[0] === 'number') assert.fail('safeRead must not read the whole file descriptor');
    return Reflect.apply(unboundedRead, fs, args);
  }) as typeof unboundedRead);
  syncBuiltinESMExports();
  try {
    assert.throws(() => safeRead(file, [root], 64), /size limit/);
    assert.ok(bytesRead <= 65);
  } finally {
    statMock.mock.restore(); readMock.mock.restore(); wholeMock.mock.restore(); syncBuiltinESMExports();
  }
  fs.writeFileSync(file, '中'.repeat(21846));
  assert.equal(safeRead(file, [root], 65538).text, '中'.repeat(21846));
  assert.throws(() => safeRead(file, [root], 65537), /exceeds/);
  fs.writeFileSync(file, Buffer.from([0xff]));
  assert.throws(() => safeRead(file, [root], 64), /UTF-8/);
});

function seed(home: string) {
  const config = resolveConfig({ homeDir: home, busyTimeoutMs: 20 }, {});
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=20; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at INTEGER NOT NULL)');
  db.exec(migrations[0].sql);
  db.prepare('INSERT INTO schema_migrations VALUES(1,?,?)').run(migrations[0].name, Date.now());
  return { config, db };
}

test('migration backup releases the write lock and resnapshots after a concurrent commit', { timeout: 5000 }, async t => {
  const { config, db } = seed(temporary(t)); cleanup(t, () => db.close());
  const original = sqlite.backup; let calls = 0;
  const mocked = t.mock.method(sqlite, 'backup', async (...args: Parameters<typeof sqlite.backup>) => {
    calls++;
    assert.equal(db.isTransaction, false, 'no transaction may cross the asynchronous backup');
    const pages = await original(...args);
    if (calls === 1) {
      const writer = new DatabaseSync(config.dbPath);
      try {
        writer.exec('PRAGMA busy_timeout=20; BEGIN IMMEDIATE');
        writer.prepare('UPDATE schema_migrations SET applied_at=?').run(12345);
        writer.exec('COMMIT');
      } finally { writer.close(); }
    }
    return pages;
  });
  syncBuiltinESMExports();
  try { await migrateDatabase(db, config); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(calls, 2);
  assert.equal(db.prepare('SELECT max(version) v FROM schema_migrations').get()!.v, SCHEMA_VERSION);
  const snapshots = fs.readdirSync(path.join(config.homeDir, 'backup'));
  assert.equal(snapshots.length, 1);
  const copy = new DatabaseSync(path.join(config.homeDir, 'backup', snapshots[0]!), { readOnly: true });
  try {
    assert.equal(copy.prepare('SELECT max(version) v FROM schema_migrations').get()!.v, 1);
    assert.equal(copy.prepare('SELECT applied_at FROM schema_migrations WHERE version=1').get()!.applied_at, 12345);
  } finally { copy.close(); }
});

test('a second migrator can finish while the first backup is paused, without duplicate migrations', { timeout: 5000 }, async t => {
  const { config, db } = seed(temporary(t)); cleanup(t, () => db.close());
  const other = new DatabaseSync(config.dbPath); other.exec('PRAGMA busy_timeout=20'); cleanup(t, () => other.close());
  const original = sqlite.backup;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const paused = new Promise<void>(resolve => { entered = resolve; });
  let first = true;
  const mocked = t.mock.method(sqlite, 'backup', async (...args: Parameters<typeof sqlite.backup>) => {
    const pages = await original(...args);
    if (first) { first = false; entered(); await gate; }
    return pages;
  });
  syncBuiltinESMExports();
  const running = migrateDatabase(db, config);
  try {
    await paused;
    await migrateDatabase(other, config);
  } finally {
    release();
    try { await running; } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  }
  assert.equal(db.prepare('SELECT count(*) n FROM schema_migrations').get()!.n, migrations.length);
  assert.equal(fs.readdirSync(path.join(config.homeDir, 'backup')).length, 1);
});
