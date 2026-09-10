import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { Filters } from '../../src/domain/memory.ts';
import { application, cleanup } from '../helpers.ts';
import { LegacySearch } from '../fixtures/legacy-search.ts';

const now = Date.parse('2026-09-10T00:00:00Z');
const iso = (time: number) => new Date(time).toISOString();
async function fixture(t: Parameters<typeof application>[0]) {
  const app = await application(t);
  t.mock.method(Date, 'now', () => now);
  app.memory.repository.transaction(() => {
    for (let i = 0; i < 80; i++) app.memory.createRecord({
      id: `fixture-${String(i).padStart(3, '0')}`, namespace: i % 7 === 0 ? 'other' : 'test',
      project: i % 4 === 0 ? 'projectneedle' : i % 4 === 1 ? 'B' : null,
      content: `Record ${i}: SQLite durable storage. 这是AI大模型长期记忆的说明。🎉 中文检索。 ${'context '.repeat(i % 3 === 0 ? 140 : 3)}`,
      title: i % 3 === 0 ? 'titleneedle SQLite 存储资料' : null,
      tags: i % 2 === 0 ? ['tagneedle', '中文'] : ['tagneedle'], type: i % 3 === 0 ? 'typeneedle' : 'note',
      source: i % 2 === 0 ? 'import' : 'manual', importance: 1 + i % 10,
      metadata: { index: i, nested: { value: 'metadata must not appear in search hits' } },
      created_at: iso(now - (i + 2) * 86400000), updated_at: iso(now - (i % 5) * 86400000),
      expires_at: i % 11 === 0 ? iso(now) : i % 13 === 0 ? iso(now + 1) : null,
      deleted_at: i % 17 === 0 ? iso(now - 1000) : null,
    }, 'test');
  });
  const db = new DatabaseSync(app.config.dbPath, { readOnly: true });
  cleanup(t, () => db.close());
  const legacy = new LegacySearch(db, app.config);
  const compare = (query: string, input: unknown = {}) => {
    const filters = app.memory.filters(input);
    const actual = app.memory.search({ query, ...(input as object) }).memories;
    assert.deepEqual(actual, legacy.search(query, filters), JSON.stringify({ query, filters }));
    return actual;
  };
  return { app, legacy, compare };
}

test('two-stage search preserves all fields, scores, snippets and literal multi-language matching', async t => {
  const { compare } = await fixture(t);
  for (const query of ['SQLite', 'SQLite storage', '长期记忆', 'AI 大模型', 'AI 模型', '中文', '🎉 中文',
    'titleneedle', 'tagneedle', 'projectneedle', 'typeneedle', '"', 'OR', 'x NEAR(y)', '*', "'; DROP TABLE memories;--", 'absent']) {
    for (const page of [{ limit: 1 }, { limit: 10, offset: 7 }, { limit: 100 }, { limit: 10, offset: 1000 }]) {
      compare(query, page);
    }
  }
  const hits = compare('AI 大模型');
  assert.ok(hits.length > 0);
  assert.ok(hits.every(hit => hit.snippet.includes('[大模型]') && !('content' in hit) && !('metadata' in hit)));
  assert.ok(compare('AI 模型', { limit: 100 }).some(hit => hit.snippet.length === 600), 'all-short substring limit is preserved');
});

test('ranking retains exact scope, temporal boundaries and every metadata filter before pagination', async t => {
  const { app, compare } = await fixture(t);
  const filters = [ {}, { namespace: 'other' }, { project: 'projectneedle' }, { project: 'B' }, { all_projects: true },
    { include_deleted: true }, { include_expired: true }, { include_deleted: true, include_expired: true },
    { tags: ['tagneedle', '中文'] }, { type: 'typeneedle', source: 'import', importance_min: 7 },
    { created_after: iso(now - 30 * 86400000), created_before: iso(now - 5 * 86400000) },
    { all_projects: true, tags: ['中文'], source: 'import', importance_min: 5, include_expired: true },
  ];
  for (const filter of filters) for (const query of ['SQLite', '长期记忆', 'AI 大模型', 'AI 模型']) {
    const hits = compare(query, { ...filter, limit: 100 });
    const expectedIds = app.memory.list({ ...filter, limit: 100 }).memories.map(m => m.id).sort();
    assert.deepEqual(hits.map(hit => hit.id).sort(), expectedIds);
    compare(query, { ...filter, limit: 3, offset: 2 });
  }
  const active = compare('SQLite', { limit: 100 });
  assert.ok(!active.some(hit => hit.id === 'fixture-022'), 'expiry equal to now is excluded');
  assert.ok(active.some(hit => hit.id === 'fixture-026'), 'expiry one millisecond later is live');
});

test('full weighted ranking has no fixed candidate cap and pagination has stable ties', async t => {
  const app = await application(t, { search: { importanceBoost: 0.2, recencyBoost: 0.1 } });
  t.mock.method(Date, 'now', () => now);
  app.memory.repository.transaction(() => {
    for (let i = 0; i < 260; i++) app.memory.createRecord({ id: `rank-${String(i).padStart(3, '0')}`,
      content: `SQLite stable ranking sample${String(i).padStart(3, '0')}`, importance: i === 259 ? 10 : 1,
      created_at: '2020-01-01T00:00:00Z', updated_at: i === 259 ? iso(now) : '2020-01-01T00:00:00Z',
    }, 'test');
  });
  const db = new DatabaseSync(app.config.dbPath, { readOnly: true }); cleanup(t, () => db.close());
  const legacy = new LegacySearch(db, app.config);
  const first = app.memory.search({ query: 'SQLite' }).memories;
  assert.equal(first[0]?.id, 'rank-259', 'a late high-importance recent record must outrank all BM25 ties');
  assert.deepEqual(first.slice(1).map(m => m.id), Array.from({ length: 9 }, (_, i) => `rank-${String(i).padStart(3, '0')}`));
  for (const [limit, offset] of [[100, 0], [100, 100], [100, 200], [101, 0], [10, 260]] as const) {
    const filters: Filters = { namespace: 'test', project: null, limit, offset };
    assert.deepEqual(app.memory.repository.search('SQLite', filters), legacy.search('SQLite', filters));
  }
  assert.throws(() => app.memory.search({ query: 'SQLite', limit: 101 }), /maximum/);
});

test('two-stage search observes committed updates, deletes, restore, rollback and TTL changes', async t => {
  const { app, compare } = await fixture(t);
  const id = 'fixture-002';
  app.memory.update({ id, updates: { content: 'Replacement PostgreSQL 中文新内容' } });
  assert.ok(!compare('SQLite', { limit: 100 }).some(m => m.id === id));
  assert.equal(compare('PostgreSQL')[0]?.id, id);
  app.memory.delete({ id }); assert.equal(compare('PostgreSQL').length, 0);
  assert.equal(compare('PostgreSQL', { include_deleted: true })[0]?.id, id);
  app.memory.restore({ id }); assert.equal(compare('PostgreSQL')[0]?.id, id);
  assert.throws(() => app.memory.repository.transaction(() => {
    app.memory.update({ id, updates: { content: 'Rollback SQLite 中文原内容' } });
    assert.equal(app.memory.search({ query: 'PostgreSQL' }).memories.length, 0);
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(compare('PostgreSQL')[0]?.id, id);
  t.mock.method(Date, 'now', () => now + 1);
  assert.ok(!compare('SQLite', { limit: 100 }).some(m => m.id === 'fixture-026'));
});
