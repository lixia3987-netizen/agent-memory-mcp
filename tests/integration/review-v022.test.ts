import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cleanup, application } from '../helpers.ts';
import { TestLlm } from '../fixtures/providers.ts';
import { AppError } from '../../src/shared/errors.ts';

const json = (memories: unknown[]) => JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), memories });
const date = (year: number) => year + '-01-01T00:00:00.000Z';

for (const action of ['reject', 'redact'] as const) test('secret policy handles punctuation, quotes and short metadata values: ' + action, async t => {
  const app = await application(t, { policy: { secretAction: action } });
  for (const secret of ['P@ssw0rd12345', '@!#$%^&*', 'abcdefg', 'x']) {
    const input = { content: 'password=' + secret, metadata: { nested: { password: secret } } };
    if (action === 'reject') {
      assert.throws(() => app.memory.add(input), /Secret/);
      assert.throws(() => app.memory.add({ content: 'safe note', metadata: input.metadata }), /Secret/);
      await assert.rejects(() => app.imports.run({ format: 'json', data: json([input]), dry_run: false }), /Secret/);
    } else {
      const m = app.memory.add(input).memory;
      assert.equal(m.content, 'password=[REDACTED]');
      assert.deepEqual(m.metadata, { nested: { password: '[REDACTED]' } });
    }
  }
  const quoted = 'password="one two@!#\\"three"';
  if (action === 'reject') assert.throws(() => app.memory.add({ content: quoted }), /Secret/);
  else assert.equal(app.memory.add({ content: quoted }).memory.content, 'password="[REDACTED]"');
});

test('redaction treats sensitive metadata keys as secrets regardless of value type', async t => {
  const app = await application(t, { policy: { secretAction: 'redact' } });
  const m = app.memory.add({ content: 'metadata policy', metadata: { password: 1234, secret: ['short', 'value'], nested: { api_key: { value: 'abc' } } } }).memory;
  assert.deepEqual(m.metadata, { password: '[REDACTED]', secret: '[REDACTED]', nested: { api_key: '[REDACTED]' } });
  const updated = app.memory.update({ id: m.id, updates: { title: 'still sanitized' } });
  assert.deepEqual(updated.metadata, m.metadata);
});

test('expired memories do not block add, update, restore or imported content deduplication', async t => {
  const app = await application(t);
  const expired = (content: string) => app.memory.add({ content, expires_at: date(2000) }).memory;
  const old = expired('renewable searchable memory');
  const fresh = app.memory.add({ content: old.content });
  assert.equal(fresh.deduplicated, false);
  assert.notEqual(fresh.memory.id, old.id);
  assert.deepEqual(app.memory.search({ query: 'renewable' }).memories.map(m => m.id), [fresh.memory.id]);
  assert.equal(app.memory.add({ content: old.content }).memory.id, fresh.memory.id);
  expired('update target');
  const updating = app.memory.add({ content: 'before update' }).memory;
  assert.equal(app.memory.update({ id: updating.id, updates: { content: 'update target' } }).content, 'update target');
  const restoring = app.memory.add({ content: 'restore target' }).memory;
  app.memory.delete({ id: restoring.id });
  expired('restore target');
  assert.equal(app.memory.restore({ id: restoring.id }).deleted_at, null);
  expired('import target');
  const imported = await app.imports.run({ format: 'json', data: json([{ content: 'import target' }]), dry_run: false });
  assert.equal(imported.added, 1);
  const source = app.memory.add({ content: 'import update before' }).memory;
  expired('import update target');
  assert.equal((await app.imports.run({ format: 'json', data: json([{ id: source.id, content: 'import update target' }]), conflict: 'update', dry_run: false })).updated, 1);
});

test('deduplication excludes the exact expiration boundary while respecting scope', async t => {
  const app = await application(t);
  const now = new Date(date(2030));
  t.mock.timers.enable({ apis: ['Date'], now });
  const old = app.memory.add({ content: 'expires exactly now', expires_at: now.toISOString() }).memory;
  assert.notEqual(app.memory.add({ content: old.content }).memory.id, old.id);
  assert.equal(app.memory.add({ content: old.content, project: 'other' }).deduplicated, false);
});

test('import update rejects inverted merged timestamps and rolls back its batch and provenance', async t => {
  const app = await application(t);
  await app.imports.run({ format: 'json', data: json([{ id: 'dated', content: 'original', created_at: date(2024) }]), dry_run: false });
  const before = app.memory.get({ id: 'dated' });
  for (const dry_run of [true, false]) {
    await assert.rejects(() => app.imports.run({ format: 'json', conflict: 'update', dry_run,
      data: json([{ content: 'must roll back' }, { id: 'dated', content: 'invalid chronology', updated_at: date(2020) }]) }), /updated_at.*created_at/);
    assert.deepEqual(app.memory.get({ id: 'dated' }), before);
    assert.equal(app.memory.list({}).total, 1);
  }
  assert.equal((await app.imports.run({ format: 'json', conflict: 'update', dry_run: false,
    data: json([{ id: 'dated', content: 'valid chronology', updated_at: date(2025) }]) })).updated, 1);
  const future = json([{ id: 'dated', content: 'future creation', created_at: date(2099) }]);
  await assert.rejects(() => app.imports.run({ format: 'json', data: future, conflict: 'update', dry_run: false }), /updated_at.*created_at/);
});

