import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { application, temporary } from '../helpers.ts';

for (const format of ['json', 'markdown'] as const) test(`${format} export/import preserves IDs, timestamps, metadata and soft deletion`, async t => {
  const source = await application(t); const target = await application(t);
  const a = source.memory.add({ content: '## A\nMarkdown --- markers\n中文正文', metadata: { nested: { value: ['a', 2] } }, tags: ['test'], importance: 8 }).memory;
  source.memory.delete({ id: a.id });
  const data = source.exports.run({ format, include_deleted: true }).data;
  const preview = await target.imports.run({ format, data });
  assert.equal(preview.added, 1); assert.equal(target.memory.list({ include_deleted: true }).total, 0);
  const result = await target.imports.run({ format, data, dry_run: false }); assert.equal(result.added, 1);
  const imported = target.memory.get({ id: a.id, include_deleted: true });
  const original = source.memory.get({ id: a.id, include_deleted: true });
  assert.deepEqual(imported, original);
  assert.equal((await target.imports.run({ format, data, dry_run: false, conflict: 'copy' })).skipped, 1);
});
test('file imports preview, skip modified files, update same ID and copy idempotently', async t => {
  const app = await application(t); const root = temporary(t); const file = path.join(root, 'notes.md');
  writeFileSync(file, '## Decision\nUse SQLite.');
  await app.imports.run({ format: 'markdown', path: file, dry_run: false });
  const id = app.memory.list({}).memories[0]!.id;
  writeFileSync(file, '## Decision\nUse SQLite with WAL.');
  assert.equal((await app.imports.run({ format: 'markdown', path: file, dry_run: false })).skipped, 1);
  assert.equal((await app.imports.run({ format: 'markdown', path: file, conflict: 'update' })).updated, 1);
  assert.equal(app.memory.get({ id }).content, '## Decision\nUse SQLite.');
  await app.imports.run({ format: 'markdown', path: file, conflict: 'update', dry_run: false });
  assert.equal(app.memory.get({ id }).content, '## Decision\nUse SQLite with WAL.');
  writeFileSync(file, '## Decision\nUse SQLite with backup.');
  assert.equal((await app.imports.run({ format: 'markdown', path: file, conflict: 'copy', dry_run: false })).copied, 1);
  assert.equal((await app.imports.run({ format: 'markdown', path: file, conflict: 'copy', dry_run: false })).skipped, 1);
  assert.equal(app.memory.list({}).total, 2);
});
test('Claude import separates project directories and honors explicit mapping', async t => {
  const app = await application(t); const root = temporary(t);
  for (const project of ['project-a', 'project-b']) {
    const memory = path.join(root, project, 'memory'); mkdirSync(memory, { recursive: true });
    writeFileSync(path.join(memory, 'MEMORY.md'), '## Environment\nRun on native Windows.');
    writeFileSync(path.join(root, project, 'ignored.md'), 'Do not read unrelated project files');
  }
  const result = await app.imports.run({ format: 'claude-code', path: root, dry_run: false });
  assert.equal(result.files, 2); assert.equal(app.memory.list({}).total, 0);
  assert.equal(app.memory.list({ project: 'project-a' }).total, 1);
  assert.equal(app.memory.list({ project: 'project-b' }).total, 1);
  assert.equal(app.memory.list({ all_projects: true }).memories[0]!.source, 'claude-code');
});
test('all records are validated before import writes; size and directory permissions are enforced', async t => {
  const allowed = temporary(t); const outside = temporary(t);
  const app = await application(t, { imports: { allowedRoots: [allowed], maxFileBytes: 1024 } });
  const data = JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), memories: [{ content: 'valid' }, { content: '' }] });
  await assert.rejects(() => app.imports.run({ format: 'json', data, dry_run: false }));
  assert.equal(app.memory.list({}).total, 0);
  writeFileSync(path.join(outside, 'outside.md'), 'outside');
  await assert.rejects(() => app.imports.run({ format: 'markdown', path: path.join(outside, 'outside.md') }), /outside/);
  writeFileSync(path.join(allowed, 'big.md'), 'a'.repeat(2000));
  await assert.rejects(() => app.imports.run({ format: 'markdown', path: path.join(allowed, 'big.md') }), /exceeds/);
});
test('import rejects symlink traversal', async t => {
  const app = await application(t); const root = temporary(t); const external = temporary(t);
  writeFileSync(path.join(external, 'secret.md'), 'outside data');
  try { symlinkSync(external, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('symlink privilege unavailable'); return; } throw error; }
  await assert.rejects(() => app.imports.run({ format: 'markdown', path: root }), /symbolic link|junction/);
});
