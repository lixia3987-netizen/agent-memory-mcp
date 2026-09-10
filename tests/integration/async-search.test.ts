import { test } from 'node:test';
import assert from 'node:assert/strict';
import { application, cleanup, temporary } from '../helpers.ts';
import { resolveConfig } from '../../src/app/config.ts';
import { SqliteAsyncSearch } from '../../src/infra/sqlite/async-search.ts';
import { AppError } from '../../src/shared/errors.ts';

const busy = (e: unknown) => e instanceof AppError && e.code === 'DATABASE_BUSY';
test('worker results preserve invocation time, scope, committed mutations and synchronous API compatibility', async t => {
  const app = await application(t);
  const now = Date.now(); t.mock.method(Date, 'now', () => now);
  const a = app.memory.add({ content: 'SQLite AI大模型 memory', expires_at: new Date(now + 1).toISOString() }).memory;
  app.memory.add({ content: 'SQLite AI大模型 other project', project: 'other' });
  for (const query of ['SQLite', 'AI 大模型', 'AI 模型']) {
    assert.deepEqual(await app.memory.searchAsync({ query }), app.memory.search({ query }));
    assert.deepEqual(await app.memory.searchAsync({ query, all_projects: true }), app.memory.search({ query, all_projects: true }));
  }
  t.mock.method(Date, 'now', () => now + 1);
  assert.equal((await app.memory.searchAsync({ query: 'SQLite' })).memories.length, 0);
  app.memory.update({ id: a.id, updates: { content: 'PostgreSQL updated', expires_at: null } });
  assert.equal((await app.memory.searchAsync({ query: 'SQLite' })).memories.length, 0);
  assert.equal((await app.memory.searchAsync({ query: 'PostgreSQL' })).memories[0]?.id, a.id);
  app.memory.delete({ id: a.id }); assert.equal((await app.memory.searchAsync({ query: 'PostgreSQL' })).memories.length, 0);
  app.memory.restore({ id: a.id }); assert.equal((await app.memory.searchAsync({ query: 'PostgreSQL' })).memories[0]?.id, a.id);
});

test('worker capacity includes running work; shutdown drains accepted jobs and rejects new submissions', async t => {
  const app = await application(t); app.memory.add({ content: 'SQLite queue fixture' });
  const executor = new SqliteAsyncSearch({ ...app.config, search: { ...app.config.search, workerQueueLimit: 2 } });
  cleanup(t, () => executor.close());
  const filters = app.memory.filters({});
  const one = executor.search('SQLite', filters, Date.now());
  const two = executor.search('SQLite', filters, Date.now());
  await assert.rejects(executor.search('SQLite', filters, Date.now()), busy);
  const closed = executor.close();
  await assert.rejects(executor.search('SQLite', filters, Date.now()), busy);
  const hits = await Promise.all([one, two]); assert.deepEqual(hits[0], hits[1]); assert.equal(hits[0]!.length, 1);
  await closed; await executor.close();
});

test('queue/execution deadlines release resources and worker startup failures propagate instead of hanging', async t => {
  const app = await application(t);
  const executor = new SqliteAsyncSearch({ ...app.config, search: { ...app.config.search, workerTimeoutMs: 1 } });
  cleanup(t, () => executor.close());
  await assert.rejects(executor.search('SQLite', app.memory.filters({}), Date.now()), e => busy(e) && (e as AppError).retryable);
  await executor.close();
  const missing = new SqliteAsyncSearch(resolveConfig({ homeDir: temporary(t) })); cleanup(t, () => missing.close());
  await assert.rejects(missing.search('SQLite', app.memory.filters({}), Date.now()), e => e instanceof AppError && e.code === 'INTERNAL_ERROR');
  await missing.close();
});

test('worker can be disabled without changing lexical search results', async t => {
  const app = await application(t, { search: { workerEnabled: false } }); app.memory.add({ content: 'SQLite fallback' });
  assert.deepEqual(await app.memory.searchAsync({ query: 'SQLite' }), app.memory.search({ query: 'SQLite' }));
});