test('import defaults apply only to new records, preserving omitted TTL, importance and type on update', async t => {
  const app = await application(t, { policy: { defaultTtlDays: 30, typeDefaults: { decision: { importance: 9 } } } });
  const m = app.memory.add({ content: 'permanent', type: 'decision', importance: 7, expires_at: null }).memory;
  for (const dry_run of [true, false]) {
    assert.equal((await app.imports.run({ format: 'json', data: json([{ id: m.id, content: 'permanent edited' }]), conflict: 'update', dry_run })).updated, 1);
    const current = app.memory.get({ id: m.id });
    assert.equal(current.expires_at, null);
    assert.equal(current.importance, 7);
    assert.equal(current.type, 'decision');
  }
  await app.imports.run({ format: 'json', data: json([{ content: 'new defaulted', type: 'decision' }]), dry_run: false });
  const added = app.memory.list({}).memories.find(m => m.content === 'new defaulted')!;
  assert.equal(added.importance, 9);
  assert.ok(Date.parse(added.expires_at!) > Date.now() + 29 * 86400000);
  await app.imports.run({ format: 'json', data: json([{ id: m.id, content: 'explicit expiry', expires_at: date(2040), importance: 8 }]), conflict: 'update', dry_run: false });
  assert.equal(app.memory.get({ id: m.id }).expires_at, date(2040));
  await app.imports.run({ format: 'json', data: json([{ id: m.id, content: 'clear expiry', expires_at: null }]), conflict: 'update', dry_run: false });
  assert.equal(app.memory.get({ id: m.id }).expires_at, null);
  assert.equal(app.memory.get({ id: m.id }).importance, 8);
});

test('partial import policy checks defer missing importance and type until merge or creation', async t => {
  const app = await application(t, { policy: { minimumImportance: 7, rejectTypes: ['note'], typeDefaults: { decision: { importance: 9 } } } });
  await app.imports.run({ format: 'json', data: json([{ id: 'policy', content: 'decision', type: 'decision' }]), dry_run: false });
  await app.imports.run({ format: 'json', data: json([{ id: 'policy', content: 'decision edited' }]), conflict: 'update', dry_run: false });
  assert.equal(app.memory.get({ id: 'policy' }).importance, 9);
  await assert.rejects(() => app.imports.run({ format: 'json', data: json([{ content: 'new untyped' }]), dry_run: false }), /policy/);
});

test('relation interval expansion, reactivation and restoration mark both conflicting facts', async t => {
  const app = await application(t);
  const [a, b, c] = ['Subject', 'First', 'Second'].map(name => app.graph.entityAdd({ name }).entity);
  for (const mode of ['interval', 'status', 'restore']) {
    const first = app.graph.relationAdd({ source_entity_id: a!.id, target_entity_id: b!.id, predicate: mode, valid_from: date(2020), valid_to: mode === 'interval' ? date(2025) : null }).relation;
    if (mode === 'status') app.graph.relationUpdate({ id: first.id, updates: { status: 'inactive' } });
    if (mode === 'restore') app.graph.relationUpdate({ id: first.id, updates: { deleted: true } });
    const second = app.graph.relationAdd({ source_entity_id: a!.id, target_entity_id: c!.id, predicate: mode, valid_from: date(2026) }).relation;
    assert.equal(second.status, 'active');
    const updates = mode === 'interval' ? { valid_to: null } : mode === 'status' ? { status: 'active' } : { deleted: false };
    const updated = app.graph.relationUpdate({ id: first.id, updates });
    assert.equal(updated.status, 'conflict');
    assert.ok((updated.attributes?.conflict_with as string[]).includes(second.id));
    const other = app.graph.relationSearch({ predicate: mode, history: true }).relations.find(r => r.id === second.id)!;
    assert.equal(other.status, 'conflict');
    assert.ok((other.attributes?.conflict_with as string[]).includes(first.id));
    assert.ok(other.confidence <= .5 && updated.confidence <= .5);
  }
});

test('adjacent facts and inactive edits do not acquire false conflicts', async t => {
  const app = await application(t);
  const [a, b, c] = ['S', 'B', 'C'].map(name => app.graph.entityAdd({ name }).entity);
  const first = app.graph.relationAdd({ source_entity_id: a!.id, target_entity_id: b!.id, predicate: 'P', valid_from: date(2020), valid_to: date(2025) }).relation;
  app.graph.relationAdd({ source_entity_id: a!.id, target_entity_id: c!.id, predicate: 'P', valid_from: date(2026) });
  assert.equal(app.graph.relationUpdate({ id: first.id, updates: { valid_to: date(2026) } }).status, 'active');
  assert.equal(app.graph.relationUpdate({ id: first.id, updates: { status: 'inactive', valid_to: null } }).status, 'inactive');
});

