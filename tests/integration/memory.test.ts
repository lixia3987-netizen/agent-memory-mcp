import { test } from 'node:test';
import assert from 'node:assert/strict';
import { application } from '../helpers.ts';
import { bootstrap } from '../../src/app/bootstrap.ts';

test('CRUD persists across reopen; FTS reflects update; duplicates share ID', async t => {
  const app = await application(t);
  const a = app.memory.add({ content: 'Use SQLite WAL for durable memory', title: 'Storage', tags: ['sqlite'] });
  assert.equal(app.memory.add({ content: ' Use SQLite  WAL for durable memory ' }).memory.id, a.memory.id);
  assert.equal(app.memory.search({ query: 'SQLite' }).memories.length, 1);
  app.memory.update({ id: a.memory.id, updates: { content: 'Use PostgreSQL for remote data', title: 'Remote', tags: ['remote'] } });
  assert.equal(app.memory.search({ query: 'SQLite' }).memories.length, 0);
  assert.equal(app.memory.search({ query: 'PostgreSQL' }).memories[0]?.id, a.memory.id);
  app.close();
  const reopened = await bootstrap({ homeDir: app.config.homeDir, namespace: 'test' });
  try { assert.equal(reopened.memory.get({ id: a.memory.id }).title, 'Remote'); }
  finally { reopened.close(); }
});
test('namespace and project filters also guard ID access and project moves', async t => {
  const app = await application(t);
  const a = app.memory.add({ namespace: 'work', project: 'A', content: 'scope knowledge' }).memory;
  app.memory.add({ namespace: 'work', project: 'B', content: 'scope knowledge' });
  assert.equal(app.memory.list({ namespace: 'work' }).total, 0);
  assert.equal(app.memory.list({ namespace: 'work', all_projects: true }).total, 2);
  assert.throws(() => app.memory.get({ id: a.id, namespace: 'work', project: 'B' }), /not found/);
  assert.throws(() => app.memory.update({ id: a.id, namespace: 'work', project: 'A', updates: { project: 'B' } }), /duplicate/);
  assert.throws(() => app.memory.list({ all_projects: true, project: 'A' }));
  app.memory.update({ id: a.id, namespace: 'work', project: 'A', updates: { project: 'C' } });
  assert.equal(app.memory.get({ id: a.id, namespace: 'work', project: 'C' }).project, 'C');
});
test('TTL, soft delete, audit, restore and explicit purge', async t => {
  const app = await application(t);
  const expired = app.memory.add({ content: 'expired knowledge', expires_at: '2000-01-01T00:00:00Z' }).memory;
  assert.equal(app.memory.get({ id: expired.id }).expired, true);
  assert.equal(app.memory.search({ query: 'knowledge' }).memories.length, 0);
  assert.equal(app.memory.list({ include_expired: true }).total, 1);
  const live = app.memory.add({ content: 'live knowledge' }).memory;
  app.memory.delete({ id: live.id });
  assert.throws(() => app.memory.get({ id: live.id }));
  assert.equal(app.memory.list({ include_deleted: true }).total, 1);
  app.memory.restore({ id: live.id }); assert.equal(app.memory.search({ query: 'live' }).memories.length, 1);
  app.memory.delete({ id: live.id });
  assert.equal(app.memory.repository.purge(app.memory.filters({}), '2100-01-01T00:00:00Z'), 1);
  assert.throws(() => app.memory.get({ id: live.id, include_deleted: true }));
  assert.equal(app.memory.get({ id: expired.id }).expired, true);
});
test('Chinese phrases, literal FTS queries and metadata filters', async t => {
  const app = await application(t);
  app.memory.add({ content: '这个项目必须支持原生运行环境以及中文全文检索能力。', type: 'convention', source: 'test-source', importance: 8, tags: ['中文', '规范'] });
  assert.equal(app.memory.search({ query: '中文全文检索' }).memories.length, 1);
  assert.equal(app.memory.list({ type: 'convention', source: 'test-source', tags: ['中文', '规范'], importance_min: 8 }).total, 1);
  assert.equal(app.memory.list({ tags: ['中文', '不存在'] }).total, 0);
  for (const query of ['"', 'OR', 'x NEAR(y)', '*', "'; DROP TABLE memories;--"]) assert.doesNotThrow(() => app.memory.search({ query }));
  assert.throws(() => app.memory.search({ query: 'x', limit: 101 }));
  assert.equal(app.memory.list({}).total, 1);
});
test('failed transactions roll back memory and its FTS entry', async t => {
  const app = await application(t);
  assert.throws(() => app.memory.repository.transaction(() => {
    app.memory.add({ content: 'should rollback' }); throw new Error('simulate failure');
  }));
  assert.equal(app.memory.list({}).total, 0);
  assert.equal(app.memory.search({ query: 'rollback' }).memories.length, 0);
  assert.equal(app.doctor().ok, true);
});
