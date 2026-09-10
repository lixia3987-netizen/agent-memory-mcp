import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { application, cleanup } from '../helpers.ts';
import { TestLlm } from '../fixtures/providers.ts';
import { providerServer } from '../fixtures/http-provider.ts';
import { AppError } from '../../src/shared/errors.ts';
import { attributesSchema, relationAddSchema } from '../../src/domain/graph.ts';
import { llmConfigSchema } from '../../src/domain/phase2-config.ts';

const date = (year: number) => `${year}-01-01T00:00:00.000Z`;
const json = (memories: unknown[]) => JSON.stringify({ schemaVersion: 1, exportedAt: date(2024), memories });

for (const hidden of ['stale', 'deleted memory', 'expired memory', 'deleted entity'] as const) {
  test(`hidden facts do not create conflicts: ${hidden}`, async t => {
    const app = await application(t);
    const source = app.memory.add({ content: 'original evidence' }).memory;
    const [a, b, c] = ['A', 'B', 'C'].map(name => app.graph.entityAdd({ name }).entity.id);
    const old = app.graph.relationAdd({ source_entity_id: a, target_entity_id: b, predicate: 'USES', source_memory_id: source.id }).relation;
    if (hidden === 'stale') app.memory.update({ id: source.id, updates: { content: 'changed evidence' } });
    if (hidden === 'deleted memory') app.memory.delete({ id: source.id });
    if (hidden === 'expired memory') app.memory.update({ id: source.id, updates: { expires_at: date(2000) } });
    if (hidden === 'deleted entity') app.graph.entityUpdate({ id: b, updates: { deleted: true } });
    assert.equal(app.graph.relationSearch({}).relations.length, 0);
    const added = app.graph.relationAdd({ source_entity_id: a, target_entity_id: c, predicate: 'USES' });
    assert.deepEqual(added.conflicts, []);
    assert.equal(added.relation.status, 'active');
    const history = app.graph.relationSearch({ history: true, include_stale: true, include_deleted: true }).relations;
    assert.equal(history.find(r => r.id === old.id)?.status, 'active');
  });
}

test('updating parallel facts preserves old overlaps but marks newly introduced overlaps', async t => {
  const app = await application(t);
  const [a, b, c, d] = ['A', 'B', 'C', 'D'].map(name => app.graph.entityAdd({ name }).entity.id);
  const first = app.graph.relationAdd({ source_entity_id: a, target_entity_id: b, predicate: 'USES', valid_from: date(2020), valid_to: date(2025) }).relation;
  const parallel = app.graph.relationAdd({ source_entity_id: a, target_entity_id: c, predicate: 'USES', valid_from: date(2020), valid_to: date(2025), conflict_strategy: 'parallel' }).relation;
  const future = app.graph.relationAdd({ source_entity_id: a, target_entity_id: d, predicate: 'USES', valid_from: date(2026) }).relation;
  const edited = app.graph.relationUpdate({ id: parallel.id, updates: { valid_to: date(2024) } });
  assert.equal(edited.status, 'active'); assert.equal(edited.confidence, 1); assert.equal(edited.attributes, null);
  const extended = app.graph.relationUpdate({ id: parallel.id, updates: { valid_to: null } });
  assert.deepEqual(extended.attributes?.conflict_with, [future.id]);
  const history = app.graph.relationSearch({ history: true }).relations;
  assert.equal(history.find(r => r.id === first.id)?.status, 'active');
  assert.equal(history.find(r => r.id === future.id)?.status, 'conflict');
  const kept = app.graph.relationUpdate({ id: parallel.id, updates: { status: 'active', confidence: 1, attributes: { note: 'edit' } } });
  assert.equal(kept.status, 'conflict'); assert.equal(kept.confidence, .5);
  assert.deepEqual(kept.attributes?.conflict_with, [future.id]);
});

test('refreshing stale evidence detects new conflicts without using its stale overlap as parallel intent', async t => {
  const app = await application(t);
  const m = app.memory.add({ content: 'H1' }).memory;
  const [a, b, c] = ['A', 'B', 'C'].map(name => app.graph.entityAdd({ name }).entity.id);
  const old = app.graph.relationAdd({ source_entity_id: a, target_entity_id: b, predicate: 'USES', source_memory_id: m.id }).relation;
  app.memory.update({ id: m.id, updates: { content: 'H2' } });
  const fresh = app.graph.relationAdd({ source_entity_id: a, target_entity_id: c, predicate: 'USES' }).relation;
  assert.equal(fresh.status, 'active');
  assert.equal(app.graph.relationUpdate({ id: old.id, updates: { valid_to: null } }).status, 'active');
  const refreshed = app.graph.relationUpdate({ id: old.id, updates: { source_memory_id: m.id } });
  assert.deepEqual(refreshed.attributes?.conflict_with, [fresh.id]);
  assert.equal(refreshed.status, 'conflict');
});