test('new backdated facts never rewrite sealed superseded facts', async t => {
  const app = await application(t);
  const [a, b, c, d] = ['Subject', 'Old', 'New', 'Alternative'].map(name => app.graph.entityAdd({ name }).entity);
  const old = app.graph.relationAdd({ source_entity_id: a!.id, target_entity_id: b!.id, predicate: 'P', valid_from: date(2020), confidence: .9 }).relation;
  app.graph.relationAdd({ source_entity_id: a!.id, target_entity_id: c!.id, predicate: 'P', valid_from: date(2025), conflict_strategy: 'supersede', supersedes: old.id });
  const before = app.graph.relationSearch({ history: true }).relations.find(r => r.id === old.id)!;
  app.graph.relationAdd({ source_entity_id: a!.id, target_entity_id: d!.id, predicate: 'P', valid_from: date(2021), valid_to: date(2024) });
  const after = app.graph.relationSearch({ history: true }).relations.find(r => r.id === old.id)!;
  assert.deepEqual(after, before);
});

test('explicit historical time has consistent stale defaults and overrides across graph queries', async t => {
  const app = await application(t);
  const memory = app.memory.add({ content: 'source before' }).memory;
  const a = app.graph.entityAdd({ name: 'A' }).entity, b = app.graph.entityAdd({ name: 'B' }).entity;
  const fact = app.graph.relationAdd({ source_entity_id: a.id, target_entity_id: b.id, predicate: 'P', source_memory_id: memory.id, valid_from: date(2020) }).relation;
  app.memory.update({ id: memory.id, updates: { content: 'source after' } });
  assert.equal(app.graph.relationSearch({}).relations.length, 0);
  assert.equal(app.graph.neighbors({ entity_id: a.id }).relations.length, 0);
  for (const include_stale of [undefined, true, false]) {
    const options = { at: date(2021), ...(include_stale === undefined ? {} : { include_stale }) };
    const expected = include_stale === false ? [] : [fact.id];
    assert.deepEqual(app.graph.relationSearch(options).relations.map(r => r.id), expected);
    assert.deepEqual(app.graph.atTime(options).relations.map(r => r.id), expected);
    assert.deepEqual(app.graph.neighbors({ ...options, entity_id: a.id }).relations.map(r => r.id), expected);
    assert.equal(app.graph.path({ ...options, source_entity_id: a.id, target_entity_id: b.id }).found, expected.length > 0);
  }
});

test('entity add and update return the same canonical-deduplicated aliases as storage', async t => {
  const app = await application(t);
  const added = app.graph.entityAdd({ name: 'Database', aliases: ['sqlite', 'SQLITE', 'ＳＱＬＩＴＥ', 'Local  DB', 'local db'] }).entity;
  assert.deepEqual(added.aliases, ['sqlite', 'Local  DB']);
  assert.deepEqual(app.graph.entityGet({ id: added.id }), added);
  const updated = app.graph.entityUpdate({ id: added.id, updates: { aliases: ['Beta', 'ALPHA', 'alpha', 'Ｂｅｔａ'] } });
  assert.deepEqual(updated.aliases, ['Beta', 'ALPHA']);
  assert.deepEqual(app.graph.entityGet({ id: added.id }), updated);
});

test('retryable enrichment failure preserves the batch for a later worker pass', async t => {
  const provider = new TestLlm();
  let unavailable = true;
  provider.beforeReturn = () => { if (unavailable) throw new AppError('PROVIDER_UNAVAILABLE', 'Temporary gateway outage', true); };
  const app = await application(t, {}, { llm: provider });
  const ids = ['first job', 'second job', 'third job'].map(content => app.memory.add({ content }).memory.id);
  for (const id of ids) await app.enrichment.run({ id, action: 'enqueue' });
  const first = await app.enrichment.work(app.memory.scope({}), 100);
  assert.equal(first.completed, 0);
  assert.equal(provider.calls, 1, 'stop on temporary provider failure instead of burning the entire queue');
  const db = new DatabaseSync(app.config.dbPath); cleanup(t, () => db.close());
  assert.ok(db.prepare('SELECT status FROM enrichment_jobs').all().every(j => j.status === 'pending'));
  unavailable = false;
  const second = await app.enrichment.work(app.memory.scope({}), 100);
  assert.equal(second.completed, 3);
  assert.equal(second.failed, 0);
  for (const id of ids) assert.ok(app.intelligence.enrichment(id, app.memory.scope({})));
  assert.ok(db.prepare('SELECT status FROM enrichment_jobs').all().every(j => j.status === 'completed'));
});

test('nonretryable enrichment failures remain failed and do not prevent other jobs', async t => {
  const provider = new TestLlm();
  provider.beforeReturn = () => { if (provider.calls === 1) throw new AppError('PROVIDER_UNAVAILABLE', 'Invalid provider output'); };
  const app = await application(t, {}, { llm: provider });
  for (const content of ['bad job', 'good job']) await app.enrichment.run({ id: app.memory.add({ content }).memory.id, action: 'enqueue' });
  const result = await app.enrichment.work(app.memory.scope({}), 100);
  assert.equal(result.failed, 1); assert.equal(result.completed, 1);
  assert.equal((await app.enrichment.work(app.memory.scope({}), 100)).failed, 0);
});
