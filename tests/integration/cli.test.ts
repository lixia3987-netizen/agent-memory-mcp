import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import { verifyBackup } from '../../src/services/backup-service.ts';
import { application, temporary } from '../helpers.ts';
import { VERSION } from '../../src/shared/version.ts';

test('compiled CLI diagnoses, imports, exports, restores and guards physical purge', t => {
  const home = temporary(t); const entry = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
  const call = (...args: string[]) => spawnSync(process.execPath, [entry, ...args, '--home', home], { encoding: 'utf8' });
  const doctor = call('doctor'); assert.equal(doctor.status, 0, doctor.stderr); assert.equal(JSON.parse(doctor.stdout).fts5, true);
  assert.equal(JSON.parse(doctor.stdout).trigram,true);
  assert.ok(call('help').stdout.includes(`Agent Memory MCP ${VERSION}`));
  const added = call('add', '--content', 'CLI durable memory'); assert.equal(added.status, 0, added.stderr);
  const id = JSON.parse(added.stdout).memory.id as string;
  const output = path.join(home, 'export.json');
  assert.equal(call('export', '--output', output).status, 0);
  assert.equal(call('export', '--output', output).status, 1);
  assert.equal(JSON.parse(call('import', '--format', 'json', '--path', output).stdout).dry_run, true);
  assert.equal(JSON.parse(call('restore', '--id', id).stdout).id, id);
  assert.equal(call('restore','--id',id,'--from','unused.db').status,1);
  assert.equal(call('purge').status, 1);
  assert.equal(JSON.parse(call('purge', '--yes', '--before', '2100-01-01T00:00:00Z').stdout).purged, 0);
  const invalid = call('doctor', '--typo'); assert.equal(invalid.status, 1); assert.equal(invalid.stdout, '');
  assert.equal(JSON.parse(invalid.stderr).error.code, 'VALIDATION_ERROR');
});
test('bounded export stops before constructing an oversized document', async t => {
  const app = await application(t, { maxExportBytes: 1024 });
  app.memory.add({ content: 'x'.repeat(600) }); app.memory.add({ content: 'y'.repeat(600) });
  assert.throws(() => app.exports.run({ format: 'json' }), /limit/);
  assert.equal(app.memory.list({}).total, 2);
});
test('CLI recovery works even when current database cannot start', async t => {
  const app = await application(t); app.memory.add({ content: 'recover after corruption' });
  const snapshot = await app.backups.create(); app.close();
  writeFileSync(app.config.dbPath, 'deliberately corrupted test database');
  const output = path.join(app.config.homeDir, 'recovered.db');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../dist/index.js', import.meta.url)),
    'restore', '--home', app.config.homeDir, '--from', snapshot, '--output', output], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).current_backup, null);
  verifyBackup(output);
  assert.equal(readFileSync(app.config.dbPath, 'utf8'), 'deliberately corrupted test database');
});