test('enrichment apply ignores facts invalidated by a source content edit', async t => {
  const provider = new TestLlm(); const app = await application(t, {}, { llm: provider });
  const m = app.memory.add({ content: 'Project uses old storage' }).memory;
  const a = app.graph.entityAdd({ name: 'Project', type: 'Project' }).entity;
  const b = app.graph.entityAdd({ name: 'Old store', type: 'Technology' }).entity;
  const old = app.graph.relationAdd({ source_entity_id: a.id, target_entity_id: b.id, predicate: 'USES', source_memory_id: m.id }).relation;
  app.memory.update({ id: m.id, updates: { content: 'Project uses SQLite' } });
  await app.enrichment.run({ id: m.id }); await app.enrichment.run({ id: m.id, action: 'apply' });
  const current = app.graph.relationSearch({}).relations;
  assert.equal(current.length, 1); assert.notEqual(current[0]!.id, old.id); assert.equal(current[0]!.status, 'active');
});

test('persistent retryable failures exhaust a finite budget and explicit enqueue can restart', async t => {
  const provider = new TestLlm();
  provider.beforeReturn = () => { throw new AppError('PROVIDER_UNAVAILABLE', 'Persistent 429/500', true); };
  const app = await application(t, {}, { llm: provider }); const scope = app.memory.scope({});
  const ids = ['one', 'two'].map(content => app.memory.add({ content }).memory.id);
  for (const id of ids) await app.enrichment.run({ id, action: 'enqueue' });
  let failed = 0;
  for (let i = 0; i < 10; i++) failed += (await app.enrichment.work(scope, 100)).failed;
  assert.equal(provider.calls, 6); assert.equal(failed, 2); assert.equal(app.intelligence.stats(scope).pending_jobs, 0);
  const db = new DatabaseSync(app.config.dbPath); cleanup(t, () => db.close());
  assert.ok(db.prepare('SELECT status,attempts FROM enrichment_jobs').all().every(j => j.status === 'failed' && j.attempts === 3));
  provider.beforeReturn = undefined;
  await app.enrichment.run({ id: ids[0], action: 'enqueue' });
  assert.equal((await app.enrichment.work(scope, 100)).completed, 1);
  assert.equal(db.prepare('SELECT attempts FROM enrichment_jobs WHERE memory_id=?').get(ids[0]!)!.attempts, 1);
});

test('single runs do not reset pending attempts, and expired leases cannot evade the budget', async t => {
  const provider = new TestLlm(); provider.beforeReturn = () => { throw new AppError('PROVIDER_UNAVAILABLE', 'Unavailable', true); };
  const app = await application(t, {}, { llm: provider }); const scope = app.memory.scope({});
  const m = app.memory.add({ content: 'single run' }).memory;
  for (let i = 0; i < 3; i++) await assert.rejects(() => app.enrichment.run({ id: m.id }), /Unavailable/);
  const db = new DatabaseSync(app.config.dbPath); cleanup(t, () => db.close());
  assert.equal(db.prepare('SELECT status FROM enrichment_jobs WHERE memory_id=?').get(m.id)!.status, 'failed');
  const leased = app.memory.add({ content: 'abandoned lease' }).memory;
  const job = app.intelligence.enqueue(leased);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  for (let i = 1; i <= 3; i++) {
    const claim = app.intelligence.claimJob(scope, 100, job.id)!; assert.equal(claim.attempts, i);
    t.mock.timers.tick(101);
  }
  assert.equal(app.intelligence.claimJob(scope, 100, job.id), null);
  assert.equal(db.prepare('SELECT status FROM enrichment_jobs WHERE id=?').get(job.id)!.status, 'failed');
});

test('historical import hashes do not skip content rollback, including dry run', async t => {
  const app = await application(t);
  const a = json([{ id: 'versioned', content: 'version A' }]); const b = json([{ id: 'versioned', content: 'version B' }]);
  const run = (data: string, dry_run = false) => app.imports.run({ format: 'json', data, conflict: 'update', dry_run });
  assert.equal((await run(a)).added, 1); assert.equal((await run(b)).updated, 1);
  assert.equal((await run(a, true)).updated, 1); assert.equal(app.memory.get({ id: 'versioned' }).content, 'version B');
  assert.equal((await run(a)).updated, 1); assert.equal(app.memory.get({ id: 'versioned' }).content, 'version A');
  assert.equal((await run(a)).skipped, 1); assert.equal((await run(b)).updated, 1);
});

test('configured job budgets retire legacy jobs only in scope and protect live leases', async t => {
  const provider = new TestLlm(); provider.beforeReturn = () => { throw new AppError('PROVIDER_UNAVAILABLE', 'Unavailable', true); };
  const app = await application(t, { llm: { maxAttempts: 2 } }, { llm: provider }); const scope = app.memory.scope({});
  const current = app.memory.add({ content: 'configured budget' }).memory;
  await app.enrichment.run({ id: current.id, action: 'enqueue' });
  assert.equal((await app.enrichment.work(scope, 10)).deferred, 1);
  assert.equal((await app.enrichment.work(scope, 10)).failed, 1);
  assert.equal((await app.enrichment.work(scope, 10)).deferred, 0); assert.equal(provider.calls, 2);
  const db = new DatabaseSync(app.config.dbPath); cleanup(t, () => db.close());
  const legacy = app.intelligence.enqueue(app.memory.add({ content: 'legacy pending' }).memory);
  const other = app.intelligence.enqueue(app.memory.add({ content: 'other scope', project: 'other' }).memory);
  db.prepare("UPDATE enrichment_jobs SET attempts=999 WHERE id IN(?,?)").run(legacy.id, other.id);
  assert.equal(app.intelligence.claimJob(scope, 100, undefined, 2), null);
  assert.equal(db.prepare('SELECT status FROM enrichment_jobs WHERE id=?').get(legacy.id)!.status, 'failed');
  assert.equal(db.prepare('SELECT status FROM enrichment_jobs WHERE id=?').get(other.id)!.status, 'pending');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const live = app.intelligence.enqueue(app.memory.add({ content: 'last live lease' }).memory);
  const claim = app.intelligence.claimJob(scope, 100, live.id, 1)!;
  assert.equal(app.intelligence.claimJob(scope, 100, live.id, 1), null);
  assert.equal(app.intelligence.ownsJob(live.id, claim.lease_token!), true);
  t.mock.timers.tick(100);
  assert.equal(app.intelligence.claimJob(scope, 100, live.id, 1), null);
  assert.equal(app.intelligence.ownsJob(live.id, claim.lease_token!), false);
  app.intelligence.finishJob(live.id, claim.lease_token!, 'completed');
  assert.equal(db.prepare('SELECT status FROM enrichment_jobs WHERE id=?').get(live.id)!.status, 'failed');
  for (const maxAttempts of [0, 1.5, 101]) assert.throws(() => llmConfigSchema.parse({ maxAttempts }));
});

for (const status of [429, 500]) test(`HTTP ${status} and an open circuit cannot keep a job pending forever`, async t => {
  const endpoint = await providerServer(t, () => ({ status, body: { error: 'unavailable' } }));
  const app = await application(t, { llm: { enabled: true, baseUrl: endpoint.baseUrl, model: 'test', retries: 0,
    maxAttempts: 2, circuitFailures: 1, circuitCooldownMs: 300000 } });
  const m = app.memory.add({ content: 'bounded HTTP outage' }).memory;
  await app.enrichment.run({ id: m.id, action: 'enqueue' }); const scope = app.memory.scope({});
  assert.equal((await app.enrichment.work(scope, 100)).deferred, 1);
  assert.equal((await app.enrichment.work(scope, 100)).failed, 1);
  assert.equal((await app.enrichment.work(scope, 100)).deferred, 0);
  assert.equal(app.intelligence.stats(scope).pending_jobs, 0); assert.equal(endpoint.requests.length, 1);
});

test('explicit import restoration still enforces active content uniqueness', async t => {
  const app = await application(t);
  const m = app.memory.add({ content: 'deleted original' }).memory; app.memory.delete({ id: m.id });
  const active = app.memory.add({ content: 'active duplicate' }).memory;
  await assert.rejects(() => app.imports.run({ format: 'json', conflict: 'update', dry_run: false,
    data: json([{ id: m.id, content: active.content, deleted_at: null }]) }), /duplicates/);
  assert.equal(app.memory.get({ id: m.id, include_deleted: true }).content, 'deleted original');
  assert.equal(app.memory.list({}).total, 1);
});

test('import skips tombstone updates unless restoration is explicit, without recreating or mutating them', async t => {
  const app = await application(t); const a = json([{ id: 'deleted-import', content: 'original' }]);
  await app.imports.run({ format: 'json', data: a, dry_run: false }); app.memory.delete({ id: 'deleted-import' });
  const before = app.memory.get({ id: 'deleted-import', include_deleted: true });
  const b = json([{ id: 'deleted-import', content: 'changed' }]);
  for (const dry_run of [true, false]) {
    const result = await app.imports.run({ format: 'json', data: b, conflict: 'update', dry_run });
    assert.equal(result.skipped, 1); assert.equal(result.updated, 0);
    assert.deepEqual(app.memory.get({ id: 'deleted-import', include_deleted: true }), before);
  }
  assert.equal(app.memory.list({}).total, 0);
  const restore = json([{ id: 'deleted-import', content: 'changed', deleted_at: null }]);
  assert.equal((await app.imports.run({ format: 'json', data: restore, conflict: 'update', dry_run: false })).updated, 1);
  assert.equal(app.memory.get({ id: 'deleted-import' }).content, 'changed');
  app.memory.delete({ id: 'deleted-import' });
  assert.equal((await app.imports.run({ format: 'json', data: restore, conflict: 'update', dry_run: false })).updated, 1, 'exact hash must not suppress explicit restoration');
});

test('redaction preserves surrounding JSON quotes for unquoted credentials and authorization tokens', async t => {
  const app = await application(t, { policy: { secretAction: 'redact' } });
  for (const key of ['password=abc', 'authorization=Bearer abc', 'authorization=Basic abc']) {
    const content = JSON.stringify([key, 'safe']);
    const output = app.memory.add({ content }).memory.content;
    assert.deepEqual(JSON.parse(output), [key.split('=')[0] + '=[REDACTED]', 'safe']);
  }
  assert.equal(app.memory.add({ content: "['password=abc','safe']" }).memory.content, "['password=[REDACTED]','safe']");
});

test('conflict references have a separate bounded budget without relaxing ordinary attributes', async t => {
  const app = await application(t); const a = app.graph.entityAdd({ name: 'A' }).entity;
  const ids: string[] = [];
  for (let i = 0; i < 450; i++) {
    const b = app.graph.entityAdd({ name: `target ${i}` }).entity;
    ids.push(app.graph.relationAdd({ source_entity_id: a.id, target_entity_id: b.id, predicate: 'USES', conflict_strategy: 'parallel' }).relation.id);
  }
  const c = app.graph.entityAdd({ name: 'new target' }).entity;
  const fresh = app.graph.relationAdd({ source_entity_id: a.id, target_entity_id: c.id, predicate: 'USES', attributes: { note: 'x'.repeat(16000) } });
  assert.equal(fresh.conflicts.length, 450); assert.deepEqual(new Set(fresh.relation.attributes?.conflict_with as string[]), new Set(ids));
  assert.ok(Buffer.byteLength(JSON.stringify(fresh.relation.attributes)) > 16384);
  assert.throws(() => attributesSchema.parse({ conflict_with: Array.from({ length: 450 }, () => randomUUID()) }), /16 KiB/);
  const input = { source_entity_id: a.id, target_entity_id: c.id, predicate: 'TEST' };
  assert.doesNotThrow(() => relationAddSchema.parse({ ...input, attributes: { conflict_with: Array.from({ length: 1000 }, () => randomUUID()) } }));
  assert.throws(() => relationAddSchema.parse({ ...input, attributes: { note: 'x'.repeat(16384) } }));
  assert.throws(() => relationAddSchema.parse({ ...input, attributes: { conflict_with: Array.from({ length: 1001 }, () => randomUUID()) } }));
});

test('mixed CJK searches retain every short token and all scope, lifecycle and pagination filters', async t => {
  const app = await application(t);
  const good = app.memory.add({ content: '这是AI大模型的说明', tags: ['wanted'] }).memory;
  const titled = app.memory.add({ title: 'ai', content: '另一条大模型说明', tags: ['wanted'] }).memory;
  app.memory.add({ content: '大模型但是缺少短词', tags: ['wanted'] });
  app.memory.add({ content: '跨项目AI大模型', project: 'other', tags: ['wanted'] });
  app.memory.add({ content: '过期AI大模型', expires_at: date(2000), tags: ['wanted'] });
  const deleted = app.memory.add({ content: '删除AI大模型', tags: ['wanted'] }).memory; app.memory.delete({ id: deleted.id });
  const found = app.memory.search({ query: 'AI 大模型', tags: ['wanted'] }).memories;
  assert.deepEqual(new Set(found.map(m => m.id)), new Set([good.id, titled.id]));
  assert.deepEqual(app.memory.search({ query: 'AI 大模型', tags: ['wanted'], limit: 1, offset: 1 }).memories.map(m => m.id), [found[1]!.id]);
  assert.equal(app.memory.search({ query: 'AI 大模型', tags: ['missing'] }).memories.length, 0);
  assert.deepEqual(new Set(app.memory.search({ query: 'AI 模型' }).memories.map(m => m.id)), new Set([good.id, titled.id]));
  const literal = app.memory.add({ content: 'AI大模型含有%符号' }).memory;
  assert.deepEqual(app.memory.search({ query: 'AI 大模型 %' }).memories.map(m => m.id), [literal.id]);
});
